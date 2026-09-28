// 轮询 + 手写 Canvas 折线图。资源与接口一律相对路径，这样既能在 nginx 的
// /monitor/ 前缀下工作，也能直连 127.0.0.1:3000。
const GB = 1073741824, MB = 1048576;
const HIST_EVERY = 6; // 历史曲线每 6 次轮询（约 30s）刷一次，卡片保持 5s

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const palette = () => ['--c1', '--c2', '--c3', '--c4', '--c5'].map(css);

const fmtPct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const fmtBytes = (v) => (v === null || v === undefined ? '—' : v >= GB ? `${(v / GB).toFixed(2)} GB` : `${Math.round(v / MB)} MB`);
const fmtNum = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
const trim = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

function timeLabel(t, spanMs) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  if (spanMs > 86400000) return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (spanMs > 21600000) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 单轴 + 多条序列。fixedMax 用于百分比类指标，避免小波动被拉满画幅。
// 注意 height 只能由调用方传进来：canvas.height 是反射属性，写回去会改掉 height 属性，
// 下次再从属性读就把已放大的值当基准，手机上 dpr=3 时高度每轮翻三倍，几次重绘就把页面撑爆。
function drawChart(canvas, series, opts) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
  const h = opts.height;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const valid = series.filter((s) => s.points.some((p) => p[1] !== null));
  const grid = css('--grid'), line = css('--line'), muted = css('--muted');
  const L = 40, R = 8, T = 8, B = 18;
  const iw = w - L - R, ih = h - T - B;

  if (!valid.length) {
    ctx.fillStyle = muted;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据', w / 2, h / 2);
    return;
  }

  let t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
  for (const s of valid) {
    for (const [t, v] of s.points) {
      if (v === null) continue;
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (t1 === t0) t1 = t0 + 1;
  // 百分比图（fixedMax）刻度钉死在 [0, fixedMax]：一是不能给上限加留白，否则顶格标出
  // 108% 这种荒唐刻度；二是数据再小也不缩放，不然 3% 的抖动会画满整张图，看着像出了大事。
  // 真有超上限的脏数据，曲线在 Y() 里被裁到顶线，刻度不外溢。
  if (opts.fixedMax !== undefined) {
    hi = opts.fixedMax;
    lo = 0;
  } else {
    lo = Math.min(lo, 0);
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.08;
    hi += pad;
    if (!opts.zeroBase) lo -= pad;
  }

  const X = (t) => L + ((t - t0) / (t1 - t0)) * iw;
  const Y = (v) => T + ih - ((v - lo) / (hi - lo)) * ih;

  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    const y = Math.round(Y(v)) + .5;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    ctx.fillText(trim(v), L - 6, y);
  }
  ctx.strokeStyle = line;
  ctx.beginPath(); ctx.moveTo(L + .5, T); ctx.lineTo(L + .5, T + ih); ctx.stroke();

  ctx.fillStyle = muted;
  ctx.textAlign = 'center';
  for (let i = 0; i <= 3; i++) {
    const t = t0 + ((t1 - t0) * i) / 3;
    ctx.fillText(timeLabel(t, t1 - t0), Math.min(Math.max(X(t), L + 12), w - R - 12), T + ih + 10);
  }

  const colors = palette();
  valid.forEach((s, i) => {
    const color = colors[i % colors.length];
    s.color = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = valid.length === 1 ? 2 : 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let open = false;
    for (const [t, v] of s.points) {
      if (v === null) { open = false; continue; }
      const x = X(t), y = Y(Math.max(lo, Math.min(hi, v)));
      if (!open) { ctx.moveTo(x, y); open = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (valid.length === 1) {
      ctx.lineTo(X(s.points.filter((p) => p[1] !== null).pop()[0]), T + ih);
      ctx.lineTo(L, T + ih);
      ctx.closePath();
      ctx.globalAlpha = .12;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  });
}

function renderLegend(el, series, fmt) {
  const last = (s) => { for (let i = s.points.length - 1; i >= 0; i--) if (s.points[i][1] !== null) return s.points[i][1]; return null; };
  el.textContent = '';
  for (const s of series) {
    if (!s.points.some((p) => p[1] !== null)) continue;
    const span = document.createElement('span');
    const sw = document.createElement('i');
    sw.style.background = s.color || css('--c1');
    const b = document.createElement('b');
    b.textContent = fmt(last(s));
    span.append(sw, document.createTextNode(`${s.name} `), b);
    el.appendChild(span);
  }
}

const CHARTS = {
  cpu: { metric: 'cpu', canvas: 'c-cpu', hint: 'h-cpu', opts: { fixedMax: 100, zeroBase: true, height: 150 }, fmt: (v) => (v === null ? '—' : `${v}%`) },
  mem: { metric: 'mem', canvas: 'c-mem', hint: 'h-mem', opts: { zeroBase: true, height: 150 }, fmt: (v) => (v === null ? '—' : `${v} MB`) },
  load: { metric: 'load', canvas: 'c-load', hint: 'h-load', opts: { zeroBase: true, height: 150 }, fmt: (v) => fmtNum(v, 2) },
  disk: { metric: 'disk', canvas: 'c-disk', hint: 'h-disk', opts: { fixedMax: 100, zeroBase: true, height: 130 }, fmt: (v) => (v === null ? '—' : `${v}%`) },
  io: { metric: 'io', canvas: 'c-io', hint: 'h-io', opts: { zeroBase: true, height: 130 }, fmt: (v) => (v === null ? '—' : `${v}`) },
};

const state = { range: '1h', pollMs: 5000, ticks: 0, cores: 0, data: {}, timer: null, busy: false };
const $ = (id) => document.getElementById(id);

function setCard(id, value, sub, level) {
  const card = $(`v-${id}`).parentElement;
  $(`v-${id}`).textContent = value;
  if (sub !== undefined) $(`s-${id}`).textContent = sub;
  card.classList.toggle('warn', level === 'warn');
  card.classList.toggle('bad', level === 'bad');
}

function renderCards(c) {
  if (c.cpu?.cores?.length) state.cores = c.cpu.cores.length;
  const cores = state.cores || c.cpu?.cores?.length || 0;
  setCard('cpu', fmtPct(c.cpu?.total), c.cpu?.cores?.length ? `每核 ${c.cpu.cores.map((v) => v.toFixed(0)).join(' / ')}` : '每核 —',
    c.cpu?.total >= 90 ? 'bad' : c.cpu?.total >= 70 ? 'warn' : '');

  const m = c.mem;
  setCard('mem', m ? fmtBytes(m.used) : '—', m ? `共 ${fmtBytes(m.total)} · 可用 ${fmtBytes(m.avail)}` : '—',
    m && m.avail / m.total < .05 ? 'bad' : m && m.avail / m.total < .15 ? 'warn' : '');

  setCard('load', c.load ? fmtNum(c.load[0]) : '—', c.load ? `5m ${fmtNum(c.load[1])} · 15m ${fmtNum(c.load[2])}` : '—',
    c.load && cores && c.load[0] > cores * 1.5 ? 'bad' : c.load && cores && c.load[0] > cores ? 'warn' : '');

  const d = c.disk;
  setCard('disk', fmtPct(d?.pct), d ? `${fmtBytes(d.used)} / ${fmtBytes(d.total)}` : '—',
    d && d.pct >= 95 ? 'bad' : d && d.pct >= 85 ? 'warn' : '');
}

async function loadCurrent() {
  const res = await fetch('./api/current', { cache: 'no-store' });
  if (!res.ok) throw new Error(`current ${res.status}`);
  const c = await res.json();
  state.pollMs = c.interval || 5000;
  renderCards(c);
  $('live').className = 'dot live';
  $('foot').textContent = `采样间隔 ${Math.round(state.pollMs / 1000)}s · 运行 ${Math.round((c.uptime || 0) / 60)} 分钟 · 最后更新 ${new Date(c.t).toLocaleTimeString('zh-CN', { hour12: false })}`;
}

async function loadHistory(force = false) {
  if (!force && state.ticks % HIST_EVERY !== 0) return;
  for (const key of Object.keys(CHARTS)) {
    const cfg = CHARTS[key];
    const res = await fetch(`./api/history?metric=${cfg.metric}&range=${state.range}`, { cache: 'no-store' });
    if (!res.ok) continue;
    const data = await res.json();
    state.data[key] = data;
    const canvas = $(cfg.canvas);
    drawChart(canvas, data.series || [], cfg.opts);
    const host = canvas.parentElement;
    let legend = host.querySelector('.legend');
    if (!legend) { legend = document.createElement('div'); legend.className = 'legend'; host.appendChild(legend); }
    renderLegend(legend, data.series || [], cfg.fmt);
    $(cfg.hint).textContent = data.step ? `步长 ${data.step}s · ${data.series?.[0]?.points.length || 0} 点` : '';
  }
}

async function poll() {
  if (state.busy) return;
  state.busy = true;
  try {
    await loadCurrent();
    state.ticks++;
    await loadHistory(state.ticks === 1); // 首屏就把图画出来，别等 30s
  } catch (err) {
    $('live').className = 'dot stale';
    $('foot').textContent = `拉取失败：${err.message}`;
  } finally {
    state.busy = false;
  }
}

function schedule() {
  clearInterval(state.timer);
  state.timer = setInterval(poll, state.pollMs);
}

$('ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.range = btn.dataset.range;
  for (const b of $('ranges').children) b.classList.toggle('on', b === btn);
  loadHistory(true);
});

// 手机切后台就停轮询，回来立刻补一次。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInterval(state.timer);
  else { poll(); schedule(); }
});

let rz;
window.addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(() => {
    for (const key of Object.keys(CHARTS)) {
      if (!state.data[key]) continue;
      drawChart($(CHARTS[key].canvas), state.data[key].series || [], CHARTS[key].opts);
    }
  }, 200);
});

// 深色模式下 CSS 变量变了，图表颜色跟着重绘。
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => loadHistory(true));

poll().then(schedule);
