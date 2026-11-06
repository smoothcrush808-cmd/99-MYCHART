// 99-MYCHART (BTC 심리차트 복사본 + 내 기록 점) — 바이낸스 현물 BTCUSDT 캔들 + 그리기 도구 (빌드 없음)
(() => {
'use strict';

const LWC = window.LightweightCharts;

// ───────────────────────── 와이드 (화면 90° 회전)
// iPhone 사파리는 화면 방향 고정 API가 없어서 CSS로 돌린다. 돌린 화면에선 터치 좌표가 어긋나므로
// 와이드일 때만 clientX/Y·pageX/Y·getBoundingClientRect를 '돌린 화면 기준'으로 바꿔 돌려준다.
// 화면 (sx, sy) ↔ 돌린 화면 (ux, uy):  ux = sy,  uy = W − sx   (W = 실제 화면 폭)
const wide = (() => {
  const html = document.documentElement;
  const root = document.getElementById('root');
  let on = false;
  const W = () => window.innerWidth;
  const active = () => on;

  for (const proto of [window.MouseEvent && MouseEvent.prototype, window.Touch && Touch.prototype]) {
    if (!proto) continue;
    const d = name => {
      for (let o = proto; o; o = Object.getPrototypeOf(o)) {
        const desc = Object.getOwnPropertyDescriptor(o, name);
        if (desc && desc.get) return desc.get;
      }
      return null;
    };
    const g = { cx: d('clientX'), cy: d('clientY'), px: d('pageX'), py: d('pageY') };
    if (!g.cx || !g.cy || !g.px || !g.py) continue;
    Object.defineProperties(proto, {
      clientX: { configurable: true, get() { return active() ? g.cy.call(this) : g.cx.call(this); } },
      clientY: { configurable: true, get() { return active() ? W() - g.cx.call(this) : g.cy.call(this); } },
      pageX: { configurable: true, get() { return active() ? g.py.call(this) : g.px.call(this); } },
      pageY: { configurable: true, get() { return active() ? W() - g.px.call(this) : g.py.call(this); } },
    });
  }
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const r = origRect.call(this);
    if (!active() || !root || !root.contains(this)) return r;
    return new DOMRect(r.top, W() - r.right, r.height, r.width);
  };
  // 사파리는 캔버스 해상도를 getClientRects로 정한다 → 돌린 화면에선 폭·높이가 뒤바뀌어 축 글씨가 뭉개짐
  const origRects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function () {
    const list = origRects.call(this);
    if (!active() || !root || !root.contains(this)) return list;
    return Array.from(list, r => new DOMRect(r.top, W() - r.right, r.height, r.width));
  };

  function apply(want) {
    // 폰을 실제로 가로로 돌렸으면 이중 회전이 되므로 끈다 (옛 index.html이면 #root가 없어 못 켬)
    on = !!want && !!root && window.innerWidth < window.innerHeight && window.innerWidth <= 720;
    html.style.setProperty('--vw', window.innerWidth + 'px');
    html.style.setProperty('--vh', window.innerHeight + 'px');
    html.classList.toggle('wide', on);
    const b = document.getElementById('wideBtn');
    if (b) b.classList.toggle('on', !!want);
  }
  return { apply, isOn: () => on };
})();
const SYMBOL = 'BTCUSDT';
const KST = 9 * 3600;            // 차트 시각은 KST로 밀어서 넣는다 (눈금이 KST 자정에 맞도록)
const PAGE = 1000;               // 바이낸스 klines 최대 개수
const EDGE = 150;                // 가장자리에서 이 정도 봉 남으면 더 받는다
// 99-MYCHART: 원본(BTC 심리차트)과 같은 github.io 주소라 localStorage를 같이 쓴다 → 키·Gist 파일 이름을 달리해 원본 그림을 건드리지 않는다
const STORE_KEY = 'myChart.drawings.v1';
const PREF_KEY = 'myChart.prefs.v1';
const BM_KEY = 'myChart.bookmarks.v1';
const SYNC_KEY = 'myChart.sync.v1';
const NOTE_KEY = 'myChart.noteKey.v1';   // 「이 기기에서 기억」한 af WC 풀이 키

const IVS = { '5m': 300, '15m': 900, '1h': 3600 };

const REST_BASES = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
];
const WS_BASES = [
  'wss://data-stream.binance.vision/ws/',
  'wss://stream.binance.com:9443/ws/',
];

const C = {
  bg: '#0a0e14', grid: 'rgba(36,52,71,0.45)', border: '#243447', text: '#8a9ab0',
  up: '#26e0a5', down: '#ff5572', btc: '#f7931a',
  hline: '#f7931a', ray: '#33d4ff', dot: '#ffcc33',
  box: '#7a93ad', boxFill: 'rgba(122,147,173,0.14)',
  erase: '#ff5572', jump: 'rgba(247,147,26,0.7)',
};

const $ = id => document.getElementById(id);

// ───────────────────────── 저장소 (localStorage는 실패할 수 있음)
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch { return false; }
  },
};

