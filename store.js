// JSONL 存储：5 秒原始点按天分文件，整点折叠成 1 分钟聚合，各自按天数淘汰。
// 字段名刻意压短以减小体积，含义见 README。
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 86400000;
// 抽稀阶梯：每条序列最多 240 点（手机可见分辨率早已溢出），取不小于 window/240 的最小档。
const STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
export const RANGES = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };

// 查询时按桶求均值的字段；峰值字段单独取桶内最大。
const MEAN = ['cpu', 'mu', 'ma', 'dp'];
const PEAK = ['cpuMax', 'muMax'];
const MB = 1048576;

// 东八区日期，文件名与人的直觉对齐。
const dayKey = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// 只看行首的 t，避免为窗口外的行付一次 JSON.parse 的钱。
function fastTime(line) {
  if (!line.startsWith('{"t":')) return null;
  let i = 5, n = 0;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') { n = n * 10 + (line.charCodeAt(i) - 48); i++; }
  return i > 5 ? n : null;
}

export class Store {
  constructor({ dataDir, rawKeepDays = 1, aggKeepDays = 7 }) {
    this.dataDir = dataDir;
    this.rawDir = path.join(dataDir, 'raw');
    this.aggDir = path.join(dataDir, 'agg');
    this.rawKeepDays = rawKeepDays;
    this.aggKeepDays = aggKeepDays;
    fs.mkdirSync(this.rawDir, { recursive: true });
    fs.mkdirSync(this.aggDir, { recursive: true });
    this.minute = null;
    this.bucket = null;
    // 上次退出时已经写过的最后一分钟。重启后若又从同一分钟采样，直接聚合会写出
    // 第二条同 t 的记录，查询时挑到哪一条全看目录返回顺序。
    this.flushedUntil = this.lastAggTime();
  }

  lastAggTime() {
    try {
      const files = fs.readdirSync(this.aggDir).filter((f) => f.endsWith('.jsonl')).sort();
      const last = files[files.length - 1];
      if (!last) return -1;
      const lines = fs.readFileSync(path.join(this.aggDir, last), 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = fastTime(lines[i]);
        if (t !== null) return t;
      }
    } catch { /* 首次运行没有文件 */ }
    return -1;
  }

  append(s) {
    if (!s.cpu) return;
    const rec = {
      t: s.t,
      cpu: s.cpu.total,
      cores: s.cpu.cores,
      mu: s.mem.used, ma: s.mem.avail, mt: s.mem.total,
      l: s.load,
      dp: s.disk.pct, du: s.disk.used, da: s.disk.avail, dt: s.disk.total,
      ri: s.io ? s.io.rMBs : null,
      wi: s.io ? s.io.wMBs : null,
      iops: s.io ? s.io.iops : null,
    };
    // 单行远小于 4096B，对单写者是原子的：崩了最多丢一行。
    fs.appendFileSync(path.join(this.rawDir, `${dayKey(s.t)}.jsonl`), JSON.stringify(rec) + '\n');

    const m = Math.floor(s.t / 60000);
    if (m * 60000 <= this.flushedUntil) return; // 这一分钟的聚合已经落盘了

    if (this.minute === null) {
      this.minute = m;
      this.bucket = this.newBucket(m);
    } else if (m !== this.minute) {
      this.flush();
      this.minute = m;
      this.bucket = this.newBucket(m);
    }
    this.feed(s);
  }

  newBucket(m) {
    return { t: m * 60000, n: 0, ioN: 0, cpuSum: 0, cpuMax: 0, muSum: 0, muMax: 0 };
  }

  feed(s) {
    const b = this.bucket;
    b.n++;
    b.cpuSum += s.cpu.total;
    b.cpuMax = Math.max(b.cpuMax, s.cpu.total);
    b.muSum += s.mem.used;
    b.muMax = Math.max(b.muMax, s.mem.used);
    b.maMin = b.maMin === undefined ? s.mem.avail : Math.min(b.maMin, s.mem.avail);
    b.mt = s.mem.total;
    for (let i = 0; i < 3; i++) b['l' + i] = (b['l' + i] || 0) + s.load[i];
    b.dpSum = (b.dpSum || 0) + s.disk.pct;
    b.du = s.disk.used;
    b.da = s.disk.avail;
    b.dt = s.disk.total;
    // io 只在采样成功的 tick 上累加，除以总 tick 数会把速率摊薄。
    if (s.io) {
      b.ioN++;
      b.riSum = (b.riSum || 0) + s.io.rMBs;
      b.wiSum = (b.wiSum || 0) + s.io.wMBs;
      b.iopsSum = (b.iopsSum || 0) + s.io.iops;
    }
  }

