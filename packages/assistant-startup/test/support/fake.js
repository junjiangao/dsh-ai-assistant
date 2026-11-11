import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * assistant-startup 需要的最小假宿主：只实现它真正读写的面。
 * @param {{ dshHome?: string }} [options]
 */
export function createStartupHost({ dshHome } = {}) {
  const home = dshHome ?? mkdtempSync(join(tmpdir(), 'assistant-startup-'));
  mkdirSync(home, { recursive: true });
  /** @type {Map<string, any>} */
  const services = new Map();
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  /** @type {number[]} */
  const exits = [];
  /** @type {string[]} */
  const logs = [];
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Array<any>} */
  const prompts = [];
  /** @type {Array<any>} */
  const creates = [];
  /** @type {Array<any>} */
  const cancels = [];
  let counter = 0;

  /** @param {string} sessionId @param {string} [cwd] */
  function makeSession(sessionId, cwd = home) {
    /** @type {any} */
    const session = {
      id: sessionId,
      header: { id: sessionId, cwd },
      events: [],
      seq: 0,
      snapshotEvents: (from = 0, to) => session.events.slice(from, to ?? session.events.length)
    };
    sessions.set(sessionId, session);
    return session;
  }

  /** @param {string} sessionId @param {any} event */
  function append(sessionId, event) {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new Error(`unknown session ${sessionId}`);
    const withSeq = { seq: session.seq, ...event };
    session.events.push(withSeq);
    session.seq += 1;
    dispatch('session/event', session, withSeq);
    return withSeq;
  }

  /** @param {string} name @param {...any} args */
  function dispatch(name, ...args) {
    for (const callback of [...(listeners.get(name) ?? [])]) callback(...args);
  }

  /** @type {any} */
  const ctx = {
    /** @param {string} name */
    get: (name) => services.get(name),
    /** @param {string} name @param {any} value */
    provide(name, value) {
      services.set(name, value);
      return () => services.delete(name);
    },
    /** @param {string} name @param {Function} callback */
    on(name, callback) {
      const list = listeners.get(name) ?? [];
      list.push(callback);
      listeners.set(name, list);
      return () => {
        const index = list.indexOf(callback);
        if (index >= 0) list.splice(index, 1);
      };
    },
    /** @param {Function} factory @param {string} label */
    effect(factory, label) {
      const dispose = factory();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    logger: {
      debug: (/** @type {string} */ message) => logs.push(`debug: ${message}`),
      info: (/** @type {string} */ message) => logs.push(`info: ${message}`),
      warn: (/** @type {string} */ message) => logs.push(`warn: ${message}`),
      error: (/** @type {string} */ message) => logs.push(`error: ${message}`)
    }
  };

  const sessionController = {
    /** @param {{ agentPreset?: string }} [request] */
    async create(request = {}) {
      creates.push({ ...request });
      counter += 1;
      const sessionId = `session-${counter}`;
      makeSession(sessionId);
      return { sessionId };
    },
    /** @param {{ sessionId: string }} request */
    async prompt(request) {
      prompts.push({ ...request });
      return { accepted: true };
    },
    /** @param {string} sessionId */
    async resolveAgent(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) return { error: new Error('not found') };
      return {
        agent: {
          id: sessionId,
          session,
          status: 'idle',
          whenIdle: async () => {},
          followup: () => {}
        }
      };
    },
    /** @param {{ sessionId: string }} request */
    cancel(request) {
      cancels.push({ ...request });
      return { accepted: true };
    }
  };

  services.set('sessionController', sessionController);
  services.set('sessions', { get: (/** @type {string} */ id) => sessions.get(id) });
  services.set('subagents', { waitForTreeWork: async () => false });
  services.set('appExit', (/** @type {number} */ code) => exits.push(code));

  return {
    home,
    ctx,
    services,
    sessions,
    prompts,
    creates,
    cancels,
    exits,
    logs,
    makeSession,
    append,
    dispatch
  };
}

/**
 * 收集写入的假 stdout/stderr。
 * @returns {{ write: (chunk: string) => void, text: () => string }}
 */
export function capture() {
  let buffer = '';
  return {
    write(chunk) {
      buffer += chunk;
    },
    text() {
      return buffer;
    }
  };
}

/**
 * @param {string} path
 * @param {string} content
 */
export function writeFileAt(path, content) {
  mkdirSync(dirnameOf(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** @param {string} path */
function dirnameOf(path) {
  return path.slice(0, path.lastIndexOf('/'));
}