// ───────────────────────── 시각 표시 (차트 시각은 이미 +9h 되어 있어 UTC 게터로 읽는다)
const pad = n => String(n).padStart(2, '0');
const WD = ['일', '월', '화', '수', '목', '금', '토'];
function fmtChartTime(t, withWeekday = true) {
  const d = new Date(t * 1000);
  const s = `${String(d.getUTCFullYear()).slice(2)}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
  return `${s}${withWeekday ? `(${WD[d.getUTCDay()]})` : ''} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function tickFmt(t, type) {
  const d = new Date(t * 1000);
  switch (type) {
    case 0: return String(d.getUTCFullYear());
    case 1: return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}`;
    case 2: return `${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
    default: return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
}
const fmtPrice = p => p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// 가격축은 소수점 없이 (축 폭을 줄인다)
const fmtAxis = p => Math.round(p).toLocaleString('en-US');
const msToChart = ms => Math.floor(ms / 1000) + KST;
const chartToMs = t => (t - KST) * 1000;

// ───────────────────────── 시세 REST
let restIdx = 0; // 마지막으로 성공한 경로를 먼저 쓴다

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `timeout(${timeoutMs / 1000}s)` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKlines(interval, { startTime, endTime, limit = PAGE } = {}) {
  const q = new URLSearchParams({ symbol: SYMBOL, interval, limit: String(limit) });
  if (startTime != null) q.set('startTime', String(Math.max(0, Math.floor(startTime))));
  if (endTime != null) q.set('endTime', String(Math.floor(endTime)));
  const path = `/api/v3/klines?${q}`;

  const routes = REST_BASES.map((b, i) => ({ i, name: new URL(b).host, url: b + path }));
  routes.push({ i: REST_BASES.length, name: 'corsproxy', url: `https://corsproxy.io/?url=${encodeURIComponent(REST_BASES[0] + path)}` });
  const ordered = [...routes.slice(restIdx), ...routes.slice(0, restIdx)];

  const errors = [];
  for (const r of ordered) {
    try {
      const json = await fetchJson(r.url);
      if (!Array.isArray(json)) throw new Error(`unexpected: ${JSON.stringify(json).slice(0, 80)}`);
      restIdx = r.i;
      return json.map(k => ({
        time: msToChart(k[0]),
        open: +k[1], high: +k[2], low: +k[3], close: +k[4],
      }));
    } catch (e) {
      errors.push(`${r.name}: ${e.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

// ───────────────────────── 화면 요소
const ui = {
  legend: $('legend'), hint: $('hint'), hintText: $('hintText'), toast: $('toast'),
  livePrice: $('livePrice'), connDot: $('connDot'),
};

let toastTimer = 0;
function toast(msg, { error = false, detail = '', retry = null, ms = 3500 } = {}) {
  clearTimeout(toastTimer);
  const el = ui.toast;
  el.className = 'toast show' + (error ? ' err' : '');
  el.innerHTML = '';
  const m = document.createElement('div'); m.textContent = msg; el.appendChild(m);
  if (detail) { const d = document.createElement('div'); d.className = 'detail'; d.textContent = detail; el.appendChild(d); }
  if (retry) {
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = '다시 시도';
    b.onclick = () => { el.className = 'toast'; retry(); };
    el.appendChild(b);
  }
  if (!retry) toastTimer = setTimeout(() => { el.className = 'toast'; }, ms);
}

// ───────────────────────── 차트
const chart = LWC.createChart($('chart'), {
  autoSize: true,
  layout: {
    background: { type: 'solid', color: C.bg }, textColor: C.text,
    fontFamily: "'IBM Plex Mono', Menlo, Consolas, monospace", fontSize: 11,
    attributionLogo: false,
  },
  grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
  rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
  timeScale: {
    borderColor: C.border, timeVisible: true, secondsVisible: false,
    rightOffset: 8, barSpacing: window.innerWidth < 720 ? 4.5 : 7, tickMarkFormatter: tickFmt,
  },
  localization: { locale: 'ko-KR', timeFormatter: t => fmtChartTime(t), priceFormatter: fmtAxis },
  crosshair: {
    mode: LWC.CrosshairMode.Normal,
    vertLine: { color: 'rgba(138,154,176,0.5)', labelBackgroundColor: '#243447' },
    horzLine: { color: 'rgba(138,154,176,0.5)', labelBackgroundColor: '#243447' },
  },
});

const series = chart.addSeries(LWC.CandlestickSeries, {
  upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down,
  wickUpColor: C.up, wickDownColor: C.down,
  priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  priceLineColor: 'rgba(247,147,26,0.8)',
});
const ts = chart.timeScale();

// ───────────────────────── 봉 데이터 상태 (봉 간격별로 메모리에 둔다)
// bars: 연속된 구간 하나. atLatest: 오른쪽 끝이 지금 봉인가 (실시간 반영 여부)
const cache = {};
const S = {
  iv: '5m', bars: [], atLatest: false, noMoreLeft: false,
  loadingLeft: false, loadingRight: false, gen: 0, jumpT: null,
};
const sec = () => IVS[S.iv];

function mergeBars(a, b) {
  const m = new Map();
  for (const x of a) m.set(x.time, x);
  for (const x of b) m.set(x.time, x);
  return [...m.values()].sort((x, y) => x.time - y.time);
}

// 데이터를 바꾸되 보던 자리를 유지한다 (shift = 왼쪽에 새로 붙은 봉 수)
function applyBars(newBars, shift = 0) {
  const r = ts.getVisibleLogicalRange();
  S.bars = newBars;
  series.setData(newBars);
  if (r && S.bars.length) ts.setVisibleLogicalRange({ from: r.from + shift, to: r.to + shift });
  saveCache();
  drawings.refresh();
  updateLegend();
}

function saveCache() {
  cache[S.iv] = { bars: S.bars, atLatest: S.atLatest, noMoreLeft: S.noMoreLeft };
}

function setBusy(on) {
  S.busy = on;
  updateLegend();
}

async function loadLatest() {
  const gen = ++S.gen;
  setBusy(true);
  try {
    const bars = await fetchKlines(S.iv);
    if (gen !== S.gen) return;
    S.atLatest = true; S.noMoreLeft = false;
    S.bars = bars;
    series.setData(bars);
    ts.scrollToRealTime();
    saveCache();
    drawings.refresh();
    updateLegend();
    setTimeout(checkEdges, 0);
  } catch (e) {
    if (gen !== S.gen) return;
    toast('시세를 받지 못했습니다', { error: true, detail: e.message, retry: loadLatest });
  } finally {
    if (gen === S.gen) setBusy(false);
  }
}

async function loadLeft() {
  if (S.loadingLeft || S.noMoreLeft || !S.bars.length) return;
  S.loadingLeft = true; setBusy(true);
  const gen = S.gen, iv = S.iv;
  try {
    const first = S.bars[0].time;
    const got = await fetchKlines(iv, { endTime: chartToMs(first) - 1 });
    if (gen !== S.gen || iv !== S.iv) return;
    if (!got.length) { S.noMoreLeft = true; saveCache(); return; }
    if (got.length < PAGE) S.noMoreLeft = true;
    const merged = mergeBars(got, S.bars);
    const shift = merged.findIndex(b => b.time === first);
    applyBars(merged, Math.max(0, shift));
  } catch (e) {
    toast('과거 봉을 받지 못했습니다', { error: true, detail: e.message, ms: 5000 });
  } finally {
    S.loadingLeft = false; setBusy(S.loadingRight);
    setTimeout(checkEdges, 300);
  }
}

async function loadRight() {
  if (S.loadingRight || S.atLatest || !S.bars.length) return;
  S.loadingRight = true; setBusy(true);
  const gen = S.gen, iv = S.iv;
  try {
    const last = S.bars[S.bars.length - 1].time;
    const got = await fetchKlines(iv, { startTime: chartToMs(last) + 1 });
    if (gen !== S.gen || iv !== S.iv) return;
    if (got.length < PAGE) S.atLatest = true;
    applyBars(mergeBars(S.bars, got), 0);
  } catch (e) {
    toast('다음 봉을 받지 못했습니다', { error: true, detail: e.message, ms: 5000 });
  } finally {
    S.loadingRight = false; setBusy(S.loadingLeft);
    setTimeout(checkEdges, 300);
  }
}

function checkEdges() {
  const r = ts.getVisibleLogicalRange();
  if (!r || !S.bars.length) return;
  if (r.from < EDGE) loadLeft();
  if (!S.atLatest && r.to > S.bars.length - 1 - EDGE) loadRight();
}
ts.subscribeVisibleLogicalRangeChange(() => {
  checkEdges();
  drawings.refresh();
});

// 특정 시각(실제 ms)으로 이동
async function jumpTo(ms, { mark = true, width: w = null } = {}) {
  const s = sec();
  const t = Math.floor(msToChart(ms) / s) * s; // 봉 시작 시각으로 내림 (KST로 민 값 기준이라 1h도 정각)
  if (mark) S.jumpT = t;
  const width = w || (() => { const r = ts.getVisibleLogicalRange(); return r ? Math.max(40, r.to - r.from) : 160; })();

  const inRange = S.bars.length && t >= S.bars[0].time && t <= S.bars[S.bars.length - 1].time;
  if (!inRange) {
    const gen = ++S.gen;
    S.loadingLeft = S.loadingRight = false;
    setBusy(true);
    try {
      const nowMs = Date.now();
      const startMs = chartToMs(t) - (PAGE / 2) * s * 1000;
      let bars;
      if (chartToMs(t) + (PAGE / 2) * s * 1000 >= nowMs) {
        // 지금과 가까우면 최신 구간을 받는다
        bars = await fetchKlines(S.iv);
        S.atLatest = true;
        if (bars.length && t < bars[0].time) {
          const more = await fetchKlines(S.iv, { endTime: chartToMs(bars[0].time) - 1 });
          bars = mergeBars(more, bars);
        }
      } else {
        bars = await fetchKlines(S.iv, { startTime: startMs });
        S.atLatest = bars.length < PAGE;
      }
      if (gen !== S.gen) return;
      if (!bars.length) { toast('그 시각의 봉이 없습니다', { error: true }); return; }
      S.noMoreLeft = false;
      S.bars = bars;
      series.setData(bars);
      saveCache();
    } catch (e) {
      if (gen !== S.gen) return;
      toast('그 시각의 시세를 받지 못했습니다', { error: true, detail: e.message, retry: () => jumpTo(ms, { mark }) });
      return;
    } finally {
      if (gen === S.gen) setBusy(false);
    }
  }
  const idx = indexAtOrBefore(t);
  ts.setVisibleLogicalRange({ from: idx - width / 2, to: idx + width / 2 });
  drawings.refresh();
  updateLegend();
  setTimeout(checkEdges, 0);
}

// 이분 탐색: time <= t 인 마지막 봉 번호 (없으면 -1)
function indexAtOrBefore(t) {
  const b = S.bars;
  let lo = 0, hi = b.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (b[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// 차트 시각(초, KST로 민 값) → 논리 봉 번호 (소수 가능, 받은 구간 밖은 봉 간격으로 연장)
function timeToLogical(t) {
  const b = S.bars, s = sec();
  if (!b.length) return null;
  if (t < b[0].time) return (t - b[0].time) / s;
  const i = indexAtOrBefore(t);
  if (i === b.length - 1) return i + (t - b[i].time) / s;
  const span = b[i + 1].time - b[i].time;
  return i + Math.min(1, (t - b[i].time) / span);
}
function logicalToTime(l) {
  const b = S.bars, s = sec();
  const i = Math.round(l);
  if (i < 0) return b[0].time + i * s;
  if (i >= b.length) return b[b.length - 1].time + (i - b.length + 1) * s;
  return b[i].time;
}
// logicalToCoordinate는 정수 번호만 제대로 받는다 → 이웃 두 봉 사이를 직접 보간
function timeToX(t) {
  const l = timeToLogical(t);
  if (l == null) return null;
  const f = Math.floor(l);
  const a = ts.logicalToCoordinate(f);
  if (a == null || l === f) return a;
  const b = ts.logicalToCoordinate(f + 1);
  return b == null ? a : a + (l - f) * (b - a);
}

// 간격을 바꿔도 같은 시각을 보도록
// centerMs를 주면 그 시각으로 (북마크), 아니면 지금 보던 시각을 유지
function switchInterval(iv, { centerMs = null, width = null } = {}) {
  if (iv === S.iv || !IVS[iv]) return;
  const r = ts.getVisibleLogicalRange();
  const wasLatest = S.atLatest && r && r.to >= S.bars.length - 3;
  const centerT = r && S.bars.length ? logicalToTime((r.from + r.to) / 2) : null;

  saveCache();
  S.gen++;
  S.loadingLeft = S.loadingRight = false;
  S.iv = iv;
  store.set(PREF_KEY, { ...store.get(PREF_KEY, {}), iv });
  document.querySelectorAll('#ivSeg button').forEach(b => b.classList.toggle('on', b.dataset.iv === iv));
  connectWs();

  const c = cache[iv];
  S.bars = c ? c.bars : [];
  S.atLatest = c ? c.atLatest : false;
  S.noMoreLeft = c ? c.noMoreLeft : false;
  series.setData(S.bars);

  if (centerMs != null) {
    jumpTo(centerMs, { mark: false, width });
  } else if (wasLatest || centerT == null) {
    if (c && c.atLatest) { ts.scrollToRealTime(); drawings.refresh(); updateLegend(); backfill(); }
    else loadLatest();
  } else {
    jumpTo(chartToMs(centerT), { mark: false });
  }
}

// ───────────────────────── 실시간 (웹소켓)
const WSs = { ws: null, idx: 0, retry: 0, timer: 0, gotMsg: false };

function setConn(state) {
  ui.connDot.className = 'dot ' + ({ ok: 'ok', wait: 'wait', bad: 'bad' }[state] || '');
  ui.connDot.title = { ok: '실시간 연결됨', wait: '연결 중…', bad: '실시간 끊김 — 재연결 시도 중' }[state] || '';
}

function connectWs() {
  clearTimeout(WSs.timer);
  if (WSs.ws) { WSs.ws.onclose = null; WSs.ws.onerror = null; try { WSs.ws.close(); } catch {} }
  const iv = S.iv;
  const url = `${WS_BASES[WSs.idx % WS_BASES.length]}${SYMBOL.toLowerCase()}@kline_${iv}`;
  setConn('wait');
  let ws;
  try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
  WSs.ws = ws; WSs.gotMsg = false;
  ws.onopen = () => { WSs.retry = 0; setConn('ok'); backfill(); };
  ws.onmessage = ev => {
    WSs.gotMsg = true;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const k = m.k; if (!k || k.i !== S.iv) return;
    onLiveBar({ time: msToChart(k.t), open: +k.o, high: +k.h, low: +k.l, close: +k.c });
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (WSs.ws !== ws) return;
    if (!WSs.gotMsg) WSs.idx++; // 메시지 한 번도 못 받았으면 다른 주소로
    setConn('bad');
    scheduleReconnect();
  };
}
function scheduleReconnect() {
  clearTimeout(WSs.timer);
  const delay = Math.min(30000, 1000 * 2 ** WSs.retry++);
  WSs.timer = setTimeout(connectWs, delay);
}

function onLiveBar(bar) {
  ui.livePrice.textContent = fmtPrice(bar.close);
  document.title = `${fmtPrice(bar.close)} · 내 기록 차트`;
  if (!S.atLatest || !S.bars.length) return;
  const last = S.bars[S.bars.length - 1];
  if (bar.time < last.time) return;
  if (bar.time === last.time) S.bars[S.bars.length - 1] = bar;
  else if (bar.time === last.time + sec()) S.bars.push(bar);
  else { backfill(); return; } // 빈 구간 생김 → REST로 메움
  series.update(bar);
  updateLegend();
}

// 끊겼다 이어졌을 때 빠진 봉을 채운다
let backfilling = false;
async function backfill() {
  if (backfilling || !S.atLatest || !S.bars.length) return;
  backfilling = true;
  const gen = S.gen, iv = S.iv;
  try {
    for (let round = 0; round < 3; round++) {
      const last = S.bars[S.bars.length - 1].time;
      const got = await fetchKlines(iv, { startTime: chartToMs(last) });
      if (gen !== S.gen || iv !== S.iv) return;
      applyBars(mergeBars(S.bars, got), 0);
      if (got.length < PAGE) return;
    }
    loadLatest(); // 너무 오래 끊겼으면 최신 구간을 새로 받는다
  } catch { /* 다음 연결 때 다시 */ }
  finally { backfilling = false; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!WSs.ws || WSs.ws.readyState > 1) { WSs.retry = 0; connectWs(); }
  else backfill();
});

// ───────────────────────── 범례 (마우스·탭 위치의 봉 OHLC)
let hoverT = null;
function updateLegend() {
  const b = S.bars;
  let bar = null;
  if (hoverT != null) { const i = indexAtOrBefore(hoverT); if (i >= 0 && b[i].time === hoverT) bar = b[i]; }
  if (!bar) bar = b[b.length - 1];
  if (!bar) { ui.legend.innerHTML = S.busy ? '<span class="busy">불러오는 중…</span>' : ''; return; }
  const chg = (bar.close - bar.open) / bar.open * 100;
  const cls = bar.close >= bar.open ? 'u' : 'd';
  ui.legend.innerHTML =
    `<span class="t">${fmtChartTime(bar.time)}</span>` +
    `<span>O <b class="${cls}">${fmtPrice(bar.open)}</b></span>` +
    `<span>H <b class="${cls}">${fmtPrice(bar.high)}</b></span>` +
    `<span>L <b class="${cls}">${fmtPrice(bar.low)}</b></span>` +
    `<span>C <b class="${cls}">${fmtPrice(bar.close)}</b></span>` +
    `<span class="${cls}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` +
    (S.busy ? '<span class="busy">불러오는 중…</span>' : '');
}

// ───────────────────────── 색 (트레이딩뷰 기본 10색에서 남보라를 빼고 흰색을 넣음)
const PALETTE = ['#ffffff', '#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#9c27b0', '#e91e63'];
const DEFAULT_COLOR = { hline: C.hline, vline: C.hline, ray: C.ray, dot: C.dot, box: C.box, text: '#ffffff' };
const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const colorOf = d => (isHex(d.c) ? d.c : DEFAULT_COLOR[d.type]);
// 밝은 바탕(흰·노랑 등)엔 어두운 글씨
function labelTextColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? C.bg : '#ffffff';
}
// 도구별 마지막에 쓴 색
const toolColors = { ...DEFAULT_COLOR };
for (const [k, v] of Object.entries(store.get(PREF_KEY, {}).colors || {})) if (k in toolColors && isHex(v)) toolColors[k] = v;
function saveToolColors() { store.set(PREF_KEY, { ...store.get(PREF_KEY, {}), colors: toolColors }); }

// ───────────────────────── 기기 간 동기화를 위한 변경 기록
// 항목마다 마지막으로 바뀐 시각 u(ms)를 달고, 지운 항목은 '지움 기록'(id → 지운 시각)으로 남긴다.
// 저장할 때 직전 저장본과 비교해서 바뀐 것만 u를 새로 찍으므로, 되돌리기로 되살린 것도 '최신 변경'이 된다.
function changeTracker(items, tombs) {
  const keyOf = d => { const { u, ...rest } = d; return JSON.stringify(rest); };
  let saved = new Map(items.map(d => [d.id, keyOf(d)]));
  return {
    stamp(list) {
      const now = Date.now();
      const ids = new Set();
      for (const d of list) {
        ids.add(d.id);
        if (saved.get(d.id) !== keyOf(d)) { d.u = now; delete tombs[d.id]; }
      }
      for (const id of saved.keys()) if (!ids.has(id)) tombs[id] = now;
      saved = new Map(list.map(d => [d.id, keyOf(d)]));
    },
    reset(list) { saved = new Map(list.map(d => [d.id, keyOf(d)])); },
  };
}
// 두 기기 내용 합치기: 같은 항목은 더 늦게 바뀐 쪽, 지움 기록이 더 늦으면 지운 것으로
function mergeSide(aItems, aTombs, bItems, bTombs) {
  const tombs = { ...bTombs };
  for (const [id, ts] of Object.entries(aTombs || {})) tombs[id] = Math.max(ts, tombs[id] || 0);
  const byId = new Map();
  for (const d of [...(bItems || []), ...(aItems || [])]) {
    const cur = byId.get(d.id);
    if (!cur || (d.u || 0) >= (cur.u || 0)) byId.set(d.id, d);
  }
  const items = [...byId.values()].filter(d => !((tombs[d.id] || -1) >= (d.u || 0)));
  const old = Date.now() - 180 * 86400000; // 반년 지난 지움 기록은 정리
  for (const id of Object.keys(tombs)) if (tombs[id] < old) delete tombs[id];
  return { items, tombs };
}

// ───────────────────────── 그림 (시각·가격으로 저장 → 확대·스크롤·간격 변경에도 따라온다)
// 저장 형식: { id, type: 'hline'|'vline'|'ray'|'dot'|'box'|'text', p?, t?, p2?, t2?, c?, text? }  (t = 실제 UTC ms, c = 색 #rrggbb)
const TEXT_FONT = "600 13px 'Pretendard Variable', -apple-system, sans-serif";
const TEXT_MAX = 60;
const drawings = (() => {
  const stored = store.get(STORE_KEY, { drawings: [] }) || {};
  let list = (stored.drawings || []).filter(valid);
  let tombs = stored.deleted && typeof stored.deleted === 'object' ? stored.deleted : {};
  const tracker = changeTracker(list, tombs);
  let onChange = () => {};
  let pending = null;   // 박스 첫 꼭짓점 {t, p}
  let preview = null;   // 박스 미리보기 둘째 꼭짓점 {t, p}
  let hot = null;       // 지우기 후보 id
  let sel = null;       // 수정 중인 그림 id
  let requestUpdate = () => {};
  // 되돌리기: 바꾸기 직전 목록을 쌓아 둔다 (최대 50단계, 새로고침하면 비워짐)
  let history = [];
  let onHistory = () => {};
  function snapshot() {
    history.push(JSON.stringify(list));
    if (history.length > 50) history.shift();
    onHistory(history.length);
  }
  const measure = document.createElement('canvas').getContext('2d');
  function textWidth(t) { measure.font = TEXT_FONT; return measure.measureText(t).width; }
  let axisViews = [];

  function valid(d) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string') return false;
    const num = v => typeof v === 'number' && isFinite(v);
    switch (d.type) {
      case 'hline': return num(d.p);
      case 'vline': return num(d.t);
      case 'ray': case 'dot': return num(d.p) && num(d.t);
      case 'box': return num(d.p) && num(d.t) && num(d.p2) && num(d.t2);
      case 'text': return num(d.p) && num(d.t) && typeof d.text === 'string' && d.text.trim().length > 0 && d.text.length <= 200;
      default: return false;
    }
  }
  function persist(fromSync = false) {
    if (!fromSync) tracker.stamp(list);
    if (!store.set(STORE_KEY, { version: 2, drawings: list, deleted: tombs })) {
      toast('이 브라우저에 저장하지 못했습니다 (개인정보 보호 모드?) — 내보내기로 백업하세요', { error: true, ms: 6000 });
    }
    rebuildAxis();
    requestUpdate();
    $('drawCount').textContent = list.length;
    if (!fromSync) onChange();
  }

  // 가격축 라벨: 수평선·레이 / 시간축 라벨: 수직선
  let timeViews = [];
  function rebuildAxis() {
    timeViews = list.filter(d => d.type === 'vline').map(d => ({
      coordinate: () => cx(d) ?? -100,
      text: () => fmtChartTime(msToChart(d.t)),
      textColor: () => (hot === d.id ? '#ffffff' : labelTextColor(colorOf(d))),
      backColor: () => (hot === d.id ? C.erase : colorOf(d)),
    }));
    axisViews = list.filter(d => d.type === 'hline' || d.type === 'ray').map(d => {
      return {
        coordinate: () => series.priceToCoordinate(d.p) ?? -100,
        text: () => fmtAxis(d.p),
        textColor: () => (hot === d.id ? '#ffffff' : labelTextColor(colorOf(d))),
        backColor: () => (hot === d.id ? C.erase : colorOf(d)),
      };
    });
  }

  const cx = d => timeToX(msToChart(d.t));
  const cy = p => series.priceToCoordinate(p);

  function draw(ctx, w, h) {
    // 날짜 이동 표시
    if (S.jumpT != null) {
      const x = timeToX(S.jumpT);
      if (x != null && x >= 0 && x <= w) {
        ctx.save(); ctx.strokeStyle = C.jump; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); ctx.stroke();
        ctx.restore();
      }
    }
    for (const d of list) drawOne(ctx, d, w, h, hot === d.id);
    const sd = sel && list.find(d => d.id === sel);
    if (sd) drawHandles(ctx, sd, w, h);
    if (pending) {
      const c = toolColors.box;
      const a = { type: 'dot', t: pending.t, p: pending.p, c };
      if (preview) drawOne(ctx, { type: 'box', t: pending.t, p: pending.p, t2: preview.t, p2: preview.p, c }, w, h, false, true);
      drawOne(ctx, a, w, h, false);
    }
  }

  function drawOne(ctx, d, w, h, isHot, ghost = false) {
    if (d.type === 'vline') {
      const x = cx(d); if (x == null) return;
      ctx.save();
      ctx.lineWidth = isHot ? 2.5 : 1.5;
      ctx.strokeStyle = isHot ? C.erase : colorOf(d);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); ctx.stroke();
      ctx.restore();
      return;
    }
    const y = cy(d.p);
    if (y == null) return;
    ctx.save();
    ctx.lineWidth = isHot ? 2.5 : 1.5;
    const color = colorOf(d);
    switch (d.type) {
      case 'hline': {
        ctx.strokeStyle = isHot ? C.erase : color;
        ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); ctx.stroke();
        break;
      }
      case 'ray': {
        const x = cx(d); if (x == null) break;
        const col = isHot ? C.erase : color;
        ctx.strokeStyle = col; ctx.fillStyle = col;
        const yy = Math.round(y) + 0.5;
        ctx.beginPath(); ctx.moveTo(Math.max(x, -10), yy); ctx.lineTo(w, yy); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'dot': {
        const x = cx(d); if (x == null) break;
        ctx.fillStyle = isHot ? C.erase : color;
        ctx.strokeStyle = C.bg; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, isHot ? 6 : 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        break;
      }
      case 'box': {
        const x1 = cx(d), x2 = timeToX(msToChart(d.t2)), y2 = cy(d.p2);
        if (x1 == null || x2 == null || y2 == null) break;
        const l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y, y2), b = Math.max(y, y2);
        ctx.strokeStyle = isHot ? C.erase : color;
        if (ghost) ctx.setLineDash([4, 3]);
        ctx.strokeRect(Math.round(l) + 0.5, Math.round(t) + 0.5, Math.round(r - l), Math.round(b - t));
        break;
      }
      case 'text': {
        const x = cx(d); if (x == null) break;
        ctx.font = TEXT_FONT; ctx.textBaseline = 'middle';
        // 캔들 위에서도 읽히게 옅은 어두운 바탕
        const tw = textWidth(d.text);
        ctx.fillStyle = 'rgba(10,14,20,0.6)';
        ctx.fillRect(x + 1, y - 10, tw + 6, 20);
        ctx.fillStyle = isHot ? C.erase : color;
        ctx.fillText(d.text, x + 4, y);
        break;
      }
    }
    ctx.restore();
  }

  // 수정 손잡이: 박스는 네 꼭짓점, 레이·점·글은 시작점, 수평선·수직선은 화면 가운데 한 점
  function handlesOf(d, w, h) {
    if (d.type === 'vline') { const x = cx(d); return x == null ? [] : [{ x, y: h / 2, tk: 't', pk: null }]; }
    const y = cy(d.p); if (y == null) return [];
    if (d.type === 'hline') return [{ x: w / 2, y, tk: null, pk: 'p' }];
    const x = cx(d); if (x == null) return [];
    if (d.type !== 'box') return [{ x, y, tk: 't', pk: 'p' }];
    const x2 = timeToX(msToChart(d.t2)), y2 = cy(d.p2);
    if (x2 == null || y2 == null) return [];
    return [
      { x, y, tk: 't', pk: 'p' }, { x: x2, y, tk: 't2', pk: 'p' },
      { x, y: y2, tk: 't', pk: 'p2' }, { x: x2, y: y2, tk: 't2', pk: 'p2' },
    ];
  }
  function drawHandles(ctx, d, w, h) {
    ctx.save();
    ctx.fillStyle = C.bg; ctx.strokeStyle = C.btc; ctx.lineWidth = 2;
    for (const hd of handlesOf(d, w, h)) {
      ctx.beginPath(); ctx.arc(hd.x, hd.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  // 지우기용: 탭 위치에서 가장 가까운 그림 (px 거리)
  function hitTest(px, py, tol = 16, only = null) {
    let best = null, bestD = tol;
    for (const d of only ? list.filter(x => x.id === only) : list) {
      if (d.type === 'vline') {
        const x = cx(d);
        if (x != null && Math.abs(px - x) < bestD) { bestD = Math.abs(px - x); best = d; }
        continue;
      }
      const y = cy(d.p); if (y == null) continue;
      let dist = Infinity;
      if (d.type === 'hline') dist = Math.abs(py - y);
      else if (d.type === 'dot') { const x = cx(d); if (x != null) dist = Math.hypot(px - x, py - y); }
      else if (d.type === 'ray') {
        const x = cx(d); if (x == null) continue;
        dist = px >= x ? Math.abs(py - y) : Math.hypot(px - x, py - y);
      } else if (d.type === 'text') {
        const x = cx(d); if (x == null) continue;
        const l = x, r = x + 4 + textWidth(d.text), t = y - 9, b = y + 9;
        dist = Math.hypot(Math.max(l - px, 0, px - r), Math.max(t - py, 0, py - b));
      } else if (d.type === 'box') {
        const x1 = cx(d), x2 = timeToX(msToChart(d.t2)), y2 = cy(d.p2);
        if (x1 == null || x2 == null || y2 == null) continue;
        const l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y, y2), b = Math.max(y, y2);
        const inside = px >= l && px <= r && py >= t && py <= b;
        const edge = Math.min(
          px >= l - tol && px <= r + tol ? Math.min(Math.abs(py - t), Math.abs(py - b)) : Infinity,
          py >= t - tol && py <= b + tol ? Math.min(Math.abs(px - l), Math.abs(px - r)) : Infinity,
        );
        dist = inside ? Math.min(edge, tol - 1) : edge; // 안쪽 탭도 지울 수 있게, 선은 우선
      }
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  }

  const paneView = {
    zOrder: () => 'top',
    renderer: () => ({
      draw: target => target.useMediaCoordinateSpace(({ context, mediaSize }) => draw(context, mediaSize.width, mediaSize.height)),
    }),
  };
  const paneViews = [paneView];
  const primitive = {
    attached: p => { requestUpdate = p.requestUpdate; },
    detached: () => { requestUpdate = () => {}; },
    updateAllViews: () => {},
    paneViews: () => paneViews,
    priceAxisViews: () => axisViews,
    timeAxisViews: () => timeViews,
  };
  series.attachPrimitive(primitive);
  rebuildAxis();
  $('drawCount').textContent = list.length;

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  return {
    refresh: () => requestUpdate(),
    all: () => list.slice(),
    count: () => list.length,
    add(d) { snapshot(); list.push({ id: newId(), ...d }); persist(); },
    remove(id) { snapshot(); list = list.filter(d => d.id !== id); hot = null; if (sel === id) sel = null; persist(); },
    snapshot,
    undo() {
      if (!history.length) return false;
      list = JSON.parse(history.pop()).filter(valid);
      hot = null;
      persist();
      onHistory(history.length);
      return true;
    },
    onHistory(cb) { onHistory = cb; cb(history.length); },
    // 동기화용
    onChange(cb) { onChange = cb; },
    syncState: () => ({ items: list.map(d => ({ ...d })), tombs: { ...tombs } }),
    applySync(items, newTombs) {
      list = items.filter(valid).map(d => ({ ...d }));
      for (const k of Object.keys(tombs)) delete tombs[k];
      Object.assign(tombs, newTombs);
      tracker.reset(list);
      hot = null;
      persist(true);
    },
    get: id => list.find(d => d.id === id) || null,
    // 끄는 동안은 그리기만 다시 하고, 손을 뗄 때 save()로 저장
    patch(id, fields) { const d = list.find(x => x.id === id); if (d) { Object.assign(d, fields); requestUpdate(); } },
    save: () => persist(),
    setSel(id) { sel = id; requestUpdate(); },
    getSel: () => sel,
    handleAt(px, py, w, h, tol) {
      const d = sel && list.find(x => x.id === sel); if (!d) return null;
      let best = null, bestD = tol;
      for (const hd of handlesOf(d, w, h)) { const dist = Math.hypot(px - hd.x, py - hd.y); if (dist < bestD) { bestD = dist; best = hd; } }
      return best;
    },
    clear() { snapshot(); list = []; sel = null; persist(); },
    importMany(arr) {
      snapshot();
      const have = new Set(list.map(d => d.id));
      let added = 0, bad = 0;
      for (const d of arr) {
        if (!valid(d)) { bad++; continue; }
        if (have.has(d.id)) continue;
        const clean = { id: d.id, type: d.type };
        if (d.p != null) clean.p = d.p;
        if (d.t != null) clean.t = d.t;
        if (d.type === 'box') { clean.p2 = d.p2; clean.t2 = d.t2; }
        if (isHex(d.c)) clean.c = d.c;
        if (d.type === 'text') clean.text = d.text;
        list.push(clean); have.add(d.id); added++;
      }
      if (!added) { history.pop(); onHistory(history.length); }
      persist();
      return { added, bad };
    },
    hitTest,
    setPending(p) { pending = p; preview = null; requestUpdate(); },
    getPending: () => pending,
    setPreview(p) { preview = p; requestUpdate(); },
    setHot(id) { if (hot !== id) { hot = id; rebuildAxis(); requestUpdate(); } },
  };
})();

// ───────────────────────── 도구 (버튼 → 탭 1번 / 박스는 2번 → 다시 커서로)
let tool = null;
const HINTS = {
  hline: '수평선 — 가격 위치를 탭하세요',
  vline: '수직선 — 시각(봉) 위치를 탭하세요',
  dot: '점 — 찍을 위치를 탭하세요',
  ray: '레이 — 시작점을 탭하세요 (오른쪽으로 뻗음)',
  box: '박스 — 첫 꼭짓점을 탭하세요',
  box2: '박스 — 반대쪽 꼭짓점을 탭하세요',
  erase: '지우기 — 지울 그림을 탭하세요',
  text: '텍스트 — 넣을 위치를 탭하세요',
  edit: '끌어서 이동 · ○로 크기 조절',
  editText: '끌어서 이동',
};

function setTool(t) {
  if (t) select(null);
  tool = t;
  drawings.setPending(null);
  drawings.setHot(null);
  document.querySelectorAll('#tools .tool[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  showHint(t ? HINTS[t] : null);
}
function showHint(text) {
  ui.hint.classList.toggle('show', !!text);
  ui.hint.classList.toggle('erase', tool === 'erase');
  ui.hintText.textContent = text || '';
  $('hintDelete').hidden = !drawings.getSel();
  const sd0 = drawings.getSel() && drawings.get(drawings.getSel());
  $('hintEditText').hidden = !(sd0 && sd0.type === 'text');
  $('hintCancel').textContent = drawings.getSel() ? '완료' : '취소';
  renderSwatches();
}

// 색 고르기: 도구를 고른 상태면 새로 그릴 색, 그림을 선택한 상태면 그 그림의 색
function renderSwatches() {
  const box = $('swatches');
  const sd = drawings.getSel() && drawings.get(drawings.getSel());
  const type = sd ? sd.type : (tool && tool !== 'erase' ? tool : null);
  box.hidden = !type;
  if (!type) return;
  const cur = sd ? colorOf(sd) : toolColors[type];
  box.innerHTML = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = 'sw' + (c.toLowerCase() === cur.toLowerCase() ? ' on' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      toolColors[type] = c; saveToolColors();
      const id = drawings.getSel();
      if (id) { drawings.snapshot(); drawings.patch(id, { c }); drawings.save(); }
      drawings.refresh();
      renderSwatches();
    });
    box.appendChild(b);
  }
}

// 그림 선택(수정 모드): 선택 중엔 차트 끌기·확대를 잠가서 손가락이 그림만 움직이게 한다
function select(id) {
  if (id === drawings.getSel()) return;
  drawings.setSel(id);
  chart.applyOptions({ handleScroll: !id, handleScale: !id });
  if (id) { tool = null; document.querySelectorAll('#tools .tool').forEach(b => b.classList.remove('on')); }
  showHint(id ? editHint() : null);
}
function editHint() {
  const d = drawings.getSel() && drawings.get(drawings.getSel());
  return d && d.type === 'box' ? HINTS.edit : HINTS.editText; // 크기 조절은 박스만
}

document.querySelectorAll('#tools .tool[data-tool]').forEach(b => {
  b.addEventListener('click', () => setTool(tool === b.dataset.tool ? null : b.dataset.tool));
});

// 되돌리기
function undo() {
  const sid = drawings.getSel();
  if (!drawings.undo()) { toast('되돌릴 것이 없습니다', { ms: 1500 }); return; }
  if (sid && !drawings.get(sid)) select(null);
  else if (sid) showHint(editHint());
}
$('undoBtn').addEventListener('click', undo);
drawings.onHistory(n => { $('undoBtn').disabled = !n; });

// 텍스트 입력창 (새로 넣기 / 고치기)
let textCtx = null; // { mode: 'new', pt, c } | { mode: 'edit', id }
function openTextModal(ctx, value) {
  textCtx = ctx;
  $('textInput').value = value || '';
  openModal('textModal');
  setTimeout(() => $('textInput').focus(), 0);
}
function commitText() {
  const v = $('textInput').value.trim().slice(0, TEXT_MAX);
  closeModal($('textModal'));
  const ctx = textCtx; textCtx = null;
  if (!ctx || !v) return;
  if (ctx.mode === 'new') drawings.add({ type: 'text', t: ctx.pt.t, p: ctx.pt.p, c: ctx.c, text: v });
  else if (drawings.get(ctx.id) && drawings.get(ctx.id).text !== v) {
    drawings.snapshot(); drawings.patch(ctx.id, { text: v }); drawings.save();
  }
}
$('textOk').addEventListener('click', commitText);
$('textInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitText(); } });
$('hintEditText').addEventListener('click', () => {
  const d = drawings.get(drawings.getSel());
  if (d && d.type === 'text') openTextModal({ mode: 'edit', id: d.id }, d.text);
});
$('hintCancel').addEventListener('click', () => { select(null); setTool(null); });
$('hintDelete').addEventListener('click', () => { const id = drawings.getSel(); select(null); if (id) drawings.remove(id); });

function pointAt(x, y) {
  if (!S.bars.length) return null;
  const p = series.coordinateToPrice(y);
  const l = ts.coordinateToLogical(x);
  if (p == null || l == null) return null;
  return { t: chartToMs(logicalToTime(l)), p: Math.round(p * 100) / 100 };
}

// 탭 처리는 직접 한다: 차트 자체 click은 0.5초 안의 두 번째 클릭을 더블클릭 대기로 삼켜서
// 박스 두 꼭짓점을 빨리 찍으면 빠진다.
const chartEl = $('chart');
const taps = new Map(); // pointerId → {x, y, t}
let multiTouch = false;
let drag = null; // {id, pointerId, handle|null, start:{l,p}, orig}
function localXY(e) {
  const r = chartEl.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width - chart.priceScale('right').width(), h: r.height - ts.height() };
}
chartEl.addEventListener('pointerdown', e => {
  taps.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
  if (taps.size > 1) { multiTouch = true; drag = null; return; }
  const sid = drawings.getSel();
  if (!sid || tool) return;
  const { x, y, w, h } = localXY(e);
  const tol = e.pointerType === 'mouse' ? 10 : 22;
  const handle = drawings.handleAt(x, y, w, h, tol);
  if (!handle && !drawings.hitTest(x, y, tol, sid)) return;
  const l = ts.coordinateToLogical(x), p = series.coordinateToPrice(y);
  if (l == null || p == null) return;
  drag = { id: sid, pointerId: e.pointerId, handle, start: { l, p }, orig: { ...drawings.get(sid) }, moved: false };
  try { chartEl.setPointerCapture(e.pointerId); } catch {}
}, true);
chartEl.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { x, y } = localXY(e);
  const l = ts.coordinateToLogical(x), p = series.coordinateToPrice(y);
  if (l == null || p == null) return;
  if (!drag.moved) drawings.snapshot(); // 끌기 한 번 = 되돌리기 한 단계
  drag.moved = true;
  const o = drag.orig, round = v => Math.round(v * 100) / 100;
  if (drag.handle) {
    // 손잡이: 그 꼭짓점만 손가락 위치로
    const f = drag.handle.pk ? { [drag.handle.pk]: round(p) } : {};
    if (drag.handle.tk) f[drag.handle.tk] = chartToMs(logicalToTime(l));
    drawings.patch(drag.id, f);
  } else {
    // 몸통: 가격·봉 개수만큼 통째로 이동
    const dp = p - drag.start.p, dl = Math.round(l - drag.start.l);
    const shiftT = t => chartToMs(logicalToTime(timeToLogical(msToChart(t)) + dl));
    const f = o.p != null ? { p: round(o.p + dp) } : {};
    if (o.t != null) f.t = shiftT(o.t);
    if (o.type === 'box') { f.p2 = round(o.p2 + dp); f.t2 = shiftT(o.t2); }
    drawings.patch(drag.id, f);
  }
}, true);
const endTap = e => {
  if (drag && e.pointerId === drag.pointerId) {
    const moved = drag.moved;
    drag = null;
    if (moved) { drawings.save(); taps.delete(e.pointerId); return; }
  }
  const d = taps.get(e.pointerId);
  taps.delete(e.pointerId);
  if (!d) return;
  const wasMulti = multiTouch;
  if (!taps.size) multiTouch = false;
  if (e.type !== 'pointerup' || wasMulti || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 600) return; // 끌기·길게 누르기는 탭 아님
  const r = chartEl.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const paneW = r.width - chart.priceScale('right').width(), paneH = r.height - ts.height();
  if (x < 0 || y < 0 || x > paneW || y > paneH) return; // 축 위 탭은 무시
  onTap(x, y);
};
chartEl.addEventListener('pointerup', endTap, true);
chartEl.addEventListener('pointercancel', endTap, true);

