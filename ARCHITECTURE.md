# Architecture

`hlconform/api.py` fetches only public Info API metadata through a fixed host map. `hlconform/core.py` owns deterministic hashing, freshness and structural checks, conformance, vector generation, and drift classification. `hlconform/__main__.py` parses CLI arguments. The offline commands import no network client for their work; tests monkeypatch `urlopen` to prove no connection is attempted.

Snapshot schema `hlconform.snapshot.v1`: network, source, `captured_at`, `capture_finished_at`, `api_endpoint`, `consistency_status`, `consistency_method`, `dexes` with original universe objects and normalized name/position/collateral, `spot_tokens`, `content_hash`. Hash is SHA256 of canonical sorted compact UTF-8 JSON excluding `content_hash`. Files are written via temp file, fsync, and replace.

Capture flow: `perpDexs` → `spotMeta` → `meta(dex)` for each DEX → repeat every `meta(dex)` → `perpDexs` → `spotMeta`. Any mismatch yields `INCONSISTENT`. No atomic consistency across all DEX metadata can be proven; the report states this residual risk.

Conformance flow: verify snapshot → freshness → network → DEX → prefix → coin → index range → spot collateral mapping → optional config assertions. An unverified prerequisite yields `UNKNOWN` before contradiction checks. Diff accepts historical but internally consistent snapshots; it distinguishes schema key changes from value changes.

No services, database, secrets, wallet integration, or scheduler are required.
