"""Allowlisted, bounded read-only public Info API capture."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from .core import HOSTS, SCHEMA, seal


class SourceUnavailable(RuntimeError):
    pass


class InfoClient:
    def __init__(self, network: str, *, interval: float = 1.1, timeout: float = 6.0):
        if network not in HOSTS:
            raise ValueError("network must be mainnet or testnet")
        self.endpoint = HOSTS[network]
        self.interval = max(interval, 0.0)
        self.timeout = min(max(timeout, 1.0), 15.0)
        self.last_request = 0.0
        self.requests = 0

    def post(self, body: dict):
        if body.get("type") not in {"perpDexs", "meta", "spotMeta"}:
            raise ValueError("only public metadata requests are allowed")
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        for attempt in range(2):
            delay = self.interval - (time.monotonic() - self.last_request)
            if delay > 0:
                time.sleep(delay)
            request = urllib.request.Request(self.endpoint, data=payload, headers={"Content-Type": "application/json", "User-Agent": "hlconform/0.1"}, method="POST")
            self.last_request = time.monotonic()
            self.requests += 1
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    if response.status != 200:
                        raise SourceUnavailable(f"HTTP {response.status}")
                    data = response.read(4_000_001)
                    if len(data) > 4_000_000:
                        raise SourceUnavailable("response too large")
                    return json.loads(data)
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 500, 502, 503, 504) and attempt == 0:
                    retry_after = exc.headers.get("Retry-After", "1")
                    try:
                        time.sleep(min(max(float(retry_after), 1.0), 3.0))
                    except ValueError:
                        time.sleep(1.0)
                    continue
                raise SourceUnavailable(f"HTTP {exc.code}") from exc
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
                if attempt == 0:
                    time.sleep(1.0)
                    continue
                raise SourceUnavailable(type(exc).__name__) from exc
        raise SourceUnavailable("retry exhausted")


def capture(network: str, client: InfoClient | None = None) -> dict:
    client = client or InfoClient(network)
    start = datetime.now(timezone.utc)
    registry = client.post({"type": "perpDexs"})
    if not isinstance(registry, list) or not registry or registry[0] is not None or len(registry) > 24:
        raise SourceUnavailable("unsupported or oversized perpDexs registry")
    if any(not isinstance(item, dict) or not isinstance(item.get("name"), str) for item in registry[1:]):
        raise SourceUnavailable("malformed perpDexs registry")
    spot_raw = client.post({"type": "spotMeta"})
    if not isinstance(spot_raw, dict) or not isinstance(spot_raw.get("tokens"), list):
        raise SourceUnavailable("malformed spotMeta")
    spot_tokens = [{"index": token.get("index"), "name": token.get("name")} for token in spot_raw["tokens"] if isinstance(token, dict)]
    dexes = []
    for position, descriptor in enumerate(registry):
        name = "" if position == 0 else descriptor["name"]
        raw = client.post({"type": "meta", "dex": name})
        if not isinstance(raw, dict) or not isinstance(raw.get("universe"), list):
            raise SourceUnavailable(f"malformed meta for dex {name}")
        collateral = raw.get("collateralToken")
        # Native USDC token 0 is documented in the official metaAndAssetCtxs example.
        if position == 0 and collateral is None:
            collateral = 0
        dexes.append({"name": name, "position": position, "collateral_token": collateral,
                      "universe": raw["universe"], "metadata_keys": sorted(raw)})
    metas_stable = True
    for entry in dexes:
        again = client.post({"type": "meta", "dex": entry["name"]})
        collateral_again = again.get("collateralToken") if isinstance(again, dict) else None
        if entry["position"] == 0 and collateral_again is None:
            collateral_again = 0
        if not isinstance(again, dict) or again.get("universe") != entry["universe"] or collateral_again != entry["collateral_token"] or sorted(again) != entry["metadata_keys"]:
            metas_stable = False
    registry_end = client.post({"type": "perpDexs"})
    spot_end = client.post({"type": "spotMeta"})
    consistent = registry == registry_end and spot_raw == spot_end and metas_stable
    # No account identifiers from perpDexs are persisted; only public market fields.
    snapshot = {"schema_version": SCHEMA, "network": network, "source": "Hyperliquid public Info API",
                "api_endpoint": client.endpoint, "captured_at": start.isoformat().replace("+00:00", "Z"),
                "capture_finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "consistency_status": "CONSISTENT" if consistent else "INCONSISTENT",
                "consistency_method": "perpDexs and spotMeta before/after; every meta repeated; no atomic guarantee",
                "request_count": client.requests, "dexes": dexes, "spot_tokens": spot_tokens}
    return seal(snapshot)