function onTap(x, y) {
  if (!tool) {
    if (notes.tap(x, y)) return; // 내 기록 점이 먼저
    // 도구 없이 탭: 그림을 고르면 수정 모드, 빈 곳이면 해제
    const sid = drawings.getSel();
    if (sid && drawings.hitTest(x, y, 22, sid)) return;
    const hit = drawings.hitTest(x, y, 18);
    select(hit ? hit.id : null);
    return;
  }
  if (tool === 'erase') {
    const hit = drawings.hitTest(x, y);
    if (hit) { drawings.remove(hit.id); setTool(null); }
    else toast('여기엔 지울 그림이 없습니다', { ms: 1500 });
    return;
  }
  const pt = pointAt(x, y);
  if (!pt) return;
  const c = toolColors[tool];
  if (tool === 'hline') drawings.add({ type: 'hline', p: pt.p, c });
  else if (tool === 'vline') drawings.add({ type: 'vline', t: pt.t, c });
  else if (tool === 'dot') drawings.add({ type: 'dot', t: pt.t, p: pt.p, c });
  else if (tool === 'ray') drawings.add({ type: 'ray', t: pt.t, p: pt.p, c });
  else if (tool === 'text') { setTool(null); openTextModal({ mode: 'new', pt, c }, ''); return; }
  else if (tool === 'box') {
    const first = drawings.getPending();
    if (!first) { drawings.setPending(pt); showHint(HINTS.box2); return; }
    if (first.t === pt.t && first.p === pt.p) return;
    drawings.add({ type: 'box', t: first.t, p: first.p, t2: pt.t, p2: pt.p, c });
  }
  setTool(null);
}

