# QDII 基金限购额度查询工具 — 设计文档

> 目标：回答一个具体问题 —— **「我想买的这只 QDII，今天还能买多少？」**

---

## 1. 问题背景

2026 年 QDII 额度持续紧张，限购已成为常态。实测数据（`2026-09-14`）：

| 现象 | 实测 |
|---|---|
| QDII 基金总数 | **735 只**（`QDII-*` 370 + `指数型-海外股票` 365） |
| 处于「限大额」 | **196 只**（占 27%） |
| 处于「暂停申购」 | **67 只** |
| 单日限购 10 元及以下 | 至少 8 只（如 `270042`/`006479` 限 **2 元**，`000834` 限 **10 元**） |

投资者的真实痛点：

1. **额度分散且极低** —— 同一指数下不同公司限额差异巨大（纳指100：2 元 / 10 元 / 100 元 / 1 万元）
2. **变化频繁** —— 基金公司几乎每周都在「调整大额申购限额」
3. **口径混乱** —— 天天基金、各销售渠道、基金公司公告三处数字可能不一致
4. **份额类别干扰** —— 人民币份额限 10 元，美元份额可能显示 0（渠道不售）
5. **场内溢价陷阱** —— 场外买不到时转场内，但 QDII ETF 实测溢价 **8%~10%**

结论：需要工具把「735 只基金 × 5 种状态 × 多份额类别」压缩成一张可决策的表。

---

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 验收标准 |
|---|---|---|
| G1 | 一屏看全市场 QDII 限购现状 | 单次 Fetch 覆盖全部 735 只 |
| G2 | 按限额精确排序，找出「还能买的」 | 限额 2 元 → 1000 万 正序可排 |
| G3 | 区分人民币 / 美元份额，避免 0 值污染 | 美元份额独立标注 |
| G4 | 定位限购公告与生效日期 | 关联 `type=5` 公告标题与日期 |
| G5 | 场内替代方案提示 | 展示 ETF 溢价率 `f402` |
| G6 | 零依赖可运行 | 仅需 Python 3.8+ 标准库 / 浏览器 |

### 2.2 非目标

- ❌ 不做下单交易
- ❌ 不做净值预测 / 估值（`fundgz` 估值接口已失效，见 `api.md` §8）
- ❌ 不做历史额度回溯建模（上游无历史额度接口，只能靠工具自身落库累积）
- ❌ 不做付费数据源（Tushare 等）接入

---

## 3. 数据源选型

依据 `docs/api.md` 的实测结论：

| 用途 | 接口 | 理由 |
|---|---|---|
| **主数据源** | A. `Fund_JJJZ_Data.aspx?t=8` | 一次请求拿全市场 27538 行，含 `日累计限定金额`，是唯一能一次覆盖全量 QDII 的接口 |
| 详情补全 | B. `FundMNewApi/FundMNBasicInformation` | `FSRQ` 带年份、`MINSG/MAXSG` 结构化、含 `DUEDATE`；支持 CORS |
| 公告溯源 | D. `api.fund.eastmoney.com/f10/JJGG?type=5` | 唯一能给出「为什么限购 / 何时生效」的接口 |
| 场内溢价 | F. `push2delay.../clist/get` | QDII ETF 替代路径必需 |
| 交叉校验 | C. `fundf10.eastmoney.com/jjfl_{code}.html` | 提供 A/B 都没有的 `持仓上限` |

**关键决策：主数据源用接口 A，而非逐只调用接口 B。**
理由：735 只 × 1 请求 = 735 次请求，对非官方接口是明显的滥用风险；
接口 A 全量 27538 只仅 1 次请求 / 4.1 MB，且 QDII 只是其子集。
接口 B 仅在用户**下钻单只基金**时按需调用。

### 3.1 数据流

