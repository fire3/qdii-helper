/* QDII 限购查询 —— 无依赖前端 */
'use strict';

const $ = (sel) => document.querySelector(sel);

/* ---------------- 状态 ---------------- */

const DEFAULT_STATE = {
  search: '',
  status: 'buyable',
  cap: null,            // 日限额上限（元）；null = 不限
  currency: 'CNY',
  regions: [],
  themes: [],
  sort: 'limit-desc',
};

let state = { ...DEFAULT_STATE };
let dataset = null;
let premiumCache = null;

const STATUS_OPTIONS = [
  { key: 'buyable', label: '可买' },
  { key: '限大额', label: '限大额' },
  { key: '开放申购', label: '开放申购' },
  { key: '暂停申购', label: '暂停申购' },
  { key: '场内交易', label: '场内交易' },
  { key: 'all', label: '全部' },
];

const CAP_OPTIONS = [
  { key: 10, label: '≤ 10 元' },
  { key: 100, label: '≤ 100 元' },
  { key: 1000, label: '≤ 1000 元' },
  { key: 10000, label: '≤ 1 万' },
  { key: 1000000, label: '≤ 100 万' },
  { key: null, label: '不限' },
];

const CURRENCY_OPTIONS = [
  { key: 'CNY', label: '人民币' },
  { key: 'USD', label: '美元' },
  { key: 'HKD', label: '港币' },
  { key: 'all', label: '全部' },
];

const SORT_OPTIONS = [
  { key: 'limit-asc', label: '额度从紧到松' },
  { key: 'limit-desc', label: '额度从松到紧' },
  { key: 'status', label: '可买优先' },
  { key: 'name', label: '按名称' },
];

const STATUS_BADGE = {
  '开放申购': 'open',
  '限大额': 'limited',
  '暂停申购': 'suspended',
  '场内交易': 'exchange',
};

/* ---------------- 工具 ---------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------------- URL hash 同步（查询可分享） ---------------- */

function readHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return;
  const p = new URLSearchParams(raw);
  state = {
    search: p.get('q') || '',
    status: p.get('st') || 'buyable',
    cap: p.has('cap') ? Number(p.get('cap')) : null,
    currency: p.get('cur') || 'CNY',
    regions: p.get('rg') ? p.get('rg').split(',').filter(Boolean) : [],
    themes: p.get('th') ? p.get('th').split(',').filter(Boolean) : [],
    sort: p.get('so') || 'limit-desc',
  };
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.search) p.set('q', state.search);
  if (state.status !== 'buyable') p.set('st', state.status);
  if (state.cap !== null) p.set('cap', String(state.cap));
  if (state.currency !== 'CNY') p.set('cur', state.currency);
  if (state.regions.length) p.set('rg', state.regions.join(','));
  if (state.themes.length) p.set('th', state.themes.join(','));
  if (state.sort !== 'limit-desc') p.set('so', state.sort);
  const next = p.toString();
  history.replaceState(null, '', next ? '#' + next : location.pathname);
}

/* ---------------- 筛选与排序（与后端语义一致） ---------------- */

function matchesCurrency(r) {
  return state.currency === 'all' || r.currency === state.currency;
}

function matchesStatus(r) {
  if (state.status === 'all') return true;
  if (state.status === 'buyable') return r.buyable;
  return r.status === state.status;
}

function matchesCategory(r) {
  if (state.regions.length && !state.regions.includes(r.region)) return false;
  if (state.themes.length && !state.themes.includes(r.theme)) return false;
  return true;
}

function matchesSearch(r) {
  if (!state.search) return true;
  const q = state.search.trim().toLowerCase();
  return r.code.includes(q) || r.name.toLowerCase().includes(q);
}

function matchesCap(r) {
  if (state.cap === null) return true;
  return r.limit !== null && r.limit <= state.cap;
}

const SORTERS = {
  // limit 为 null 表示无限额，一律排在最后
  'limit-asc': (a, b) => (a.limit === null) - (b.limit === null) || a.limit - b.limit,
  'limit-desc': (a, b) => (b.limit === null) - (a.limit === null) || b.limit - a.limit,
  'status': (a, b) => {
    const w = { '开放申购': 0, '限大额': 1, '暂停申购': 2, '场内交易': 3 };
    return (w[a.status] ?? 9) - (w[b.status] ?? 9)
      || (a.limit === null) - (b.limit === null)
      || (b.limit ?? 0) - (a.limit ?? 0);
  },
  'name': (a, b) => a.name.localeCompare(b.name, 'zh'),
};

function visibleFunds() {
  return dataset.funds
    .filter((r) => matchesCurrency(r) && matchesStatus(r) && matchesCategory(r)
      && matchesSearch(r) && matchesCap(r))
    .sort(SORTERS[state.sort]);
}