chart.subscribeCrosshairMove(param => {
  hoverT = param.time ?? null;
  updateLegend();
  if (!tool || !param.point) { if (tool === 'erase') drawings.setHot(null); return; }
  if (tool === 'erase') {
    const hit = drawings.hitTest(param.point.x, param.point.y);
    drawings.setHot(hit ? hit.id : null);
  } else if (tool === 'box' && drawings.getPending()) {
    const pt = pointAt(param.point.x, param.point.y);
    if (pt) drawings.setPreview(pt);
  }
});

// ───────────────────────── 시점 북마크 (보던 시각·봉 간격·확대 정도를 저장 → 누르면 그대로 돌아감)
// 저장 형식: { id, name, t (화면 가운데 실제 ms), iv, w (보이는 봉 수) }
const bookmarks = (() => {
  const ok = b => b && typeof b.id === 'string' && typeof b.name === 'string'
    && Number.isFinite(b.t) && IVS[b.iv] && Number.isFinite(b.w);
  const raw = store.get(BM_KEY, []) || [];
  let list = (Array.isArray(raw) ? raw : raw.items || []).filter(ok);
  let tombs = (!Array.isArray(raw) && raw.deleted) || {};
  const tracker = changeTracker(list, tombs);
  let onChange = () => {};
  const persist = (fromSync = false) => {
    if (!fromSync) tracker.stamp(list);
    if (!store.set(BM_KEY, { items: list, deleted: tombs })) toast('이 브라우저에 저장하지 못했습니다', { error: true });
    render();
    if (!fromSync) onChange();
  };

  function render() {
    const ul = $('bmList');
    ul.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li'); li.className = 'bm-empty';
      li.textContent = '아직 없음 — 공부하던 자리에서 저장해 두면 여기서 바로 돌아갑니다';
      ul.appendChild(li);
    }
    for (const b of list) {
      const li = document.createElement('li');
      const go = document.createElement('button'); go.className = 'bm-go';
      const nm = document.createElement('span'); nm.className = 'bm-name'; nm.textContent = b.name;
      const sub = document.createElement('span'); sub.className = 'bm-sub';
      sub.textContent = `${fmtChartTime(msToChart(b.t))} · ${{ '5m': '5분', '15m': '15분', '1h': '1시간' }[b.iv]}`;
      go.append(nm, sub);
      go.addEventListener('click', () => { closeModal($('gotoModal')); goTo(b); });
      const del = document.createElement('button'); del.className = 'bm-del'; del.textContent = '✕'; del.title = '삭제';
      del.addEventListener('click', () => {
        if (!confirm(`'${b.name}' 북마크를 지울까요?`)) return;
        list = list.filter(x => x.id !== b.id); persist();
      });
      li.append(go, del);
      ul.appendChild(li);
    }
    $('bmCount').textContent = list.length;
  }

  function goTo(b) {
    if (b.iv !== S.iv) switchInterval(b.iv, { centerMs: b.t, width: b.w });
    else jumpTo(b.t, { mark: false, width: b.w });
  }

  function saveCurrent(name) {
    const r = ts.getVisibleLogicalRange();
    if (!r || !S.bars.length) { toast('차트가 아직 안 떴습니다', { error: true }); return; }
    const t = chartToMs(logicalToTime((r.from + r.to) / 2));
    const b = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: (name || '').trim() || fmtChartTime(msToChart(t)),
      t, iv: S.iv, w: Math.round(r.to - r.from),
    };
    list.unshift(b); persist();
    toast(`📌 '${b.name}' 저장했습니다`);
  }

  function importMany(arr) {
    if (!Array.isArray(arr)) return 0;
    const have = new Set(list.map(b => b.id));
    let added = 0;
    for (const b of arr) {
      if (!ok(b) || have.has(b.id)) continue;
      list.push({ id: b.id, name: b.name, t: b.t, iv: b.iv, w: b.w }); have.add(b.id); added++;
    }
    list.sort((a, b) => b.id.localeCompare(a.id)); // 최근 저장한 것이 위로 (id가 저장 시각 기반)
    persist();
    return added;
  }

  render();
  function applySync(items, newTombs) {
    list = items.filter(ok).map(b => ({ ...b }));
    list.sort((a, b) => b.id.localeCompare(a.id));
    for (const k of Object.keys(tombs)) delete tombs[k];
    Object.assign(tombs, newTombs);
    tracker.reset(list);
    persist(true);
  }
  return {
    all: () => list.map(({ u, ...b }) => b), count: () => list.length, saveCurrent, importMany, goTo,
    onChange(cb) { onChange = cb; },
    syncState: () => ({ items: list.map(b => ({ ...b })), tombs: { ...tombs } }),
    applySync,
  };
})();