```
                  ┌─────────────────────────────┐
                  │ 接口 A (1 次 / 4.1 MB)      │
                  │ 全市场申购状态              │
                  └──────────────┬──────────────┘
                                 │ 解析 datas 数组 (27538 行)
                                 ▼
                  ┌─────────────────────────────┐
                  │ ① QDII 过滤    (§1.3 口径)  │
                  │ ② 状态归一化   (§1.1)       │
                  │ ③ 限额归一化   (§1.2 哨兵)  │
                  │ ④ 份额币种识别 (§1.4)       │
                  └──────────────┬──────────────┘
                                 ▼
                  ┌─────────────────────────────┐
                  │ 内存数据集 735 只            │
                  │  + TTL 缓存 (默认 30 min)    │
                  └──────────────┬──────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
   list / top               show <code>              watch (轮询 diff)
   (纯内存筛选排序)          ├─ 接口 B 详情            ├─ 接口 A 定时拉取
                            ├─ 接口 D 公告            └─ 额度变化告警
                            └─ 接口 F 场内溢价
```

---

## 4. 数据模型

```python
from dataclasses import dataclass, field
from enum import Enum


class PurchaseStatus(str, Enum):
    OPEN = "开放申购"
    LIMITED = "限大额"        # 核心关注
    SUSPENDED = "暂停申购"
    ON_EXCHANGE = "场内交易"
    CLOSED = "封闭期"
    SUBSCRIBING = "认购期"
    UNKNOWN = ""


class RedeemStatus(str, Enum):
    """赎回状态是另一套枚举（开放赎回 vs 开放申购），不能复用 PurchaseStatus。"""
    OPEN = "开放赎回"
    SUSPENDED = "暂停赎回"
    ON_EXCHANGE = "场内交易"
    CLOSED = "封闭期"
    SUBSCRIBING = "认购期"
    UNKNOWN = ""


class Currency(str, Enum):
    CNY = "CNY"
    USD = "USD"


@dataclass(frozen=True)
class FundLimit:
    # ---- 身份 ----
    code: str                      # "270042"
    name: str                      # "广发纳斯达克100ETF联接人民币(QDII)A"
    fund_type: str                 # "指数型-海外股票"
    currency: Currency             # CNY / USD

    # ---- 申购 ----
    status: PurchaseStatus
    daily_limit: float | None      # None = 无限额；单位见 currency
    min_purchase: float | None
    next_open_date: str | None     # "2026-12-08" 或 None

    # ---- 赎回 ----
    redeem_status: RedeemStatus

    # ---- 参考信息 ----
    nav: float | None              # 单位净值
    nav_date: str | None           # "09-11" (接口 A) / "2026-09-11" (接口 B)
    fee: str                       # "0.13%" / ""

    # ---- 派生 ----
    @property
    def is_on_exchange(self) -> bool:
        return self.status is PurchaseStatus.ON_EXCHANGE

    @property
    def is_buyable(self) -> bool:
        return self.status in (PurchaseStatus.OPEN, PurchaseStatus.LIMITED)

    @property
    def limit_display(self) -> str:
        if self.status is PurchaseStatus.SUSPENDED:
            return "暂停申购"
        if self.is_on_exchange:
            return "场内交易"
        if self.daily_limit is None:
            return "无限额"
        return f"{self.daily_limit:,.0f} 元" if self.currency is Currency.CNY \
               else f"{self.daily_limit:,.2f} 美元"
```

设计取舍：

- `daily_limit = None` 表示**无限额**，把「哨兵值」在归一化阶段就消灭，避免下游到处写 `if x >= 1e10`
- `Currency` 独立成字段，使「按人民币额度排序」这类操作不必再做字符串匹配
- `is_on_exchange` 单列，因为 `场内交易` 意味着**完全不经过申赎额度**
- **份额类别（A/C/D/F）不单独建模** —— 简称里已含该信息，单独建字段在 P0 阶段属于无用抽象

---

## 5. 核心算法

### 5.1 QDII 识别（对应 `api.md` §1.3）

