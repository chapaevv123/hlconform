"""Regenerate compact site data from the verified hlconform snapshot and vectors."""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from hlconform.core import read_snapshot, resolve, write_json  # noqa: E402

NAMES = ("xyz:XYZ100", "flx:TSLA", "hyna:BTC", "BTC")
SOURCE = ROOT / "examples" / "mainnet_snapshot.json"
VECTORS = ROOT / "examples" / "mainnet_vectors.json"
TARGET = ROOT / "site" / "data"


def main() -> None:
    snapshot = read_snapshot(SOURCE)
    existing = json.loads(VECTORS.read_text(encoding="utf-8"))
    if existing.get("source_snapshot") != snapshot["content_hash"]:
        raise ValueError("vectors and snapshot do not share provenance")
    captured = datetime.fromisoformat(snapshot["captured_at"].replace("Z", "+00:00"))
    entries = []
    for coin in NAMES:
        result = resolve(snapshot, coin, now=captured)
        if result["verdict"] != "VALID":
            raise ValueError(f"recorded example is not valid: {coin}: {result}")
        match = next((v for v in existing["vectors"] if v["input"]["coin"] == coin), None)
        if not match or match["expected"]["asset_id"] != result["asset_id"]:
            raise ValueError(f"vector mismatch: {coin}")
        token = next(t for t in snapshot["spot_tokens"] if t["index"] == result["collateral_token"])
        entries.append({"coin": coin, "dex": result["dex"], "index": result["index"],
                        "dexPosition": next(d["position"] for d in snapshot["dexes"] if d["name"] == ("" if result["dex"] == "native" else result["dex"])),
                        "assetId": result["asset_id"], "collateralToken": result["collateral_token"],
                        "collateralName": token["name"], "vector": match})
    TARGET.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE, TARGET / "mainnet_snapshot.json")
    payload = {"schema": "hlconform.site-demo.v1", "kind": "RECORDED_SNAPSHOT_EXCERPT",
               "sourceSnapshotHash": snapshot["content_hash"],
               "sourceFileSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
               "capturedAt": snapshot["captured_at"], "apiEndpoint": snapshot["api_endpoint"],
               "network": snapshot["network"], "consistencyStatus": snapshot["consistency_status"],
               "consistencyMethod": snapshot["consistency_method"], "markets": entries}
    write_json(TARGET / "demo.json", payload)
    print(json.dumps({"markets": len(entries), "source_snapshot": snapshot["content_hash"]}))


if __name__ == "__main__":
    main()
