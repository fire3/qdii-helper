#!/usr/bin/env python3
"""QDII 基金限购额度查询工具（参考实现）。

数据源与字段语义见 docs/api.md，设计说明见 docs/design.md。
仅依赖 Python 3.8+ 标准库。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache"
CACHE_TTL = 30 * 60

# 「无限额」哨兵值实测有 9,999,999,999 / 1e10 / 1e11 等多种写法，
# 而真实限额最高仅 50,000,000（5 千万），1e8 是安全的判定阈值。
UNLIMITED_THRESHOLD = 1e8

# 「人民币」优先于其它币种标记：如「中银美元债债券(QDII)人民币A」是人民币份额，
# 只是投资标的为美元债，名称中的「美元」不代表份额币种。
USD_MARKERS = ("美元", "美汇", "美钞", "现汇", "现钞")
HKD_MARKERS = ("港币", "港元")

EXIT_OK, EXIT_ARG, EXIT_NOTFOUND, EXIT_UPSTREAM = 0, 1, 2, 3

DISCLAIMER = "仅供参考，实际限额以基金公司最新公告为准"


class UpstreamError(RuntimeError):
    pass


class PurchaseStatus(str, Enum):
    OPEN = "开放申购"
    LIMITED = "限大额"
    SUSPENDED = "暂停申购"
    ON_EXCHANGE = "场内交易"
    CLOSED = "封闭期"
    SUBSCRIBING = "认购期"
    UNKNOWN = ""

    @classmethod
    def parse(cls, raw: str) -> "PurchaseStatus":
        try:
            return cls(raw or "")
        except ValueError:
            return cls.UNKNOWN


class RedeemStatus(str, Enum):
    """赎回状态取值与申购状态不同（`开放赎回` vs `开放申购`），不能复用枚举。"""

    OPEN = "开放赎回"
    SUSPENDED = "暂停赎回"
    ON_EXCHANGE = "场内交易"
    CLOSED = "封闭期"
    SUBSCRIBING = "认购期"
    UNKNOWN = ""

    @classmethod
    def parse(cls, raw: str) -> "RedeemStatus":
        try:
            return cls(raw or "")
        except ValueError:
            return cls.UNKNOWN


class Currency(str, Enum):
    CNY = "CNY"
    USD = "USD"
    HKD = "HKD"


STATUS_WEIGHT = {
    PurchaseStatus.OPEN: 0,
    PurchaseStatus.LIMITED: 1,
    PurchaseStatus.SUSPENDED: 2,
    PurchaseStatus.ON_EXCHANGE: 3,
    PurchaseStatus.CLOSED: 4,
    PurchaseStatus.SUBSCRIBING: 5,
    PurchaseStatus.UNKNOWN: 6,
}


@dataclass(frozen=True)
class FundLimit:
    code: str
    name: str
    fund_type: str
    currency: Currency
    status: PurchaseStatus
    daily_limit: float | None
    min_purchase: float | None
    next_open_date: str | None
    redeem_status: RedeemStatus
    nav: float | None
    nav_date: str | None
    fee: str

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
        return self._amount(self.daily_limit)

    @property
    def min_purchase_display(self) -> str:
        if self.min_purchase is None:
            return "--"
        return self._amount(self.min_purchase)

    def _amount(self, value: float) -> str:
        if self.currency is Currency.CNY:
            return f"{value:,.0f} 元"
        if self.currency is Currency.HKD:
            return f"{value:,.2f} 港币"
        return f"{value:,.2f} 美元"


# --------------------------------------------------------------------------
# 接口层
# --------------------------------------------------------------------------

def http_get(url: str, referer: str = "https://fund.eastmoney.com/", timeout: int = 60) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8-sig", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise UpstreamError(f"请求失败 {url}: {exc}") from exc


def fetch_purchase_snapshot(use_cache: bool = True) -> tuple[list[list[str]], dict]:
    """接口 A：全市场基金申购状态。

    返回 (rows, meta)。meta 含 record / pages / showday（showday[0] 为数据日期）。
    """
    CACHE_DIR.mkdir(exist_ok=True)
    cache = CACHE_DIR / "sgzt.json"

    if use_cache and cache.exists() and time.time() - cache.stat().st_mtime < CACHE_TTL:
        try:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            if isinstance(cached, list):
                return cached, {}                      # 旧版缓存格式
            return cached["rows"], cached.get("meta", {})
        except (json.JSONDecodeError, OSError, KeyError, TypeError):
            pass

    params = urllib.parse.urlencode(
        {"t": "8", "page": "1,50000", "js": "reData", "sort": "fcode,asc"}
    )
    text = http_get(f"https://fund.eastmoney.com/Data/Fund_JJJZ_Data.aspx?{params}")

    # 响应体是 JS 对象字面量，外层 key 无引号，故截取数组而非整体 json.loads
    try:
        start = text.index("datas:[") + len("datas:")
        end = text.index("],record:") + 1
        rows = json.loads(text[start:end])
    except (ValueError, json.JSONDecodeError) as exc:
        raise UpstreamError(f"申购状态数据解析失败（上游可能已改版）: {exc}") from exc

    if not rows or len(rows[0]) != 13:
        raise UpstreamError(f"申购状态列数异常：期望 13，实际 {len(rows[0]) if rows else 0}")

    raw_meta = dict(re.findall(r'(\w+):("[^"]*"|\[[^\]]*\])', text[text.index("record:"):]))
    meta = {k: v.strip('"') for k, v in raw_meta.items() if not v.startswith("[")}
    try:
        meta["showday"] = json.loads(raw_meta.get("showday", "[]"))
    except json.JSONDecodeError:
        meta["showday"] = []

    cache.write_text(json.dumps({"rows": rows, "meta": meta}, ensure_ascii=False),
                     encoding="utf-8")
    return rows, meta


def fetch_fund_detail(code: str) -> dict:
    """接口 B：单基金实时信息（移动端）。"""
    params = urllib.parse.urlencode(
        {"FCODE": code, "deviceid": "qdii-helper", "plat": "Android",
         "product": "EFund", "version": "6.2.8"}
    )
    url = f"https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation?{params}"
    try:
        payload = json.loads(http_get(url, referer="https://fund.eastmoney.com/"))
    except json.JSONDecodeError as exc:
        raise UpstreamError(f"基金详情解析失败: {exc}") from exc
    if not payload.get("Datas"):
        raise UpstreamError(f"未获取到基金 {code} 的详情数据")
    return payload["Datas"]


def fetch_limit_notices(code: str, size: int = 10) -> list[dict]:
    """接口 D：申购赎回类公告（type=5）。"""
    params = urllib.parse.urlencode(
        {"callback": "cb", "fundcode": code, "pageIndex": 1,
         "pageSize": size, "type": 5}
    )
    url = f"https://api.fund.eastmoney.com/f10/JJGG?{params}"
    text = http_get(url, referer="https://fundf10.eastmoney.com/")
    match = re.search(r"cb\((.*)\)\s*$", text.strip(), re.S)
    if not match:
        return []
    try:
        return json.loads(match.group(1)).get("Data", [])
    except json.JSONDecodeError:
        return []


def fetch_exchange_premium(codes: list[str]) -> dict[str, float]:
    """接口 F：场内行情折价率 f402（负值 = 溢价）。"""
    if not codes:
        return {}
    secids = ",".join(("1." if c.startswith("5") else "0.") + c for c in codes[:100])
    params = urllib.parse.urlencode(
        {"fltt": "2", "fields": "f2,f12,f14,f402", "secids": secids}
    )
    for host in ("push2.eastmoney.com", "push2delay.eastmoney.com"):
        try:
            url = f"https://{host}/api/qt/ulist.np/get?{params}"
            payload = json.loads(http_get(url, referer="https://quote.eastmoney.com/", timeout=20))
            return {
                item["f12"]: item.get("f402")
                for item in (payload.get("data") or {}).get("diff") or []
            }
        except (UpstreamError, json.JSONDecodeError):
            continue
    return {}


def parse_pingzhong(text: str) -> dict:
    """解析 pingzhongdata 的 JS 文本为 {块名: 已解析对象}。

    文本形如 `/*注释*/var Data_netWorthTrend = <json>;`，逐个 `var` 块取值。
    实测每个值内部不含分号，故按第一个分号截断；解析失败的块直接跳过。
    """
    out: dict = {}
    for match in re.finditer(r"\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?);", text, re.S):
        try:
            out[match.group(1)] = json.loads(match.group(2))
        except json.JSONDecodeError:
            continue
    return out


CN_TZ = timezone(timedelta(hours=8))


def ts_to_date(ms: float) -> str:
    """上游时间戳是北京时间零点，按 UTC+8 取日期才不会差一天。"""
    return datetime.fromtimestamp(ms / 1000, tz=CN_TZ).strftime("%Y-%m-%d")


def fetch_pingzhong(code: str) -> dict:
    """接口 G：净值走势 / 规模变动 / 资产配置 / 持有人结构（一次请求）。"""
    url = f"https://fund.eastmoney.com/pingzhongdata/{code}.js"
    text = http_get(url, referer=f"https://fund.eastmoney.com/{code}.html")
    data = parse_pingzhong(text)
    if not data:
        raise UpstreamError(f"基金 {code} 的净值数据解析失败（上游可能已改版）")
    return data


def fetch_period_increase(code: str) -> list[dict]:
    """接口 H：分周期收益率 + 同类平均 + 沪深300 + 同类排名。"""
    params = urllib.parse.urlencode(
        {"FCODE": code, "deviceid": "qdii-helper", "plat": "Android",
         "product": "EFund", "version": "6.2.8"}
    )
    url = f"https://fundmobapi.eastmoney.com/FundMNewApi/FundMNPeriodIncrease?{params}"
    try:
        payload = json.loads(http_get(url))
    except json.JSONDecodeError as exc:
        raise UpstreamError(f"阶段涨幅解析失败: {exc}") from exc
    return payload.get("Datas") or []


def fetch_holdings(code: str) -> dict:
    """接口 I：重仓股 / 债券持仓 / 联接基金的底层 ETF。"""
    params = urllib.parse.urlencode(
        {"FCODE": code, "deviceid": "qdii-helper", "plat": "Android",
         "product": "EFund", "version": "6.2.8"}
    )
    url = f"https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?{params}"
    try:
        payload = json.loads(http_get(url))
    except json.JSONDecodeError as exc:
        raise UpstreamError(f"持仓数据解析失败: {exc}") from exc
    # 报告期在响应顶层而非 Datas 内，一并带回免得再取一次
    return {**(payload.get("Datas") or {}), "Expansion": payload.get("Expansion")}


# --------------------------------------------------------------------------
# 归一化层（design.md §5）
# --------------------------------------------------------------------------

def is_qdii(fund_type: str) -> bool:
    """指数型 QDII 的标签是「指数型-海外股票」，不含 QDII 字样。"""
    return fund_type.startswith("QDII-") or fund_type == "指数型-海外股票"


def parse_currency(name: str) -> Currency:
    if "人民币" in name:
        return Currency.CNY
    if any(k in name for k in HKD_MARKERS):
        return Currency.HKD
    return Currency.USD if any(k in name for k in USD_MARKERS) else Currency.CNY


def _to_float(raw: str) -> float | None:
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def normalize_limit(raw: str, status: PurchaseStatus, currency: Currency) -> float | None:
    value = _to_float(raw)
    if value is None:
        return None
    if value >= UNLIMITED_THRESHOLD:
        return None
    if value == 0:
        if status is PurchaseStatus.ON_EXCHANGE:
            return None
        # 非人民币份额在天天基金渠道通常不售，0 不代表「限 0 元」
        if currency is not Currency.CNY:
            return None
        # 人民币 + 限大额：真实就是 0（暂停但未公告）
        return 0.0
    return value


def build_fund(row: list[str]) -> FundLimit:
    code, name, ftype, nav, nav_date, sgzt, shzt, next_open, min_purchase, limit, _, _, fee = row
    currency = parse_currency(name)
    status = PurchaseStatus.parse(sgzt)
    return FundLimit(
        code=code,
        name=name,
        fund_type=ftype,
        currency=currency,
        status=status,
        daily_limit=normalize_limit(limit, status, currency),
        min_purchase=_to_float(min_purchase),
        next_open_date=next_open or None,
        redeem_status=RedeemStatus.parse(shzt),
        nav=_to_float(nav),
        nav_date=nav_date or None,
        fee=fee or "",
    )


def load_qdii(use_cache: bool = True) -> list[FundLimit]:
    rows, _ = fetch_purchase_snapshot(use_cache=use_cache)
    funds = [build_fund(r) for r in rows]
    qdii = [f for f in funds if is_qdii(f.fund_type)]
    if len(qdii) < 500:
        print(f"警告：QDII 仅匹配到 {len(qdii)} 只，可能上游基金类型标签已变更",
              file=sys.stderr)
    return qdii


def load_qdii_with_meta(use_cache: bool = True) -> tuple[list[FundLimit], dict]:
    """Web 端使用：同时拿到基金列表与数据日期等元信息。"""
    rows, meta = fetch_purchase_snapshot(use_cache=use_cache)
    funds = [build_fund(r) for r in rows]
    return [f for f in funds if is_qdii(f.fund_type)], meta


# --------------------------------------------------------------------------
# 视图层
# --------------------------------------------------------------------------

def sort_key_limit_asc(fund: FundLimit) -> tuple:
    return (fund.daily_limit is None, fund.daily_limit or 0.0, fund.code)


def sort_key_limit_desc(fund: FundLimit) -> tuple:
    return (fund.daily_limit is None, -(fund.daily_limit or 0.0), fund.code)


def sort_key_default(fund: FundLimit) -> tuple:
    return (STATUS_WEIGHT[fund.status], sort_key_limit_desc(fund))


SORTERS = {
    "limit-asc": sort_key_limit_asc,
    "limit-desc": sort_key_limit_desc,
    "status": sort_key_default,
}


def apply_filters(
    funds: list[FundLimit],
    statuses: list[str] | None,
    currency: str,
    min_limit: float | None,
    max_limit: float | None,
    keyword: str | None,
) -> list[FundLimit]:
    out = funds

    if currency != "all":
        want = Currency.CNY if currency == "cny" else Currency.USD
        out = [f for f in out if f.currency is want]

    if statuses:
        if any(s in ("全部", "all") for s in statuses):
            pass                                    # 不做状态过滤
        else:
            allowed: set[PurchaseStatus] = set()
            for raw in statuses:
                if raw in ("可买", "buyable"):
                    allowed |= {PurchaseStatus.OPEN, PurchaseStatus.LIMITED}
                else:
                    allowed.add(PurchaseStatus.parse(raw))
            out = [f for f in out if f.status in allowed]
    else:
        out = [f for f in out if f.is_buyable]

    if min_limit is not None:
        out = [f for f in out if f.daily_limit is not None and f.daily_limit >= min_limit]
    if max_limit is not None:
        out = [f for f in out if f.daily_limit is not None and f.daily_limit <= max_limit]
    if keyword:
        out = [f for f in out if keyword in f.name or keyword in f.code]

    return out


def _width(text: str) -> int:
    """终端显示宽度：中日韩全角字符占 2 列。"""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def pad(text: str, width: int, align: str = "<") -> str:
    space = max(0, width - _width(text))
    if align == ">":
        return " " * space + text
    return text + " " * space


def truncate(text: str, width: int) -> str:
    if _width(text) <= width:
        return text
    out = ""
    for ch in text:
        if _width(out + ch) > width - 1:
            break
        out += ch
    return out + "…"


def render_table(funds: list[FundLimit], total: int) -> str:
    if not funds:
        return "  没有符合条件的基金。"

    header = (pad("代码", 8) + pad("基金简称", 38) + pad("类型", 18)
              + pad("净值(日期)", 18) + pad("日限额", 14, ">") + pad("起点", 13, ">")
              + "  " + "费率")
    lines = ["  " + header, "  " + "─" * _width(header)]
    for f in funds:
        nav = f"{f.nav:.4f} ({f.nav_date})" if f.nav is not None else "--"
        start = f.min_purchase_display
        lines.append(
            "  " + pad(f.code, 8) + pad(truncate(f.name, 36), 38)
            + pad(f.fund_type, 18) + pad(nav, 18)
            + pad(f.limit_display, 14, ">") + pad(start, 13, ">")
            + "  " + f.fee
        )
    lines.append("")
    lines.append(f"  共 {len(funds)} 只（匹配 {total} 只 QDII） · {DISCLAIMER}")
    return "\n".join(lines)


def render_json(funds: list[FundLimit]) -> str:
    return json.dumps(
        [
            {
                "code": f.code, "name": f.name, "type": f.fund_type,
                "currency": f.currency.value, "status": f.status.value,
                "daily_limit": f.daily_limit, "min_purchase": f.min_purchase,
                "next_open_date": f.next_open_date, "redeem_status": f.redeem_status.value,
                "nav": f.nav, "nav_date": f.nav_date, "fee": f.fee,
            }
            for f in funds
        ],
        ensure_ascii=False,
        indent=2,
    )


def render_csv(funds: list[FundLimit]) -> str:
    rows = ["代码,基金简称,类型,币种,申购状态,日限额,起点,净值,净值日期,费率"]
    for f in funds:
        name = f'"{f.name}"' if "," in f.name else f.name
        limit = "" if f.daily_limit is None else f"{f.daily_limit:.0f}"
        rows.append(f"{f.code},{name},{f.fund_type},{f.currency.value},{f.status.value},"
                    f"{limit},{f.min_purchase or ''},{f.nav or ''},{f.nav_date or ''},{f.fee}")
    return "\n".join(rows)


# --------------------------------------------------------------------------
# 子命令
# --------------------------------------------------------------------------

def cmd_list(args: argparse.Namespace) -> int:
    funds = load_qdii(use_cache=not args.no_cache)
    selected = apply_filters(funds, args.status, args.currency,
                             args.min_limit, args.max_limit, args.keyword)
    selected.sort(key=SORTERS[args.sort])

    if args.format == "json":
        print(render_json(selected))
    elif args.format == "csv":
        print(render_csv(selected))
    else:
        print(render_table(selected, len(funds)))
    return EXIT_OK


def cmd_top(args: argparse.Namespace) -> int:
    tight = args.kind == "tight"
    funds = load_qdii(use_cache=not args.no_cache)
    selected = apply_filters(
        funds,
        ["限大额"] if tight else ["可买"],
        args.currency,
        None,
        None,
        None,
    )
    selected.sort(key=sort_key_limit_asc if tight else sort_key_limit_desc)
    selected = selected[: args.n]

    if args.format == "json":
        print(render_json(selected))
    elif args.format == "csv":
        print(render_csv(selected))
    else:
        label = "额度最紧" if tight else "额度最宽"
        print(f"  {label}的 QDII（前 {args.n} 只）\n")
        print(render_table(selected, len(funds)))
    return EXIT_OK


def cmd_show(args: argparse.Namespace) -> int:
    funds = load_qdii(use_cache=not args.no_cache)
    target = next((f for f in funds if f.code == args.code), None)

    if target is None:
        if not re.fullmatch(r"\d{6}", args.code):
            print(f"错误：基金代码格式不正确：{args.code}", file=sys.stderr)
            return EXIT_ARG
        print(f"未找到 QDII 基金 {args.code}（可能非 QDII 或代码有误）", file=sys.stderr)
        return EXIT_NOTFOUND

    width = 66
    print(f"\n  {truncate(target.name, width)}")
    print(f"  {'─' * width}")

    def line(*pairs: tuple[str, str, int]) -> str:
        return "  " + "".join(pad(label, lw) + pad(value, vw) for label, value, lw, vw in pairs)

    print(line(("代码", target.code, 14, 20), ("类型", target.fund_type, 12, 20)))
    print(line(("申购状态", target.status.value or "--", 14, 20),
               ("赎回状态", target.redeem_status.value or "--", 12, 20)))
    start = target.min_purchase_display
    print(line(("日累计限额", target.limit_display, 14, 20), ("申购起点", start, 12, 20)))
    nav = f"{target.nav:.4f} ({target.nav_date})" if target.nav is not None else "--"
    print(line(("单位净值", nav, 14, 20), ("费率", target.fee or "--", 12, 20)))
    if target.next_open_date:
        print(line(("下一开放日", target.next_open_date, 14, 20)))
    print(line(("份额币种", target.currency.value, 14, 20)))

    try:
        detail = fetch_fund_detail(target.code)
        print(line(("基金公司", detail.get("JJGS", "--"), 14, 20),
                   ("基金经理", detail.get("JJJL", "--"), 12, 20)))
        rate = f"{detail.get('SOURCERATE', '--')} → {detail.get('RATE', '--')}"
        print(line(("费率(实时)", rate, 14, 20)))
    except UpstreamError as exc:
        print(f"  （详情接口不可用：{exc}）", file=sys.stderr)

    notices = fetch_limit_notices(target.code)
    print(f"  {'─' * width}")
    if notices:
        print("  最近申购相关公告")
        for item in notices[:5]:
            title = item.get("TITLE", "")[:56]
            print(f"    {item.get('PUBLISHDATEDesc', '')}  {title}")
    else:
        print("  （未取到申购相关公告）")
    print(f"\n  {DISCLAIMER}\n")
    return EXIT_OK


def cmd_premium(args: argparse.Namespace) -> int:
    funds = load_qdii(use_cache=not args.no_cache)
    exchange = [f for f in funds if f.is_on_exchange]
    if not exchange:
        print("  没有匹配到场内交易的 QDII。")
        return EXIT_OK

    codes = [f.code for f in exchange]
    premium = fetch_exchange_premium(codes[: args.n])
    if not premium:
        print("  行情接口不可用，无法获取折价率。", file=sys.stderr)
        return EXIT_UPSTREAM

    by_code = {f.code: f for f in exchange}
    rows = []
    for code in codes[: args.n]:
        if code not in premium:
            continue
        rate = premium[code]
        if rate is None:
            continue
        rows.append((by_code[code], float(rate)))
    rows.sort(key=lambda x: x[1])  # 折价率升序 = 溢价最高在前

    header = pad("代码", 8) + pad("名称", 30) + pad("折价率", 10, ">") + "  说明"
    print(f"  场内 QDII 折溢价（共 {len(rows)} 只）\n")
    print("  " + header)
    print("  " + "─" * _width(header))
    for fund, rate in rows:
        tag = f"溢价 {abs(rate):.2f}%" if rate < 0 else f"折价 {rate:.2f}%"
        print("  " + pad(fund.code, 8) + pad(truncate(fund.name, 28), 30)
              + pad(f"{rate:.2f}%", 10, ">") + "  " + tag)
    print(f"\n  {DISCLAIMER}\n")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="qdii_limit",
        description="QDII 基金限购额度查询工具",
    )
    parser.add_argument("--no-cache", action="store_true", help="忽略本地缓存，强制刷新")
    sub = parser.add_subparsers(dest="command")

    def add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--format", choices=["table", "csv", "json"], default="table")

    p_list = sub.add_parser("list", help="列出 QDII 及其限购情况")
    p_list.add_argument("--status", nargs="+", default=None,
                        help="申购状态：开放申购/限大额/暂停申购/场内交易/可买（默认：可买）")
    p_list.add_argument("--currency", choices=["cny", "usd", "all"], default="cny")
    p_list.add_argument("--min-limit", type=float, default=None)
    p_list.add_argument("--max-limit", type=float, default=None)
    p_list.add_argument("--keyword", default=None, help="按简称或代码过滤")
    p_list.add_argument("--sort", choices=list(SORTERS), default="status")
    add_common(p_list)
    p_list.set_defaults(func=cmd_list)

    p_top = sub.add_parser("top", help="额度最紧/最宽的 QDII")
    p_top.add_argument("--kind", choices=["tight", "loose"], default="tight")
    p_top.add_argument("--n", type=int, default=20)
    p_top.add_argument("--currency", choices=["cny", "usd", "all"], default="cny")
    add_common(p_top)
    p_top.set_defaults(func=cmd_top)

    p_show = sub.add_parser("show", help="单只基金详情 + 限购公告")
    p_show.add_argument("code")
    p_show.set_defaults(func=cmd_show, format="table")

    p_prem = sub.add_parser("premium", help="场内 QDII 折溢价率")
    p_prem.add_argument("--n", type=int, default=30)
    p_prem.set_defaults(func=cmd_premium, format="table")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return EXIT_ARG
    try:
        return args.func(args)
    except UpstreamError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return EXIT_UPSTREAM
    except KeyboardInterrupt:
        return EXIT_UPSTREAM


if __name__ == "__main__":
    sys.exit(main())
