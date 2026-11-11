#!/usr/bin/env bash
# 安装/更新个人 AI 助理（设计文档 §4/§9/§10）。
#
# 幂等：重复执行只补齐缺失项，不覆盖已有的身份文件与 env。
# 用法：
#   deploy/install.sh [--dry-run] [--start] [--no-systemd] [--link] [--home <dir>]
#
# 数据根固定为 ~/.dsh-assistant（不沿用环境里的 DSH_HOME：从 dsh 里跑脚本时它指向 ~/.dsh，
# 那是桌面 Web 的数据根）。--home 可覆盖到别的目录。
#
# --link 用 `link:` 而不是 `file:` 安装 bundle：本地开发时改仓库代码立即生效
# （生产安装用 file: 快照：pnpm 把包文件硬链接进 profile；就地改内容会同步，新增/改名不会）。
#
# 它做的事：
#   1. 建数据根与目录骨架；
#   2. 从模板落地 SOUL/SYSTEM/AGENTS 与 ~/.config/dsh-assistant/env（仅当缺失）；
#   3. 生成 preset 快照（会核对 DSH 升级是否让删除名单与 preset 结构失效）；
#   4. 建/更新 profile assistant：bundles = [dsh-base, dsh-web-app, assistant-bundle]；
#   5. 渲染并安装 systemd 用户单元与健康 timer；
#   6. 跑一次 identity-snapshot。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 助理固定用独立数据根。注意：从 dsh 进程里跑本脚本时环境里常常带着 DSH_HOME=~/.dsh
# （桌面 Web 的数据根），直接沿用会把 assistant profile 装进桌面数据根，所以这里只认自己的变量。
ASSISTANT_HOME="${ASSISTANT_HOME:-$HOME/.dsh-assistant}"
CONFIG_DIR="${ASSISTANT_CONFIG_DIR:-$HOME/.config/dsh-assistant}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DRY_RUN=0
START=0
USE_SYSTEMD=1
BUNDLE_PROTOCOL="file"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --start) START=1 ;;
    --no-systemd) USE_SYSTEMD=0 ;;
    --link) BUNDLE_PROTOCOL="link" ;;
    --home)
      [ "$#" -ge 2 ] || { echo "install: --home 需要目录参数" >&2; exit 2; }
      ASSISTANT_HOME="$2"; shift ;;
    --home=*) ASSISTANT_HOME="${1#--home=}" ;;
    -h|--help)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "install: 未知参数 $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "${DSH_HOME:-}" ] && [ "$DSH_HOME" != "$ASSISTANT_HOME" ]; then
  echo "install: 忽略环境里的 DSH_HOME=$DSH_HOME（那是其它 profile 的数据根）；本助理用 $ASSISTANT_HOME（--home 可改）" >&2
fi
# 子进程（dsh plugin / identity-snapshot / gen-preset）都按这个数据根工作。
export DSH_HOME="$ASSISTANT_HOME"
PROFILE_DIR="$ASSISTANT_HOME/profiles/assistant"

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  + %s\n' "$*"
  else
    "$@"
  fi
}

# ── 0. 前置检查 ────────────────────────────────────────────────────────────────
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
[ -n "$DSH_BIN" ] || { echo "install: 找不到 dsh（pnpm add -g @deepseek-ai/dsh）" >&2; exit 1; }
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "install: 找不到 node" >&2; exit 1; }
PNPM_BIN="$(command -v pnpm || true)"
[ -n "$PNPM_BIN" ] || { echo "install: 找不到 pnpm" >&2; exit 1; }

NODE_BIN_DIR="$(dirname "$(readlink -f "$NODE_BIN")")"
PNPM_BIN_DIR="$(dirname "$(readlink -f "$PNPM_BIN")")"

say "install: DSH_HOME=$DSH_HOME"
say "install: dsh=$DSH_BIN"
say "install: node=$NODE_BIN_DIR"

# ── 1. 目录骨架 ────────────────────────────────────────────────────────────────
for dir in "$DSH_HOME" "$DSH_HOME/identity" "$DSH_HOME/identity-history" "$DSH_HOME/skills" \
           "$DSH_HOME/sessions" "$DSH_HOME/storages" "$DSH_HOME/workspace" "$DSH_HOME/workspace/inbox" \
           "$DSH_HOME/run" "$DSH_HOME/audit" "$DSH_HOME/logs" "$CONFIG_DIR"; do
  run mkdir -p "$dir"
done
run chmod 700 "$DSH_HOME" "$CONFIG_DIR"

# ── 2. 身份文件与 env（只在缺失时落地）────────────────────────────────────────
copy_if_missing() {
  local source="$1" target="$2" mode="${3:-600}"
  if [ -f "$target" ]; then
    say "install: 保留已有 $target"
    return
  fi
  run install -m "$mode" "$source" "$target"
}
copy_if_missing "$REPO_ROOT/deploy/templates/SOUL.md.tmpl" "$DSH_HOME/identity/SOUL.md" 600
copy_if_missing "$REPO_ROOT/deploy/templates/SYSTEM.md.tmpl" "$DSH_HOME/identity/SYSTEM.md" 600
copy_if_missing "$REPO_ROOT/deploy/templates/AGENTS.md.tmpl" "$DSH_HOME/AGENTS.md" 600
copy_if_missing "$REPO_ROOT/deploy/templates/env.example" "$CONFIG_DIR/env" 600
# 已有 env 不受 copy_if_missing 的权限约束：手工建的 644 文件会让同机其它用户读到 token。
if [ -f "$CONFIG_DIR/env" ] && [ "$(stat -c '%a' "$CONFIG_DIR/env")" != "600" ]; then
  say "install: 收紧 $CONFIG_DIR/env 权限为 600"
  run chmod 600 "$CONFIG_DIR/env"
