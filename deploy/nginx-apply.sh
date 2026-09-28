#!/bin/bash
# 把 /monitor/ 反代接进现有 nginx 站点。
#
# drop-in 方式：本脚本只往 /etc/nginx/snippets/servers/ 里放自己的片段文件，
# 站点配置那边用一行泛化包含把它收进来：
#   include /etc/nginx/snippets/servers/*.conf;
#
# 以前这个脚本会去改两处别人的文件 —— 线上的 /etc/nginx/sites-available/default，
# 以及站点仓库里的模板 deploy/nginx-site.conf —— 因为站点仓库的
# deploy.sh 每次发布都用模板整体覆盖线上配置，只改线上就会被下次部署抹掉。那等于把
# 两个仓库耦在一起：monitor 的一次执行会改写另一个仓库受版本控制的文件，反过来那个
# 仓库每次更新模板也可能顺手删掉这行 include。现在模板里常驻一行通配包含（实测目录空着
# 或不存在都能通过 nginx -t），本脚本就再也不需要知道别的仓库存在。
#
# 片段里的 location 必须写 ^~，理由见 monitor-snippet.conf 头部注释。
#
#   sudo bash deploy/nginx-apply.sh
# 想先看效果：DRY=1 bash deploy/nginx-apply.sh

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNIPPET_SRC="$DIR/deploy/monitor-snippet.conf"
SNIPPET_DIR="/etc/nginx/snippets/servers"
SNIPPET_DST="$SNIPPET_DIR/monitor.conf"
# 只读检查：确认某个站点确实会收进 drop-in 片段。改由站点自己的部署负责，本脚本不写。
SITE="${SITE:-/etc/nginx/sites-available/default}"
GLOB_INCLUDE='include /etc/nginx/snippets/servers/*.conf;'
BACKUP=""
SUDO=""
[[ $EUID -eq 0 ]] || SUDO="sudo"

[[ -f "$SNIPPET_SRC" ]] || { echo "缺少 $SNIPPET_SRC" >&2; exit 1; }

# ── 先做只读前置检查，任何一条不过都不写盘 ──────────────────────────────
# 顺序有讲究：以前是先装片段再检查站点，结果站点不含通配包含时会在
# /etc/nginx/snippets/servers/ 里留下一个没人 include 的孤儿文件，而脚本已经退出了。
if [[ ! -r "$SITE" ]]; then
  echo "读不到站点配置 $SITE，无法确认它会收进 drop-in 片段" >&2
  exit 1
fi
if ! $SUDO grep -qF "$GLOB_INCLUDE" "$SITE" 2>/dev/null; then
  echo "⚠ 线上 $SITE 里没有「$GLOB_INCLUDE」，片段不会被加载。" >&2
  echo "  这行应由站点仓库的模板自带（站点仓库/deploy/nginx-site.conf），" >&2
  echo "  跑它的 deploy.sh 即可；本脚本不替别人改站点配置。" >&2
  exit 1
fi
# 通配包含已经收进这个文件了，再点名 include 一次会得到两条 location ^~ /monitor/，
# nginx -t 直接失败。历史布局残留最容易踩这个。
if $SUDO grep -qF "include $SNIPPET_DST;" "$SITE" 2>/dev/null; then
  echo "⚠ $SITE 同时对 $SNIPPET_DST 既有通配包含又有点名包含，会得到重复的 location。" >&2
  echo "  请删掉那行点名 include（通配那行负责收进来）。" >&2
  exit 1
fi

if [[ -f "$SNIPPET_DST" ]] && cmp -s "$SNIPPET_SRC" "$SNIPPET_DST"; then
  echo "片段已是最新：$SNIPPET_DST"
else
  echo "--- 将安装 $SNIPPET_SRC -> $SNIPPET_DST ---"
  diff -u "$SNIPPET_DST" "$SNIPPET_SRC" 2>/dev/null || true
fi

if [[ -n "$DRY" ]]; then
  echo "DRY=1，未做任何改动"
  exit 0
fi

$SUDO mkdir -p "$SNIPPET_DIR"
$SUDO cp "$SNIPPET_SRC" "$SNIPPET_DST"
# 属主定成 root：这个目录是所有服务往 nginx 里塞 location 的公共入口，
# 谁都能免 sudo 改，就等于谁能改写这台机器的路由。
$SUDO chown root:root "$SNIPPET_DST"
$SUDO chmod 644 "$SNIPPET_DST"

# 老布局的残留。它以前被站点配置点名 include，换成通配 include 后就是孤儿文件；
# 留着会让"到底哪份在生效"变成猜谜，所以挪走备份。
if [[ -f /etc/nginx/snippets/monitor.conf ]]; then
  BACKUP="/etc/nginx/snippets/monitor.conf.removed-$(date +%Y%m%d-%H%M%S)"
  echo ">>> 发现旧布局残留 /etc/nginx/snippets/monitor.conf，移到 $BACKUP"
  $SUDO mv /etc/nginx/snippets/monitor.conf "$BACKUP"
fi

if ! $SUDO nginx -t; then
  echo "nginx -t 失败，回滚片段" >&2
  if [[ -n "$BACKUP" ]]; then
    $SUDO rm -f "$SNIPPET_DST"
    $SUDO mv "$BACKUP" /etc/nginx/snippets/monitor.conf
  else
    $SUDO rm -f "$SNIPPET_DST"
  fi
  exit 1
fi

$SUDO systemctl reload nginx 2>/dev/null || $SUDO nginx -s reload
echo ">>> 已 reload，开始自检"

fail=0
# reload 之后旧 worker 还会把手头连接答完，紧接着自检有概率读到旧配置
# （站点仓库的 deploy.sh 踩过同样的坑，靠 __deploy_probe__ 规避）。
# 这里等不到就重试，最多 5 秒。
check() {
  local label="$1" expect="$2" actual="" i
  shift 2
  for i in 1 2 3 4 5 6 7 8 9 10; do
    actual="$("$@")"
    [[ "$actual" == "$expect" ]] && break
    sleep 0.5
  done
  if [[ "$actual" == "$expect" ]]; then echo "  ok   $label ($actual)"; else echo "  FAIL $label: 期望 $expect，实际 $actual" >&2; fail=1; fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }

check "301 /monitor"        "301" code http://127.0.0.1/monitor
check "200 /monitor/"       "200" code http://127.0.0.1/monitor/
check "200 /monitor/app.js" "200" code http://127.0.0.1/monitor/app.js
# app.js 必须仍是 JS。返回 HTML 就说明被 SPA 兜底接管了，面板会白屏。
check "app.js 类型" "text/javascript; charset=utf-8" \
  curl -s -o /dev/null -w '%{content_type}' http://127.0.0.1/monitor/app.js
check "反代 API"            "200" code http://127.0.0.1/monitor/api/current
# 站点原有的 SPA 兜底不能被 include 打坏
check "站点仓库首页" "200" code http://127.0.0.1/
check "站点仓库缺失资源仍 404" "404" code http://127.0.0.1/no-such-file.js

[[ $fail -eq 0 ]] && echo "✅ 手机可访问 http://<服务器IP>/monitor/"
exit $fail
