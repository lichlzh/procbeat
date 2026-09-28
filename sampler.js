// 只读 /proc 与 statfs 的采集器，不做任何 I/O 写入。
// procDir 可注入，便于用合成数据对差值算法做确定性测试。
import fs from 'node:fs';
import path from 'node:path';

// /proc/stat 字段：user nice system idle iowait irq softirq steal guest guest_nice
// guest/guest_nice 已被内核计入 user/nice，求和时排除，否则重复计数。
const FIELDS = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];

function parseCpuLine(tokens) {
  const t = {};
  let total = 0;
  for (let i = 0; i < FIELDS.length; i++) {
    t[FIELDS[i]] = Number(tokens[i]) || 0;
    total += t[FIELDS[i]];
  }
  t.total = total;
  return t;
}

// 整盘设备名：/dev/vda3 -> vda，/dev/nvme0n1p3 -> nvme0n1。
// 分区行是整盘行的子集，取分区会重复计数，所以只认整盘。
function parentDevice(rootDev) {
  const base = rootDev.split('/').pop();
  return base.replace(/p?\d+$/, '') || base;
}

export class Sampler {
  constructor({ procDir = '/proc', mountPoint = '/' } = {}) {
    this.proc = procDir;
    this.mountPoint = mountPoint;
    this.prevCpu = null;
    this.prevDisk = null;
    this.diskName = null;
    this.knownCores = null;
    this.rootDev = this.readRootDevice();
  }

  read(procFile) {
    return fs.readFileSync(path.join(this.proc, procFile), 'utf8');
  }

  readRootDevice() {
    try {
      for (const line of this.read('self/mountinfo').split('\n')) {
        const p = line.split(' ');
        if (p[4] !== this.mountPoint) continue;
        // 可选字段数量不定，真正的 fstype/mountsource 在 "-" 分隔符之后。
        const sep = p.indexOf('-');
        if (sep !== -1 && p[sep + 2]) return p[sep + 2];
      }
    } catch { /* 读不到就不给 IO 指标 */ }
    return null;
  }

  cpu() {
    let total = null;
    const cores = [];
    for (const line of this.read('stat').split('\n')) {
      if (!line.startsWith('cpu')) break;
      const p = line.trim().split(/\s+/);
      if (p[0] === 'cpu') total = parseCpuLine(p.slice(1));
      else cores.push({ name: p[0], t: parseCpuLine(p.slice(1)) });
    }
    if (!total) return null;

    // CPU 热插拔导致核数变化时旧差值作废，重新预热一次。
    if (this.knownCores !== null && this.knownCores !== cores.length) this.prevCpu = null;
    this.knownCores = cores.length;

    const prev = this.prevCpu;
    this.prevCpu = { total, cores };
    if (!prev) return null;

    const pct = (a, b) => {
      const span = b.total - a.total;
      if (span <= 0) return 0;
      // steal 计入忙：虚拟机上这段等待是本机真实感受到的不可用时间。
      const busy = span - (b.idle - a.idle) - (b.iowait - a.iowait);
      return Math.round((busy / span) * 1000) / 10;
    };
    const corePct = [];
    for (let i = 0; i < cores.length && i < prev.cores.length; i++) {
      if (cores[i].name !== prev.cores[i].name) return { total: pct(prev.total, total), cores: null };
      corePct.push(pct(prev.cores[i].t, cores[i].t));
    }
    return { total: pct(prev.total, total), cores: corePct };
  }

  memory() {
    const text = this.read('meminfo');
    const pick = (key) => {
      const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return m ? Number(m[1]) * 1024 : 0;
    };
    const total = pick('MemTotal');
    const avail = pick('MemAvailable');
    // MemFree - Buffers - Cached 从 3.14 起就是错的口径，可回收的页缓存没算进去。
    return { total, used: total - avail, avail };
  }

  load() {
    const f = this.read('loadavg').trim().split(/\s+/);
    return [Number(f[0]), Number(f[1]), Number(f[2])];
  }

  disk() {
    const s = fs.statfsSync(this.mountPoint);
    // 与 df 同口径：used 只算真正写掉的空间，剩余用普通用户能碰到的 bavail，
    // 分母相应取 used+avail，root 预留块就不会被算进"已用"里。
    const total = s.blocks * s.bsize;
    const used = (s.blocks - s.bfree) * s.bsize;
    const avail = s.bavail * s.bsize;
    return { total, used, avail, pct: Math.round((used / (used + avail)) * 1000) / 10 };
  }

  // 优先整盘行；个别设备名（如 md0）去掉尾号后不存在，退化用分区自身那行。
  resolveDiskName() {
    if (this.diskName) return this.diskName;
    if (!this.rootDev) return null;
    const names = new Set();
    for (const line of this.read('diskstats').split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p[2]) names.add(p[2]);
    }
    const part = this.rootDev.split('/').pop();
    this.diskName = names.has(parentDevice(this.rootDev)) ? parentDevice(this.rootDev) : (names.has(part) ? part : null);
    return this.diskName;
  }

  io(elapsedMs) {
    const want = this.resolveDiskName();
    if (!want) return null;
    let row = null;
    for (const line of this.read('diskstats').split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p[2] === want) { row = p; break; }
    }
    if (!row) return null;
    // major minor name 之后依次是：读完成 读合并 读扇区 读毫秒 写完成 写合并 写扇区 写毫秒 ...
    const n = (i) => Number(row[3 + i]) || 0;
    const cur = { reads: n(0), rsec: n(2), writes: n(4), wsec: n(6) };
    const prev = this.prevDisk;
    this.prevDisk = cur;
    if (!prev || elapsedMs <= 0) return null;
    const sec = elapsedMs / 1000;
    // 扇区恒按 512B 计，与物理扇区大小无关。
    const rB = (cur.rsec - prev.rsec) * 512;
    const wB = (cur.wsec - prev.wsec) * 512;
    return {
      rMBs: Math.round((rB / sec / 1048576) * 100) / 100,
      wMBs: Math.round((wB / sec / 1048576) * 100) / 100,
      iops: Math.round(((cur.reads - prev.reads) + (cur.writes - prev.writes)) / sec * 10) / 10,
    };
  }

  // 首次调用只建立差值基准，cpu/io 返回 null。
  sample(elapsedMs) {
    return {
      t: Date.now(),
      cpu: this.cpu(),
      mem: this.memory(),
      load: this.load(),
      disk: this.disk(),
      io: this.io(elapsedMs),
    };
  }
}