  flush() {
    const b = this.bucket;
    this.bucket = null;
    this.minute = null;
    if (!b || b.n === 0) return;
    const io = b.ioN;
    const agg = {
      t: b.t, n: b.n,
      cpu: round(b.cpuSum / b.n), cpuMax: round(b.cpuMax),
      mu: Math.round(b.muSum / b.n), muMax: b.muMax, ma: b.maMin, mt: b.mt,
      l: [round(b.l0 / b.n, 3), round(b.l1 / b.n, 3), round(b.l2 / b.n, 3)],
      dp: round(b.dpSum / b.n), du: b.du, da: b.da, dt: b.dt,
      ri: io ? round(b.riSum / io, 3) : null,
      wi: io ? round(b.wiSum / io, 3) : null,
      iops: io ? round(b.iopsSum / io, 2) : null,
    };
    fs.appendFileSync(path.join(this.aggDir, `${dayKey(agg.t)}.jsonl`), JSON.stringify(agg) + '\n');
    this.flushedUntil = agg.t;
  }

  prune() {
    const cut = (dir, keepDays) => {
      const limit = dayKey(Date.now() - keepDays * DAY_MS);
      let removed = 0;
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return 0;
      }
      for (const f of names) {
        if (f.endsWith('.jsonl') && f.slice(0, 10) < limit) { fs.rmSync(path.join(dir, f)); removed++; }
      }
      return removed;
    };
    return { raw: cut(this.rawDir, this.rawKeepDays), agg: cut(this.aggDir, this.aggKeepDays) };
  }

  // 分块读，边读边解析，避免把几 MB 的整天文件变成一个大字符串。
  *lines(file) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(65536);
      let carry = '';
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        const chunk = carry + buf.toString('utf8', 0, n);
        const nl = chunk.lastIndexOf('\n');
        if (nl === -1) { carry = chunk; continue; }
        carry = chunk.slice(nl + 1);
        for (const line of chunk.slice(0, nl).split('\n')) if (line) yield line;
      }
      if (carry) yield carry;
    } finally {
      fs.closeSync(fd);
    }
  }

  // 只有 1h 用原始点（要每核曲线，也只有这个窗口需要 5 秒粒度），其余一律读聚合。
  // 桶内求均值而不是取最后一个：24 小时视图里 10 分钟取一个瞬时值会把尖峰整个抹掉。
  scan(from, to, stepMs, useAgg) {
    const dir = useAgg ? this.aggDir : this.rawDir;
    const fromDay = dayKey(from);
    const toDay = dayKey(to);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const buckets = new Map();
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      const day = f.slice(0, 10);
      if (day < fromDay || day > toDay) continue;
      for (const line of this.lines(path.join(dir, f))) {
        const hint = fastTime(line);
        if (hint !== null && (hint < from || hint > to)) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; } // 崩溃留下的半行，跳过
        if (typeof rec.t !== 'number' || rec.t < from || rec.t > to) continue;
        const key = Math.floor(rec.t / stepMs) * stepMs;
        let b = buckets.get(key);
        if (!b) { b = this.newScanBucket(); buckets.set(key, b); }
        this.accumulate(b, rec, useAgg);
      }
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t).map((b) => this.finish(b));
  }

  newScanBucket() {
    const b = { t: -1, n: 0, ioN: 0, coreN: 0, sum: {}, peak: {}, l: [0, 0, 0], cores: null };
    for (const k of MEAN) b.sum[k] = 0;
    return b;
  }

  accumulate(b, r, useAgg) {
    b.n++;
    b.t = Math.max(b.t, r.t); // 点画在桶的右端，代表"截至这个时刻"
    for (const k of MEAN) if (typeof r[k] === 'number') b.sum[k] += r[k];
    if (Array.isArray(r.l)) for (let i = 0; i < 3; i++) if (typeof r.l[i] === 'number') b.l[i] += r.l[i];
    for (const k of PEAK) if (typeof r[k] === 'number') b.peak[k] = Math.max(b.peak[k] || 0, r[k]);
    if (typeof r.ri === 'number') {
      b.ioN++;
      b.sum.ri = (b.sum.ri || 0) + r.ri;
      b.sum.wi = (b.sum.wi || 0) + (typeof r.wi === 'number' ? r.wi : 0);
      b.sum.iops = (b.sum.iops || 0) + (typeof r.iops === 'number' ? r.iops : 0);
    }
    if (!useAgg && Array.isArray(r.cores)) {
      if (!b.cores) b.cores = r.cores.map(() => 0);
      for (let i = 0; i < b.cores.length && i < r.cores.length; i++) b.cores[i] += r.cores[i];
      b.coreN++;
    }
    b.last = r;
  }

  finish(b) {
    const out = {
      t: b.t, n: b.n,
      cpu: b.sum.cpu / b.n, mu: b.sum.mu / b.n, ma: b.sum.ma / b.n, dp: b.sum.dp / b.n,
      l: b.l.map((v) => v / b.n),
      du: b.last.du, da: b.last.da, dt: b.last.dt,
    };
    for (const k of PEAK) if (b.peak[k] !== undefined) out[k] = b.peak[k];
    if (b.ioN) { out.ri = b.sum.ri / b.ioN; out.wi = b.sum.wi / b.ioN; out.iops = b.sum.iops / b.ioN; }
    if (b.cores && b.coreN) out.cores = b.cores.map((v) => v / b.coreN);
    return out;
  }

  history(metric, range, now = Date.now()) {
    const seconds = RANGES[range] || RANGES['1h'];
    // 桶数 = window/step + 1（首尾各占一格），据此保证点数不超过 240。
    const step = STEPS.find((s) => seconds / s + 1 <= 240) || STEPS[STEPS.length - 1];
    const useAgg = seconds > RANGES['1h'];
    const recs = this.scan(now - seconds * 1000, now, step * 1000, useAgg);
    const source = useAgg ? 'agg' : 'raw';
    const series = [];
    const push = (name, get, unit, digits = 1) => {
      const points = recs.map((r) => {
        const v = get(r);
        return [r.t, v === null || v === undefined || Number.isNaN(v) ? null : round(v, digits)];
      });
      if (points.some((p) => p[1] !== null)) series.push({ name, unit, points });
    };

    switch (metric) {
      case 'cpu':
        push('CPU', (r) => r.cpu, '%');
        // 峰值只有聚合里才有：5 秒原始点本身就扛得住尖峰，不需要再算分钟最大值。
        if (source === 'agg') push('峰值', (r) => r.cpuMax, '%');
        // 每核只在 1h 视图展开，7 天里核数还可能变，混着画没意义。
        if (range === '1h' && recs.some((r) => Array.isArray(r.cores))) {
          const n = Math.max(...recs.map((r) => (r.cores || []).length));
          for (let i = 0; i < n; i++) push(`cpu${i}`, (r) => (r.cores || [])[i], '%');
        }
        break;
      case 'mem':
        push('已用', (r) => r.mu / MB, 'MB', 0);
        if (source === 'agg') push('峰值', (r) => r.muMax / MB, 'MB', 0);
        push('可用', (r) => r.ma / MB, 'MB', 0);
        break;
      case 'load':
        push('1min', (r) => (r.l || [])[0], '');
        push('5min', (r) => (r.l || [])[1], '');
        push('15min', (r) => (r.l || [])[2], '');
        break;
      case 'disk':
        push('使用率', (r) => r.dp, '%');
        break;
      case 'io':
        push('读', (r) => r.ri, 'MB/s', 2);
        push('写', (r) => r.wi, 'MB/s', 2);
        push('IOPS', (r) => r.iops, '', 1);
        break;
      default:
        break;
    }
    return { metric, range, step, source, series };
  }
}