```python
def is_qdii(fund_type: str) -> bool:
    """注意：指数型 QDII 的标签是「指数型-海外股票」，不含 QDII 字样。"""
    return fund_type.startswith("QDII-") or fund_type == "指数型-海外股票"
```

**这是最容易出错的地方** —— 只用 `"QDII" in fund_type` 会漏掉 365 只（约一半），
包括 `270042 广发纳斯达克100ETF联接人民币(QDII)A` 这类最主流的标的。

> 后续若东财新增 `指数型-海外债券` 等标签，需扩展该函数；
> 建议加一条「标签白名单变更」的回归测试。

### 5.2 限额归一化（对应 `api.md` §1.2）

```python
UNLIMITED_THRESHOLD = 1e10   # 实测哨兵值 ≥ 1e10

def normalize_limit(raw: str, status: PurchaseStatus,
                    currency: Currency) -> float | None:
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None                       # "--" / "" 等

    if v >= UNLIMITED_THRESHOLD:
        return None                       # 无限额

    if v == 0:
        # 场内交易：本就不走申赎通道
        if status == PurchaseStatus.ON_EXCHANGE:
            return None
        # 美元份额：天天基金渠道不售，0 不代表「限 0 元」
        if currency is Currency.USD:
            return None
        # 人民币 + 限大额：真实就是 0（暂停但未公告）
        return 0.0

    return v
```

`v == 0` 的处理是三个不同业务含义挤在同一个数值上，必须结合 `status` 与 `currency`
才能正确区分 —— 这是设计里唯一需要「多字段联合判断」的规则。

### 5.3 份额币种判定（对应 `api.md` §1.4）

**这条规则踩过坑，务必注意「人民币」的优先级。**

朴素做法「名称含 `美元` 即为美元份额」是**错的**：
`中银美元债债券(QDII)人民币A`、`汇添富美元债债券(QDII)人民币A` 是 **人民币份额**，
只是投资标的为美元债，名称中的「美元」描述的是**投资方向而非份额币种**。

实测全量 QDII 名称中，同时含「美元」与「人民币」的有 **12 只**（真·人民币份额）。

```python
USD_MARKERS = ("美元", "美汇", "美钞", "现汇", "现钞")

def parse_currency(name: str) -> Currency:
    if "人民币" in name:          # 「人民币」优先，避免美元债主题误判
        return Currency.CNY
    return Currency.USD if any(k in name for k in USD_MARKERS) else Currency.CNY
```

标记覆盖率（实测 334 只含币种关键字的 QDII）：

| 标记 | 数量 | 示例 |
|---|---|---|
| `人民币` | 152 | `华夏全球股票(QDII)(人民币)` |
| `美元现汇` | 90 | `嘉实美国成长股票美元现汇` |
| `美元` | 65 | `广发纳斯达克100ETF联接美元(QDII)A` |
| `美元现钞` | 17 | `嘉实全球互联网股票美元现钞` |
| `现汇` / `现钞` | 3 / 3 | `华夏恒生ETF联接现汇` |
| `美汇` / `美钞` | 2 / 2 | `摩根富时发达市场REITs指数(QDII)美汇` |

> `美汇`/`美钞` 这种简写很容易被漏掉，漏掉后摩根那两只会被误判为人民币份额。

### 5.4 排序与分组

| 视图 | 排序键 | 用途 |
|---|---|---|
| 最紧额度 | `daily_limit` 升序（`None` 排最后） | 看「哪些基金几乎买不到」 |
| 最松额度 | `daily_limit` 降序 | 看「还有哪些能买」 |
| 可买优先 | `status` 权重 → `daily_limit` 降序 | **默认视图**，直接给可操作结论 |
| 按类型 | `fund_type` → 额度升序 | 纳指100 / 标普500 横向对比 |

`status` 权重：`开放申购(0) < 限大额(1) < 暂停申购(2) < 场内交易(3) < 封闭期(4)`

### 5.5 缓存策略

