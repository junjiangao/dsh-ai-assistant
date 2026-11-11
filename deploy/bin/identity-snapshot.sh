#!/usr/bin/env bash
# 启动前给身份文件做快照，并对上一版生成 DIFF.txt（设计文档 §5.2）。
#
# 为什么在 systemd 的 ExecStartPre 里做：身份只读是**约定**，助理技术上能改；
# 唯一可靠的对账点是"每次启动、进程还没起来之前"。
# 插件启动时会把非空 DIFF 推给 owner 的 Telegram（channel-core 负责投递）。
set -euo pipefail

# 固定助理数据根：从 dsh 进程里跑这些脚本时环境常带 DSH_HOME=~/.dsh（桌面 Web 的数据根），
# 沿用它会读错/写错目录。ASSISTANT_HOME 可覆盖。
ASSISTANT_HOME="${ASSISTANT_HOME:-$HOME/.dsh-assistant}"
DSH_HOME="$ASSISTANT_HOME"
KEEP="${IDENTITY_SNAPSHOT_KEEP:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# 同一秒内重启（或手工连跑）也要拿到独立目录，否则"上一版"会被自己覆盖。
DEST="$DSH_HOME/identity-history/$STAMP"
suffix=2
while [ -e "$DEST" ]; do
  DEST="$DSH_HOME/identity-history/$STAMP-$suffix"
  suffix=$((suffix + 1))
done

mkdir -p "$DEST"

for rel in identity/SOUL.md identity/SYSTEM.md AGENTS.md; do
  if [ -f "$DSH_HOME/$rel" ]; then
    cp -p "$DSH_HOME/$rel" "$DEST/$(basename "$rel")"
  fi
done

# 上一份快照（当前这份尚未计入）。
prev=""
for candidate in $(ls -1d "$DSH_HOME"/identity-history/*/ 2>/dev/null | sort); do
  [ "$candidate" = "$DEST/" ] && continue
  prev="$candidate"
done

if [ -n "$prev" ]; then
  # 只在内容有变化时留下 DIFF；空文件表示"与上一版相同"，插件据此不推送。
  ( cd "$prev" && diff -ru --exclude='DIFF.txt' --exclude='.notified' . "$DEST" > "$DEST/DIFF.txt" 2>/dev/null ) || true
fi

chmod -R go-rwx "$DEST" 2>/dev/null || true

# 只保留最近 KEEP 份。
count="$(ls -1d "$DSH_HOME"/identity-history/*/ 2>/dev/null | wc -l)"
if [ "$count" -gt "$KEEP" ]; then
  ls -1d "$DSH_HOME"/identity-history/*/ | sort | head -n "$((count - KEEP))" | while read -r old; do
    rm -rf "$old"
  done
fi

changed="否"
if [ -s "$DEST/DIFF.txt" ]; then changed="是"; fi
echo "identity-snapshot: $DEST（与上一版有变更：$changed）"