$('bmSave').addEventListener('click', () => { bookmarks.saveCurrent($('bmName').value); $('bmName').value = ''; });
$('bmName').addEventListener('keydown', e => { if (e.key === 'Enter') $('bmSave').click(); });

// ───────────────────────── 팝업
function openModal(id) { $(id).classList.add('show'); }
function closeModal(el) {
  el.classList.remove('show');
  if (el.contains(document.activeElement)) document.activeElement.blur(); // 숨은 입력칸이 단축키를 막지 않게
}
document.querySelectorAll('.backdrop').forEach(bd => {
  bd.addEventListener('click', e => { if (e.target === bd || e.target.hasAttribute('data-close')) closeModal(bd); });
});

// 날짜 이동 (입력은 KST)
function kstInputValue(ms) {
  const d = new Date(ms + KST * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function parseKstInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - KST * 1000;
}
$('gotoBtn').addEventListener('click', () => {
  const inp = $('gotoInput');
  inp.max = kstInputValue(Date.now());
  if (!inp.value) {
    const r = ts.getVisibleLogicalRange();
    inp.value = kstInputValue(r && S.bars.length ? chartToMs(logicalToTime((r.from + r.to) / 2)) : Date.now());
  }
  openModal('gotoModal');
});
function doGoto(ms) {
  if (ms == null || isNaN(ms)) { toast('날짜·시각을 입력하세요', { error: true }); return; }
  if (ms > Date.now()) ms = Date.now();
  closeModal($('gotoModal'));
  jumpTo(ms);
}
$('gotoGo').addEventListener('click', () => doGoto(parseKstInput($('gotoInput').value)));
$('gotoInput').addEventListener('keydown', e => { if (e.key === 'Enter') doGoto(parseKstInput(e.target.value)); });
document.querySelectorAll('#gotoModal [data-ago]').forEach(b => b.addEventListener('click', () => {
  const ms = Date.now() - (+b.dataset.ago) * 86400000;
  $('gotoInput').value = kstInputValue(ms);
  doGoto(ms);
}));
document.querySelectorAll('#gotoModal [data-date]').forEach(b => b.addEventListener('click', () => {
  $('gotoInput').value = b.dataset.date;
  doGoto(parseKstInput(b.dataset.date));
}));

$('latestBtn').addEventListener('click', () => {
  S.jumpT = null;
  if (S.atLatest) { ts.scrollToRealTime(); drawings.refresh(); }
  else loadLatest();
});

// 내보내기 / 가져오기
function exportPayload() {
  return JSON.stringify({
    app: 'btc-psych-chart', version: 1, symbol: SYMBOL,
    exportedAt: new Date().toISOString(), drawings: drawings.all(), bookmarks: bookmarks.all(),
  }, null, 1);
}
$('dataBtn').addEventListener('click', () => {
  $('drawCount').textContent = drawings.count();
  $('bmCount2').textContent = bookmarks.count();
  openModal('dataModal');
});
$('exportFile').addEventListener('click', () => {
  const blob = new Blob([exportPayload()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `btc-psych-drawings-${kstInputValue(Date.now()).replace(/[-:]/g, '').replace('T', '-')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('exportCopy').addEventListener('click', async () => {
  const text = exportPayload();
  try { await navigator.clipboard.writeText(text); toast(`그림 ${drawings.count()}개 · 북마크 ${bookmarks.count()}개를 복사했습니다`); }
  catch { $('importText').value = text; $('importText').select(); toast('자동 복사가 막혀 있어요 — 아래 칸의 텍스트를 직접 복사하세요', { ms: 5000 }); }
});
function importText(text) {
  let data;
  try { data = JSON.parse(text); } catch { toast('JSON 형식이 아닙니다', { error: true }); return; }
  const arr = Array.isArray(data) ? data : data && data.drawings;
  if (!Array.isArray(arr)) { toast('그림 목록을 찾지 못했습니다', { error: true }); return; }
  const { added, bad } = drawings.importMany(arr);
  const bmAdded = bookmarks.importMany(data && data.bookmarks);
  $('drawCount').textContent = drawings.count();
  $('bmCount2').textContent = bookmarks.count();
  toast(`그림 ${added}개${bmAdded ? ` · 북마크 ${bmAdded}개` : ''} 가져왔습니다${bad ? ` (잘못된 항목 ${bad}개 건너뜀)` : ''}`);
}
$('importFileBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  importText(await f.text());
  e.target.value = '';
});
$('importPaste').addEventListener('click', () => {
  const v = $('importText').value.trim();
  if (!v) { toast('붙여넣은 내용이 없습니다', { error: true }); return; }
  importText(v);
  $('importText').value = '';
});
$('clearAll').addEventListener('click', () => {
  if (!drawings.count()) return;
  if (!confirm(`그림 ${drawings.count()}개를 모두 지울까요? (먼저 내보내기로 백업 권장)`)) return;
  drawings.clear();
  $('drawCount').textContent = 0;
});

// 봉 간격 버튼
document.querySelectorAll('#ivSeg button').forEach(b => b.addEventListener('click', () => switchInterval(b.dataset.iv)));

// 단축키 (PC)
document.addEventListener('keydown', e => {
  const inField = e.target.matches('input, textarea');
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !inField) {
    e.preventDefault(); undo(); return;
  }
  if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') {
    const open = document.querySelector('.backdrop.show');
    if (open) closeModal(open); else { select(null); setTool(null); }
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && drawings.getSel()) { $('hintDelete').click(); return; }
  if (document.querySelector('.backdrop.show')) return;
  const map = { h: 'hline', v: 'vline', b: 'box', d: 'dot', r: 'ray', t: 'text', e: 'erase' };
  const k = e.key.toLowerCase();
  if (map[k]) setTool(tool === map[k] ? null : map[k]);
  else if (k === 'g') $('gotoBtn').click();
  else if (k === 'l') $('latestBtn').click();
  else if (k === '1') switchInterval('5m');
  else if (k === '2') switchInterval('15m');
  else if (k === '3') switchInterval('1h');
});

// 와이드 버튼
let wantWide = false;
$('wideBtn')?.addEventListener('click', () => {
  wantWide = !wantWide;
  store.set(PREF_KEY, { ...store.get(PREF_KEY, {}), wide: wantWide });
  wide.apply(wantWide);
});
window.addEventListener('resize', () => wide.apply(wantWide));

// ───────────────────────── 기기 간 자동 동기화 (GitHub 비공개 Gist)
// 열쇠(토큰)는 이 기기 브라우저에만 저장. 그림·북마크만 맞추고 화면 설정(와이드·색 등)은 기기마다 따로.
const sync = (() => {
  const FILE = 'my-chart.json';
  const DESC = '내 기록 차트 동기화 (자동 생성 — 지우지 마세요)';
  let cfg = store.get(SYNC_KEY, null);
  let running = false, again = false, timer = 0, lastErr = '';

  async function gh(path, opts = {}) {
    const res = await fetch('https://api.github.com' + path, {
      ...opts,
      headers: {
        Authorization: 'Bearer ' + cfg.token,
        Accept: 'application/vnd.github+json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      const e = new Error(res.status === 401 ? '열쇠가 틀렸거나 만료됐습니다' : res.status === 404 ? 'not-found' : `GitHub 오류 ${res.status}`);
      e.status = res.status; throw e;
    }
    return res.status === 204 ? null : res.json();
  }

  // 비교가 순서에 흔들리지 않게 정렬해서 직렬화
  const sorted = o => Object.fromEntries(Object.entries(o || {}).sort(([a], [b]) => a.localeCompare(b)));
  const byId = arr => [...(arr || [])].sort((a, b) => a.id.localeCompare(b.id));
  const payload = (d, b) => JSON.stringify({
    app: 'btc-psych-chart', version: 2,
    drawings: byId(d.items), deleted: sorted(d.tombs), bookmarks: byId(b.items), bookmarksDeleted: sorted(b.tombs),
  });

  async function readRemote() {
    const g = await gh(`/gists/${cfg.gistId}`);
    const f = g.files && g.files[FILE];
    if (!f) return {};
    let text = f.content;
    if (f.truncated) text = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
    try { return JSON.parse(text || '{}'); } catch { return {}; }
  }

  async function findOrCreateGist() {
    const list = await gh('/gists?per_page=100');
    const hit = list.find(g => g.files && g.files[FILE]);
    if (hit) return hit.id;
    const g = await gh('/gists', {
      method: 'POST',
      body: JSON.stringify({ description: DESC, public: false, files: { [FILE]: { content: payload(drawings.syncState(), bookmarks.syncState()) } } }),
    });
    return g.id;
  }

  async function syncNow() {
    if (!cfg || !cfg.token) return;
    if (running || drag) { again = true; return; } // 끄는 도중엔 미룬다
    running = true; again = false;
    setStatus('동기화 중…');
    try {
      if (!cfg.gistId) { cfg.gistId = await findOrCreateGist(); store.set(SYNC_KEY, cfg); }
      let remote;
      try { remote = await readRemote(); }
      catch (e) {
        if (e.status !== 404) throw e;
        cfg.gistId = await findOrCreateGist(); store.set(SYNC_KEY, cfg); // Gist가 지워졌으면 새로
        remote = await readRemote();
      }
      const ld = drawings.syncState(), lb = bookmarks.syncState();
      const md = mergeSide(ld.items, ld.tombs, remote.drawings, remote.deleted);
      const mb = mergeSide(lb.items, lb.tombs, remote.bookmarks, remote.bookmarksDeleted);
      const out = payload(md, mb);
      if (payload(ld, lb) !== out) {
        const sid = drawings.getSel();
        drawings.applySync(md.items, md.tombs);
        bookmarks.applySync(mb.items, mb.tombs);
        if (sid && !drawings.get(sid)) select(null);
      }
      if (payload({ items: remote.drawings || [], tombs: remote.deleted || {} }, { items: remote.bookmarks || [], tombs: remote.bookmarksDeleted || {} }) !== out) {
        await gh(`/gists/${cfg.gistId}`, { method: 'PATCH', body: JSON.stringify({ files: { [FILE]: { content: out } } }) });
      }
      cfg.last = Date.now(); store.set(SYNC_KEY, cfg);
      lastErr = '';
      setStatus();
    } catch (e) {
      const msg = e.message === 'not-found' ? 'Gist를 찾지 못했습니다' : e.message;
      if (msg !== lastErr) toast('동기화 실패 — ' + msg, { error: true, ms: 5000 });
      lastErr = msg;
      setStatus('⚠ ' + msg);
    } finally {
      running = false;
      if (again) setTimeout(syncNow, 500);
    }
  }

  function soon() { clearTimeout(timer); timer = setTimeout(syncNow, 2000); }

  function setStatus(text) {
    const on = !!(cfg && cfg.token);
    $('syncOff').hidden = on; $('syncOn').hidden = !on;
    const t = cfg && cfg.last ? new Date(cfg.last + KST * 1000) : null;
    $('syncStatus').textContent = !on ? '꺼짐 — 이 기기에만 저장 중'
      : text || (t ? `켜짐 · 마지막 동기화 ${pad(t.getUTCMonth() + 1)}.${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` : '켜짐');
    $('syncStatus').className = 'sync-status' + (on ? ' on' : '') + (text && text.startsWith('⚠') ? ' err' : '');
  }

  async function connect(token) {
    token = (token || '').trim();
    if (!token) { toast('열쇠(토큰)를 붙여넣으세요', { error: true }); return; }
    cfg = { token };
    setStatus('연결 중…');
    try {
      await gh('/user');
      store.set(SYNC_KEY, cfg);
      $('syncToken').value = '';
      await syncNow();
      if (!lastErr) toast('☁ 동기화를 켰습니다 — 다른 기기에도 같은 열쇠를 넣으세요');
    } catch (e) {
      cfg = null; store.set(SYNC_KEY, null);
      toast('연결 실패 — ' + e.message, { error: true, ms: 6000 });
      setStatus();
    }
  }
  function disconnect() {
    if (!confirm('이 기기의 동기화를 끌까요? (그림은 이 기기에 그대로 남고, GitHub의 사본도 지워지지 않습니다)')) return;
    cfg = null;
    try { localStorage.removeItem(SYNC_KEY); } catch {}
    setStatus();
  }

  drawings.onChange(soon);
  bookmarks.onChange(soon);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);
  $('syncConnect').addEventListener('click', () => connect($('syncToken').value));
  $('syncToken').addEventListener('keydown', e => { if (e.key === 'Enter') connect($('syncToken').value); });
  $('syncNowBtn').addEventListener('click', syncNow);
  $('syncDisconnect').addEventListener('click', disconnect);
  setStatus();
  return { syncNow, isOn: () => !!(cfg && cfg.token) };
})();

// ───────────────────────── 내 기록 (노션 af WC → data/notes.enc, 시간축 위 점 → 탭하면 팝업)
// 노션 → 차트 한 방향. 평문은 저장소에 없다: notes.enc(PBKDF2-SHA256 → AES-GCM, 99-REPLAY와 같은 방식)
// 캡쳐는 data/img/{id}.bin = iv(12바이트) + 암호문 — 팝업을 열 때 그 한 장만 받아 푼다.
const MARK_COL = { '도전': '#ff9800', '고민': '#ffeb3b', '포기': '#f23645', '확신': '#26e0a5' };
const MARK_NONE = '#33d4ff';
const isPhone = () => window.matchMedia('(max-width: 720px)').matches || wide.isOn();
const notes = (() => {
  let on = !!store.get(PREF_KEY, {}).notes;
  let env = null;          // 암호 봉투
  let key = null;          // 푼 키 (캡쳐 풀 때도 씀) · 샘플이면 'sample'
  let list = [];           // [{id, t(ms), ...}] 시각순
  let hits = [];           // [{x, y, items}]
  let selId = null;
  let requestUpdate = () => {};
  const imgCache = new Map(); // id → objectURL
  const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64e = u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };

  function setBtn() {
    const b = $('notesBtn'); if (!b) return;
    b.classList.toggle('on', on);
    $('notesCount').textContent = on && list.length ? list.length : '';
  }
  function setList(d) {
    list = (d && Array.isArray(d.notes) ? d.notes : []).filter(n => n && Number.isFinite(n.t)).sort((a, b) => a.t - b.t);
    setBtn(); requestUpdate();
  }
  async function loadEnv() {
    try {
      const r = await fetch('data/notes.enc', { cache: 'no-cache' });
      if (!r.ok) return null;
      const e = await r.json();
      return e && e.v === 1 && e.salt && e.iv && e.ct && Number.isFinite(e.iter) ? e : null;
    } catch { return null; }
  }
  async function open(k) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(env.iv) }, k, b64d(env.ct));
    key = k;
    setList(JSON.parse(new TextDecoder().decode(pt)));
  }
  async function unlockSaved() {
    const saved = store.get(NOTE_KEY, null);
    if (!saved || saved.salt !== env.salt || !window.crypto || !crypto.subtle) return false;
    try {
      await open(await crypto.subtle.importKey('raw', b64d(saved.key), { name: 'AES-GCM' }, false, ['decrypt']));
      return true;
    } catch { store.del(NOTE_KEY); return false; } // 새 비번으로 바뀌었으면 버린다
  }
  async function unlockPw(pw, remember) {
    if (!window.crypto || !crypto.subtle) throw new Error('이 주소에서는 브라우저 암호 기능을 쓸 수 없습니다 (https 또는 localhost 필요)');
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64d(env.salt), iterations: env.iter },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
    await open(k);
    if (remember) store.set(NOTE_KEY, { salt: env.salt, key: b64e(new Uint8Array(await crypto.subtle.exportKey('raw', k))) });
  }
  async function ensure() {
    if (key) return true;
    if (new URLSearchParams(location.search).has('sample')) {
      try { key = 'sample'; setList(await fetchJson('docs/sample_notes.json')); return true; }
      catch (e) { key = null; toast('샘플을 읽지 못했습니다', { error: true, detail: e.message }); return false; }
    }
    if (!env) env = await loadEnv();
    if (!env) { toast('아직 올린 기록이 없습니다 (data/notes.enc 없음)', { ms: 3000 }); return false; }
    if (await unlockSaved()) return true;
    $('notesPw').value = ''; openModal('notesLock'); setTimeout(() => $('notesPw').focus(), 0);
    return false;
  }
  async function toggle(want = !on) {
    on = want;
    store.set(PREF_KEY, { ...store.get(PREF_KEY, {}), notes: on });
    setBtn(); requestUpdate();
    if (on) await ensure();
  }

  // 점: 시간축 바로 위. 가까운 점(10px 안)은 하나로 묶고 개수를 적는다
  function draw(ctx, w, h) {
    hits = [];
    if (!on || !list.length || !S.bars.length) return;
    const k = isPhone() ? 1.3 : 1;
    const y = h - Math.round(9 * k);
    const groups = [];
    for (const n of list) {
      const x = timeToX(msToChart(n.t));
      if (x == null || x < -6 || x > w + 6) continue;
      const g = groups[groups.length - 1];
      if (g && x - g.x0 < 10 * k) { g.items.push(n); g.x = (g.x0 + x) / 2; }
      else groups.push({ x0: x, x, items: [n] });
    }
    ctx.save();
    for (const g of groups) {
      const selN = g.items.find(n => n.id === selId);
      if (selN) { // 고른 기록의 시각에 옅은 세로 점선
        const x = Math.round(timeToX(msToChart(selN.t))) + 0.5;
        ctx.strokeStyle = 'rgba(51,212,255,0.55)'; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.setLineDash([]);
      }
      const many = g.items.length > 1;
      const r = (many ? 6.5 : 4.5) * k;
      const last = g.items[g.items.length - 1];
      ctx.fillStyle = MARK_COL[last.mark] || MARK_NONE;
      ctx.beginPath(); ctx.arc(g.x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = selN ? '#ffffff' : 'rgba(10,14,20,0.9)';
      ctx.beginPath(); ctx.arc(g.x, y, r + (selN ? 2 : 0.5), 0, Math.PI * 2); ctx.stroke();
      if (many) {
        ctx.fillStyle = '#0a0e14';
        ctx.font = `700 ${Math.round(9 * k)}px 'IBM Plex Mono', Menlo, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(g.items.length), g.x, y + 0.5);
      }
      hits.push({ x: g.x, y, items: g.items });
    }
    ctx.restore();
  }
  series.attachPrimitive({
    attached: p => { requestUpdate = p.requestUpdate; },
    detached: () => { requestUpdate = () => {}; },
    updateAllViews: () => {},
    paneViews: () => [{ zOrder: () => 'top', renderer: () => ({
      draw: target => target.useMediaCoordinateSpace(({ context, mediaSize }) => draw(context, mediaSize.width, mediaSize.height)),
    }) }],
  });

  // 탭: 점 근처(손가락 크기)면 팝업. 아니면 false → 원래 탭 처리(그림 고르기)
  function tap(x, y) {
    if (!on || !hits.length) return false;
    const tol = isPhone() ? 24 : 14;
    let best = null, bd = Infinity;
    for (const g of hits) {
      const d = Math.hypot(g.x - x, (g.y - y) * 0.6);
      if (d < tol && d < bd) { bd = d; best = g; }
    }
    if (!best) return false;
    show(best.items);
    return true;
  }

  // ── 팝업 (폰: 아래에서 올라오는 시트 / PC: 가운데 상자)
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const markTag = m => (m ? `<span class="nt-mark" style="--mc:${MARK_COL[m] || MARK_NONE}">${esc(m)}</span>` : '');
  const kst = ms => { const d = new Date(ms + KST * 1000); return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  let shown = [];
  function show(items) {
    shown = items;
    selId = items[items.length - 1].id;
    $('noteBody').innerHTML = items.map(n => `
      <article class="nt">
        <div class="nt-head">
          <span class="nt-time">${kst(n.t)}${n.est ? ' <em title="차트 시각을 정확히 모름 — 제목 시각 또는 Claude 추정">추정</em>' : ''}</span>
          ${n.tf ? `<span class="nt-tf">${esc(n.tf)}</span>` : ''}${markTag(n.mark)}
          <span class="spacer"></span>
          <button class="nt-go" data-go="${esc(n.id)}" title="이 시각을 차트 가운데로">이동</button>
        </div>
        ${n.img ? `<div class="nt-img" data-img="${esc(n.id)}"><span>캡쳐 여는 중…</span></div>` : ''}
        ${n.text ? `<div class="nt-text">${esc(n.text)}</div>` : '<div class="nt-text nt-empty">(글 없음)</div>'}
        ${n.comments && n.comments.length ? `<details class="nt-cm"><summary>Claude 댓글 ${n.comments.length}</summary>${
          n.comments.map(c => `<p>${esc(c.text)}</p>`).join('')}</details>` : ''}
      </article>`).join('');
    const i = list.indexOf(items[0]), j = list.indexOf(items[items.length - 1]);
    $('notePrev').disabled = i <= 0;
    $('noteNext').disabled = j < 0 || j >= list.length - 1;
    $('notePos').textContent = items.length > 1 ? `${i + 1}–${j + 1} / ${list.length}` : `${i + 1} / ${list.length}`;
    $('noteSheet').classList.toggle('sheet', isPhone());
    openModal('noteSheet');
    $('noteBody').scrollTop = 0;
    requestUpdate();
    for (const n of items) if (n.img) loadImg(n);
  }
  async function loadImg(n) {
    const el = $('noteBody').querySelector(`[data-img="${CSS.escape(n.id)}"]`);
    if (!el) return;
    try {
      let url = imgCache.get(n.id);
      if (!url) {
        const r = await fetch(key === 'sample' ? n.img : `data/${n.img}`, { cache: 'force-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        let buf = new Uint8Array(await r.arrayBuffer());
        if (key !== 'sample') buf = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12)));
        url = URL.createObjectURL(new Blob([buf], { type: n.mime || 'image/webp' }));
        imgCache.set(n.id, url);
      }
      el.innerHTML = `<img src="${url}" alt="캡쳐">`;
      el.querySelector('img').addEventListener('click', () => { $('noteZoomImg').src = url; openModal('noteZoom'); });
    } catch (e) { el.innerHTML = `<span>캡쳐를 열지 못했습니다 (${esc(e.message)})</span>`; }
  }
  function step(dir) {
    const i = list.indexOf(dir < 0 ? shown[0] : shown[shown.length - 1]) + dir;
    if (i < 0 || i >= list.length) return;
    jumpTo(list[i].t, { mark: false });
    show([list[i]]);
  }
  $('noteBody').addEventListener('click', e => {
    const id = e.target.closest('[data-go]')?.dataset.go;
    const n = id && list.find(x => x.id === id);
    if (!n) return;
    closeModal($('noteSheet'));
    selId = n.id;
    jumpTo(n.t, { mark: false });
  });
  $('notePrev').addEventListener('click', () => step(-1));
  $('noteNext').addEventListener('click', () => step(1));
  $('notesBtn').addEventListener('click', () => toggle());

  async function doUnlock() {
    const pw = $('notesPw').value; if (!pw) return;
    $('notesOk').disabled = true; $('notesOk').textContent = '여는 중…';
    try {
      await unlockPw(pw, $('notesRemember').checked);
      closeModal($('notesLock'));
      toast(`내 기록 ${list.length}개를 열었습니다`);
    } catch (e) {
      toast(e.name === 'OperationError' ? '비밀번호가 맞지 않습니다' : '열지 못했습니다', { error: true, detail: e.name === 'OperationError' ? '' : e.message });
    } finally { $('notesOk').disabled = false; $('notesOk').textContent = '열기'; $('notesPw').value = ''; }
  }
  $('notesOk').addEventListener('click', doUnlock);
  $('notesPw').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doUnlock(); } });

  setBtn();
  if (on) ensure();
  return { tap, toggle, refresh: () => requestUpdate(), list: () => list.slice() };
})();

// ───────────────────────── 지금 시각 (KST) — 캡쳐에 같이 찍히게 가격축·시간축이 만나는 오른쪽 아래 모서리에
(() => {
  const el = $('clock');
  const tick = () => {
    const d = new Date(Date.now() + KST * 1000);
    el.innerHTML = `<span>${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}</span><b>${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}</b>`;
    try {
      const w = chart.priceScale('right').width(), h = ts.height();
      if (w > 0) el.style.width = w + 'px';
      if (h > 0) el.style.height = h + 'px';
    } catch {}
  };
  tick(); setInterval(tick, 1000);
})();

// ───────────────────────── 시작
const prefs = store.get(PREF_KEY, {});
wantWide = !!prefs.wide;
wide.apply(wantWide);
S.iv = IVS[prefs.iv] ? prefs.iv : '5m';
document.querySelectorAll('#ivSeg button').forEach(b => b.classList.toggle('on', b.dataset.iv === S.iv));
updateLegend();
loadLatest();
connectWs();
sync.syncNow();

// 디버그·테스트용
window.__psych = { S, chart, series, drawings, bookmarks, sync, notes, jumpTo, switchInterval, wide };
})();
