#!/bin/sh

set -eu

APP_DIR=$(
  CDPATH= cd -- "$(dirname -- "$0")"
  pwd
)

PID_DIR="$APP_DIR/data/run"
LOG_DIR="$APP_DIR/data/logs"
PID_FILE="$PID_DIR/chatdrop.pid"
LOG_FILE="$LOG_DIR/chatdrop.log"
CONFIG_FILE="$APP_DIR/config.yaml"
DEFAULT_CONFIG_FILE="$APP_DIR/config-default.yaml"

ensure_dirs() {
  mkdir -p "$PID_DIR" "$LOG_DIR"
}

ensure_config() {
  if [ -f "$CONFIG_FILE" ]; then
    return
  fi

  if [ -f "$DEFAULT_CONFIG_FILE" ]; then
    cp "$DEFAULT_CONFIG_FILE" "$CONFIG_FILE"
    printf '%s\n' "config.yaml 不存在，已从 config-default.yaml 复制一份。"
    return
  fi

  printf '%s\n' "缺少 config.yaml 和 config-default.yaml，无法启动。" >&2
  exit 1
}

read_port() {
  if [ -f "$CONFIG_FILE" ]; then
    port=$(
      sed -n 's/^[[:space:]]*port:[[:space:]]*//p' "$CONFIG_FILE" |
        head -n 1 |
        tr -d '"[:space:]'
    )
    if [ -n "$port" ]; then
      printf '%s\n' "$port"
      return
    fi
  fi

  printf '%s\n' "3000"
}

port_pid() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

command_for_pid() {
  ps -p "$1" -o command= 2>/dev/null || true
}

is_chatdrop_pid() {
  pid="$1"
  cmd=$(command_for_pid "$pid")
  if [ -z "$cmd" ]; then
    return 1
  fi

  printf '%s\n' "$cmd" | grep -q 'src/server.js'
}

find_running_pid() {
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && is_chatdrop_pid "$pid"; then
      printf '%s\n' "$pid"
      return 0
    fi
  fi

  pid=$(port_pid "$PORT")
  if [ -n "$pid" ] && is_chatdrop_pid "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi

  return 1
}

cleanup_stale_pid_file() {
  if [ -f "$PID_FILE" ] && ! find_running_pid >/dev/null 2>&1; then
    rm -f "$PID_FILE"
  fi
}

start_service() {
  ensure_dirs
  ensure_config
  cleanup_stale_pid_file

  if pid=$(find_running_pid); then
    printf '%s\n' "ChatDrop 已在运行，PID: $pid"
    printf '%s\n' "$pid" >"$PID_FILE"
    return
  fi

  occupied_pid=$(port_pid "$PORT")
  if [ -n "$occupied_pid" ]; then
    printf '%s\n' "端口 $PORT 已被其他进程占用，PID: $occupied_pid" >&2
    exit 1
  fi

  (
    cd "$APP_DIR"
    exec nohup node src/server.js >>"$LOG_FILE" 2>&1 </dev/null
  ) &
  echo $! >"$PID_FILE"

  sleep 1
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "ChatDrop 已启动，PID: $pid"
    printf '%s\n' "日志: $LOG_FILE"
    return
  fi

  printf '%s\n' "ChatDrop 启动失败，请检查日志: $LOG_FILE" >&2
  exit 1
}

stop_service() {
  cleanup_stale_pid_file

  if ! pid=$(find_running_pid); then
    rm -f "$PID_FILE"
    printf '%s\n' "ChatDrop 当前未运行"
    return
  fi

  kill "$pid" 2>/dev/null || true

  count=0
  while kill -0 "$pid" 2>/dev/null; do
    count=$((count + 1))
    if [ "$count" -ge 20 ]; then
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
  done

  rm -f "$PID_FILE"
  printf '%s\n' "ChatDrop 已停止，PID: $pid"
}

status_service() {
  cleanup_stale_pid_file

  if pid=$(find_running_pid); then
    printf '%s\n' "ChatDrop 正在运行，PID: ${pid}，端口: ${PORT}"
    return
  fi

  printf '%s\n' "ChatDrop 当前未运行"
}

logs_service() {
  ensure_dirs
  touch "$LOG_FILE"
  tail -f "$LOG_FILE"
}

usage() {
  cat <<EOF
用法:
  ./chatdrop.sh start
  ./chatdrop.sh stop
  ./chatdrop.sh restart
  ./chatdrop.sh status
  ./chatdrop.sh logs
EOF
}

ensure_dirs
ensure_config
PORT=$(read_port)

case "${1:-}" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    status_service
    ;;
  logs)
    logs_service
    ;;
  *)
    usage
    exit 1
    ;;
esac