上游是**日频**数据（`showday` 只到日），因此：

- 内存 / 磁盘缓存 TTL = **30 分钟**（远小于数据变化频率）
- 缓存文件：`.cache/sgzt_{YYYYMMDD_HHMM}.json`
- 单次全量 4.1 MB，落盘 JSON 约 3 MB，保留最近 2 份即可

**不建议更频繁**：一是数据本身日频，二是对非官方接口应保持克制。

---

## 6. 接口设计（CLI）

采用子命令结构，与 `api.md` 的接口一一对应但隐藏实现细节。

```bash
# 默认视图：可买的 QDII，可买优先 + 额度从高到低
qdii_limit list

# 只看限大额，且筛选条件（金额单位：元）
qdii_limit list --status 限大额 --min-limit 0 --max-limit 100 --sort limit-asc

# 按指数主题过滤（对简称做子串匹配）
qdii_limit list --keyword 纳斯达克 --currency cny

# 额度最紧的 20 只
qdii_limit top --n 20 --kind tight

# 单只基金详情（接口 A 行 + 接口 B 详情 + 接口 D 公告）
qdii_limit show 270042

# 场内 QDII 折溢价（接口 F），用于评估"场外买不到就转场内"的代价
qdii_limit premium --n 30

# 输出格式
qdii_limit list --format table|csv|json
```

### 6.1 参数表

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `--status` | `开放申购`/`限大额`/`暂停申购`/`场内交易`/`可买` | `可买` | 支持多值 |
| `--min-limit` / `--max-limit` | 数字 | — | 过滤 `daily_limit`（元） |
| `--currency` | `cny`/`usd`/`all` | `cny` | **默认 CNY**，屏蔽美元份额噪声 |
| `--keyword` | 字符串 | — | 简称或代码子串匹配 |
| `--sort` | `limit-asc`/`limit-desc`/`status` | `status` | |
| `--n` | 整数 | 20 | `top` 条数 |
| `--no-cache` | flag | off | 强制刷新 |
| `--format` | `table`/`csv`/`json` | `table` | |

> 未显式指定 `--status` 时默认只显示 `可买`（`开放申购` + `限大额`），因为查询工具的
> 主命题是「现在还能买什么」；要看全貌需显式传 `--status 全部`。

### 6.2 输出示例（实测）

```
$ qdii_limit list --status 限大额 --max-limit 25 --sort limit-asc

  代码    基金简称                              类型              净值(日期)             日限额   起点  费率
  ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  270042  广发纳斯达克100ETF联接人民币(QDII)A   指数型-海外股票   8.1177 (09-11)           2 元   2 元  0.13%
  006479  广发纳斯达克100ETF联接人民币(QDII)C   指数型-海外股票   7.9752 (09-11)           2 元   2 元  0.00%
  000834  大成纳斯达克100ETF联接(QDII)A         指数型-海外股票   6.2705 (09-11)          10 元  10 元  0.12%
  017641  摩根标普500指数(QDII)人民币A          指数型-海外股票   1.7012 (09-11)          10 元  10 元  0.12%
  501312  华宝海外科技股票(QDII-LOF)A           QDII-普通股票     2.3686 (09-11)          20 元  10 元  0.12%

  共 43 只（匹配 735 只 QDII） · 仅供参考，实际限额以基金公司最新公告为准

$ qdii_limit show 270042

  广发纳斯达克100ETF联接人民币(QDII)A
  ──────────────────────────────────────────────────────────────────
  代码          270042              类型        指数型-海外股票
  申购状态      限大额              赎回状态    开放赎回
  日累计限额    2 元                申购起点    2 元
  单位净值      8.1177 (09-11)      费率        0.13%
  份额币种      CNY
  基金公司      广发基金            基金经理    刘杰
  费率(实时)    1.30% → 0.13%
  ──────────────────────────────────────────────────────────────────
  最近申购相关公告
    2026-09-10  广发基金管理有限公司关于…(QDII)人民币份额调整大额申购…业务限额的公告
    2026-07-20  关于…(QDII)A类及C类基金份额调整大额申购…业务限额的公告

  仅供参考，实际限额以基金公司最新公告为准

$ qdii_limit premium --n 5

  场内 QDII 折溢价（共 5 只）

  代码    名称                              折价率  说明
  ──────────────────────────────────────────────────────
  159509  纳指科技ETF景顺                  -22.97%  溢价 22.97%
  159501  纳指ETF嘉实                      -11.82%  溢价 11.82%
  159513  纳斯达克100ETF大成                -6.60%  溢价 6.60%
  159518  标普油气ETF嘉实                   -2.60%  溢价 2.60%
  159529  标普消费ETF景顺                   -0.63%  溢价 0.63%
```

