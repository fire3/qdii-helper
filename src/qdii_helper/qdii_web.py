#!/usr/bin/env python3
"""QDII 基金限购额度查询 —— Web 工具后端。

复用 `qdii_limit.py` 的全部归一化逻辑与 `qdii_categories.py` 的归类规则，
不自建第二套数据口径。

仅依赖 Python 标准库：
    qdii-web                           # 默认 http://127.0.0.1:8765
    qdii-web --port 9000 --host 0.0.0.0
    python -m qdii_helper              # 等价写法
"""

from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import sys
import threading
import time
from collections import Counter
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import qdii_categories as cats
from . import qdii_limit as ql

WEB_DIR = Path(__file__).resolve().parent / "web"

DISCLAIMER = "数据来自天天基金公开接口，仅供参考，实际限额以基金公司最新公告为准"


# --------------------------------------------------------------------------
# 数据集（进程内缓存，与 qdii_limit 的文件缓存 TTL 对齐）
# --------------------------------------------------------------------------

class Dataset:
    """构建并缓存面向 Web 的基金数据集。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._payload: dict | None = None
        self._built_at: float = 0.0
        self._ttl = ql.CACHE_TTL

    def get(self, force: bool = False) -> dict:
        with self._lock:
            fresh = self._payload is not None and time.time() - self._built_at < self._ttl
            if fresh and not force:
                return self._payload
            self._payload = self._build(force)
            self._built_at = time.time()
            return self._payload

    def _build(self, force: bool) -> dict:
        funds, meta = ql.load_qdii_with_meta(use_cache=not force)

        records = []
        for f in funds:
            region, theme = cats.classify(f.name)
            records.append({
                "code": f.code,
                "name": f.name,
                "type": f.fund_type,
                "region": region,
                "theme": theme,
                "currency": f.currency.value,
                "status": f.status.value,
                "limit": f.daily_limit,          # None = 无限额
                "limit_text": f.limit_display,
                "min_purchase_text": f.min_purchase_display,
                "next_open_date": f.next_open_date,
                "redeem_status": f.redeem_status.value,
                "nav": f.nav,
                "nav_date": f.nav_date,
                "fee": f.fee,
                "on_exchange": f.is_on_exchange,
                "buyable": f.is_buyable,
            })

        cny = [r for r in records if r["currency"] == "CNY"]
        status_counts = Counter(r["status"] for r in records)

        return {
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "data_date": (meta.get("showday") or [None])[0],
            "total": len(records),
            "stats": {
                "status": dict(status_counts),
                "buyable": sum(1 for r in records if r["buyable"]),
                # 限购档位分布只统计人民币份额，避免美元/港币份额污染
                "limit_bands": _limit_bands(cny),
                # 「最紧」取最小的**正数**限额：限大额里存在真实的 0 元档，
                # 但 0 元不传达有效信息
                "tightest": min(
                    (r["limit"] for r in cny
                     if r["status"] == "限大额" and r["limit"]),
                    default=None,
                ),
            },
            "categories": {
                "regions": _ordered_counts(records, "region", cats.FEATURED_REGIONS),
                "themes": _ordered_counts(records, "theme", cats.FEATURED_THEMES),
            },
            "funds": records,
            "disclaimer": DISCLAIMER,
        }


def _ordered_counts(records: list[dict], key: str, featured: list[str]) -> list[dict]:
    """分类计数，featured 中的按预设顺序置前，其余按数量降序。"""
    counts = Counter(r[key] for r in records)
    ordered = [k for k in featured if k in counts]
    ordered += [k for k, _ in counts.most_common() if k not in ordered]
    return [{"name": k, "count": counts[k]} for k in ordered]


LIMIT_BANDS = [
    ("限 10 元以内", 0, 10),
    ("限 100 元以内", 10.01, 100),
    ("限 1000 元以内", 100.01, 1000),
    ("限 1 万元以内", 1000.01, 10000),
    ("限 100 万元以内", 10000.01, 1000000),
    ("限 100 万元以上", 1000000.01, float("inf")),
]


def _limit_bands(records: list[dict]) -> list[dict]:
    limited = [r["limit"] for r in records
               if r["status"] == "限大额" and r["limit"] is not None]
    out = []
    for label, low, high in LIMIT_BANDS:
        n = sum(1 for v in limited if low <= v <= high)
        if n:
            out.append({"name": label, "count": n, "low": low,
                        "high": None if high == float("inf") else high})
    return out


DATASET = Dataset()


class CodeCache:
    """按基金代码缓存的详情数据，TTL 与数据集对齐。"""

    def __init__(self, ttl: float) -> None:
        self._lock = threading.Lock()
        self._items: dict[str, tuple[float, dict]] = {}
        self._ttl = ttl

    def get_or_build(self, code: str, build) -> dict:
        with self._lock:
            hit = self._items.get(code)
            if hit is not None and time.time() - hit[0] < self._ttl:
                return hit[1]
            built = build()
            self._items[code] = (time.time(), built)
            return built


DETAILS = CodeCache(ql.CACHE_TTL)

# 净值走势只回传最近约 3.2 年（800 个交易日），前端区间最大到「近3年」，
# 全量 3000+ 点没有意义，白白撑大响应体。
NAV_POINTS = 800


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _fund_extra(code: str) -> dict:
    """接口 G / H / I：净值走势、阶段涨幅、规模与持仓。

    每一块独立容错：某一块失败只影响对应区块，其余照常返回。
    """
    out: dict = {"nav": [], "scale": None, "allocation": None, "holders": None,
                 "periods": [], "holdings": {}, "report_date": None, "errors": []}

    try:
        data = ql.fetch_pingzhong(code)
        trend = data.get("Data_netWorthTrend") or []
        out["nav"] = [
            {"date": ql.ts_to_date(p["x"]), "nav": p.get("y"),
             "change": p.get("equityReturn")}
            for p in trend if p.get("x") and p.get("y") is not None
        ][-NAV_POINTS:]
        out["scale"] = data.get("Data_fluctuationScale")
        out["allocation"] = data.get("Data_assetAllocation")
        out["holders"] = data.get("Data_holderStructure")
    except (ql.UpstreamError, KeyError, TypeError, ValueError) as exc:
        out["errors"].append(f"净值走势不可用：{exc}")

    try:
        out["periods"] = [
            {"key": item.get("title"), "ret": _num(item.get("syl")),
             "avg": _num(item.get("avg")), "bench": _num(item.get("hs300")),
             "rank": _int(item.get("rank")), "total": _int(item.get("sc"))}
            for item in ql.fetch_period_increase(code)
        ]
    except ql.UpstreamError as exc:
        out["errors"].append(f"阶段涨幅不可用：{exc}")

    try:
        raw = ql.fetch_holdings(code)
        out["report_date"] = raw.get("Expansion")
        out["holdings"] = {
            "stocks": [
                {"code": s.get("GPDM"), "name": s.get("GPJC"),
                 "weight": _num(s.get("JZBL")), "action": s.get("PCTNVCHGTYPE"),
                 "delta": _num(s.get("PCTNVCHG"))}
                for s in raw.get("fundStocks") or []
            ],
            "bonds": [
                {"code": b.get("ZQDM"), "name": b.get("ZQMC"),
                 "weight": _num(b.get("ZJZBL"))}
                for b in raw.get("fundboods") or []
            ],
            "etf": ({"code": raw.get("ETFCODE"), "name": raw.get("ETFSHORTNAME")}
                    if raw.get("ETFCODE") else None),
        }
    except ql.UpstreamError as exc:
        out["errors"].append(f"持仓数据不可用：{exc}")

    return out


def _fund_detail(code: str) -> dict:
    """单只基金的完整详情（接口 B/G/H/I 聚合），按 code 做 30 分钟缓存。"""
    return DETAILS.get_or_build(code, lambda: _build_fund_detail(code))


def _build_fund_detail(code: str) -> dict:
    out: dict = {"code": code, "errors": []}
    try:
        d = ql.fetch_fund_detail(code)
        out["detail"] = {
            "name": d.get("SHORTNAME"),
            "type": d.get("FTYPE"),
            "company": d.get("JJGS"),
            "manager": d.get("JJJL"),
            "purchase_status": d.get("SGZT"),
            "redeem_status": d.get("SHZT"),
            "max_purchase": d.get("MAXSG"),
            "min_purchase": d.get("MINSG"),
            "nav": d.get("DWJZ"),
            "nav_date": d.get("FSRQ"),
            "next_open_date": d.get("DUEDATE"),
            "source_rate": d.get("SOURCERATE"),
            "rate": d.get("RATE"),
            "risk_level": d.get("RISKLEVEL"),
        }
    except ql.UpstreamError as exc:
        out["errors"].append(f"详情接口不可用：{exc}")

    extra = _fund_extra(code)
    out["errors"].extend(extra.pop("errors"))
    out.update(extra)
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "qdii-helper"

    def log_message(self, fmt: str, *args) -> None:      # 静音默认访问日志
        if self.server.verbose:                          # type: ignore[attr-defined]
            super().log_message(fmt, *args)

    # ---- 响应助手 ----

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        headers = [("Content-Type", content_type), ("Cache-Control", "no-store")]
        # 数据集约 300 KB，gzip 后可降到 ~40 KB
        if len(body) > 1024 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(body, 6)
            headers.append(("Content-Encoding", "gzip"))
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, message: str) -> None:
        self._json({"error": message}, status)

    # ---- 路由 ----

    def do_GET(self) -> None:                            # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        try:
            if path == "/api/dataset":
                force = query.get("refresh", ["0"])[0] == "1"
                self._json(DATASET.get(force=force))
            elif path == "/api/fund":
                code = (query.get("code") or [""])[0].strip()
                if not code.isdigit() or len(code) != 6:
                    self._error(HTTPStatus.BAD_REQUEST, "code 必须是 6 位数字")
                else:
                    self._json(_fund_detail(code))
            elif path == "/api/premium":
                self._json(self._premium())
            else:
                self._static(path)
        except ql.UpstreamError as exc:
            self._error(HTTPStatus.SERVICE_UNAVAILABLE, f"上游接口不可用：{exc}")
        except BrokenPipeError:
            pass
        except Exception as exc:                         # noqa: BLE001
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"服务内部错误：{exc}")

    def _premium(self) -> dict:
        data = DATASET.get()
        codes = [r["code"] for r in data["funds"] if r["on_exchange"]]
        rates = ql.fetch_exchange_premium(codes)
        items = []
        for r in data["funds"]:
            if r["code"] in rates and rates[r["code"]] is not None:
                items.append({"code": r["code"], "name": r["name"],
                              "discount": rates[r["code"]]})
        items.sort(key=lambda x: x["discount"])
        return {"items": items, "disclaimer": DISCLAIMER}

    def _static(self, path: str) -> None:
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (WEB_DIR / rel).resolve()
        if not str(target).startswith(str(WEB_DIR)) or not target.is_file():
            self._error(HTTPStatus.NOT_FOUND, f"未找到 {path}")
            return
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self._send(HTTPStatus.OK, target.read_bytes(), ctype)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="QDII 基金限购额度查询 Web 工具")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--verbose", action="store_true", help="打印访问日志")
    args = parser.parse_args(argv)

    if not WEB_DIR.is_dir():
        print(f"错误：前端目录不存在 {WEB_DIR}", file=sys.stderr)
        return 1

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.verbose = args.verbose            # type: ignore[attr-defined]
    print(f"QDII 限购查询 Web 工具已启动： http://{args.host}:{args.port}")
    print(f"数据缓存目录：{ql.CACHE_DIR}")
    print("首次加载会拉取上游数据（约 4 MB），之后 30 分钟内走缓存。Ctrl+C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
