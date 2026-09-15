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
const source = readFileSync(new URL('../src/qdii_helper/web/app.js', import.meta.url), 'utf8')
  + `\n;globalThis.__t = {
       get state() { return state; }, set state(v) { state = v; },
       get dataset() { return dataset; }, set dataset(v) { dataset = v; },
       visibleFunds, set, toggle, SORTERS, DEFAULT_STATE, readHash,
       PERIOD_LABELS, PERIOD_ORDER, sliceByDays, rangeStats, buildLinePath,
       fmtPct, fmtNum, trendClass,
       buyAdvice, adviceSection, shareClass, siblingShare, breakevenRange, fmtBreakeven,
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

/* ---------- 详情：格式化与净值几何 ---------- */

check('周期标签齐全', T.PERIOD_ORDER.every((k) => T.PERIOD_LABELS[k]), T.PERIOD_ORDER.join(','));
check('近1年标签正确', T.PERIOD_LABELS['1N'] === '近1年');
check('成立来标签正确', T.PERIOD_LABELS.LN === '成立来');

check('fmtPct 空值兜底', T.fmtPct(null) === '—' && T.fmtPct('') === '—' && T.fmtPct(undefined) === '—');
check('fmtPct 带符号', T.fmtPct(1.5) === '+1.50%' && T.fmtPct(-0.69) === '-0.69%');
check('fmtPct 零不带符号', T.fmtPct(0) === '0.00%');
check('fmtNum 空值兜底', T.fmtNum(null) === '—' && T.fmtNum(NaN) === '—');
check('fmtNum 保留小数位', T.fmtNum(8.1177) === '8.1177' && T.fmtNum(1.5, 2) === '1.50');

check('trendClass 涨跌着色',
  T.trendClass(1) === 'pos' && T.trendClass(-1) === 'neg'
  && T.trendClass(0) === '' && T.trendClass(null) === '');

/* 构造 800 个连续交易日的净值，用于区间切片与统计 */
const DAY = 86400000;
const END = Date.parse('2026-09-11');
const series = Array.from({ length: 800 }, (_, i) => {
  const t = END - (799 - i) * DAY;
  return { date: new Date(t).toISOString().slice(0, 10), nav: 100 + i, change: 0 };
});

const last30 = T.sliceByDays(series, 30);
check('sliceByDays 近1月约为 31 个点',
  last30.length >= 29 && last30.length <= 32, `实际 ${last30.length}`);
check('sliceByDays 结果全部落在区间内',
  last30.every((p) => Date.parse(p.date) >= END - 30 * DAY));
check('sliceByDays 保留最后一个点',
  last30[last30.length - 1].date === series[series.length - 1].date);

const last365 = T.sliceByDays(series, 365);
check('sliceByDays 近1年多于近1月', last365.length > last30.length);
check('sliceByDays 近3年多于近1年', T.sliceByDays(series, 1095).length > last365.length);
check('sliceByDays 空输入返回空', T.sliceByDays([], 30).length === 0);
check('sliceByDays 数据不足时退回末尾点',
  T.sliceByDays(series.slice(-1), 30).length === 1);

/* 10 → 12 → 6 → 9：区间跌幅 10%，自峰值回撤 50% */
const stats = T.rangeStats([
  { nav: 10 }, { nav: 12 }, { nav: 6 }, { nav: 9 },
]);
check('rangeStats 区间涨幅', Math.abs(stats.changePct - (-10)) < 1e-9, `实际 ${stats.changePct}`);
check('rangeStats 最大回撤', Math.abs(stats.maxDrawdown - 50) < 1e-9, `实际 ${stats.maxDrawdown}`);
check('rangeStats 区间高低', stats.high === 12 && stats.low === 6);
check('rangeStats 单调上涨时回撤为 0',
  T.rangeStats([{ nav: 1 }, { nav: 2 }, { nav: 3 }]).maxDrawdown === 0);
check('rangeStats 点数不足返回空值',
  T.rangeStats([{ nav: 1 }]).changePct === null);
check('rangeStats 忽略非数值点',
  T.rangeStats([{ nav: 1 }, { nav: null }, { nav: 3 }]).maxDrawdown === 0);

const geo = T.buildLinePath([1, 2, 3], 100, 50, 10);
check('buildLinePath 返回折线与面积', typeof geo.line === 'string' && typeof geo.area === 'string');
check('buildLinePath 折线从起点开始', geo.line.startsWith('M'));
check('buildLinePath 三个点两段线', (geo.line.match(/L/g) || []).length === 2);
check('buildLinePath 面积路径闭合', geo.area.endsWith('Z'));
check('buildLinePath 上下边界贴合 padding',
  Math.abs(geo.yOf(3) - 10) < 1e-9 && Math.abs(geo.yOf(1) - 40) < 1e-9);
check('buildLinePath 首尾贴边',
  Math.abs(geo.xOf(0) - 10) < 1e-9 && Math.abs(geo.xOf(2) - 90) < 1e-9);
check('buildLinePath 空输入返回 null', T.buildLinePath([], 100, 50, 10) === null);
check('buildLinePath 常数列不产生 NaN',
  !T.buildLinePath([5, 5, 5], 100, 50, 10).line.includes('NaN'));

/* ---------- 契约：详情接口字段名与前端一致 ---------- */

check('数据集声明免责声明', typeof payload.disclaimer === 'string' && payload.disclaimer.length > 0);
check('分类计数与实际基金数一致',
  payload.categories.regions.reduce((s, c) => s + c.count, 0) === payload.total,
  `regions 合计 ${payload.categories.regions.reduce((s, c) => s + c.count, 0)} vs ${payload.total}`);

/* ---------- 购买建议 ---------- */

const byCode = (c) => payload.funds.find((f) => f.code === c);
const fundA = byCode('270042');
const fundC = byCode('006479');
const adviceText = (items) => items.map((i) => i.text).join(' ');

check('份额类别识别 A / C',
  T.shareClass(fundA.name) === 'A' && T.shareClass(fundC.name) === 'C',
  `${T.shareClass(fundA.name)} / ${T.shareClass(fundC.name)}`);
check('以 ETF / LOF 结尾不算份额类别',
  T.shareClass('天弘恒生科技ETF') === null && T.shareClass('某某LOF') === null);
check('无类别字母的基金返回 null',
  T.shareClass('华夏全球股票(QDII)(人民币)') === null);
check('空名返回 null', T.shareClass('') === null && T.shareClass(undefined) === null);

check('A 类能找到 C 类份额',
  T.siblingShare(fundA, payload.funds)?.code === '006479');
check('C 类能找到 A 类份额',
  T.siblingShare(fundC, payload.funds)?.code === '270042');
check('非 A/C 份额不配对', T.siblingShare(byCode('021778'), payload.funds) === null);

/* 0.4% 一次性申购费 ÷ 0.4%/年 = 12 个月；服务费越低平衡点越晚 */
const be = T.breakevenRange(0.4);
check('平衡点用量纲正确', Math.abs(be[0] - 12) < 1e-9, `实际 ${be[0]}`);
check('平衡点区间下界更早', be[0] < be[1]);
check('申购费为 0 时无平衡点', T.breakevenRange(0) === null);
check('申购费为 null 时无平衡点', T.breakevenRange(null) === null);

const advA = T.buyAdvice(fundA, { rate: '0.13%', source_rate: '1.30%' }, payload.funds);
const advC = T.buyAdvice(fundC, null, payload.funds);
check('A 类建议写明一次性申购费', /一次性申购费/.test(adviceText(advA)));
check('A 类建议用折后费率而非原价', /0\.13%/.test(adviceText(advA)));
check('A 类建议带出原价', /原价 1\.30%/.test(adviceText(advA)));
check('A 类建议给出平衡持有期',
  /平衡点（约 <b>\d+(\.\d+)?～\d+(\.\d+)? 个月<\/b>）/.test(adviceText(advA)),
  adviceText(advA));
check('C 类建议写明免申购费', /免申购费/.test(adviceText(advC)));
check('C 类建议用同基金 A 类费率算平衡点',
  /平衡点（约 <b>\d+(\.\d+)?～\d+(\.\d+)? 个月<\/b>）/.test(adviceText(advC)),
  adviceText(advC));
check('A 类建议带出 C 类份额代码',
  advA.some((i) => i.goto && i.goto.code === '006479'));
check('C 类建议带出 A 类份额代码',
  advC.some((i) => i.goto && i.goto.code === '270042'));

/* 缺少接口 B 数据时退回到列表里的手续费列 */
const advNoDetail = T.buyAdvice(fundA, null, payload.funds);
check('无接口 B 数据时仍能给出平衡点',
  /平衡点（约 <b>/.test(adviceText(advNoDetail)), adviceText(advNoDetail));
check('平衡点超过两年时改用「年」',
  /^\d+(\.\d+)?～\d+(\.\d+)? 年$/.test(T.fmtBreakeven(T.breakevenRange(1.3))),
  T.fmtBreakeven(T.breakevenRange(1.3)));
check('平衡点为空时返回 null', T.fmtBreakeven(null) === null);

const suspended = payload.funds.find((f) => f.status === '暂停申购');
check('暂停申购给出危险提示',
  T.buyAdvice(suspended, null, payload.funds).some((i) => i.level === 'danger'));
check('买不到的基金不再啰嗦 7 天赎回费',
  !T.buyAdvice(suspended, null, payload.funds).some((i) => i.text.includes('不满 7 天')));
check('场内交易提示看溢价',
  T.buyAdvice(byCode('513100'), null, payload.funds).some((i) => i.text.includes('溢价')));
check('限额 ≤100 元提示分多日买入',
  T.buyAdvice(fundA, null, payload.funds).some((i) => i.text.includes('分多日')));
check('可买的场外基金提示 7 天赎回费',
  T.buyAdvice(fundA, null, payload.funds).some((i) => i.text.includes('不满 7 天')));
check('场内基金不提示 7 天赎回费',
  !T.buyAdvice(byCode('513100'), null, payload.funds).some((i) => i.text.includes('不满 7 天')));

/* 限大额但限额为 0：买不进去，不能说「分多日」 */
const zeroLimit = payload.funds.find((f) => f.buyable && f.limit === 0);
check('存在限 0 元的基金（样本有效）', Boolean(zeroLimit), `实际 ${zeroLimit?.code}`);
const zeroAdvice = T.buyAdvice(zeroLimit, null, payload.funds);
check('限 0 元提示等于买不进去',
  zeroAdvice.some((i) => i.level === 'danger' && i.text.includes('0 元')));
check('限 0 元不再提示分多日',
  !zeroAdvice.some((i) => i.text.includes('分多日')));

/* 另一份额暂停申购时不该出现「暂停申购 · 暂停申购」 */
const dupSib = payload.funds.filter((f) => f.code !== fundC.code)
  .concat([{ ...fundC, status: '暂停申购', limit_text: '暂停申购' }]);
check('另一份额暂停时不重复展示状态',
  T.buyAdvice(fundA, null, dupSib).every((i) => !/(\S+) · \1/.test(i.text)),
  adviceText(T.buyAdvice(fundA, null, dupSib)));

/* 拿不到费率时不该在句子里留破折号 */
const noFeeFund = { ...fundA, fee: '' };
const noFeeAdvice = adviceText(T.buyAdvice(noFeeFund, null, [noFeeFund]));
check('无费率时不给破折号',
  !noFeeAdvice.includes('申购费 —') && noFeeAdvice.includes('一次性申购费'),
  noFeeAdvice);

/* 735 只全跑一遍：不该出现 undefined / NaN / 空建议 */
const brokenAdvice = payload.funds.filter((f) => {
  const t = adviceText(T.buyAdvice(f, null, payload.funds));
  return /undefined|NaN|\[object/.test(t);
});
check('全部基金的建议都无 undefined / NaN',
  brokenAdvice.length === 0,
  `${brokenAdvice.length} 条：${brokenAdvice.slice(0, 3).map((f) => f.code).join(',')}`);

/* 建议块渲染与转义 */
check('adviceSection 渲染出建议块',
  /<div class="advice">/.test(T.adviceSection(fundA, null, payload.funds)));
check('adviceSection 带出可跳转的另一份额',
  /data-goto="006479"/.test(T.adviceSection(fundA, null, payload.funds)));

const evilSib = { ...fundC, limit_text: '<img src=x onerror=alert(1)>', status: '<b>注入</b>' };
const evilOut = T.adviceSection(fundA, null, [evilSib, fundA]);
check('建议块转义另一份额的字段', !/<img/.test(evilOut), evilOut.slice(0, 120));

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
