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
  sort: 'limit-asc',
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
    sort: p.get('so') || 'limit-asc',
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
  if (state.sort !== 'limit-asc') p.set('so', state.sort);
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

  let extra = '';
  let notices = '';
  try {
    const res = await fetch(`/api/fund?code=${encodeURIComponent(code)}`);
    const data = await res.json();
    if (data.detail) {
      const d = data.detail;
      extra = `<div class="section-title">实时详情（接口 B）</div><dl class="kv">
        <dt>基金公司</dt><dd>${esc(d.company || '—')}</dd>
        <dt>基金经理</dt><dd>${esc(d.manager || '—')}</dd>
        <dt>实时状态</dt><dd>${esc(d.purchase_status || '—')}</dd>
        <dt>最大申购</dt><dd>${esc(d.max_purchase || '—')}</dd>
        <dt>费率</dt><dd>${esc(d.source_rate || '—')} → ${esc(d.rate || '—')}</dd>
        <dt>风险等级</dt><dd>${esc(d.risk_level || '—')}</dd>
      </dl>`;
    }
    if (data.notices && data.notices.length) {
      notices = `<div class="section-title">申购相关公告（接口 D，type=5）</div>` +
        data.notices.map((n) => `<div class="notice">
          <span class="d">${esc(n.date)}</span>${esc(n.title)}</div>`).join('');
    } else {
      notices = '<div class="section-title">申购相关公告</div><p style="color:var(--muted);font-size:12.5px">未取到公告。</p>';
    }
    if (data.errors && data.errors.length) {
      extra += `<div class="note">${esc(data.errors.join('；'))}</div>`;
    }
  } catch (err) {
    extra = `<div class="note">详情加载失败：${esc(err.message)}</div>`;
  }

  body.innerHTML = `
    <h3>${esc(fund ? fund.name : code)}</h3>
    <p class="sub">${esc(code)}</p>
    ${kv(fund || { code })}
    ${extra}${notices}
    <div class="note" style="margin-top:16px">${esc(dataset.disclaimer)}</div>`;
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
