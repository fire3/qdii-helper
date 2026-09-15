#!/usr/bin/env python3
"""QDII 基金归类规则（地区/市场 + 主题 两个维度）。

规则基于 **735 只真实 QDII 基金名称** 的实测归纳（2026-09-14），
覆盖情况见 `coverage()`。

为什么用两个维度而不是单一分类：
`景顺长城全球半导体芯片`、`易方达标普生物科技` 这类基金同时带有
「地区」与「主题」两个属性。单层分类必须二选一，会丢掉一半信息 —
放进「半导体」就丢了美国属性，放进「美国」就丢了半导体属性。
两个维度各自独立筛选，取交集即得精确结果。
"""

from __future__ import annotations

import re
from collections import Counter

# 有序规则表：第一个匹配生效，兜底规则（`.`）必须在最后。
# 规则顺序即优先级 —— 越具体的指数越靠前（如 `纳斯达克100` 先于 `纳斯达克`，
# `恒生科技` 先于 `恒生指数/港股`）。
REGION_RULES: list[tuple[str, str]] = [
    ("纳斯达克100", r"纳斯达克100|纳指100"),
    ("纳斯达克", r"纳斯达克|纳指"),
    ("标普500", r"标普500"),
    ("美国", r"标普|道琼斯|美国|罗素"),
    ("日本", r"日经|日本|东证"),
    ("德国", r"德国|DAX"),
    ("法国", r"法国|CAC"),
    ("欧洲", r"欧洲|欧元区|英国|富时"),
    ("越南", r"越南"),
    ("印度", r"印度"),
    ("巴西", r"巴西|拉美"),
    ("沙特", r"沙特|中东"),
    ("中韩", r"中韩|韩国"),
    ("中概互联", r"中概|海外互联网|中国互联网|海外中国|中国海外|港美|中美"),
    ("恒生科技", r"恒生科技|香港科技|港股科技"),
    ("恒生互联网", r"恒生互联网"),
    ("恒生医药", r"恒生医药|恒生医疗|恒生生物|港股创新药|恒生创新药"),
    ("恒生消费", r"恒生消费"),
    ("恒生国企/H股", r"恒生国企|恒生中国企业|H股|港股国企|恒生央企"
                      r"|恒生红利|港股通红利|港股通金融"),
    ("恒生指数/港股", r"恒生|香港|港股|大中华"),
    ("亚太", r"亚太|亚洲|东南亚"),
    ("新兴市场", r"新兴市场"),
    ("中国", r"中国|境内"),
    ("全球", r"."),  # 兜底：无单一市场限定，多为全球/跨市场 mandate
]

THEME_RULES: list[tuple[str, str]] = [
    ("半导体", r"半导体|芯片"),
    ("医药生物", r"生物科技|生物医药|医药|医疗|健康|创新药"),
    ("科技互联网", r"信息科技|科技|互联网|移动互联|软件|数字"),
    ("消费", r"消费"),
    ("能源", r"石油|油气|能源|天然气|原油|资源"),
    ("贵金属/商品", r"黄金|贵金属|商品|抗通胀|通胀"),
    ("房地产/REITs", r"房地产|REITs|不动产|房托|REIT"),
    ("债券", r"债|票息|高收益|收益债券"),
    ("汽车", r"汽车"),
    ("教育", r"教育"),
    ("金融", r"金融|银行|券商|保险"),
    ("红利/国企", r"红利|央企|国企|价值|股息"),
    ("综合配置", r"配置|精选|成长|新经济|优质|稳健|多元|中小盘|龙头"
                 r"|领导企业|发现|产业升级|新时代|策略"),
    ("宽基指数", r"."),  # 兜底：纯指数/宽基，无行业主题
]

# 前端筛选栏的展示顺序（其余按数量降序追加）
FEATURED_REGIONS = [
    "纳斯达克100", "纳斯达克", "标普500", "美国", "日本", "德国",
    "恒生科技", "恒生互联网", "中概互联", "恒生指数/港股", "恒生国企/H股",
    "恒生医药", "恒生消费", "亚太", "新兴市场", "越南", "印度", "沙特",
    "欧洲", "中韩", "中国", "全球",
]

FEATURED_THEMES = [
    "半导体", "医药生物", "科技互联网", "消费", "能源", "贵金属/商品",
    "房地产/REITs", "债券", "金融", "红利/国企", "汽车", "教育",
    "综合配置", "宽基指数",
]

_REGION_COMPILED = [(name, re.compile(pat)) for name, pat in REGION_RULES]
_THEME_COMPILED = [(name, re.compile(pat)) for name, pat in THEME_RULES]


def classify_region(name: str) -> str:
    for label, pattern in _REGION_COMPILED:
        if pattern.search(name):
            return label
    return REGION_RULES[-1][0]


def classify_theme(name: str) -> str:
    for label, pattern in _THEME_COMPILED:
        if pattern.search(name):
            return label
    return THEME_RULES[-1][0]


def classify(name: str) -> tuple[str, str]:
    """返回 (地区, 主题)。"""
    return classify_region(name), classify_theme(name)


def coverage(names: list[str]) -> dict:
    """统计分类覆盖情况，用于回归检查规则是否失效。"""
    pairs = [classify(n) for n in names]
    return {
        "total": len(names),
        "regions": Counter(p[0] for p in pairs),
        "themes": Counter(p[1] for p in pairs),
    }


if __name__ == "__main__":
    import json

    from .qdii_limit import CACHE_DIR

    cache = CACHE_DIR / "sgzt.json"
    if not cache.exists():
        raise SystemExit("请先生成缓存：qdii-limit list")
    cached = json.loads(cache.read_text(encoding="utf-8"))
    # 缓存有两种历史格式：早期是裸 rows 数组，现为 {"rows": [...], "meta": {...}}
    rows = cached if isinstance(cached, list) else cached["rows"]
    qdii = [r[1] for r in rows
            if r[2].startswith("QDII-") or r[2] == "指数型-海外股票"]

    result = coverage(qdii)
    print(f"共 {result['total']} 只 QDII\n")
    print("地区/市场：")
    for k, v in result["regions"].most_common():
        print(f"  {k:<14}{v:4d}")
    print("\n主题：")
    for k, v in result["themes"].most_common():
        print(f"  {k:<14}{v:4d}")
