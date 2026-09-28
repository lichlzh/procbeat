// 测试用：往数据目录写入合成历史，用来验证 24h 原始 / 7d 聚合两条查询路径，
// 不必真等一天。生产数据请指到别的目录，别污染 data/。
//   MONITOR_DATA_DIR=./data-seed node seed.js
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.MONITOR_DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const RAW = path.join(DIR, 'raw');
const AGG = path.join(DIR, 'agg');
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(AGG, { recursive: true });

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const now = Date.now();
const dayKey = (ms) => new Date(ms + 8 * HOUR).toISOString().slice(0, 10);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// 白天高、夜里低的正弦 + 噪声，内存带一点泄漏锯齿，磁盘缓慢上涨。
function at(t) {
  const d = new Date(t + 8 * HOUR);
  const hourOfDay = d.getUTCHours() + d.getUTCMinutes() / 60;
  const wave = Math.max(0, Math.sin(((hourOfDay - 6) / 24) * Math.PI * 2));
  const spike = rnd() > 0.985 ? 45 : 0;
  const cpu = round(6 + wave * 28 + spike + rnd() * 8, 1);
  const age = (now - t) / DAY;
  const memUsed = Math.round((0.55 + age * 0.12 + wave * 0.06 + rnd() * 0.05) * 1647536 * 1024);
  const memTotal = 1647536 * 1024;
  return {
    cpu,
    cores: [round(cpu + rnd() * 6 - 3, 1), round(cpu + rnd() * 6 - 3, 1)],
    mu: Math.min(memUsed, memTotal - 40 * 1048576),
    ma: memTotal - Math.min(memUsed, memTotal - 40 * 1048576),
    mt: memTotal,
    l: [round(cpu / 40 + wave, 2), round(cpu / 45 + wave * .8, 2), round(cpu / 50 + wave * .7, 2)],
    dp: round(14 + age * 0.9, 1),
    du: Math.round((14 + age * 0.9) / 100 * 39.9 * 1073741824),
    da: Math.round((100 - (14 + age * 0.9)) / 100 * 39.9 * 1073741824),
    dt: Math.round(39.9 * 1073741824),
    ri: round(rnd() > 0.9 ? rnd() * 12 : rnd() * 0.4, 2),
    wi: round(rnd() > 0.85 ? rnd() * 8 : rnd() * 0.6, 2),
    iops: round(rnd() * 60, 1),
  };
}

const raw = new Map(), agg = new Map();
const put = (map, t, line) => {
  const k = dayKey(t);
  if (!map.has(k)) map.set(k, '');
  map.set(k, map.get(k) + line + '\n');
};

let nRaw = 0, nAgg = 0;
for (let t = now - DAY; t <= now; t += 5000) {
  const v = at(t);
  put(raw, t, JSON.stringify({ t, ...v }));
  nRaw++;
}
// 真实系统里聚合是持续写的，最近 24h 同时存在 raw 与 agg，种子数据要照这个形状来。
for (let t = now - DAY * 8; t <= now; t += MIN) {
  const v = at(t);
  put(agg, t, JSON.stringify({
    t, n: 12,
    cpu: v.cpu, cpuMax: round(v.cpu + rnd() * 20, 2),
    mu: v.mu, muMax: Math.round(v.mu * 1.1), ma: v.ma, mt: v.mt,
    l: v.l, dp: v.dp, du: v.du, da: v.da, dt: v.dt,
    ri: v.ri, wi: v.wi, iops: v.iops,
  }));
  nAgg++;
}
for (const [dir, map] of [[RAW, raw], [AGG, agg]]) {
  for (const [day, body] of map) fs.writeFileSync(path.join(dir, `${day}.jsonl`), body);
}
console.log(`已写入 raw ${nRaw} 行 / agg ${nAgg} 行 -> ${DIR}`);
