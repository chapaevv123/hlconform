import copy
import io
import json
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from hlconform import api, core
from hlconform.__main__ import main

NOW = datetime(2026, 10, 21, 4, 0, tzinfo=timezone.utc)


def fixture():
    return core.seal({
        "schema_version": core.SCHEMA, "network": "mainnet", "source": "synthetic",
        "api_endpoint": core.HOSTS["mainnet"], "captured_at": NOW.isoformat().replace("+00:00", "Z"),
        "consistency_status": "CONSISTENT", "spot_tokens": [{"index": 0, "name": "USDC"}, {"index": 7, "name": "USDH"}],
        "dexes": [
            {"name": "", "position": 0, "collateral_token": 0, "universe": [{"name": "BTC", "szDecimals": 5}, {"name": "ETH", "szDecimals": 4}], "metadata_keys": ["universe"]},
            {"name": "xyz", "position": 1, "collateral_token": 7, "universe": [{"name": "xyz:AAPL", "szDecimals": 2}, {"name": "xyz:MSFT", "szDecimals": 3}], "metadata_keys": ["universe", "collateralToken"]},
        ],
    })


class ConformanceTests(unittest.TestCase):
    def r(self, coin="xyz:AAPL", **kw):
        return core.resolve(fixture(), coin, now=NOW, **kw)

    def assert_reason(self, expected, coin="xyz:AAPL", **kw):
        self.assertIn(expected, self.r(coin, **kw)["reason_codes"])

    def test_01_native(self):
        self.assertEqual(self.r("BTC")["asset_id"], 0)

    def test_02_hip3_first(self):
        self.assertEqual(self.r()["asset_id"], 110000)

    def test_03_hip3_second(self):
        self.assertEqual(self.r("xyz:MSFT")["asset_id"], 110001)

    def test_04_config_correct(self):
        self.assertEqual(self.r(network="mainnet", asset_id=110000, collateral_token=7)["verdict"], "VALID")

    def test_05_dex_absent(self):
        self.assert_reason("DEX_NOT_FOUND", dex="missing")

    def test_06_coin_absent(self):
        self.assert_reason("COIN_NOT_IN_UNIVERSE", "xyz:OTHER")

    def test_07_prefix(self):
        self.assert_reason("COIN_PREFIX_MISMATCH", "bad:AAPL", dex="xyz")

    def test_08_asset_mismatch(self):
        self.assert_reason("ASSET_ID_MISMATCH", asset_id=100000)

    def test_09_collateral_mismatch(self):
        self.assert_reason("COLLATERAL_MISMATCH", collateral_token=0)

    def test_10_collateral_not_spot(self):
        snap = fixture(); snap["dexes"][1]["collateral_token"] = 99
        self.assertEqual(core.resolve(snap, "xyz:AAPL", now=NOW)["reason_codes"], ["COLLATERAL_NOT_IN_SPOTMETA"])

    def test_11_stale(self):
        self.assertEqual(core.resolve(fixture(), "xyz:AAPL", now=NOW + timedelta(days=2))["reason_codes"], ["SNAPSHOT_STALE"])

    def test_12_inconsistent(self):
        snap = fixture(); snap["consistency_status"] = "INCONSISTENT"
        self.assertEqual(core.resolve(snap, "xyz:AAPL", now=NOW)["reason_codes"], ["SNAPSHOT_INCONSISTENT"])

    def test_13_source_unavailable(self):
        with patch.object(api.InfoClient, "post", side_effect=api.SourceUnavailable("offline")):
            with self.assertRaises(api.SourceUnavailable): api.capture("mainnet")

    def test_14_corrupt_file(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "bad.json"; p.write_text("{invalid", encoding="utf-8")
            with self.assertRaises(ValueError): core.read_snapshot(p)
            s = fixture(); s["dexes"][1]["position"] = 3
            core.write_json(p, s)
            with self.assertRaises(ValueError): core.read_snapshot(p)

    def test_15_hip4(self):
        self.assertEqual(self.r("#10")["reason_codes"], ["UNSUPPORTED"])

    def test_16_index_range(self):
        snap = fixture(); snap["dexes"][1]["universe"] = [{"name": f"xyz:X{i}"} for i in range(10000)] + [{"name": "xyz:AAPL"}]
        self.assertEqual(core.resolve(snap, "xyz:AAPL", now=NOW)["reason_codes"], ["ASSET_ID_RANGE_UNSUPPORTED"])

    def test_17_overflow_guard(self):
        snap = fixture(); snap["dexes"][1]["position"] = 2**53
        with patch.object(core, "snapshot_problem", return_value=None):
            self.assertEqual(core.resolve(snap, "xyz:AAPL", now=NOW)["reason_codes"], ["INDEX_OVERFLOW"])

    def test_18_native_no_offset(self):
        self.assertEqual(self.r("ETH")["asset_id"], 1)

    def test_19_collateral_drift(self):
        old = fixture(); new = copy.deepcopy(old); new["dexes"][1]["collateral_token"] = 0; new = core.seal(new)
        kinds = [c["kind"] for c in core.diff(old, new)["changes"]]
        self.assertEqual(kinds, ["COLLATERAL_CHANGED"])

    def test_20_reorder(self):
        old = fixture(); new = copy.deepcopy(old); new["dexes"][1]["universe"].reverse(); new = core.seal(new)
        self.assertEqual([c["kind"] for c in core.diff(old, new)["changes"]].count("INDEX_DRIFT"), 2)

    def test_21_schema_change(self):
        old = fixture(); new = copy.deepcopy(old); new["dexes"][1]["universe"][0]["newField"] = 1; new = core.seal(new)
        self.assertIn("SCHEMA_CHANGED", [c["kind"] for c in core.diff(old, new)["changes"]])

    def test_22_value_change(self):
        old = fixture(); new = copy.deepcopy(old); new["dexes"][1]["universe"][0]["szDecimals"] = 4; new = core.seal(new)
        kinds = [c["kind"] for c in core.diff(old, new)["changes"]]
        self.assertEqual(kinds, ["METADATA_CHANGED"])

    def test_23_vectors(self):
        data = core.vectors(fixture(), NOW)
        self.assertEqual(len(data["vectors"]), 4)
        self.assertTrue(all({"input", "expected", "source_snapshot", "evidence_references", "formula_version", "reason_codes"} <= set(v) for v in data["vectors"]))
        json.loads(json.dumps(data))

    def test_24_offline_cli(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "s.json"; core.write_json(p, fixture())
            with patch("urllib.request.urlopen", side_effect=AssertionError("network used")):
                with patch("sys.stdout", new=io.StringIO()):
                    self.assertEqual(main(["diff", str(p), str(p), "--json"]), 0)
                    self.assertEqual(main(["resolve", "BTC", "--snapshot", str(p)]), 0)
                    self.assertEqual(main(["vectors", "--snapshot", str(p), "--out", str(Path(td) / "v.json")]), 0)

    def test_25_unicode_path(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "снимок 日本語.json"; core.write_json(p, fixture())
            self.assertEqual(core.read_snapshot(p)["content_hash"], fixture()["content_hash"])

    def test_26_rate_limit(self):
        error = HTTPError(core.HOSTS["mainnet"], 429, "rate", {"Retry-After": "0"}, None)
        with patch("urllib.request.urlopen", side_effect=error), patch("time.sleep"):
            client = api.InfoClient("mainnet", interval=0)
            with self.assertRaises(api.SourceUnavailable): client.post({"type": "perpDexs"})
            self.assertEqual(client.requests, 2)

    def test_27_no_false_verdicts(self):
        snap = fixture(); snap["consistency_status"] = "INCONSISTENT"
        self.assertEqual(core.resolve(snap, "xyz:OTHER", now=NOW)["verdict"], "UNKNOWN")

    def test_28_network_mismatch(self):
        self.assert_reason("NETWORK_MISMATCH", network="testnet")

    def test_29_meta_schema_change(self):
        old = fixture(); new = copy.deepcopy(old); new["dexes"][1]["metadata_keys"].append("newField"); new = core.seal(new)
        self.assertIn("SCHEMA_CHANGED", [c["kind"] for c in core.diff(old, new)["changes"]])

    def test_30_spot_token_drift(self):
        old = fixture(); new = copy.deepcopy(old); new["spot_tokens"][1]["name"] = "OTHER"; new = core.seal(new)
        self.assertIn("SPOT_TOKEN_CHANGED", [c["kind"] for c in core.diff(old, new)["changes"]])

    def test_31_check_toml(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td); core.write_json(p / "s.json", fixture())
            (p / "c.toml").write_text('[market]\nnetwork="mainnet"\ndex="xyz"\ncoin="xyz:AAPL"\nasset_id=110000\ncollateral_token=7\n', encoding="utf-8")
            with patch("sys.stdout", new=io.StringIO()), patch("urllib.request.urlopen", side_effect=AssertionError("network used")):
                self.assertEqual(main(["check", "--config", str(p / "c.toml"), "--snapshot", str(p / "s.json"), "--json"]), 0)

    def test_32_capture_consistency(self):
        class FakeClient:
            endpoint = core.HOSTS["mainnet"]
            requests = 0
            def post(self, body):
                self.requests += 1
                if body["type"] == "perpDexs": return [None, {"name": "xyz", "deployer": "PUBLIC_ADDRESS"}]
                if body["type"] == "spotMeta": return {"tokens": [{"index": 0, "name": "USDC"}]}
                return {"universe": [{"name": "BTC"}] if body["dex"] == "" else [{"name": "xyz:ABC"}], "collateralToken": 0}
        snap = api.capture("mainnet", FakeClient())
        self.assertEqual(snap["consistency_status"], "CONSISTENT")
        self.assertEqual(snap["request_count"], 8)
        self.assertNotIn("PUBLIC_ADDRESS", json.dumps(snap))


if __name__ == "__main__":
    unittest.main()
