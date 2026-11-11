/** @typedef {{ now: () => number }} Clock */
/** 默认时钟；测试注入固定时钟。 @type {Clock} */
export const systemClock = { now: () => Date.now() };