/* ---------------- 渲染 ---------------- */

function renderStats() {
  const s = dataset.stats;
  const limited = s.status['限大额'] || 0;
  const suspended = s.status['暂停申购'] || 0;
  const cells = [
    { k: 'QDII 总数', v: dataset.total },
    { k: '当前可买', v: s.buyable, cls: 'ok' },
    { k: '限大额', v: limited, cls: 'warn' },
    { k: '暂停申购', v: suspended, cls: 'danger' },
    { k: '最紧日限额', v: s.tightest !== null && s.tightest !== undefined
        ? `${s.tightest.toLocaleString()} 元` : '—', cls: 'danger' },
  ];
  $('#stats').innerHTML = cells.map((c) =>
    `<div class="stat ${c.cls || ''}"><div class="k">${esc(c.k)}</div>` +
    `<div class="v">${esc(c.v)}</div></div>`).join('');
}

function renderChips(host, options, isOn, onPick, counts) {
  host.innerHTML = options.map((o) => {
    const n = counts ? counts(o.key) : null;
    return `<button class="chip${isOn(o.key) ? ' is-on' : ''}" data-key="${esc(o.key ?? 'null')}">` +
      `${esc(o.label)}${n !== null && n !== undefined ? `<span class="n">${n}</span>` : ''}</button>`;
  }).join('');
  host.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.key;
      onPick(raw === 'null' ? null : (/^\d+$/.test(raw) ? Number(raw) : raw));
    });
  });
}

function renderFilters() {
  const funds = dataset.funds;
  const base = funds.filter(matchesCurrency);

  renderChips($('#status-chips'), STATUS_OPTIONS,
    (k) => state.status === k, (k) => set({ status: k }),
    (k) => base.filter((r) => k === 'all' ? true
      : k === 'buyable' ? r.buyable : r.status === k).length);

  renderChips($('#limit-chips'), CAP_OPTIONS,
    (k) => state.cap === k, (k) => set({ cap: k }));

  renderChips($('#currency-chips'), CURRENCY_OPTIONS,
    (k) => state.currency === k, (k) => set({ currency: k }),
    (k) => k === 'all' ? funds.length : funds.filter((r) => r.currency === k).length);

  renderChips($('#region-chips'),
    dataset.categories.regions.map((c) => ({ key: c.name, label: c.name })),
    (k) => state.regions.includes(k),
    (k) => toggle('regions', k),
    (k) => base.filter((r) => r.region === k).length);

  renderChips($('#theme-chips'),
    dataset.categories.themes.map((c) => ({ key: c.name, label: c.name })),
    (k) => state.themes.includes(k),
    (k) => toggle('themes', k),
    (k) => base.filter((r) => r.theme === k).length);

  renderChips($('#sort-chips'), SORT_OPTIONS,
    (k) => state.sort === k, (k) => set({ sort: k }));

  $('#search').value = state.search;
}

function renderActiveFilters() {
  const tags = [];
  if (state.search) tags.push(['搜索: ' + state.search, () => set({ search: '' })]);
  if (state.status !== 'buyable') {
    const label = STATUS_OPTIONS.find((o) => o.key === state.status);
    tags.push([label ? label.label : state.status, () => set({ status: 'buyable' })]);
  }
  if (state.cap !== null) tags.push([`限额 ≤ ${state.cap.toLocaleString()} 元`, () => set({ cap: null })]);
  if (state.currency !== 'CNY') tags.push([`币种: ${state.currency}`, () => set({ currency: 'CNY' })]);
  state.regions.forEach((r) => tags.push([r, () => toggle('regions', r)]));
  state.themes.forEach((t) => tags.push([t, () => toggle('themes', t)]));

  const host = $('#active-filters');
  host.innerHTML = tags.map(([label], i) =>
    `<span class="tag">${esc(label)}<button data-i="${i}" aria-label="移除">×</button></span>`).join('');
  host.querySelectorAll('button[data-i]').forEach((b) => {
    b.addEventListener('click', () => tags[Number(b.dataset.i)][1]());
  });
}

function limitCell(r) {
  if (!r.buyable) return `<span class="limit none">${esc(r.limit_text)}</span>`;
  if (r.limit === null) return '<span class="limit none">无限额</span>';
  const cls = r.limit <= 100 ? 'tight' : 'limited';
  return `<span class="limit ${cls}">${esc(r.limit_text)}</span>`;
}

