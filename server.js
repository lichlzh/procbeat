// 入口：定时采样 -> 落盘 + 内存里留最新一份；对外只提供 /api/* 和 public/ 静态文件。
// 注意：本机登录 shell 的 NODE_OPTIONS 含 --use-system-ca，会让 node 直接拒绝启动，
// 所以请通过 monitor.sh / systemd 启动（它们负责改写 NODE_OPTIONS），别裸跑 node server.js。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sampler } from './sampler.js';
import { Store, RANGES } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.MONITOR_HOST || '127.0.0.1';
const PORT = Number(process.env.MONITOR_PORT || 3000);
const INTERVAL = Math.max(1000, Number(process.env.MONITOR_INTERVAL || 5000));
const DATA_DIR = process.env.MONITOR_DATA_DIR || path.join(HERE, 'data');
const PUBLIC_DIR = path.join(HERE, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const sampler = new Sampler();
const store = new Store({ dataDir: DATA_DIR });
let latest = null;
let lastTick = Date.now();
const startedAt = Date.now();

function tick() {
  const now = Date.now();
  const span = now - lastTick;
  lastTick = now;
  let s;
  try {
    s = sampler.sample(span);
  } catch (err) {
    // /proc 读取理论上不会失败，但一次异常不该把服务带走。
    console.error(`采样失败: ${err.message}`);
    return;
  }
  if (!s.cpu) return; // 第一次采样只有基准，没有差值
  // span 一并给出：cpu/io 是这个窗口的平均，窗口被事件循环拖长时能看得出来。
  latest = { ...s, span };
  try {
    store.append(s);
  } catch (err) {
    console.error(`写入失败: ${err.message}`);
  }
}

function safePrune() {
  try {
    store.prune();
  } catch (err) {
    console.error(`淘汰失败: ${err.message}`);
  }
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  // 只允许 public/ 内的真实文件，且后缀在白名单里。
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  const ext = path.extname(file).toLowerCase();
  if (!TYPES[ext]) return sendJson(res, 404, { error: 'not found' });
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  const type = TYPES[ext];
  send(res, 200, data, { 'Content-Type': type });
}

// 顶层必须兜住任何抛出：畸形 Host（例如 `Host: a:99999`）会让 new URL 同步抛错，
// 没接住就是未捕获异常、整个进程退出，监控本身也就没了。
const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    console.error(`请求处理异常 ${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.end();
  }
});

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  const host = typeof req.headers.host === 'string' && /^[\w.-]+(:\d{1,5})?$/.test(req.headers.host)
    ? req.headers.host
    : '127.0.0.1';
  const url = new URL(req.url, `http://${host}`);
  const p = url.pathname;

  if (p === '/api/current') {
    if (!latest) return sendJson(res, 503, { error: 'warming up', interval: INTERVAL });
    return sendJson(res, 200, { ...latest, uptime: Math.round((Date.now() - startedAt) / 1000), interval: INTERVAL });
  }

  if (p === '/api/history') {
    const range = url.searchParams.get('range') || '1h';
    const metric = url.searchParams.get('metric') || 'cpu';
    if (!RANGES[range]) return sendJson(res, 400, { error: `range must be one of ${Object.keys(RANGES).join('|')}` });
    const out = store.history(metric, range);
    if (!out.series.length) return sendJson(res, 200, { ...out, empty: true });
    return sendJson(res, 200, out);
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
  return serveStatic(p, res);
}

tick();
const timer = setInterval(tick, INTERVAL);
const pruner = setInterval(safePrune, 6 * 3600000);
safePrune();

function shutdown(signal) {
  clearInterval(timer);
  clearInterval(pruner);
  try {
    store.flush();
  } catch (err) {
    console.error(`聚合落盘失败: ${err.message}`);
  }
  server.close(() => process.exit(0));
  console.log(`收到 ${signal}，已退出`);
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  console.log(`monitor 监听 http://${HOST}:${PORT} 间隔=${INTERVAL}ms 数据目录=${DATA_DIR}`);
});
