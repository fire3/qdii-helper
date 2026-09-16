# qdii-helper

QDII 基金限购额度查询工具。

2026 年 QDII 额度持续紧张，735 只 QDII 中有 **196 只「限大额」、67 只「暂停申购」**，
单日限购低至 **2 元**。本项目解决一个具体问题：

> **「我想买的这只 QDII，今天还能买多少？」**

---

## 目录

| 路径 | 内容 |
|---|---|
| [`pyproject.toml`](pyproject.toml) | 打包配置 —— `pip install .` 后得到 `qdii-web` / `qdii-limit` 两个命令 |
| [`docs/api.md`](docs/api.md) | **接口文档** —— 天天基金/东方财富限购相关接口的逆向调研结果，全部实测验证 |
| [`docs/design.md`](docs/design.md) | **设计文档** —— 数据源选型、数据模型、归一化算法、归类设计、CLI/Web 设计、演进路线 |
| [`src/qdii_helper/qdii_limit.py`](src/qdii_helper/qdii_limit.py) | P0：命令行工具（仅标准库） |
| [`src/qdii_helper/qdii_categories.py`](src/qdii_helper/qdii_categories.py) | 归类规则（地区/市场 × 主题 两个维度） |
| [`src/qdii_helper/qdii_web.py`](src/qdii_helper/qdii_web.py) | P1：Web 工具后端（仅标准库，复用上述两个模块） |
| [`src/qdii_helper/web/`](src/qdii_helper/web/) | P1：零依赖前端（HTML + CSS + JS，无构建步骤） |
| [`tests/`](tests/) | 归一化规则 + 前端查询逻辑测试 |

---

## 安装

```bash
pip install .                                              # 在仓库根目录
pip install git+https://github.com/fire3/qdii-helper.git    # 或直接装 GitHub 上的版本
```

> 如果安装时报 `Could not find a version that satisfies the requirement setuptools>=61 (from versions: none)`，
> 那多半是镜像拦了 pip 的 User-Agent，不是本仓库的问题（用 curl／浏览器访问同一个地址却是 200）。
> 升级 pip 后 UA 会变，通常就能恢复：
>
> ```bash
> python -m pip install -U pip                               # 先试这个
> pip install . -i https://mirrors.aliyun.com/pypi/simple     # 或者临时换一个能用的镜像
> pip install . --no-build-isolation                          # 或者复用本机已有的 setuptools（需 >= 61）
> ```

装好后直接用一个命令启动 Web 工具：

```bash
qdii-web                    # http://127.0.0.1:8765
qdii-web --port 9000        # 换端口
qdii-web --host 0.0.0.0     # 局域网可访问
```

命令行工具同理（下文示例中的 `qdii-limit`）。

不想安装时，两种都能直接跑：

```bash
PYTHONPATH=src python3 -m qdii_helper.qdii_web
PYTHONPATH=src python3 -m qdii_helper.qdii_limit list
```

**数据缓存**在用户缓存目录，不在仓库或安装目录里：

| 平台 | 路径 |
|---|---|
| Linux | `$XDG_CACHE_HOME/qdii-helper`（默认 `~/.cache/qdii-helper`） |
| macOS | `~/Library/Caches/qdii-helper` |
| Windows | `%LOCALAPPDATA%\qdii-helper` |

可用环境变量 `QDII_HELPER_CACHE_DIR` 覆盖。删掉该目录即可强制重新拉取。

---

## 一、命令行工具

无需安装任何依赖，Python 3.8+：

```bash
# 可买的 QDII，额度从高到低
qdii-limit list

# 限大额且日限额 <= 25 元，按额度从紧到松
qdii-limit list --status 限大额 --max-limit 25 --sort limit-asc

# 额度最紧的 20 只
qdii-limit top --n 20

# 单只基金详情 + 最近限购公告
qdii-limit show 270042

# 场内 QDII 折溢价（评估"转战场内"的代价）
qdii-limit premium --n 30

# 导出
qdii-limit list --status 全部 --format json
```

## 二、Web 工具

```bash
qdii-web                 # http://127.0.0.1:8765
qdii-web --port 9000     # 换端口
qdii-web --host 0.0.0.0  # 局域网可访问
```

首次打开会拉取上游数据（约 4 MB），之后 30 分钟走缓存。

### 功能

- **双维度归类**：24 个「地区/市场」× 14 个「主题」，735 只全部覆盖，无未分类残留
  - 地区：纳斯达克100、标普500、恒生科技、恒生医药、中概互联、日本、德国、越南、印度…
  - 主题：半导体、医药生物、科技互联网、能源、贵金属/商品、债券、红利/国企…
  - 两个维度各自多选，**维内取并集、维度间取交集** —— 直接回答
    「美国的、医药生物的 QDII 还有多少能买？」