function renderTable() {
  const rows = visibleFunds();
  const host = $('#table-host');

  $('#result-title').textContent = `结果 ${rows.length} 只`;

  if (!rows.length) {
    host.innerHTML = '<div class="empty">没有符合条件的基金，试试放宽筛选条件。</div>';
    return;
  }

  const head = `<thead><tr>
    <th>代码</th><th>基金简称</th><th>地区 / 市场</th><th>主题</th>
    <th>申购状态</th><th class="num">日累计限额</th><th class="num">起购</th>
    <th class="num">单位净值</th><th class="num">费率</th>
  </tr></thead>`;

  const body = rows.map((r) => `<tr data-code="${esc(r.code)}">
    <td class="code">${esc(r.code)}</td>
    <td class="name">${esc(r.name)}</td>
    <td><span class="tagchip">${esc(r.region)}</span></td>
    <td><span class="tagchip">${esc(r.theme)}</span></td>
    <td><span class="badge ${STATUS_BADGE[r.status] || 'other'}">${esc(r.status || '—')}</span></td>
    <td class="num">${limitCell(r)}</td>
    <td class="num">${esc(r.min_purchase_text)}</td>
    <td class="num">${r.nav === null ? '—' : esc(r.nav.toFixed(4))}
      <span style="opacity:.55;font-size:11px">${esc(r.nav_date || '')}</span></td>
    <td class="num">${esc(r.fee || '—')}</td>
  </tr>`).join('');

  host.innerHTML = `<table>${head}<tbody>${body}</tbody></table>`;
  host.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => openDrawer(tr.dataset.code));
  });
}

function render() {
  renderFilters();
  renderActiveFilters();
  renderTable();
}

/* ---------------- 详情：格式化与几何（纯函数，便于测试） ---------------- */

const PERIOD_LABELS = {
  Z: '近1周', Y: '近1月', '3Y': '近3月', '6Y': '近6月', '1N': '近1年',
  '2N': '近2年', '3N': '近3年', '5N': '近5年', JN: '今年来', LN: '成立来',
};

// 收益率表的展示顺序；接口 H 可能只返回其中一部分
const PERIOD_ORDER = ['Z', 'Y', '3Y', '6Y', '1N', '2N', '3N', '5N', 'JN', 'LN'];

const RANGE_OPTIONS = [
  { label: '近1月', days: 30 },
  { label: '近3月', days: 90 },
  { label: '近6月', days: 182 },
  { label: '近1年', days: 365 },
  { label: '近3年', days: 1095 },
];
const DEFAULT_RANGE = 365;

const CHART_W = 480;
const CHART_H = 150;
const CHART_PAD = 22;

const isBlank = (v) => v === null || v === undefined || v === '' || Number.isNaN(Number(v));

