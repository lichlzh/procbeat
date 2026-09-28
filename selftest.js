// 自检：用合成的 /proc 夹具验证差值算法，不需要真的把机器压满。
// 运行：NODE_OPTIONS= node selftest.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Sampler } from './sampler.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-proc-'));

function mkproc(name, files) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, 'self'), { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  return dir;
}

let pass = 0;
function check(label, fn) {
  fn();
  pass++;
  console.log(`  ok  ${label}`);
}

const FIXTURE = {
  'self/mountinfo': '31 1 252:3 / / rw,relatime shared:1 - ext4 /dev/vda3 rw\n',
  meminfo: 'MemTotal:        1647536 kB\nMemFree:            93984 kB\nMemAvailable:      615068 kB\nBuffers:            14324 kB\nCached:            607292 kB\n',
  loadavg: '0.52 0.43 0.31 1/234 9999\n',
  diskstats: '',
};

const writeStat = (dir, lines) => fs.writeFileSync(path.join(dir, 'stat'), lines.join('\n') + '\n');
const cpuLine = (name, v) => `${name} ${v.join(' ')}`;

// 写两帧再取差值，等价于服务里相隔 5 秒的两次采样。
function twoFrames(name, frame0, frame1) {
  const dir = mkproc(name, FIXTURE);
  const s = new Sampler({ procDir: dir });
  writeStat(dir, frame0);
  const warm = s.cpu();
  writeStat(dir, frame1);
  return { s, dir, warm, result: s.cpu() };
}

console.log('CPU 差值');

check('双核全忙 -> 100%', () => {
  const { warm, result } = twoFrames('busy',
    [cpuLine('cpu', [1000, 0, 1000, 1000, 0, 0, 0, 0, 0, 0]), cpuLine('cpu0', [500, 0, 500, 500, 0, 0, 0, 0, 0, 0]), cpuLine('cpu1', [500, 0, 500, 500, 0, 0, 0, 0, 0, 0])],
    [cpuLine('cpu', [2000, 0, 2000, 1000, 0, 0, 0, 0, 0, 0]), cpuLine('cpu0', [1000, 0, 1000, 500, 0, 0, 0, 0, 0, 0]), cpuLine('cpu1', [1000, 0, 1000, 500, 0, 0, 0, 0, 0, 0])]);
  assert.equal(warm, null, '首帧只建立基准，不该编出数字');
  assert.deepEqual(result, { total: 100, cores: [100, 100] });
});

check('一半时间空闲 -> 50%', () => {
  const { result } = twoFrames('half',
    [cpuLine('cpu', [0, 0, 0, 100, 0, 0, 0, 0, 0, 0]), cpuLine('cpu0', [0, 0, 0, 100, 0, 0, 0, 0, 0, 0])],
    [cpuLine('cpu', [50, 0, 0, 150, 0, 0, 0, 0, 0, 0]), cpuLine('cpu0', [50, 0, 0, 150, 0, 0, 0, 0, 0, 0])]);
  assert.equal(result.total, 50);
});

check('guest 不重复计入总量（否则会算出 >100%）', () => {
  // guest 时间已被内核并入 user，若把 10 个字段全加起来，busy 会被算成两倍。
  const { result } = twoFrames('guest',
    [cpuLine('cpu', [100, 0, 0, 100, 0, 0, 0, 0, 100, 0]), cpuLine('cpu0', [100, 0, 0, 100, 0, 0, 0, 0, 100, 0])],
    [cpuLine('cpu', [300, 0, 0, 100, 0, 0, 0, 0, 300, 0]), cpuLine('cpu0', [300, 0, 0, 100, 0, 0, 0, 0, 300, 0])]);
  assert.equal(result.total, 100, '增量 user +200（含 guest +200）、idle +0 -> 满载 100%');
});

check('iowait 记为空闲、steal 记为忙碌', () => {
  const { result } = twoFrames('steal',
    [cpuLine('cpu', [0, 0, 0, 0, 50, 0, 0, 50, 0, 0]), cpuLine('cpu0', [0, 0, 0, 0, 50, 0, 0, 50, 0, 0])],
    [cpuLine('cpu', [0, 0, 0, 0, 150, 0, 0, 150, 0, 0]), cpuLine('cpu0', [0, 0, 0, 0, 150, 0, 0, 150, 0, 0])]);
  assert.equal(result.total, 50, '总增量 200：iowait 100 记空闲、steal 100 记忙');
});

