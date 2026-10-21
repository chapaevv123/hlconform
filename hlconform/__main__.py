"""Command-line interface. All commands except snapshot are offline."""
from __future__ import annotations

import argparse
import json
import sys
import tomllib
from pathlib import Path
from .api import SourceUnavailable, capture
from .core import diff, read_snapshot, resolve, vectors, write_json


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hlconform", description="Read-only HIP-3 conformance and drift diagnostics")
    sub = p.add_subparsers(dest="command", required=True)
    s = sub.add_parser("snapshot", help="Capture public metadata (network access)")
    s.add_argument("--network", required=True, choices=["mainnet", "testnet"])
    s.add_argument("--out", required=True)
    r = sub.add_parser("resolve", help="Resolve a coin from a local snapshot")
    r.add_argument("coin")
    r.add_argument("--snapshot", required=True)
    r.add_argument("--dex")
    r.add_argument("--json", action="store_true")
    c = sub.add_parser("check", help="Check TOML developer config offline")
    c.add_argument("--config", required=True)
    c.add_argument("--snapshot", required=True)
    c.add_argument("--json", action="store_true")
    v = sub.add_parser("vectors", help="Export portable JSON conformance vectors")
    v.add_argument("--snapshot", required=True)
    v.add_argument("--out", required=True)
    d = sub.add_parser("diff", help="Compare two local snapshots")
    d.add_argument("old")
    d.add_argument("new")
    d.add_argument("--json", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "snapshot":
            result = capture(args.network)
            write_json(args.out, result)
            print(json.dumps({"out": args.out, "content_hash": result["content_hash"], "consistency_status": result["consistency_status"], "request_count": result["request_count"]}))
            return 0 if result["consistency_status"] == "CONSISTENT" else 2
        if args.command == "resolve":
            result = resolve(read_snapshot(args.snapshot), args.coin, dex=args.dex)
        elif args.command == "check":
            config = tomllib.loads(Path(args.config).read_text(encoding="utf-8"))
            market = config.get("market")
            if not isinstance(market, dict) or not isinstance(market.get("coin"), str):
                raise ValueError("config requires [market] and coin")
            result = resolve(read_snapshot(args.snapshot), market["coin"], dex=market.get("dex"), network=market.get("network"),
                             asset_id=market.get("asset_id"), collateral_token=market.get("collateral_token"))
        elif args.command == "vectors":
            result = vectors(read_snapshot(args.snapshot))
            write_json(args.out, result)
            print(json.dumps({"out": args.out, "verdict": result["verdict"], "count": len(result["vectors"])}))
            return 0 if result["verdict"] == "VALID" else 2
        else:
            result = diff(read_snapshot(args.old), read_snapshot(args.new))
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0 if result["verdict"] == "VALID" else 2
    except (ValueError, SourceUnavailable, OSError, tomllib.TOMLDecodeError) as exc:
        print(json.dumps({"verdict": "UNKNOWN", "reason_codes": ["SOURCE_UNAVAILABLE" if isinstance(exc, SourceUnavailable) else "INVALID_INPUT"], "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