const fmtPct = (v) => (isBlank(v) ? '—' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

const fmtNum = (v, digits = 4) => (isBlank(v) ? '—' : Number(v).toFixed(digits));

const trendClass = (v) => (isBlank(v) ? '' : Number(v) > 0 ? 'pos' : Number(v) < 0 ? 'neg' : '');

// 取最近 N 天的净值点；区间内不足两个点时退回最后两个点，保证能画出线
function sliceByDays(navs, days) {
  if (!Array.isArray(navs) || !navs.length) return [];
  const last = Date.parse(navs[navs.length - 1].date);
  if (Number.isNaN(last)) return navs.slice();
  const cutoff = last - days * 86400000;
  const out = navs.filter((p) => Date.parse(p.date) >= cutoff);
  return out.length >= 2 ? out : navs.slice(-2);
}

// 区间涨幅与最大回撤（最大回撤 = 峰值到谷底的最大跌幅）
function rangeStats(navs) {
  const vals = (navs || []).map((p) => p.nav).filter((v) => typeof v === 'number');
  if (vals.length < 2) return { changePct: null, maxDrawdown: null, high: null, low: null };
  let peak = vals[0];
  let maxDrawdown = 0;
  for (const v of vals) {
    if (v > peak) peak = v;
    maxDrawdown = Math.max(maxDrawdown, (peak - v) / peak);
  }
  const first = vals[0];
  const last = vals[vals.length - 1];
  return {
    changePct: first ? ((last - first) / first) * 100 : null,
    maxDrawdown: maxDrawdown * 100,
    high: Math.max(...vals),
    low: Math.min(...vals),
  };
}

// 把数值序列映射为 SVG 折线 / 面积路径
function buildLinePath(values, w, h, pad) {
  if (!Array.isArray(values) || !values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = (max - min) || 1;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  const n = values.length;
  const xOf = (i) => pad + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yOf = (v) => pad + innerH - ((v - min) / span) * innerH;
  const line = 'M' + values.map((v, i) => `${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`).join(' L');
  const base = (h - pad).toFixed(2);
  const area = `${line} L${xOf(n - 1).toFixed(2)},${base} L${xOf(0).toFixed(2)},${base} Z`;
  return { line, area, min, max, xOf, yOf };
}

/* ---------------- 详情：区块渲染 ---------------- */

function perfSection(periods) {
  const byKey = Object.fromEntries((periods || []).map((p) => [p.key, p]));
  const rows = PERIOD_ORDER.filter((k) => byKey[k]).map((k) => {
    const p = byKey[k];
    const rank = p.rank && p.total ? `${p.rank}/${p.total}` : '—';
    return `<tr>
      <td>${esc(PERIOD_LABELS[k])}</td>
      <td class="num ${trendClass(p.ret)}">${fmtPct(p.ret)}</td>
      <td class="num">${fmtPct(p.avg)}</td>
      <td class="num">${fmtPct(p.bench)}</td>
      <td class="num">${esc(rank)}</td>
    </tr>`;
  }).join('');

  const body = rows || '<tr><td colspan="5" class="muted">暂无阶段涨幅数据。</td></tr>';
  return `<div class="section-title">收益表现</div>
    <table class="perf-table"><thead><tr>
      <th>周期</th><th class="num">本基金</th><th class="num">同类平均</th>
      <th class="num">沪深300</th><th class="num">同类排名</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

function navSection(navs) {
  if (!navs || navs.length < 2) {
    return `<div class="section-title">净值走势</div>
      <p class="muted small">暂无净值数据。</p>`;
  }
  const chips = RANGE_OPTIONS.map((o) =>
    `<button class="chip${o.days === DEFAULT_RANGE ? ' is-on' : ''}" data-days="${o.days}">${o.label}</button>`,
  ).join('');
  return `<div class="section-title">净值走势</div>
    <div class="chart-wrap">
      <div class="chips chart-chips">${chips}</div>
      <div class="chart-canvas"></div>
      <div class="chart-tip" hidden></div>
    </div>`;
}

function initChart(scope, navs) {
  const wrap = scope.querySelector('.chart-wrap');
  if (!wrap) return;
  const canvas = wrap.querySelector('.chart-canvas');
  const tip = wrap.querySelector('.chart-tip');

  const paint = (days) => {
    const pts = sliceByDays(navs, days);
    const geo = buildLinePath(pts.map((p) => p.nav), CHART_W, CHART_H, CHART_PAD);
    if (!geo) {
      canvas.innerHTML = '<p class="muted small">区间内数据不足。</p>';
      return;
    }
    const stats = rangeStats(pts);
    const drawdown = stats.maxDrawdown === null ? '—' : `-${stats.maxDrawdown.toFixed(2)}%`;

    canvas.innerHTML = `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" class="chart-svg">
      <defs><linearGradient id="navFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity=".26"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${geo.area}" fill="url(#navFill)"/>
      <path d="${geo.line}" fill="none" stroke="var(--accent)" stroke-width="1.6"
            stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <circle class="chart-dot" r="3.2" fill="var(--accent)" hidden/>
    </svg>
    <div class="chart-stats">
      <span>区间涨幅 <b class="${trendClass(stats.changePct)}">${fmtPct(stats.changePct)}</b></span>
      <span>最大回撤 <b class="neg">${drawdown}</b></span>
      <span>区间高/低 <b>${fmtNum(stats.high)} / ${fmtNum(stats.low)}</b></span>
    </div>`;

    const svg = canvas.querySelector('svg');
    const dot = canvas.querySelector('.chart-dot');
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const vbX = ((e.clientX - rect.left) / rect.width) * CHART_W;
      const n = pts.length;
      const idx = Math.max(0, Math.min(n - 1,
        Math.round(((vbX - CHART_PAD) / (CHART_W - CHART_PAD * 2)) * (n - 1))));
      const p = pts[idx];
      dot.setAttribute('cx', geo.xOf(idx).toFixed(2));
      dot.setAttribute('cy', geo.yOf(p.nav).toFixed(2));
      dot.hidden = false;
      tip.hidden = false;
      tip.textContent = `${p.date}　${fmtNum(p.nav)}`;
      tip.style.left = `${(vbX / CHART_W) * 100}%`;
    });
    svg.addEventListener('mouseleave', () => { dot.hidden = true; tip.hidden = true; });
  };

  wrap.querySelectorAll('.chart-chips .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.chart-chips .chip')
        .forEach((b) => b.classList.toggle('is-on', b === btn));
      paint(Number(btn.dataset.days));
    });
  });
  paint(DEFAULT_RANGE);
}

function scaleSection(scale) {
  const cats = (scale && scale.categories) || [];
  const series = (scale && scale.series) || [];
  if (!cats.length || !series.length) return '';
  const values = series.map((s) => s.y).filter((v) => typeof v === 'number');
  const max = Math.max(...values) || 1;
  const bars = cats.map((c, i) => {
    const item = series[i] || {};
    const h = typeof item.y === 'number' ? Math.max(3, (item.y / max) * 100) : 0;
    return `<div class="bar" title="${esc(c)}　${esc(item.y)} 亿元">
      <div class="bar-track"><div class="bar-fill" style="height:${h.toFixed(1)}%"></div></div>
      <span class="bar-x">${esc(String(c).slice(2, 7))}</span>
    </div>`;
  }).join('');
  const latest = series[series.length - 1] || {};
  return `<div class="section-title">规模变动</div>
    <p class="muted small">最新 ${esc(cats[cats.length - 1])}：
      <b>${esc(latest.y)} 亿元</b>${latest.mom ? `（环比 ${esc(latest.mom)}）` : ''}</p>
    <div class="bars">${bars}</div>`;
}

function allocationSection(allocation, holders) {
  const blocks = [];
  const pct = (v) => (v === null ? '—' : `${v.toFixed(2)}%`);

  if (allocation && (allocation.categories || []).length) {
    const i = allocation.categories.length - 1;
    const pick = (prefix) => {
      const s = (allocation.series || []).find((x) => String(x.name || '').startsWith(prefix));
      return s && typeof s.data[i] === 'number' ? s.data[i] : null;
    };
    const net = pick('净资产');
    blocks.push(`<div class="section-title">资产配置 <span class="hint">${esc(allocation.categories[i])}</span></div>
      <dl class="kv">
        <dt>股票占净比</dt><dd>${pct(pick('股票'))}</dd>
        <dt>债券占净比</dt><dd>${pct(pick('债券'))}</dd>
        <dt>现金占净比</dt><dd>${pct(pick('现金'))}</dd>
        <dt>净资产</dt><dd>${net === null ? '—' : `${net.toFixed(2)} 亿元`}</dd>
      </dl>`);
  }

  if (holders && (holders.categories || []).length) {
    const i = holders.categories.length - 1;
    const pick = (name) => {
      const s = (holders.series || []).find((x) => x.name === name);
      return s && typeof s.data[i] === 'number' ? s.data[i] : null;
    };
    blocks.push(`<div class="section-title">持有人结构 <span class="hint">${esc(holders.categories[i])}</span></div>
      <dl class="kv">
        <dt>机构持有</dt><dd>${pct(pick('机构持有比例'))}</dd>
        <dt>个人持有</dt><dd>${pct(pick('个人持有比例'))}</dd>
      </dl>`);
  }

  return blocks.join('');
}

function holdingsSection(holdings, reportDate) {
  const h = holdings || {};
  const stocks = h.stocks || [];
  const bonds = h.bonds || [];
  const etf = h.etf;
  if (!stocks.length && !bonds.length && !etf) return '';

  const parts = [`<div class="section-title">主要成分${
    reportDate ? ` <span class="hint">${esc(reportDate)}</span>` : ''}</div>`];

  if (etf) {
    parts.push(`<p class="muted small">跟踪标的：
      <b>${esc(etf.name || '')}</b> <span class="mono">${esc(etf.code || '')}</span></p>`);
  }

  if (stocks.length) {
    parts.push(`<table class="mini-table"><thead><tr>
      <th>股票</th><th class="num">占净值比</th><th class="num">较上期</th>
    </tr></thead><tbody>${stocks.map((s) => `<tr>
      <td>${esc(s.name)} <span class="mono muted">${esc(s.code)}</span></td>
      <td class="num">${s.weight === null ? '—' : `${s.weight.toFixed(2)}%`}</td>
      <td class="num ${trendClass(s.delta)}">${esc(s.action || '')}${
        s.delta === null ? '' : ` ${fmtPct(s.delta)}`}</td>
    </tr>`).join('')}</tbody></table>`);
  } else if (bonds.length) {
    parts.push(`<table class="mini-table"><thead><tr>
      <th>债券</th><th class="num">占净值比</th>
    </tr></thead><tbody>${bonds.map((b) => `<tr>
      <td>${esc(b.name)} <span class="mono muted">${esc(b.code)}</span></td>
      <td class="num">${b.weight === null ? '—' : `${b.weight.toFixed(2)}%`}</td>
    </tr>`).join('')}</tbody></table>`);
  } else if (etf) {
    parts.push('<p class="muted small">该基金为联接 / FOF 型，直接持有底层 ETF，不披露个股持仓。</p>');
  }

  return parts.join('');
}

/* ---------------- 详情：购买建议 ---------------- */

// 份额类别字母（A/C/D/E/I/F…）长在简称末尾。
// 「天弘恒生科技ETF」这类以 ETF 结尾的名字是场内份额、类别字母，必须排除。
function shareClass(name) {
  if (!name || /(ETF|LOF|FOF|REITs)$/.test(name)) return null;
  const m = String(name).match(/([A-Z])$/);
  return m ? m[1] : null;
}

// 同一只基金的另一类份额（A↔C）。币种、渠道都写在简称里，直接按名字配。
function siblingShare(fund, funds) {
  const cls = shareClass(fund.name);
  const other = cls === 'A' ? 'C' : cls === 'C' ? 'A' : null;
  if (!other) return null;
  const base = fund.name.slice(0, -1);
  return (funds || []).find((r) => r.name === base + other) || null;
}

const feePct = (s) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
};

const fmtFee = (v) => (isBlank(v) ? '—' : `${Number(v).toFixed(2)}%`);

// C 类销售服务费的常见区间（年率）。数据源没有这个字段，只能按区间估算；
// 平衡点 = A 类一次性申购费 ÷ C 类年销售服务费。费用越低、平衡点越晚。
const SERVICE_FEE_LOW = 0.2;
const SERVICE_FEE_HIGH = 0.4;

function breakevenRange(loadFee) {
  if (loadFee === null || loadFee <= 0) return null;
  return [(loadFee / SERVICE_FEE_HIGH) * 12, (loadFee / SERVICE_FEE_LOW) * 12];
}

// 区间的两个端点统一用一个单位，避免出现「3.9 个月～7.8 个月」这种重复
function fmtBreakeven(range) {
  if (!range) return null;
  const [early, late] = range;
  return late >= 24
    ? `${(early / 12).toFixed(1)}～${(late / 12).toFixed(1)} 年`
    : `${early.toFixed(1)}～${late.toFixed(1)} 个月`;
}

/** 生成购买建议条目。纯函数，便于回归测试。 */
function buyAdvice(fund, detail, funds) {
  if (!fund) return [];
  const items = [];
  const cls = shareClass(fund.name);
  const sib = siblingShare(fund, funds);
  const ownFee = feePct(fund.fee);
  const liveRate = detail ? feePct(detail.rate) : null;
  const sourceRate = detail ? feePct(detail.source_rate) : null;
  // A 类的一次性申购费：优先用接口 B 的折后费率，退回列表里的手续费列。
  // C 类自己免申购费，要拿同基金 A 类的费率才能算平衡点。
  const loadFee = cls === 'A' ? (liveRate ?? ownFee) : (sib ? feePct(sib.fee) : null);
  const breakeven = fmtBreakeven(breakevenRange(loadFee));

  if (cls === 'A') {
    const discounted = liveRate !== null && sourceRate !== null && sourceRate > liveRate;
    // 没取到费率时说「按平台费率」，别在句子里留一个破折号
    const feeClause = loadFee === null
      ? 'A 类收<b>一次性申购费</b>'
      : `A 类收<b>一次性申购费</b> ${fmtFee(loadFee)}`;
    items.push({
      level: 'info',
      text: `${feeClause}${discounted ? `（原价 ${fmtFee(sourceRate)}）` : ''}，不收销售服务费；` +
        (breakeven
          ? `持有时长超过平衡点（约 <b>${breakeven}</b>）选 A 更划算`
          : '适合长期持有'),
    });
  } else if (cls === 'C') {
    items.push({
      level: 'info',
      text: 'C 类<b>免申购费</b>，但按日计提销售服务费（从净值里扣）；' +
        (breakeven
          ? `持有时长在平衡点（约 <b>${breakeven}</b>）以内选 C 更划算`
          : '更适合短期持有'),
    });
  } else if (cls) {
    items.push({
      level: 'info',
      text: `${esc(cls)} 类份额，各渠道费率规则不统一，以招募说明书为准。`,
    });
  }

  if (sib) {
    // 暂停申购时 limit_text 与 status 是同一个词，别写成「暂停申购 · 暂停申购」
    const sibInfo = sib.limit_text === sib.status
      ? sib.status
      : `${sib.limit_text} · ${sib.status}`;
    items.push({
      level: sib.buyable ? 'info' : 'warn',
      text: `同一只基金还有 <b>${esc(cls === 'A' ? 'C' : 'A')} 类</b>份额：${esc(sibInfo)}`,
      goto: sib,
    });
  }

  // 限额建议只对买得到的基金说，且要区分「限 0 元」这种买不进的情况
  if (fund.buyable && fund.limit !== null) {
    if (fund.limit <= 0) {
      items.push({
        level: 'danger',
        text: '日限额为 <b>0 元</b>，实际等于买不进去（限大额但未公告暂停）；' +
          '留意最新公告，或看同标的场内 ETF。',
      });
    } else if (fund.limit <= 100) {
      items.push({
        level: 'warn',
        text: `日限额仅 ${esc(fund.limit_text)}，大额买入要分多日；也可看同标的场内 ETF，但要留意溢价。`,
      });
    }
  }

  if (fund.buyable && !fund.on_exchange) {
    items.push({
      level: 'warn',
      text: '场外份额持有不满 7 天，赎回费不低于 <b>1.5%</b> 且全额计入基金资产；' +
        'QDII 确认与到账本就慢，不适合短线。',
    });
  }

  if (fund.buyable && fund.limit === null && fund.status === '开放申购') {
    items.push({ level: 'ok', text: '当前开放申购，且没有单日限额。' });
  }
  if (fund.status === '暂停申购') {
    items.push({ level: 'danger', text: '当前<b>暂停申购</b>，买不进去；可留意下一开放日或场内替代。' });
  } else if (fund.on_exchange) {
    items.push({
      level: 'info',
      text: '场内份额，买入前先看「场内折溢价」标签页，溢价高时别追。',
    });
  }

  return items;
}

function adviceSection(fund, detail, funds) {
  const items = buyAdvice(fund, detail, funds);
  if (!items.length) return '';
  const lis = items.map((it) => `<li class="${it.level}">${it.text}${
    it.goto ? ` <button class="link" data-goto="${esc(it.goto.code)}">查看 ${esc(it.goto.code)}</button>` : ''
  }</li>`).join('');
  return `<div class="advice">
    <h4>购买建议</h4>
    <ul>${lis}</ul>
    <p class="fine">平衡点 = A 类一次性申购费 ÷ C 类销售服务费，按 ${SERVICE_FEE_LOW}%～${SERVICE_FEE_HIGH}%/年 估算；实际费率以招募说明书为准。</p>
  </div>`;
}

/* ---------------- 详情抽屉 ---------------- */

async function openDrawer(code) {
  const fund = dataset.funds.find((r) => r.code === code);
  const drawer = $('#drawer');
  const body = $('#drawer-body');
  drawer.hidden = false;
  body.innerHTML = '<div class="loading">加载详情与公告…</div>';

  const kv = (data) => {
    const rows = [
      ['代码', data.code],
      ['地区 / 市场', data.region],
      ['主题', data.theme],
      ['基金类型', data.type],
      ['申购状态', data.status || '—'],
      ['赎回状态', data.redeem_status || '—'],
      ['日累计限额', data.limit_text],
      ['起购金额', data.min_purchase_text],
      ['申购币种', data.currency],
      ['单位净值', data.nav === null ? '—' : `${data.nav} (${data.nav_date || ''})`],
      ['费率', data.fee || '—'],
    ];
    if (data.next_open_date) rows.push(['下一开放日', data.next_open_date]);
    return `<dl class="kv">${rows.map(([k, v]) =>
      `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  };

  let detailBlock = '';
  let notices = '';
  let sections = '';
  let errorNote = '';
  let navs = [];
  let detailData = null;

  try {
    const res = await fetch(`/api/fund?code=${encodeURIComponent(code)}`);
    const data = await res.json();

    if (data.detail) {
      const d = data.detail;
      detailData = d;
      detailBlock = `<div class="section-title">实时详情（接口 B）</div><dl class="kv">
        <dt>基金公司</dt><dd>${esc(d.company || '—')}</dd>
        <dt>基金经理</dt><dd>${esc(d.manager || '—')}</dd>
        <dt>实时状态</dt><dd>${esc(d.purchase_status || '—')}</dd>
        <dt>最大申购</dt><dd>${esc(d.max_purchase || '—')}</dd>
        <dt>费率</dt><dd>${esc(d.source_rate || '—')} → ${esc(d.rate || '—')}</dd>
        <dt>风险等级</dt><dd>${esc(d.risk_level || '—')}</dd>
      </dl>`;
    }

    navs = data.nav || [];
    sections = perfSection(data.periods)
      + navSection(navs)
      + scaleSection(data.scale)
      + allocationSection(data.allocation, data.holders)
      + holdingsSection(data.holdings, data.report_date);

    if (data.notices && data.notices.length) {
      notices = `<div class="section-title">申购相关公告（接口 D，type=5）</div>` +
        data.notices.map((n) => `<div class="notice">
          <span class="d">${esc(n.date)}</span>${esc(n.title)}</div>`).join('');
    } else {
      notices = `<div class="section-title">申购相关公告</div>
        <p class="muted small">未取到公告。</p>`;
    }

    if (data.errors && data.errors.length) {
      errorNote = `<div class="note">${esc(data.errors.join('；'))}</div>`;
    }
  } catch (err) {
    errorNote = `<div class="note">详情加载失败：${esc(err.message)}</div>`;
  }

  body.innerHTML = `
    <h3>${esc(fund ? fund.name : code)}</h3>
    <p class="sub">${esc(code)}</p>
    ${adviceSection(fund, detailData, dataset.funds)}
    ${kv(fund || { code })}
    ${sections}
    ${notices}
    ${detailBlock}
    ${errorNote}
    <div class="note" style="margin-top:16px">${esc(dataset.disclaimer)}</div>`;

  body.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => openDrawer(btn.dataset.goto));
  });
  initChart(body, navs);
}

function closeDrawer() { $('#drawer').hidden = true; }

/* ---------------- 场内折溢价 ---------------- */

async function renderPremium(force) {
  const host = $('#premium-host');
  if (premiumCache && !force) { paintPremium(host, premiumCache); return; }

  host.innerHTML = '<div class="loading">加载场内行情…</div>';
  try {
    const res = await fetch('/api/premium');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    premiumCache = await res.json();
    paintPremium(host, premiumCache);
  } catch (err) {
    host.innerHTML = `<div class="empty">场内行情接口不可用：${esc(err.message)}</div>`;
  }
}

function paintPremium(host, data) {
  if (!data.items.length) {
    host.innerHTML = '<div class="empty">没有场内交易的 QDII 数据。</div>';
    return;
  }
  const body = data.items.map((it) => {
    const premium = -it.discount;              // f402 负值 = 溢价
    const cls = premium > 3 ? 'limit tight' : premium > 0 ? 'limit limited' : 'limit none';
    const label = premium >= 0 ? `溢价 ${premium.toFixed(2)}%` : `折价 ${(-premium).toFixed(2)}%`;
    return `<tr data-code="${esc(it.code)}">
      <td class="code">${esc(it.code)}</td>
      <td class="name">${esc(it.name)}</td>
      <td class="num"><span class="${cls}">${esc(label)}</span></td>
    </tr>`;
  }).join('');
  host.innerHTML = `<table><thead><tr><th>代码</th><th>基金简称</th>
    <th class="num">相对 T-1 净值</th></tr></thead><tbody>${body}</tbody></table>
    <p style="padding:12px 14px;color:var(--muted);font-size:12.5px;margin:0">
      溢价率高意味着场内买入比净值贵。场外限购时转战场内需权衡这部分成本。</p>`;
  host.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => openDrawer(tr.dataset.code));
  });
}

/* ---------------- 状态更新 ---------------- */

function set(patch) {
  Object.assign(state, patch);
  writeHash();
  render();
}

function toggle(bucket, key) {
  const list = state[bucket];
  state[bucket] = list.includes(key) ? list.filter((x) => x !== key) : [...list, key];
  writeHash();
  render();
}

/* ---------------- 启动 ---------------- */

async function load(force) {
  $('#table-host').innerHTML = '<div class="loading">加载数据中…首次会拉取上游约 4 MB，请稍候。</div>';
  try {
    const res = await fetch(`/api/dataset${force ? '?refresh=1' : ''}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    dataset = await res.json();
    premiumCache = null;

    $('#data-date').textContent = dataset.data_date ? `数据日期 ${dataset.data_date}` : '数据日期未知';
    $('#total-count').textContent = `${dataset.total} 只 QDII`;
    $('#generated-at').textContent = `生成于 ${dataset.generated_at}`;
    $('#disclaimer').textContent = dataset.disclaimer;

    renderStats();
    render();
  } catch (err) {
    $('#table-host').innerHTML = `<div class="empty">数据加载失败：${esc(err.message)}<br>
      <button class="btn" style="margin-top:12px" onclick="location.reload()">重试</button></div>`;
  }
}

function init() {
  readHash();
  load(false);

  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    writeHash();
    renderActiveFilters();
    renderTable();
  });

  $('#clear-filters').addEventListener('click', () => {
    state = { ...DEFAULT_STATE };
    writeHash();
    render();
  });

  $('#refresh').addEventListener('click', async () => {
    toast('正在重新拉取上游数据…');
    await load(true);
    toast('数据已刷新');
  });

  $('#theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
  });

  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $('#tabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    const isFunds = tab.dataset.tab === 'funds';
    $('#table-host').hidden = !isFunds;
    $('#premium-host').hidden = isFunds;
    if (!isFunds) renderPremium(false);
  });

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', closeDrawer);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if (e.key === '/' && document.activeElement !== $('#search')) {
      e.preventDefault();
      $('#search').focus();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
