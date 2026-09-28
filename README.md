# ProcBeat

**一台机器的心跳，手机打开就看。** CPU / 内存 / 负载 / 磁盘的实时值与 7 天历史。

零依赖：后端只用 Node 标准库读 `/proc`，前端是手写 Canvas 折线图，
**不需要 npm install，也没有构建步骤**。这么选是因为最初那台机器只有 2 核 / 1.6G 内存、
可用约 620M，跑不起一套打包工具链——结果就是它在一台 1.6G 的小机器上只占 43 MB。

名字来自它的全部设计约束：`/proc` 是唯一数据源，`beat` 是它唯一的节奏（5 秒一次）。

> **关于名字**：仓库叫 ProcBeat，但**线上产物仍叫 monitor**——目录 `workspace/monitor`、
> systemd unit `monitor.service`、nginx 片段 `snippets/servers/monitor.conf`、URL 前缀 `/monitor/`。
> 这是刻意的：`/monitor/` 这个路径给人看的语义比品牌名重要，而改名等于重跑一次 nginx 接入流程，
> 收益不抵风险。下文所有 `monitor.*` 文件名与 `/monitor/` 路径都指线上那套。

> **文中的地址与路径是作者本机的部署实例。** `<你的公网IP>`、`<你的内网IP>` 是占位符，
> `/home/admin/workspace/monitor` 是我的实际目录——换成你自己的即可。真实 IP 不会出现在这个仓库里，
> 因为面板**没有鉴权**（见「已知限制」）。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/用户手册.md`](docs/用户手册.md) | 网址、界面怎么读、阈值含义、排查场景、FAQ、运维修令 |
| [`docs/技术方案.md`](docs/技术方案.md) | 环境实测约束、每个指标的口径与依据、存储/抽稀设计、取舍日志、验证结果 |
| 本文件 | 目录结构、启动命令、当前部署状态、API 与字段速查 |

排查问题的顺序通常是：先 `./monitor.sh status`，再 `docs/用户手册.md` §6 常见问题，
最后才是 `docs/技术方案.md` §10 看某个数字"本该是多少"。

`docs/` 不在 `public/` 下，因此**不会通过 nginx 暴露**——服务只读 `public/` 里
白名单后缀的真实文件。技术方案里有机器规格与部署细节，本来也不该被公网摸到。

## 目录

```
server.js         定时采样 -> 落盘 + 内存留最新一份；对外只提供 /api/* 和 public/
sampler.js        读 /proc/stat、meminfo、loadavg、diskstats 与 statfs
store.js          JSONL 落盘、每分钟聚合、7 天淘汰、抽稀查询
selftest.js       采集算法自检（合成 /proc 夹具，不需要压机器）
seed.js           生成 7 天合成历史，供验证查询路径用
monitor.sh        install|start|stop|restart|status|logs|selftest
monitor.service   systemd unit
deploy/           nginx 反代片段与上线脚本
docs/             技术方案、用户手册
public/           index.html / app.js / style.css / manifest / icon
data/             raw/ 5 秒原始点，agg/ 1 分钟聚合
```

## 启动

```bash
./monitor.sh start      # 没装 unit 时用 nohup 起，PID 记在 .monitor.pid
./monitor.sh install    # 装成 systemd 服务并开机自启（需要 sudo）
./monitor.sh status     # 运行状态 + 最新指标 + 数据目录占用
./monitor.sh selftest   # 12 项采集算法自检
```

第一次采样只能建立差值基准，所以启动后约 5 秒内 `/api/current` 会返回 `{"error":"warming up"}`。

### 当前部署状态（2026-09-28）

- systemd：`monitor.service` 已安装并 `enable`，`Restart=always`、`MemoryMax=200M`、
  `ProtectSystem=full`，实测 RSS ≈ 43MB。
- nginx：drop-in 片段已装在 `/etc/nginx/snippets/servers/monitor.conf`，由站点配置里的
  通配 `include /etc/nginx/snippets/servers/*.conf;` 收进来。站点仓库的模板
  `deploy/nginx-site.conf` 已常驻这一行，所以它每次发布覆盖线上配置也不会弄丢 `/monitor/`，
  monitor 侧也不再需要改别的仓库。reload 后 7 项自检全过。
- 回滚点：接入过程中产生的 4 份备份（`default.bak-monitor-*`、`default.bak-dropin-*`、
  `default.pre-dropin-test.bak`、`snippets/monitor.conf.removed-*`）面板已稳定运行、
  7 项自检全绿，于 2026-09-28 删除。`/etc/nginx` 下现存配置经 `nginx -t` 复验通过。
  注意 `sites-available/default.pre-deploy.bak` **不是**本项目的产物，它是站点仓库
  自己每次发布写的回滚点，别替它清理。

上线时的验证矩阵（12 项算法自检、与 `free`/`df`/`loadavg` 对表、抽稀边界、重启去重、
淘汰边界、nginx 7 项断言）与**未验证项**记录在 `docs/技术方案.md` §10。

## 以后新增别的项目怎么办

`/monitor/` 这条路由不属于任何项目，它住在 `/etc/nginx/snippets/servers/monitor.conf` 里，
由站点配置的一行通配 include 收进来：

```nginx
include /etc/nginx/snippets/servers/*.conf;
```

- 新项目**复用**这台机器 80 端口的 default server（现在的模式）：只要它的配置模板
  （或它自己）带了上面那行通配 include，跑一次 `sudo bash deploy/nginx-apply.sh`
  放好片段就够了——本脚本不再改线上配置，也不再改任何其他仓库的模板。
- 新项目有**自己独立的 server / 端口**：在它自己的 server 块里加那行通配 include，
  monitor 侧零改动。
- 唯一不要做的事：把那段 location 复制粘贴进多个项目模板。片段只有一份，改一处生效。
- 通配 include 的目录空着、甚至整个不存在，都能通过 `nginx -t`（本机用独立配置实测过
  这两种情况），所以站点模板里那一行可以永久常驻，不必为「有没有装 monitor」做条件判断。

三条硬约束，违反其中任何一条都会出事：

1. **片段里的 location 必须写 `^~`**。否则 `/monitor/app.js` 会被站点的静态后缀兜底正则
   抢走，404、面板白屏。
2. **有了通配 include 就别再点名 include 同一个文件**。收两次会得到两条
   `location ^~ /monitor/`，`nginx -t` 直接失败——连累整台 nginx。
   `nginx-apply.sh` 会检查这种组合并拒绝安装。
3. **别手工往 `servers/` 里丢文件**。这个目录是所有服务共用 nginx 的入口，
   谁落下一个语法错的片段，全站（包括站点仓库）都起不来。
   一律走 `nginx-apply.sh`：写文件 → `nginx -t` → 失败回滚 → reload。
   片段属主固定为 `root:root 644`，避免免 sudo 就能改写这台机器的路由。
4. **改片段会连带影响别家的发布预检**。站点仓库的 `deploy.sh` 在发布前会把它自己的
   模板 include 进一个临时配置做语法检查，而那模板里的通配 include 会把整个 `servers/`
   收进去——monitor 的片段写坏，别人家 `deploy.sh` 就红。所以只改仓库里的
   `deploy/monitor-snippet.conf` 再跑 apply，**不要直接编辑线上那份**。

> **别裸跑 `node server.js`。** 这台机器登录 shell 导出的 `NODE_OPTIONS` 含
> `--use-system-ca`，本机 node 不认，连 `node -e ''` 都会失败；而且里面的
> `--max-old-space-size=8192` 在 1.6G 的机器上是有害的。`monitor.sh` 与 systemd unit
> 都会把它覆盖成 `--max-old-space-size=96`。

## 访问

服务只监听 `127.0.0.1:3000`，对外靠已有的 nginx：

```
手机 -> http://<服务器IP>/monitor/ -> nginx:80 -> 127.0.0.1:3000
```

本机实测地址形式：公网 `http://<你的公网IP>/monitor/`、同 VPC 内网
`http://<你的内网IP>/monitor/`、机器本地 `http://127.0.0.1:3000/`。末尾斜杠别丢
（详见 `docs/用户手册.md` §1）。

> ⚠️ **公开仓库里不放真实地址**。本项目的面板**没有鉴权**（`docs/用户手册.md` §8 有说明），
> 把可达 URL 写进 README 等于把一台无鉴权机器的实时负载曲线交给所有读到 repo 的人。
> 自己部署时把上面的占位符换成实际地址，别提交回去。

接入方式见 `deploy/nginx-apply.sh`（幂等；`nginx -t` 校验、失败回滚、reload 后自检）。
它只做一件事：把 `deploy/monitor-snippet.conf` 装到 `/etc/nginx/snippets/servers/monitor.conf`。

之所以做成 drop-in 目录，而不是直接把 location 写进站点文件、也不是由本脚本去改站点文件：
站点仓库的 `deploy.sh` 每次发布都会用自己的模板整体覆盖
`/etc/nginx/sites-available/default`，写进去的改动下次发布就没了。早年的做法是让
`nginx-apply.sh` 一次改两处（线上配置 +站点仓库的模板），但那等于两个仓库互相
改写对方的文件——站点仓库更新一次模板就可能顺手删掉那行 include。现在模板里常驻
一行通配 include，两边彻底解耦：站点仓库不需要知道 monitor 存在，monitor 也不需要
知道站点仓库存在。

片段里的 location 必须写 `^~`，原因见 `deploy/monitor-snippet.conf` 头部注释
（站点有一条静态后缀兜底正则，普通前缀会被它抢走）。

不共用 80 端口 default server 的项目，也可以让它自己 `proxy_pass` 到 `127.0.0.1:3000`——
Node 侧不需要任何改动。真正要避免的是把 `/monitor/` 的 location 抄进多个项目模板：
那份片段是唯一事实来源，改一处即可。

临时不看面板可以只走本机：`curl http://127.0.0.1:3000/api/current`。

## API

| 接口 | 说明 |
|---|---|
| `GET /api/current` | 最新一次采样。含 `span`（本次 cpu/io 覆盖的毫秒窗口） |
| `GET /api/history?range=1h\|6h\|24h\|7d&metric=cpu\|mem\|load\|disk\|io` | 历史曲线，已按窗口抽稀 |

响应示例：

```json
{ "metric": "cpu", "range": "7d", "step": 3600, "source": "agg",
  "series": [ { "name": "CPU", "unit": "%", "points": [[1790000000000, 12.5], ...] } ] }
```

每条序列最多 240 个点（手机宽度约 400px，再密也看不出来），所以最大的一档响应约 10KB。

## 数据与口径

- 每 5 秒采样一次，原始点写 `data/raw/YYYY-MM-DD.jsonl`，跨分钟折叠成 1 分钟均值+峰值写 `data/agg/`。
- 原始只留今天+昨天，聚合留 7 天。实测行均 205 B / 236 B，稳态占用约 **10 MB**
  （2 个原始日文件 ≈7 MB + 8 个聚合日文件 ≈2.7 MB）。进程 RSS 约 **36–45 MB**
  （cgroup `memory.current` 约 13 MB，两者口径不同），`MemoryMax=200M` 兜底。
- **只有 `range=1h` 走原始点**（每核曲线需要 5 秒粒度），`6h/24h/7d` 一律走聚合。
  抽稀步长与实测点数见 `docs/技术方案.md` §6。
- 字段压缩过：`t` 时间戳、`cpu` 占用%、`cores` 每核、`mu/ma/mt` 内存已用/可用/总量、
  `l` 1/5/15 分钟负载、`dp/du/da/dt` 磁盘使用率/已用/可用/总量、`ri/wi/iops` 磁盘读写。
  完整字典与聚合规则见 `docs/技术方案.md` §5。

几个刻意的选择，跟常见的错觉对不上时先看这里：

- **内存已用 = MemTotal − MemAvailable**，比 `free` 显示的 `used` 大。`free` 的 used 把可回收
  的页缓存算在 buff/cache 里，而那部分其实随时能让给进程；`total - available` 才是"真的占着"。
- **磁盘与 `df` 同口径**：已用按 `blocks - bfree`，剩余按 `bavail`，所以 root 预留块不会被算进
  "已用"。`df` 的百分比向上取整，这里保留一位小数（`df` 显示 17% 时这里是 16.6%）。
- **steal 计入忙碌**。虚拟机上被宿主拿走的时间本机无法干预，但确实是用户感受到的不可用。
  所以极端情况下这个数字会比 `top` 的 `%used` 略高。
- **guest/guest_nice 不参与求和**，内核已把它们并入 user/nice，再加一次会算出超过 100% 的值。
- **磁盘 IO 取整盘设备**（`vda`）而不是分区（`vda3`），分区数据是整盘的子集，取分区会重复计数。
- `iowait` 记为空闲、`steal` 记为忙碌，`selftest.js` 里这两种情形都有断言。

## 前端

- 首屏 4 张数字卡片（CPU / 内存 / 负载 / 磁盘），下面是图表。
- 卡片每 5 秒刷新；历史曲线每 30 秒刷新一次（每 6 次轮询），切时间范围时立刻刷。
  一次全刷要扫 5 个指标的日志文件，在 2 核机器上跟着 5 秒轮询跑纯属浪费。
- 手机切到后台就停轮询，回来立刻补一次。
- 深色模式跟随系统 `prefers-color-scheme`，切换时会重绘图表配色。
- `manifest.webmanifest` 支持加到主屏。**没有 service worker**——缓存型 SW 一旦上线很难
  在手机上清掉，这个面板本来也不需要离线。

## 已知限制

- 无鉴权。面板只反映这台机器的状态，但 CPU/内存曲线本身也是信息，
  公网 80 端口开放就意味着知道 URL 的人都能看。需要的话得自己加 Basic Auth 或 IP 限制。
- 没有温度：`/sys/class/thermal/` 下只有 `cooling_device*`，没有 `thermal_zone*`。
- 无网络流量、进程排行、服务存活——这几项在需求确认时明确排除了。
- 采样窗口 = 定时器间隔。事件循环被拖长时窗口跟着变宽，`/api/current` 的 `span` 会如实反映，
  此时读数是较长一段时间的平均值。
