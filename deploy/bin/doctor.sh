#!/usr/bin/env bash
# 一页诊断：先跑插件的 --doctor，再补一条"零监听"检查（插件看不到端口）。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# 固定助理数据根：从 dsh 进程里跑这些脚本时环境常带 DSH_HOME=~/.dsh（桌面 Web 的数据根），
# 沿用它会读错/写错目录。ASSISTANT_HOME 可覆盖。
ASSISTANT_HOME="${ASSISTANT_HOME:-$HOME/.dsh-assistant}"
DSH_HOME="$ASSISTANT_HOME"
export DSH_HOME

# 手动跑 doctor 的 shell 不会加载 systemd 的 EnvironmentFile：这里补上，
# 否则通道会被误报成"占位符"，模型 provider 也看不到。
ENV_FILE="${ASSISTANT_CONFIG_DIR:-$HOME/.config/dsh-assistant}/env"
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"

status=0
if [ ! -f "$DSH_HOME/profiles/assistant/package.json" ]; then
  echo "doctor: $DSH_HOME 下没有 profile assistant；先跑 deploy/install.sh" >&2
  exit 2
fi
if [ -z "$DSH_BIN" ]; then
  echo "doctor: 找不到 dsh；请设置 DSH_BIN" >&2
  status=1
else
  "$DSH_BIN" --profile assistant --doctor || status=$?
fi

# 模型：provider/model 与网关可达性全部来自 env，不在仓库里写死厂商或地址。
model_provider="${ASSISTANT_MODEL_PROVIDER:-deepseek-official}"
model_name="${ASSISTANT_MODEL:-deepseek-flash}"
model_key_var="${ASSISTANT_MODEL_KEY_ENV:-DEEPSEEK_API_KEY}"
model_base_url="${ASSISTANT_MODEL_BASE_URL:-}"
model_key=""
if [ -n "$model_key_var" ] && [ -n "${!model_key_var:-}" ]; then model_key="${!model_key_var}"; fi
if [ -z "$model_key" ]; then
  model_detail="密钥 ${model_key_var} 未设置"
  status=1
elif [ -z "$model_base_url" ]; then
  model_detail="直连 ${model_provider}（未配置网关）"
elif command -v curl >/dev/null 2>&1; then
  code="$(curl -s -o /dev/null --max-time 5 -H "authorization: Bearer $model_key" -w '%{http_code}' "${model_base_url%/}/models" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then
    model_detail="网关 200"
  else
    model_detail="网关不可用（HTTP ${code:-超时}）"
    status=1
  fi
else
  model_detail="网关（curl 不可用，未检查）"
fi
echo "  模型：$model_provider/$model_name（$model_detail）"
# 零监听：进程不应当有任何 LISTEN 端口（设计文档 §9.2）。
PID_FILE="$DSH_HOME/run/host.pid"
if [ -f "$PID_FILE" ]; then
  pid="$(tr -dc '0-9' < "$PID_FILE")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    listeners="$(ss -lntp 2>/dev/null | grep -c "pid=$pid," || true)"
    if [ "${listeners:-0}" -gt 0 ]; then
      echo "❌ 零监听：进程 $pid 有 $listeners 个监听端口" >&2
      ss -lntp 2>/dev/null | grep "pid=$pid," >&2
      status=1
    else
      echo "✅ 零监听：进程 $pid 没有任何监听端口"
    fi
  else
    echo "⚠️ 零监听：pid 锁是陈旧的（进程 $pid 不存在），跳过端口检查"
  fi
else
  echo "⚠️ 零监听：没有 pid 锁，进程未运行；跳过端口检查"
fi

exit "$status"