### 6.3 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 参数错误 |
| `2` | 基金代码不存在 / 非 QDII |
| `3` | 上游接口不可达 / 解析失败 |

---

## 7. 形态演进

| 阶段 | 形态 | 技术 | 适用 |
|---|---|---|---|
| **P0（本文参考实现）** | Python CLI | 仅标准库 `urllib` | 本地、可脚本化、零依赖 |
| P1 | 纯静态页 | 单 HTML，直连接口 B（**CORS `*`**，`api.md` §3.2） | 手机随手看、可分享；参考 `zddhhh/qdii-monitor` |
| P2 | 静态 + 定时落库 | GitHub Actions 每 30 min 拉接口 A → `data.json` | 避免客户端各自请求上游；天然形成**额度历史** |
| P3 | 服务 + 告警 | SQLite 落库 + diff 检测 | 「我关注的基金额度变了」推送 |

**P2 是性价比拐点**：因为上游没有额度历史接口（`api.md` §8），
额度的时间序列只能靠自己累积。P0/P1 都是无状态的，P2 才开始产生增量价值。

**P1 与 P0 可共用同一套归一化规则**（§5.1–5.4 是纯函数），
建议将其实现为独立模块，CLI 与前端各自复用。

---

## 8. 失败模式与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 上游改字段 / 改路径 | 全部失败 | 解析层加**结构校验**：`datas` 存在、每行 13 列、字段数不符则明确报错而非静默出错 |
| `datas` key 无引号导致 JSON 解析失败 | 全量失败 | 用截取数组的方式解析（`api.md` §2.4），**不要** `json.loads` 整个响应体 |
| `指数型-海外股票` 标签变更 | QDII 漏筛一半 | 标签白名单 + 覆盖率告警：QDII 数量 < 500 时警告 |
| 净值日期只有 `MM-DD` | 跨年误判 | 展示层补当前年份；需要精确日期时回退接口 B 的 `FSRQ` |
| `push2` 主域名超时 | 溢价率缺失 | 自动切 `push2delay`（`api.md` §7.5）；溢价缺失不阻断主流程 |
| 美元份额 0 值污染排序 | 结论错误 | 默认 `--currency CNY`，USD 需显式指定 |
| 被上游限流 / 封禁 | 不可用 | 建议 ≥30 min 一次；带 `User-Agent` / `Referer`；失败指数退避 |

---

## 9. 合规与免责

1. 全部数据来自公开网页接口，**非官方 API**，无 SLA
2. 限制请求频率，禁止高频轮询与商业分发
3. 工具输出**仅供参考**，实际限额以基金公司最新公告为准（对应接口 D）
4. 界面/输出应固定携带免责声明与数据日期，避免用户基于过期数据决策

---

## 10. 参考实现

`src/qdii_limit.py` 是本设计的 P0 落地版本：

- 仅用 Python 标准库（`urllib` / `json` / `re` / `dataclasses` / `argparse`）
- 实现 §5.1–5.5 全部规则
- 提供 `list` / `top` / `show` 三个子命令
- 已实测跑通，输出即 §6.2 示例

相关文档：接口细节见 [`api.md`](./api.md)。