check('核数变化时作废旧基准', () => {
  const dir = mkproc('hotplug', FIXTURE);
  const s = new Sampler({ procDir: dir });
  writeStat(dir, [cpuLine('cpu', [0, 0, 0, 100, 0, 0, 0, 0, 0, 0]), cpuLine('cpu0', [0, 0, 0, 100, 0, 0, 0, 0, 0, 0])]);
  assert.equal(s.cpu(), null);
  writeStat(dir, [cpuLine('cpu', [10, 0, 0, 100, 0, 0, 0, 0, 0, 0]), cpuLine('cpu0', [10, 0, 0, 100, 0, 0, 0, 0, 0, 0]), cpuLine('cpu1', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
  assert.equal(s.cpu(), null, '不能拿 1 核的旧差值去比 2 核的新帧');
  writeStat(dir, [cpuLine('cpu', [20, 0, 0, 100, 0, 0, 0, 0, 0, 0]), cpuLine('cpu0', [20, 0, 0, 100, 0, 0, 0, 0, 0, 0]), cpuLine('cpu1', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
  assert.equal(s.cpu().cores.length, 2);
});

console.log('内存 / 负载');

check('used = MemTotal - MemAvailable', () => {
  const s = new Sampler({ procDir: mkproc('mem', FIXTURE) });
  const m = s.memory();
  assert.equal(m.total, 1647536 * 1024);
  assert.equal(m.used + m.avail, m.total);
  assert.equal(m.used, (1647536 - 615068) * 1024);
});

check('取 /proc/loadavg 前三项', () => {
  const s = new Sampler({ procDir: mkproc('ld', FIXTURE) });
  assert.deepEqual(s.load(), [0.52, 0.43, 0.31]);
});

console.log('磁盘 IO');

const ds = (vda) => `252 0 vda ${vda.join(' ')} 0 0 0 0 0 0 0\n252 3 vda3 1 2 3 4 5 6 7 8 9 10 11\n`;

check('取整盘 vda 而不是分区 vda3', () => {
  const dir = mkproc('dev', {
    'self/mountinfo': '31 1 252:3 / / rw - ext4 /dev/vda3 rw\n',
    diskstats: ds([0, 0, 0, 0, 0, 0, 0, 0]),
  });
  const s = new Sampler({ procDir: dir });
  assert.equal(s.rootDev, '/dev/vda3');
  assert.equal(s.resolveDiskName(), 'vda');
});

check('nvme 分区名也能回溯到整盘', () => {
  const dir = mkproc('nvme', {
    'self/mountinfo': '31 1 259:3 / / rw - ext4 /dev/nvme0n1p3 rw\n',
    diskstats: '259 0 nvme0n1 1 2 3 4 5 6 7 8 9 10 11\n',
  });
  assert.equal(new Sampler({ procDir: dir }).resolveDiskName(), 'nvme0n1');
});

check('md0 这类去尾号不存在的设备，退化用分区自身行', () => {
  const dir = mkproc('md', {
    'self/mountinfo': '31 1 9:0 / / rw - ext4 /dev/md0 rw\n',
    diskstats: '9 0 md0 1 2 3 4 5 6 7 8 9 10 11\n',
  });
  assert.equal(new Sampler({ procDir: dir }).resolveDiskName(), 'md0');
});

check('读写速率与 IOPS 由 512B 扇区差值算出', () => {
  const dir = mkproc('io', { 'self/mountinfo': '31 1 252:3 / / rw - ext4 /dev/vda3 rw\n', diskstats: ds([0, 0, 0, 0, 0, 0, 0, 0]) });
  const s = new Sampler({ procDir: dir });
  assert.equal(s.io(1000), null);
  // 2 秒内：读 2048 扇区 = 1MB，写 4096 扇区 = 2MB，完成 20 次读 + 40 次写
  fs.writeFileSync(path.join(dir, 'diskstats'), ds([20, 0, 2048, 0, 40, 0, 4096, 0]));
  assert.deepEqual(s.io(2000), { rMBs: 0.5, wMBs: 1, iops: 30 });
});

console.log('\nmountinfo 可选字段解析');

check('带 shared:1 等可选字段时仍能取到 mountsource', () => {
  const dir = mkproc('mi', { 'self/mountinfo': '31 1 252:3 / / rw,relatime shared:1 - ext4 /dev/vda3 rw\n' });
  assert.equal(new Sampler({ procDir: dir }).rootDev, '/dev/vda3');
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n全部通过：${pass} 项`);
