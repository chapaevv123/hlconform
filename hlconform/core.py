"""Snapshot, conformance and drift logic. No network access in this module."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

SCHEMA = "hlconform.snapshot.v1"
FORMULA = "hyperliquid.asset-ids.2026-10-21"
ASSET_DOC = "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids"
INFO_DOC = "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals"
HOSTS = {"mainnet": "https://api.hyperliquid.xyz/info", "testnet": "https://api.hyperliquid-testnet.xyz/info"}


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def seal(snapshot: dict) -> dict:
    result = dict(snapshot)
    result.pop("content_hash", None)
    result["content_hash"] = digest(result)
    return result


def read_snapshot(path: str | Path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid snapshot file: {exc}") from exc
    if not isinstance(data, dict) or data.get("schema_version") != SCHEMA:
        raise ValueError("unsupported snapshot schema")
    actual = data.get("content_hash")
    if not isinstance(actual, str) or seal(data)["content_hash"] != actual:
        raise ValueError("snapshot hash mismatch")
    return data


def write_json(path: str | Path, value: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Local output; temp + replace avoids partial snapshots after interruption.
    import os, tempfile
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=target.parent, prefix=f".{target.name}.", suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(value, handle, indent=2, ensure_ascii=False, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)


def _dt(raw: str) -> datetime:
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("snapshot timestamp has no timezone")
    return parsed.astimezone(timezone.utc)


def snapshot_problem(snapshot: dict, now: datetime | None = None) -> str | None:
    if snapshot.get("consistency_status") != "CONSISTENT":
        return "SNAPSHOT_INCONSISTENT"
    if snapshot.get("network") not in HOSTS or snapshot.get("api_endpoint") != HOSTS[snapshot["network"]]:
        return "SOURCE_UNAVAILABLE"
    if not isinstance(snapshot.get("dexes"), list) or not isinstance(snapshot.get("spot_tokens"), list):
        return "SNAPSHOT_INCONSISTENT"
    dexes = snapshot["dexes"]
    if not dexes or [d.get("position") for d in dexes if isinstance(d, dict)] != list(range(len(dexes))):
        return "SNAPSHOT_INCONSISTENT"
    if any(not isinstance(d, dict) or not isinstance(d.get("name"), str) or not isinstance(d.get("universe"), list) for d in dexes):
        return "SNAPSHOT_INCONSISTENT"
    if dexes[0]["name"] != "" or len({d["name"] for d in dexes}) != len(dexes):
        return "SNAPSHOT_INCONSISTENT"
    if any(not isinstance(t, dict) or type(t.get("index")) is not int for t in snapshot["spot_tokens"]):
        return "SNAPSHOT_INCONSISTENT"
    if len({t["index"] for t in snapshot["spot_tokens"]}) != len(snapshot["spot_tokens"]):
        return "SNAPSHOT_INCONSISTENT"
    for entry in dexes:
        universe = entry["universe"]
        if any(not isinstance(m, dict) or not isinstance(m.get("name"), str) for m in universe):
            return "SNAPSHOT_INCONSISTENT"
        if len({m["name"] for m in universe}) != len(universe):
            return "SNAPSHOT_INCONSISTENT"
        if entry["name"] and any(not m["name"].startswith(entry["name"] + ":") for m in universe):
            return "SNAPSHOT_INCONSISTENT"
    try:
        captured = _dt(snapshot["captured_at"])
    except (KeyError, TypeError, ValueError):
        return "SNAPSHOT_INCONSISTENT"
    now = now or datetime.now(timezone.utc)
    if captured > now + timedelta(minutes=5) or now - captured > timedelta(hours=24):
        return "SNAPSHOT_STALE"
    return None


def _result(verdict: str, reasons: list[str], **extra: Any) -> dict:
    return {"verdict": verdict, "reason_codes": reasons, **extra}


def resolve(snapshot: dict, coin: str, *, dex: str | None = None, network: str | None = None,
            asset_id: int | None = None, collateral_token: int | None = None,
            now: datetime | None = None) -> dict:
    problem = snapshot_problem(snapshot, now)
    if problem:
        return _result("UNKNOWN", [problem])
    if not isinstance(coin, str) or not coin:
        return _result("UNKNOWN", ["SNAPSHOT_INCONSISTENT"])
    if coin.startswith(("#", "+")):
        return _result("UNKNOWN", ["UNSUPPORTED"])
    if network is not None and network != snapshot["network"]:
        return _result("INVALID", ["NETWORK_MISMATCH"])
    dex = dex if dex is not None else (coin.split(":", 1)[0] if ":" in coin else "")
    dexes = snapshot["dexes"]
    matches = [entry for entry in dexes if isinstance(entry, dict) and entry.get("name") == dex]
    if not matches:
        return _result("INVALID", ["DEX_NOT_FOUND"])
    if len(matches) != 1:
        return _result("UNKNOWN", ["SNAPSHOT_INCONSISTENT"])
    entry = matches[0]
    position = entry.get("position")
    universe = entry.get("universe")
    if not isinstance(position, int) or isinstance(position, bool) or not isinstance(universe, list):
        return _result("UNKNOWN", ["SNAPSHOT_INCONSISTENT"])
    if dex and not coin.startswith(dex + ":"):
        return _result("INVALID", ["COIN_PREFIX_MISMATCH"])
    if not dex and ":" in coin:
        return _result("INVALID", ["COIN_PREFIX_MISMATCH"])
    names = [market.get("name") if isinstance(market, dict) else None for market in universe]
    if len(names) != len(set(names)) or any(not isinstance(name, str) for name in names):
        return _result("UNKNOWN", ["SNAPSHOT_INCONSISTENT"])
    if coin not in names:
        return _result("INVALID", ["COIN_NOT_IN_UNIVERSE"])
    index = names.index(coin)
    if index > 2**53 - 1 or position > 2**53 - 1:
        return _result("UNKNOWN", ["INDEX_OVERFLOW"])
    if dex and index >= 10000:
        return _result("UNKNOWN", ["ASSET_ID_RANGE_UNSUPPORTED"])
    expected_id = index if not dex else 100000 + position * 10000 + index
    if dex and (position <= 0 or position >= 9990):
        return _result("UNKNOWN", ["ASSET_ID_RANGE_UNSUPPORTED"])
    token = entry.get("collateral_token")
    spot = snapshot["spot_tokens"]
    spot_indices = {item.get("index") for item in spot if isinstance(item, dict) and type(item.get("index")) is int}
    if type(token) is not int or token not in spot_indices:
        return _result("UNKNOWN", ["COLLATERAL_NOT_IN_SPOTMETA"])
    reasons = []
    if asset_id is not None and (type(asset_id) is not int or asset_id != expected_id):
        reasons.append("ASSET_ID_MISMATCH")
    if collateral_token is not None and (type(collateral_token) is not int or collateral_token != token):
        reasons.append("COLLATERAL_MISMATCH")
    return _result("INVALID" if reasons else "VALID", reasons,
                   network=snapshot["network"], dex=dex or "native", coin=coin,
                   asset_id=expected_id, index=index, collateral_token=token,
                   snapshot_hash=snapshot["content_hash"], captured_at=snapshot["captured_at"])


def vectors(snapshot: dict, now: datetime | None = None) -> dict:
    problem = snapshot_problem(snapshot, now)
    if problem:
        return {"schema_version": "hlconform.vectors.v1", "verdict": "UNKNOWN", "reason_codes": [problem], "vectors": []}
    output = []
    for entry in snapshot["dexes"]:
        for market in entry["universe"]:
            coin = market["name"]
            result = resolve(snapshot, coin, dex=entry["name"], now=now)
            output.append({"input": {"network": snapshot["network"], "dex": entry["name"], "coin": coin},
                           "expected": result, "source_snapshot": snapshot["content_hash"],
                           "evidence_references": [ASSET_DOC, INFO_DOC], "formula_version": FORMULA,
                           "reason_codes": result["reason_codes"]})
    return {"schema_version": "hlconform.vectors.v1", "verdict": "VALID" if all(v["expected"]["verdict"] == "VALID" for v in output) else "UNKNOWN",
            "source_snapshot": snapshot["content_hash"], "vectors": output}


def diff(old: dict, new: dict) -> dict:
    try:
        old_issue = snapshot_problem(old, _dt(old["captured_at"]))
        new_issue = snapshot_problem(new, _dt(new["captured_at"]))
    except (KeyError, TypeError, ValueError):
        return _result("UNKNOWN", ["SNAPSHOT_INCONSISTENT"], changes=[])
    if old_issue or new_issue:
        return _result("UNKNOWN", [old_issue or new_issue], changes=[])
    if old.get("network") != new.get("network"):
        return _result("UNKNOWN", ["NETWORK_MISMATCH"], changes=[])
    if old.get("consistency_status") != "CONSISTENT" or new.get("consistency_status") != "CONSISTENT":
        return _result("UNKNOWN", ["SNAPSHOT_INCONSISTENT"], changes=[])
    if old.get("schema_version") != SCHEMA or new.get("schema_version") != SCHEMA:
        return _result("UNKNOWN", ["SNAPSHOT_INCONSISTENT"], changes=[])
    changes = []
    old_map = {d["name"]: d for d in old["dexes"]}
    new_map = {d["name"]: d for d in new["dexes"]}
    for name in sorted(old_map.keys() | new_map.keys()):
        if name not in old_map or name not in new_map:
            changes.append({"kind": "DEX_ADDED" if name in new_map else "DEX_REMOVED", "dex": name})
            continue
        before, after = old_map[name], new_map[name]
        if before.get("position") != after.get("position"):
            changes.append({"kind": "INDEX_DRIFT", "dex": name, "field": "dex_position", "old": before.get("position"), "new": after.get("position")})
        if before.get("collateral_token") != after.get("collateral_token"):
            changes.append({"kind": "COLLATERAL_CHANGED", "dex": name, "old": before.get("collateral_token"), "new": after.get("collateral_token")})
        if before.get("metadata_keys") != after.get("metadata_keys"):
            changes.append({"kind": "SCHEMA_CHANGED", "dex": name, "field": "meta", "old_keys": before.get("metadata_keys"), "new_keys": after.get("metadata_keys")})
        b, a = before["universe"], after["universe"]
        bi, ai = {m["name"]: (i, m) for i, m in enumerate(b)}, {m["name"]: (i, m) for i, m in enumerate(a)}
        for coin in sorted(bi.keys() | ai.keys()):
            if coin not in bi or coin not in ai:
                changes.append({"kind": "MARKET_ADDED" if coin in ai else "MARKET_REMOVED", "dex": name, "coin": coin})
                continue
            old_i, old_m = bi[coin]
            new_i, new_m = ai[coin]
            if old_i != new_i:
                changes.append({"kind": "INDEX_DRIFT", "dex": name, "coin": coin, "old": old_i, "new": new_i})
            if set(old_m) != set(new_m):
                changes.append({"kind": "SCHEMA_CHANGED", "dex": name, "coin": coin, "old_keys": sorted(old_m), "new_keys": sorted(new_m)})
            for field in sorted(set(old_m) & set(new_m)):
                if old_m[field] != new_m[field]:
                    changes.append({"kind": "METADATA_CHANGED", "dex": name, "coin": coin, "field": field, "old": old_m[field], "new": new_m[field]})
    before_tokens = {t["index"]: t for t in old["spot_tokens"]}
    after_tokens = {t["index"]: t for t in new["spot_tokens"]}
    for index in sorted(before_tokens.keys() | after_tokens.keys()):
        if index not in before_tokens or index not in after_tokens:
            changes.append({"kind": "SPOT_TOKEN_ADDED" if index in after_tokens else "SPOT_TOKEN_REMOVED", "index": index})
        elif before_tokens[index] != after_tokens[index]:
            changes.append({"kind": "SPOT_TOKEN_CHANGED", "index": index, "old": before_tokens[index], "new": after_tokens[index]})
    return _result("VALID", [], changes=changes, old_hash=old["content_hash"], new_hash=new["content_hash"])
