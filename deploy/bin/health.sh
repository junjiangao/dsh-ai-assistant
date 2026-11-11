#!/usr/bin/env bash
# 心跳健康检查：心跳过期或进程消失就 restart 主单元（设计文档 §9.3）。
#
# 心跳由 channel-core 每 30 秒原子写一次；这里只读。阈值默认 120 秒（= 4 个周期）。
set -uo pipefail

# 固定助理数据根：从 dsh 进程里跑这些脚本时环境常带 DSH_HOME=~/.dsh（桌面 Web 的数据根），
# 沿用它会读错/写错目录。ASSISTANT_HOME 可覆盖。
ASSISTANT_HOME="${ASSISTANT_HOME:-$HOME/.dsh-assistant}"
DSH_HOME="$ASSISTANT_HOME"
UNIT="${ASSISTANT_UNIT:-dsh-assistant.service}"
MAX_AGE="${HEARTBEAT_MAX_AGE_SECONDS:-120}"
HEARTBEAT="$DSH_HOME/run/heartbeat.json"

restart() {
  echo "health: $1；重启 $UNIT" >&2
  systemctl --user restart "$UNIT" || echo "health: 重启失败，请检查 systemctl --user status $UNIT" >&2
  exit 0
}

if [ ! -f "$HEARTBEAT" ]; then
  if systemctl --user is-active --quiet "$UNIT"; then
    restart "心跳文件不存在"
  fi
  echo "health: 单元未运行且没有心跳，视为停机状态"
  exit 0
fi

node_bin="${NODE_BIN:-node}"
age="$("$node_bin" -e '
const fs = require("node:fs");
const path = process.argv[1];
try {
  const heartbeat = JSON.parse(fs.readFileSync(path, "utf8"));
  const age = Math.max(0, Math.round((Date.now() - Number(heartbeat.ts ?? 0)) / 1000));
  process.stdout.write(String(age));
} catch {
  process.stdout.write("invalid");
}
' "$HEARTBEAT" 2>/dev/null)"

if [ -z "$age" ] || [ "$age" = "invalid" ]; then
  restart "心跳文件无法解析"
fi

if [ "$age" -gt "$MAX_AGE" ]; then
  restart "心跳已 ${age}s 未更新（阈值 ${MAX_AGE}s）"
fi

echo "health: 心跳 ${age}s 前，正常"