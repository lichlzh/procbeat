// 前端的无浏览器自检。本机没有浏览器，所以用 node:vm 加载**真实的** public/app.js，
// canvas 与 DOM 元素换成桩：一边抓写进画布的刻度文本断言纵轴边界，一边抓卡片小字的
// textContent 断言"核数变了该怎么显示"这段逻辑。
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
// 元素桩按 id 分组：drawChart 要 canvas，setCard 要普通节点，两者都从 getElementById 拿。
// 只有一个共用桩的话，就分不清"这段文字到底写进了哪个元素"。
const els = new Map();
const el = (id) => {
  if (!els.has(id)) {
    const e = {
      clientWidth: 400, width: 0, height: 0, style: {}, children: [], dataset: {},
      textContent: '', classList: { toggle() {} }, getContext: () => ctx,
      addEventListener() {}, appendChild() {},
    };
    e.parentElement = { clientWidth: 400, children: [], classList: { toggle() {} } };
    els.set(id, e);
  }
  return els.get(id);
};
const canvas = el('c-cpu');
const sandbox = {
  window: { devicePixelRatio: 3, addEventListener() {} },
  document: { documentElement: {}, getElementById: el, addEventListener() {} },
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
// 函数声明会挂到 vm 的 global 上，直接取来测；取不到说明 app.js 那边改名或内联了，
// 宁可在这里失败，也不要留一组静悄悄不执行的断言。
const { coreSummary, renderCards } = sandbox;
assert.equal(typeof coreSummary, 'function', 'app.js 里没有 coreSummary，这段断言要跟着改');
assert.equal(typeof renderCards, 'function', 'app.js 里没有 renderCards，这段断言要跟着改');
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

// 本机只有 2 核，核多时的文案没法用眼睛验，只能走真实函数。
console.log('卡片小字：核少逐个列，核多只报最高那根（不让一行字把卡片撑高）');
check('2 核逐个列，每个数自带 %', () =>
  assert.equal(coreSummary([11.1, 9.3]), '每核 11% / 9%'));
check('6 核（阈值内）仍是全列表', () =>
  assert.equal(coreSummary([1, 2, 3, 4, 5, 92.4]), '每核 1% / 2% / 3% / 4% / 5% / 92%'));
check('7 核起改汇总，报最大的那根', () =>
  assert.equal(coreSummary([1, 2, 3, 4, 5, 6, 92.4]), '每核 7 核 · 最高 92%(cpu6)'));
check('最大的在中间也要挑出来', () =>
  assert.equal(coreSummary([1, 99.6, 3, 4, 5, 6, 7, 8]), '每核 8 核 · 最高 100%(cpu1)'));
check('64 核的文案长度有界，不随核数线性变长', () => {
  const s = coreSummary(Array.from({ length: 64 }, (_, i) => i % 101));
  assert.ok(s.length <= 26, `实际 ${s.length} 字符：${s}`);
  assert.ok(!s.includes(' / '), `汇总里不该再有全列表：${s}`);
});
check('renderCards 把这段文字写进了 #s-cpu', () => {
  els.clear();
  renderCards({ cpu: { total: 10.1, cores: [11.1, 9.3] }, mem: null, load: null, disk: null });
  assert.equal(el('s-cpu').textContent, '每核 11% / 9%');
});

console.log(`\n全部通过：${n} 项前端断言`);
