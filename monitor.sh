#!/bin/bash
# 监控服务管理脚本
# 用法: ./monitor.sh {install|start|stop|restart|status|logs|selftest}
#
# 装了 systemd unit 就走 systemctl；没装则退化成 nohup + pidfile，方便先试跑再正式接管。

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT=monitor
UNIT_FILE="/etc/systemd/system/${UNIT}.service"
PID_FILE="$DIR/.monitor.pid"
LOG_FILE="$DIR/data/monitor.log"
PORT="${MONITOR_PORT:-3000}"
# 登录 shell 的 NODE_OPTIONS 里有本机 node 不认的 --use-system-ca，
# 且 --max-old-space-size=8192 会把 1.6G 的机器拖爆，这里统一改成 96M。
export NODE_OPTIONS="--max-old-space-size=96"

die() { echo "错误: $1" >&2; exit 1; }

usage() {
    echo "用法: $0 {install|start|stop|restart|status|logs|selftest}"
    echo ""
    echo "  install   - 安装 systemd unit 并设为开机自启（需要 sudo）"
    echo "  start     - 启动服务"
    echo "  stop      - 停止服务"
    echo "  restart   - 重启服务"
    echo "  status    - 查看运行状态与最新指标"
    echo "  logs      - 查看日志（logs -f 持续跟踪）"
    echo "  selftest  - 跑自检：采集算法 + 前端纵轴边界（都不需要压机器）"
    exit 1
}

have_unit() { [[ -f "$UNIT_FILE" ]]; }

running_pid() {
    [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null && cat "$PID_FILE"
}

start_nohup() {
    local pid
    pid=$(running_pid) && { echo "已在运行（pid $pid），无需重复启动"; return 0; } || true
    mkdir -p "$DIR/data"
    setsid nohup node "$DIR/server.js" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2
    running_pid >/dev/null || { tail -5 "$LOG_FILE" || true; die "启动失败，见 $LOG_FILE"; }
    echo ">>> 已启动（pid $(cat "$PID_FILE")，未接 systemd）"
}

stop_nohup() {
    local pid
    if pid=$(running_pid); then
        kill "$pid"
        echo ">>> 已停止（pid $pid）"
    else
        echo ">>> 没有在运行"
    fi
    rm -f "$PID_FILE"
}

show_status() {
    local pid resp
    if have_unit; then
        systemctl status "$UNIT" --no-pager -l | sed -n '1,10p'
    elif pid=$(running_pid); then
        echo "active (nohup, pid $pid, RSS $(ps -o rss= -p "$pid") KB)"
    else
        echo "inactive"
    fi
    echo ""
    echo "=== 最新指标 (127.0.0.1:$PORT) ==="
    resp=$(curl -s --max-time 3 "http://127.0.0.1:$PORT/api/current" || true)
    if [[ -z "$resp" ]]; then
        echo "（端口 $PORT 无响应）"
    else
        # 刚起来的几秒只会返回 warming up，别当成取到了 0。
        echo "$resp" | jq -c 'if .error then . else {time:(.t/1000|floor|localtime|strftime("%H:%M:%S")), cpu:.cpu.total, cores:.cpu.cores, used_MB:(.mem.used/1048576|floor), avail_MB:(.mem.avail/1048576|floor), load:.load, disk_pct:.disk.pct, io:.io} end'
    fi
    echo ""
    echo "数据目录 $(du -sh "$DIR/data" 2>/dev/null | cut -f1)（raw $(wc -l < "$DIR/data/raw/$(date +%F).jsonl" 2>/dev/null || echo 0) 行 / agg $(wc -l < "$DIR/data/agg/$(date +%F).jsonl" 2>/dev/null || echo 0) 行 今日）"
}

[[ -z "$1" ]] && usage

case "$1" in
  install)
    [[ -f "$DIR/monitor.service" ]] || die "缺少 $DIR/monitor.service"
    mkdir -p "$DIR/data"
    sudo cp "$DIR/monitor.service" "$UNIT_FILE"
    sudo systemctl daemon-reload
    # 试跑留下的 nohup 进程会占着端口，接管前先让位
    stop_nohup
    sudo systemctl enable --now "$UNIT"
    echo "✅ 已安装并启动，开机自启已开启"
    ;;

  start)
    if have_unit; then sudo systemctl start "$UNIT"; echo ">>> 已启动"; else start_nohup; fi
    ;;

  stop)
    if have_unit; then sudo systemctl stop "$UNIT"; echo ">>> 已停止"; else stop_nohup; fi
    ;;

  restart)
    if have_unit; then sudo systemctl restart "$UNIT"; echo ">>> 已重启"; else stop_nohup; start_nohup; fi
    ;;

  status)
    show_status
    ;;

  logs)
    if have_unit; then sudo journalctl -u "$UNIT" -n 60 --no-pager ${2:+-f}
    else tail -n 60 "$LOG_FILE" ${2:+-f}; fi
    ;;

  selftest)
    node "$DIR/selftest.js" && node "$DIR/axistest.js"
    ;;

  *)
    die "未知操作 '$1'"
    ;;
esac