- **额度筛选**：≤10 元 / ≤100 元 / ≤1000 元 / ≤1 万 / ≤100 万 / 不限
- **状态筛选**：可买 / 限大额 / 开放申购 / 暂停申购 / 场内交易 / 全部
- **搜索**：基金代码或名称
- **排序**：额度从紧到松 / 从松到紧 / 可买优先 / 按名称
- **详情抽屉**：点击任意基金，查看可指导购买的完整信息
  - **购买建议**：置顶提示。A/C 份额怎么选（用折后申购费算出与另一类的**平衡持有期**）、
    同基金另一类份额的代码/限额/状态（**可点击直达**）、7 天赎回费红线、限购与状态提醒
  - **净值走势**：区间可切换（近1月/近3月/近6月/近1年/近3年），附区间涨幅与**最大回撤**
  - **收益表现**：近1周到成立来的分周期收益率，对比**同类平均**、**沪深300**，并给出**同类排名**
  - **规模变动**：季度净资产规模及环比
  - **资产配置 / 持有人结构**：股/债/现金占净比、机构与个人持有比例
  - **主要成分**：重仓股及增减持；联接基金显示底层 ETF
  - 另有实时详情（基金公司 / 基金经理 / 费率 / 风险等级）
- **场内折溢价**：85 只场内 QDII 的溢价率排行
- **查询可分享**：筛选条件写入 URL hash，复制链接即可复现同一查询
- 深色模式、响应式；`/` 聚焦搜索框，`Esc` 关闭抽屉

### 归类示例

以下数字均为实测（数据日期 2026-09-14）：

```
默认视图 = 人民币份额 + 可买                        → 419 只
点「纳斯达克100」                                   → 31 只（含 270042，日限额 2 元）
点「纳斯达克100」+「限额 ≤100 元」                  → 29 只
点「限额 ≤10 元」                                   → 50 只
点「恒生科技」                                      → 46 只
状态改为「全部」+「美国」+「医药生物」               → 5 只（标普生物科技类）
```

## 测试

```bash
python3 tests/test_normalize.py                              # 24 项，归一化规则 + pingzhongdata 解析

# 前端查询逻辑（需要服务在跑）
curl -s http://127.0.0.1:8765/api/dataset > /tmp/dataset.json
node tests/test_web_logic.mjs /tmp/dataset.json               # 100 项
```

---

## 输出示例

```
$ qdii-limit list --status 限大额 --max-limit 25 --sort limit-asc

  代码    基金简称                              类型              净值(日期)                日限额         起点  费率
  ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  270042  广发纳斯达克100ETF联接人民币(QDII)A   指数型-海外股票   8.1177 (09-11)              2 元         2 元  0.13%
  006479  广发纳斯达克100ETF联接人民币(QDII)C   指数型-海外股票   7.9752 (09-11)              2 元         2 元  0.00%
  000834  大成纳斯达克100ETF联接(QDII)A         指数型-海外股票   6.2705 (09-11)             10 元        10 元  0.12%
  017641  摩根标普500指数(QDII)人民币A          指数型-海外股票   1.7012 (09-11)             10 元        10 元  0.12%

  共 43 只（匹配 735 只 QDII） · 仅供参考，实际限额以基金公司最新公告为准
```

---

## 调研要点

全部结论均来自实测（详见 `docs/api.md`）：

**首选数据源是一接口拿全量** —— `fund.eastmoney.com/Data/Fund_JJJZ_Data.aspx?t=8`
单次返回 27538 只基金的申购状态与日累计限定金额（约 4.1 MB）。
无需逐只请求，避免对非官方接口造成压力。

调研中发现的几个关键坑：

| 坑 | 后果 | 处理 |
|---|---|---|
| QDII 标签分裂为 `QDII-*` 与 `指数型-海外股票` | 只匹配 `QDII` 会漏掉 **365 只**（含纳指100 等主流标的） | 两类标签并集，实测 735 只 |
| `日累计限定金额` 用大整数表示「无限额」 | 被当成真实额度参与排序 | 实测真实限额最高仅 5 千万，`>= 1e8` 即视为无限额 |
| 响应体是 JS 对象字面量，key 无引号 | `json.loads` 整体解析失败 | 截取 `datas` 数组解析 |
| `中银美元债债券(QDII)人民币A` 含「美元」但是人民币份额 | 币种误判 | 「人民币」优先判定 |
| `美汇`/`美钞` 是美元的简写变体 | 漏判为人民币份额 | 补充标记 |
| 赎回状态是另一套枚举（`开放赎回` ≠ `开放申购`） | 赎回状态显示为空 | 独立 `RedeemStatus` 枚举 |
| 场内 QDII ETF 溢价可达 **23%** | 场外限购时盲目转场内会多付两成成本 | 提供 `premium` 子命令 |
| `pingzhongdata` 是 JS 文本（`var X = <json>;`）而非 JSON | 整体 `json.loads` 失败 | 按 `var` 逐块截取解析，非 JSON 块跳过 |
| 净值时间戳是**北京时间零点** | 按 UTC 取日期会差一天 | 按 UTC+8 换算 |
| 持仓接口的报告期 `Expansion` 在**响应顶层** | 从 `Datas` 里取不到报告期 | 在顶层读取 |
| 联接基金 `fundStocks` 为空（只持有 ETF） | 「主要成分」空白 | 回退展示 `ETFCODE` 底层 ETF |
| 旧估值接口 `fundgz.1234567.com.cn` 已 404 | 按老资料实现会全部失败 | 已标注弃用 |

---

## 免责声明

- 数据来自天天基金/东方财富的**非官方公开接口**，无 SLA，字段可能随时变更
- 请控制请求频率（建议 ≥30 分钟一次），禁止高频轮询与商业分发
- 工具输出**仅供参考**，实际申购限额以基金公司最新公告为准