fi

# ── 3. preset 快照 ────────────────────────────────────────────────────────────
say "install: 生成 preset 快照并核对删除名单"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  + node $REPO_ROOT/deploy/gen-preset.mjs"
else
  node "$REPO_ROOT/deploy/gen-preset.mjs"
fi

# ── 4. profile ────────────────────────────────────────────────────────────────
BUNDLE_SPEC="$BUNDLE_PROTOCOL:$REPO_ROOT/packages/assistant-bundle"
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  say "install: 初始化 profile assistant（首次会创建 package.json 与 pnpm 工作区设置）"
  run "$DSH_BIN" plugin --profile assistant add "$BUNDLE_SPEC"
else
  if ! node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const deps = manifest.dependencies ?? {};
const wanted = Object.keys(deps).find((name) => name === "@junjiangao/assistant-bundle");
process.exit(wanted && /^(file|link):/.test(deps[wanted]) ? 0 : 1);
' "$PROFILE_DIR/package.json"; then
    say "install: 补装 assistant-bundle 到 profile"
    run "$DSH_BIN" plugin --profile assistant add "$BUNDLE_SPEC"
  fi
fi

# `link:` 安装不会展开 bundle 包的依赖（pnpm 只链接它本身），因此开发模式要把
# 三个同级包显式 link 进 profile，否则通道插件在 profile 里 import 不到。
if [ "$BUNDLE_PROTOCOL" = "link" ]; then
  for package_name in channel-core channel-telegram assistant-startup; do
    if ! node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const deps = manifest.dependencies ?? {};
process.exit(deps["@junjiangao/" + process.argv[2]] === undefined ? 1 : 0);
' "$PROFILE_DIR/package.json" "$package_name"; then
      say "install: link 模式补装 @junjiangao/$package_name"
      run "$DSH_BIN" plugin --profile assistant add "link:$REPO_ROOT/packages/$package_name"
    fi
  done
fi

say "install: 对齐 bundles 顺序为 [dsh-base, dsh-web-app, assistant-bundle]"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  + node (重写 $PROFILE_DIR/package.json 的 dsh.profile.bundles)"
else
  node -e '
const fs = require("node:fs");
const path = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
manifest.dsh = manifest.dsh ?? {};
manifest.dsh.profile = manifest.dsh.profile ?? {};
const core = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@junjiangao/assistant-bundle"];
// 保留用户额外启用的 bundle，只对齐基础组合的加载顺序。
const extra = (manifest.dsh.profile.bundles ?? []).filter((name) => !core.includes(name));
manifest.dsh.profile.bundles = [...core, ...extra];
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$PROFILE_DIR/package.json"
fi
run "$DSH_BIN" plugin --profile assistant install

# ── 5. systemd ────────────────────────────────────────────────────────────────
render() {
  local template="$1" target="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  + 渲染 $target"
    return
  fi
  sed -e "s#@REPO_ROOT@#$REPO_ROOT#g" \
      -e "s#@DSH_BIN@#$DSH_BIN#g" \
      -e "s#@ASSISTANT_HOME@#$ASSISTANT_HOME#g" \
      -e "s#@CONFIG_DIR@#$CONFIG_DIR#g" \
      -e "s#@NODE_BIN_DIR@#$NODE_BIN_DIR#g" \
      -e "s#@PNPM_BIN_DIR@#$PNPM_BIN_DIR#g" \
      "$template" > "$target"
  chmod 644 "$target"
}

if [ "$USE_SYSTEMD" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
  run mkdir -p "$UNIT_DIR"
  render "$REPO_ROOT/deploy/systemd/dsh-assistant.service.in" "$UNIT_DIR/dsh-assistant.service"
  render "$REPO_ROOT/deploy/systemd/dsh-assistant-health.service.in" "$UNIT_DIR/dsh-assistant-health.service"
  run install -m 644 "$REPO_ROOT/deploy/systemd/dsh-assistant-health.timer" "$UNIT_DIR/dsh-assistant-health.timer"
  run systemctl --user daemon-reload
  run systemctl --user enable dsh-assistant.service dsh-assistant-health.timer
  if [ "$START" -eq 1 ]; then
    run systemctl --user restart dsh-assistant.service
    run systemctl --user start dsh-assistant-health.timer
  fi
else
  say "install: 跳过 systemd（--no-systemd 或系统没有 systemctl）"
fi

# ── 6. 身份快照 ───────────────────────────────────────────────────────────────
say "install: 身份快照"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  + $REPO_ROOT/deploy/bin/identity-snapshot.sh"
else
  DSH_HOME="$DSH_HOME" "$REPO_ROOT/deploy/bin/identity-snapshot.sh"
fi

cat <<EOF

安装完成。下一步：
  1. 填 $CONFIG_DIR/env（至少 DEEPSEEK_API_KEY；接真实 Telegram 时填 TELEGRAM_BOT_TOKEN 与 TELEGRAM_OWNER_ID）
  2. 诊断：$REPO_ROOT/deploy/bin/doctor.sh
  3. 一次性自检：DSH_HOME=$DSH_HOME $DSH_BIN --profile assistant --once "报一下今天的日期"
  4. 常驻：systemctl --user restart dsh-assistant.service
  5. 无登录也常驻：sudo loginctl enable-linger $USER
占位符模式：把一行 JSON 追加到 $DSH_HOME/channels/telegram/sim/inbox.jsonl 即可对话。
EOF