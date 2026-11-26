#!/bin/sh
# 项目统一入口。后台进程、PID 校验和健康检查由现有 Node 管理器负责。
set -eu

project_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
cd "$project_dir"

usage() {
  cat <<'USAGE'
用法：./manage.sh <命令>

  start          后台启动；缺少构建产物时先构建
  stop           安全停止服务，等待进程退出
  exit           同 stop
  restart        安全停止后重新启动
  status         检查进程、监听端口及健康状态
  build          构建前端和后端，不启动服务
  logs           查看最近 100 行日志
  logs --follow  持续查看日志（Ctrl+C 仅退出日志查看）
  help           显示本帮助

首次使用请先执行 npm ci，并配置本机 .env。
USAGE
}

fail() { printf '%s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "缺少 $1，请先安装后重试。"; }
require_node24() {
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" = 24 ] || fail '启动和构建需要 Node 24，请切换版本后重试。'
}
run_build() {
  require_command npm
  [ -d node_modules ] || fail '尚未安装依赖，请先在项目根目录执行 npm ci。'
  npm run build
}
ensure_build() {
  if [ ! -f dist/server/server/index.js ] || [ ! -f dist/client/index.html ]; then
    printf '%s\n' '缺少构建产物，正在构建项目…'
    run_build
  fi
}

action=${1:-help}
if [ "$#" -gt 0 ]; then shift; fi
case "$action" in
  logs)
    [ "$#" -le 1 ] || fail '用法：./manage.sh logs [--follow]'
    follow=${1:-}
    case "$follow" in ''|-f|--follow) ;; *) fail '用法：./manage.sh logs [--follow]' ;; esac
    set --
    for file in .runtime/stdout.log .runtime/stderr.log; do
      if [ -f "$file" ]; then set -- "$@" "$file"; fi
    done
    if [ "$#" -eq 0 ]; then printf '%s\n' '暂无服务日志。'; exit 0; fi
    if [ -n "$follow" ]; then exec tail -n 100 -F "$@"; fi
    exec tail -n 100 "$@"
    ;;
  help|-h|--help)
    [ "$#" -eq 0 ] || fail 'help 不接受额外参数。'
    usage
    exit 0
    ;;
  start|stop|exit|restart|status|build)
    [ "$#" -eq 0 ] || fail '此命令不接受额外参数，请执行 ./manage.sh help 查看用法。'
    ;;
  *) usage >&2; exit 2 ;;
esac

require_command node
case "$action" in
  start|restart)
    require_node24
    require_command ps
    require_command lsof
    # 构建成功后才执行 restart，避免构建失败时先停止现有服务。
    ensure_build
    exec node "$project_dir/scripts/service.mjs" "$action"
    ;;
  stop|exit|status)
    require_command ps
    require_command lsof
    if [ "$action" = exit ]; then action=stop; fi
    exec node "$project_dir/scripts/service.mjs" "$action"
    ;;
  build)
    require_node24
    run_build
    ;;
esac
