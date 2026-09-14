#!/usr/bin/env python3
"""归一化规则的回归测试（design.md §5）。

这些规则对应上游数据里的隐式约定，最容易在改版时静默出错，因此单独锁定。
运行：python3 tests/test_normalize.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from qdii_limit import (  # noqa: E402
    Currency,
    PurchaseStatus,
    build_fund,
    is_qdii,
    normalize_limit,
    parse_currency,
)


class TestIsQdii(unittest.TestCase):
    def test_index_qdii_has_no_qdii_token(self):
        # 指数型 QDII 的标签不含 "QDII" 字样，漏掉它会少筛一半基金
        self.assertTrue(is_qdii("指数型-海外股票"))

    def test_qdii_prefix(self):
        for t in ("QDII-普通股票", "QDII-纯债", "QDII-FOF", "QDII-REITs", "QDII-商品"):
            self.assertTrue(is_qdii(t), t)

    def test_non_qdii(self):
        for t in ("混合型-灵活", "债券型-混合二级", "指数型-股票", "股票型", "FOF"):
            self.assertFalse(is_qdii(t), t)


class TestParseCurrency(unittest.TestCase):
    def test_rmb_wins_over_usd_bond_theme(self):
        # 投资标的为美元债，但份额是人民币
        self.assertIs(parse_currency("中银美元债债券(QDII)人民币A"), Currency.CNY)
        self.assertIs(parse_currency("汇添富美元债债券(QDII)人民币A"), Currency.CNY)

    def test_usd_variants(self):
        cases = [
            "嘉实美国成长股票美元现汇",
            "广发纳斯达克100ETF联接美元(QDII)A",
            "华夏恒生ETF联接现汇",
            "华夏恒生ETF联接现钞",
            "摩根富时发达市场REITs指数(QDII)美钞",
            "摩根富时发达市场REITs指数(QDII)美汇",
        ]
        for name in cases:
            self.assertIs(parse_currency(name), Currency.USD, name)

    def test_default_rmb(self):
        self.assertIs(parse_currency("广发纳斯达克100ETF联接人民币(QDII)A"), Currency.CNY)
        self.assertIs(parse_currency("嘉实美国成长股票人民币"), Currency.CNY)

    def test_hkd(self):
        self.assertIs(parse_currency("工银全球股票(QDII)港币"), Currency.HKD)


class TestNormalizeLimit(unittest.TestCase):
    def test_sentinel_variants(self):
        # 上游存在多种哨兵写法，真实限额最高仅 5 千万（实测）
        for raw in ("100000000000", "10000000000", "9999999999", "99999999999"):
            self.assertIsNone(
                normalize_limit(raw, PurchaseStatus.OPEN, Currency.CNY), raw
            )

    def test_largest_real_limit_is_kept(self):
        self.assertEqual(
            normalize_limit("50000000", PurchaseStatus.LIMITED, Currency.CNY), 5e7
        )

    def test_real_limit(self):
        self.assertEqual(
            normalize_limit("2.0", PurchaseStatus.LIMITED, Currency.CNY), 2.0
        )
        self.assertEqual(
            normalize_limit("1000.0", PurchaseStatus.LIMITED, Currency.CNY), 1000.0
        )

    def test_zero_on_exchange_is_unlimited(self):
        # 场内交易不走申赎通道，0 不代表"限 0 元"
        self.assertIsNone(
            normalize_limit("0", PurchaseStatus.ON_EXCHANGE, Currency.CNY)
        )

    def test_zero_non_rmb_is_noise(self):
        # 非人民币份额在天天基金渠道不售，0 不代表「限 0 元」
        for cur in (Currency.USD, Currency.HKD):
            self.assertIsNone(
                normalize_limit("0", PurchaseStatus.LIMITED, cur), cur
            )

    def test_zero_rmb_limited_is_real(self):
        self.assertEqual(
            normalize_limit("0", PurchaseStatus.LIMITED, Currency.CNY), 0.0
        )

    def test_invalid(self):
        for raw in ("", "--", None, "abc"):
            self.assertIsNone(
                normalize_limit(raw, PurchaseStatus.LIMITED, Currency.CNY), repr(raw)
            )


class TestBuildFundWithRealRows(unittest.TestCase):
    """使用 docs/api.md §2.6 记录的真实数据行。"""

    ROWS = [
        ["270042", "广发纳斯达克100ETF联接人民币(QDII)A", "指数型-海外股票", "8.1177",
         "09-11", "限大额", "开放赎回", "", "2.0", "2.0", "1.0", "1", "0.13%"],
        ["000834", "大成纳斯达克100ETF联接(QDII)A", "指数型-海外股票", "6.2705",
         "09-11", "限大额", "开放赎回", "", "10.0", "10.0", "1.0", "1", "0.12%"],
        ["050025", "博时标普500ETF联接A", "指数型-海外股票", "5.5759",
         "09-11", "暂停申购", "开放赎回", "", "10.0", "100.0", "1.0", "4", "0.12%"],
        ["513100", "纳指ETF国泰", "指数型-海外股票", "1.9831",
         "09-11", "场内交易", "场内交易", "", "0", "0", "0", "", ""],
    ]

    def test_270042(self):
        f = build_fund(self.ROWS[0])
        self.assertEqual(f.code, "270042")
        self.assertIs(f.status, PurchaseStatus.LIMITED)
        self.assertIs(f.currency, Currency.CNY)
        self.assertEqual(f.daily_limit, 2.0)
        self.assertEqual(f.limit_display, "2 元")
        self.assertTrue(f.is_buyable)

    def test_050025_suspended(self):
        f = build_fund(self.ROWS[2])
        self.assertIs(f.status, PurchaseStatus.SUSPENDED)
        self.assertFalse(f.is_buyable)
        self.assertEqual(f.limit_display, "暂停申购")

    def test_513100_on_exchange(self):
        f = build_fund(self.ROWS[3])
        self.assertTrue(f.is_on_exchange)
        self.assertFalse(f.is_buyable)
        self.assertEqual(f.limit_display, "场内交易")


if __name__ == "__main__":
    unittest.main(verbosity=2)
