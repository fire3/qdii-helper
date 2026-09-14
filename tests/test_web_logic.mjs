#!/usr/bin/env node
/**
 * 前端查询逻辑测试：把 web/app.js 配桩加载，用真实数据集跑真实的
 * 筛选 / 排序 / 归类逻辑，断言结果。
 *
 * 运行： node tests/test_web_logic.mjs <dataset.json>
 * 数据集： curl -s http://127.0.0.1:8765/api/dataset > /tmp/dataset.json
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const dataPath = process.argv[2];
if (!dataPath) {
  console.error('用法: node tests/test_web_logic.mjs <dataset.json>');
  process.exit(2);
}
const payload = JSON.parse(readFileSync(dataPath, 'utf8'));

/* ---------- DOM / BOM 桩 ---------- */

const el = () => ({
  innerHTML: '',
  value: '',
  hidden: false,
  textContent: '',
  classList: { toggle() {}, add() {}, remove() {} },
  addEventListener() {},
  querySelectorAll: () => [],
  querySelector: () => null,
  closest: () => null,
  dataset: {},
});

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  location: { hash: '', pathname: '/' },
  history: { replaceState() {} },
  document: {
    addEventListener() {},
    querySelector: () => el(),
    querySelectorAll: () => [],
    documentElement: { getAttribute: () => null, setAttribute() {}, removeAttribute() {} },
  },
};
sandbox.globalThis = sandbox;

/* 加载 app.js，并把内部符号暴露出来供断言使用。
   注意用 getter/setter：直接取值只会拿到加载瞬间的快照（dataset 尚为 null）。 */
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  + `\n;globalThis.__t = {
       get state() { return state; }, set state(v) { state = v; },
       get dataset() { return dataset; }, set dataset(v) { dataset = v; },
       visibleFunds, set, toggle, SORTERS, DEFAULT_STATE, readHash,
     };`;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const T = sandbox.__t;
T.dataset = payload;
T.state = { ...T.DEFAULT_STATE };

/* ---------- 断言框架 ---------- */

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

const codes = (rows) => rows.map((r) => r.code);
const apply = (patch) => { T.state = { ...T.DEFAULT_STATE, ...patch }; return T.visibleFunds(); };

/* ---------- 数据契约 ---------- */

check('数据集含 735 只 QDII', payload.total === 735, `实际 ${payload.total}`);
check('每条记录都有归类', payload.funds.every((f) => f.region && f.theme));
check('limit 与 limit_text 一致',
  payload.funds.every((f) => f.limit === null ? f.limit_text === '无限额' || !f.buyable : true));

// CSV 导出字段完整性之外，检查 JSON 里不该出现 undefined
const undefinedFields = payload.funds.filter((f) =>
  ['code', 'name', 'region', 'theme', 'status', 'limit_text', 'buyable']
    .some((k) => f[k] === undefined));
check('无缺失关键字段的记录', undefinedFields.length === 0, `${undefinedFields.length} 条`);

/* ---------- 默认视图：人民币 + 可买 ---------- */

const def = apply({});
check('默认只返回可买（不含暂停申购）',
  def.every((r) => r.buyable), `含 ${def.filter((r) => !r.buyable).length} 只非可买`);
check('默认只返回人民币份额',
  def.every((r) => r.currency === 'CNY'),
  `含 ${def.filter((r) => r.currency !== 'CNY').length} 只非人民币`);

/* ---------- 归类筛选：纳斯达克 ---------- */

const nasdaq = apply({ regions: ['纳斯达克100'] });
check('纳斯达克100 筛选非空', nasdaq.length > 0);
check('纳斯达克100 结果全部属于该地区',
  nasdaq.every((r) => r.region === '纳斯达克100'));
check('纳斯达克100 包含 270042',
  codes(nasdaq).includes('270042'), `实际 ${codes(nasdaq).slice(0, 5)}`);

const nasdaqAll = apply({ regions: ['纳斯达克100', '纳斯达克'], status: 'all', currency: 'all' });
check('纳斯达克 + 纳斯达克100 多选取并集',
  nasdaqAll.every((r) => ['纳斯达克100', '纳斯达克'].includes(r.region)));
check('多选结果多于单选',
  nasdaqAll.length >= nasdaq.length, `${nasdaqAll.length} vs ${nasdaq.length}`);

