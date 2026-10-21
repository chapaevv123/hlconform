# hlconform — HIP-3 Conformance & Drift Kit

`hlconform` is a read-only Python 3.11 CLI for checking Hyperliquid perp market identifiers against a timestamped public metadata snapshot. It exports portable JSON vectors and explains metadata drift. It never places orders, signs transactions, or asks for keys.

## One-click website demo

From this directory, start the static site with one command:

```powershell
python -m http.server 4173 --directory site
```

Open `http://localhost:4173/` and click **RUN HIP-3 CHECK**. The hosted demo is at [GitHub Pages](https://chapaevv123.github.io/hlconform/). No login, wallet, backend, or external service is needed. The default `VALID` example is a historical replay of a recorded public mainnet snapshot. `INVALID`, `UNKNOWN`, and drift examples are clearly marked **SYNTHETIC TEST CASE**. The browser makes no live Hyperliquid API request. The recorded source JSON is available in the evidence drawer; `site/data/demo.json` is regenerated from the verified snapshot and vectors with `python scripts/build_site_data.py`.

## Quick start

From this directory, without installation:

```powershell
python -m hlconform --help
python -m hlconform snapshot --network mainnet --out snap.json
python -m hlconform resolve xyz:XYZ100 --snapshot snap.json
python -m hlconform check --config examples/example.toml --snapshot snap.json --json
python -m hlconform vectors --snapshot snap.json --out vectors.json
python -m hlconform diff examples/mainnet_snapshot.json examples/mainnet_snapshot.json --json
python -m unittest discover -s tests -v
node --test site/tests/site.test.mjs
```

An optional installed entry point is declared in `pyproject.toml`. There are no runtime dependencies outside Python 3.11 stdlib.

`snapshot` is the only networked command. It calls only the official mainnet or testnet `/info` host with `perpDexs`, `spotMeta`, and `meta(dex)`. A snapshot covers all DEXs in a registry with at most 24 entries; a larger or malformed registry fails safely to stay within a conservative request budget. Requests are spaced by at least 1.1 seconds, time out, and retry at most once on 429/transient failures. `resolve`, `check`, `vectors`, and `diff` are offline.

## TOML developer config

```toml
[market]
network = "mainnet"
dex = "xyz"                # use "" for the native perp DEX
coin = "xyz:XYZ100"       # exact API universe name
asset_id = 110000         # optional expected ID
collateral_token = 0      # optional spotMeta token index
```

The market identity is `(network, dex, coin, index in this snapshot)`. `collateral_token` is a mutable DEX attribute, not immutable identity. Native perp IDs equal their native universe indices; builder-deployed HIP-3 perp IDs use `100000 + perp_dex_index * 10000 + index_in_meta`, where `perp_dex_index` is the position in `perpDexs` (including the native `null` at zero). Outcome/HIP-4 assets are unsupported.

Verdicts: `VALID` means the config agrees with official documented formulas and this snapshot at capture time. It does **not** mean an order will be accepted, a market is safe, or metadata will stay unchanged. `INVALID` is a proved contradiction from a consistent, fresh snapshot. `UNKNOWN` covers missing, stale, inconsistent, unsupported, or unavailable evidence. Snapshots older than 24 hours cannot yield a current conformance `VALID`; historical `diff` still works.

Snapshots include normalized public market metadata, selected raw universe fields, UTC capture time, official endpoint, a SHA256 content hash, and a consistency result. The capture repeats the registry, spot metadata, and every DEX meta and checks equality. The API does not offer an atomic all-DEX snapshot, so a change between repeated reads can still escape detection. Treat important results as evidence to review, not a trading authorization.

`diff` separates DEX additions/removals, index drift, collateral changes, metadata field changes, API metadata key changes, and spot-token changes. Ordinary metadata value changes are reported as `METADATA_CHANGED`, not as an API schema violation. JSON vectors include input, expected verdict and ID, source snapshot hash, reason codes, formula version, and official evidence links. No proprietary code was copied.

## Security and limitations

- No wallet, account address, API key, credential, order, or exchange action is needed.
- Only an allowlist of official HTTPS Info API hosts is used; no arbitrary URL option is accepted.
- Public API access can fail, rate-limit, or change schema. A failed capture produces no false `VALID`.
- Local JSON files are integrity checked, but SHA256 is not an authentication signature. Treat snapshots from untrusted parties as untrusted data.
- A snapshot may be stale or non-atomic. `VALID` is scoped to this data and formula, never to execution or market risk.
- The CLI does not validate spot orders, HIP-4 outcomes, fee tiers, price precision, margin, or smart contracts.
- Windows UTF-8 paths are supported. Use `python -X utf8` if your terminal encoding is legacy.

## Sources

- [Official asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids)
- [Official perp Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
- [Official rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)

## Support Development

Funding addresses and URLs are deliberately omitted pending owner verification and approval. Never send funds to an address claimed to represent this project without a future verified announcement in this repository.
