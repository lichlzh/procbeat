// 前端图表的纵轴边界自检。本机没有浏览器，所以用 node:vm 加载**真实的** public/app.js，
// 把 canvas 换成桩、抓住写进画布的刻度文本，断言边界与刻度位置。
// 运行：node axistest.js（或 ./monitor.sh selftest，会连采集算法一起跑）
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// app.js 末尾会自己启动轮询，在 vm 里跑之前得先摘掉这个自启动语句。
const raw = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const bootstrap = /\npoll\(\)\.then\(schedule\);\s*$/;
assert.ok(bootstrap.test(raw),
  'app.js 末尾的自启动语句没匹配上——它被改过，这个桩脚本的裁剪方式要跟着改');
// const 声明不挂到 global 上，追加一行把 CHARTS 交出来
const src = raw.replace(bootstrap, '\n') + '\nglobalThis.__exports = { CHARTS };\n';

const labels = [];
const ctx = new Proxy({}, {
  get(_t, p) {
    if (p === 'fillText') return (text, x, y) => labels.push({ text, x, y });
    return () => {};
  },
  set() { return true; },
});
const canvas = {
  clientWidth: 400, width: 0, height: 0, style: {}, children: [],
  getContext: () => ctx, parentElement: { clientWidth: 400 },
  addEventListener() {}, classList: { toggle() {} }, dataset: {},
};
const sandbox = {
  window: { devicePixelRatio: 3, addEventListener() {} },
  document: { documentElement: {}, getElementById: () => canvas, addEventListener() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '#fff' }),
  matchMedia: () => ({ addEventListener() {} }),
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  fetch: async () => ({ ok: false, status: 0 }),
  console, Math, JSON, Number, Array, Object, Infinity, NaN, String, Boolean,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const drawChart = sandbox.drawChart;
const CHARTS = sandbox.__exports.CHARTS;
const series = (values) => [{ name: 'x', unit: '', points: values.map((v, i) => [1790000000000 + i * 30000, v]) }];
// 只取 y 轴那一列文字（x < 40 落在左边距里），按绘制顺序 lo → hi
const axis = (metric, values) => {
  labels.length = 0;
  drawChart(canvas, series(values), CHARTS[metric].opts);
  const y = labels.filter((l) => l.x < 40);
  return { texts: y.map((l) => Number(l.text)), ys: y.map((l) => l.y) };
};
const show = (title, r) => console.log(`${title}\n  刻度: ${r.texts.join(' / ')}`);

let n = 0;
const check = (desc, fn) => { fn(); n++; console.log(`  ok  ${desc}`); };

console.log('百分比图：纵轴钉死在 [0, fixedMax]，不随数据缩放、不加留白');
const cpu = axis('cpu', [5, 12, 8, 15, 9]);
show('CPU 5~15%', cpu);
check('正常数据顶格是 100、底格是 0', () => {
  assert.equal(cpu.texts.at(-1), 100);
  assert.equal(cpu.texts[0], 0);
});
const dirty = axis('cpu', [5, 130, 8]);
show('CPU 含 130% 脏数据', dirty);
check('脏数据不外溢刻度', () => assert.ok(Math.max(...dirty.texts) <= 100));
const zero = axis('cpu', [0, 0, 0]);
show('CPU 全 0', zero);
check('全 0 仍然铺满 0~100，不自适应成小尺子', () => {
  assert.equal(Math.max(...zero.texts), 100);
  assert.equal(Math.min(...zero.texts), 0);
});
const disk = axis('disk', [16.4, 16.5]);
show('磁盘使用率', disk);
check('磁盘同样钉死 100', () => assert.equal(Math.max(...disk.texts), 100));

console.log('绝对量图：仍按数据自适应（留 8% 余量）');
const mem = axis('mem', [1100, 1200, 1150]);
show('内存', mem);
check('内存顶格贴合数据上界', () => {
  assert.ok(Math.max(...mem.texts) > 1200 && Math.max(...mem.texts) < 1400);
  assert.equal(Math.min(...mem.texts), 0);
});
const io = axis('io', [0.1, 4.2, 0]);
show('IO', io);
check('IO 顶格 >= 数据最大值且留有余量', () => {
  assert.ok(Math.max(...io.texts) >= 4.2 && Math.max(...io.texts) < 5);
});

console.log('刻度文本必须落在对应的网格线上（否则是标签与位置错位）');
const TOP = 8;          // drawChart 的上边距 T；18 是下边距（x 轴时间标签的高度）
for (const m of ['cpu', 'disk', 'mem', 'io', 'load']) {
  const { ys } = axis(m, [1, 2, 3]);
  const bottom = TOP + (CHARTS[m].opts.height - TOP - 18);
  check(`${m} 四条网格线位置`, () => {
    assert.ok(Math.abs(ys[0] - bottom) < 1.5, `${m} 底格 y=${ys[0]} 应在 ${bottom}`);
    assert.ok(Math.abs(ys[3] - TOP) < 1.5, `${m} 顶格 y=${ys[3]} 应在 ${TOP}`);
  });
}

console.log(`\n全部通过：${n} 项纵轴断言`);