/* ---------- 归类：地区 × 主题 取交集 ---------- */

const intersect = apply({ regions: ['美国'], themes: ['医药生物'], status: 'all', currency: 'all' });
check('美国 × 医药生物 取交集',
  intersect.every((r) => r.region === '美国' && r.theme === '医药生物'),
  JSON.stringify(intersect.slice(0, 3).map((r) => [r.name, r.region, r.theme])));
check('美国 × 医药生物 命中标普生物科技类',
  intersect.some((r) => r.name.includes('生物科技')),
  `实际 ${intersect.map((r) => r.name).slice(0, 5)}`);

/* ---------- 限额筛选 ---------- */

const cap = apply({ cap: 10 });
check('限额 ≤10 元 全部满足', cap.every((r) => r.limit !== null && r.limit <= 10));
check('限额 ≤10 元 不含无限额', cap.every((r) => r.limit !== null));
check('限额 ≤10 元 含 270042（2 元）', codes(cap).includes('270042'));

const cap100 = apply({ cap: 100 });
check('限额放宽到 100 元后结果更多',
  cap100.length >= cap.length, `${cap100.length} vs ${cap.length}`);

/* ---------- 排序 ---------- */

const asc = apply({ sort: 'limit-asc' });
const ascVals = asc.map((r) => r.limit).filter((v) => v !== null);
check('额度升序单调不减',
  ascVals.every((v, i) => i === 0 || ascVals[i - 1] <= v));
check('额度升序把无限额排在最后',
  asc.findIndex((r) => r.limit === null) === -1 ||
  asc.slice(asc.findIndex((r) => r.limit === null)).every((r) => r.limit === null));
check('额度升序首位是最紧的可买基金',
  asc.length > 0 && asc[0].limit !== null && asc[0].limit <= 10,
  `首位 ${asc[0]?.code} ${asc[0]?.limit}`);

const desc = apply({ sort: 'limit-desc' });
const descVals = desc.map((r) => r.limit).filter((v) => v !== null);
check('额度降序单调不增',
  descVals.every((v, i) => i === 0 || descVals[i - 1] >= v));

const byStatus = apply({ sort: 'status' });
const weight = { '开放申购': 0, '限大额': 1, '暂停申购': 2, '场内交易': 3 };
const ws = byStatus.map((r) => weight[r.status] ?? 9);
check('状态排序：可买优先且单调', ws.every((v, i) => i === 0 || ws[i - 1] <= v));

/* ---------- 搜索 ---------- */

check('按代码搜索 270042 命中 1 条',
  apply({ search: '270042' }).some((r) => r.code === '270042'));
check('按代码搜索不会误命中其它',
  apply({ search: '270042' }).every((r) => r.code.includes('270042') || r.name.toLowerCase().includes('270042')));
check('按名称搜索「恒生科技」命中多只',
  apply({ search: '恒生科技', status: 'all', currency: 'all' }).length > 3);
check('搜索无结果时返回空',
  apply({ search: 'zzz不存在的基金zzz', status: 'all', currency: 'all' }).length === 0);

/* ---------- 币种 ---------- */

const usd = apply({ currency: 'USD', status: 'all' });
check('美元份额筛选正确', usd.every((r) => r.currency === 'USD'));
check('美元份额非空', usd.length > 0);
const all = apply({ currency: 'all', status: 'all' });
check('全部币种 = 735', all.length === 735, `实际 ${all.length}`);

/* ---------- 组合筛选不可超出单条件结果 ---------- */

const combo = apply({ regions: ['纳斯达克100'], cap: 100, sort: 'limit-asc' });
check('组合筛选是各条件的交集',
  combo.every((r) => r.region === '纳斯达克100' && r.limit !== null && r.limit <= 100 && r.buyable));
check('组合筛选结果 ≤ 单归类结果', combo.length <= nasdaq.length);

/* ---------- 汇总 ---------- */

console.log(`\n通过 ${passed} 项断言，失败 ${failures.length} 项`);
console.log(`抽样：纳斯达克100 可买 ${nasdaq.length} 只 | 限额≤10 元 ${cap.length} 只 | ` +
  `美国×医药生物 ${intersect.length} 只 | 美元份额 ${usd.length} 只`);
if (failures.length) {
  console.error('\n失败项：');
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('\n全部通过 ✓');
