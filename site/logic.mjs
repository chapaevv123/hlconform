export const SNAPSHOT_SCHEMA = "hlconform.site-demo.v1";
export const OFFICIAL_ASSET_IDS = "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids";
const HASH = /^[a-f0-9]{64}$/;

export function validateDemo(data) {
  if (!data || data.schema !== SNAPSHOT_SCHEMA || data.kind !== "RECORDED_SNAPSHOT_EXCERPT") return "Unsupported demo data";
  if (data.network !== "mainnet" || data.apiEndpoint !== "https://api.hyperliquid.xyz/info") return "Unexpected API source";
  if (!HASH.test(data.sourceSnapshotHash) || !HASH.test(data.sourceFileSha256)) return "Missing source provenance";
  if (!Number.isFinite(Date.parse(data.capturedAt)) || data.consistencyStatus !== "CONSISTENT") return "Unverified snapshot";
  if (!Array.isArray(data.markets) || !data.markets.length) return "No recorded markets";
  for (const market of data.markets) {
    if (!market || typeof market.coin !== "string" || typeof market.dex !== "string" ||
        !Number.isSafeInteger(market.index) || market.index < 0 ||
        !Number.isSafeInteger(market.dexPosition) || market.dexPosition < 0 ||
        !Number.isSafeInteger(market.assetId) || !Number.isSafeInteger(market.collateralToken) ||
        !market.vector || market.vector.source_snapshot !== data.sourceSnapshotHash ||
        market.vector.input?.coin !== market.coin ||
        market.vector.input?.network !== data.network ||
        market.vector.input?.dex !== (market.dex === "native" ? "" : market.dex) ||
        market.vector.expected?.asset_id !== market.assetId ||
        market.vector.expected?.collateral_token !== market.collateralToken ||
        market.vector.expected?.snapshot_hash !== data.sourceSnapshotHash ||
        market.vector.expected?.captured_at !== data.capturedAt ||
        market.vector.expected?.verdict !== "VALID") return "Recorded vector does not match snapshot excerpt";
  }
  return null;
}

export function assetId(market) {
  if (market.dexPosition === 0) return market.index;
  if (market.index >= 10000 || market.dexPosition <= 0) return null;
  return 100000 + market.dexPosition * 10000 + market.index;
}

export function checkMarket(data, market, scenario = "recorded") {
  const problem = validateDemo(data);
  if (problem || !data.markets.includes(market)) {
    return { verdict: "UNKNOWN", reasonCode: "SNAPSHOT_INCONSISTENT", explanation: problem || "Market is absent from this recorded excerpt.", kind: "RECORDED SNAPSHOT" };
  }
  const calculated = assetId(market);
  if (calculated === null || calculated !== market.assetId) {
    return { verdict: "UNKNOWN", reasonCode: "SNAPSHOT_INCONSISTENT", explanation: "Recorded index and asset ID disagree. No conformance result is safe.", kind: "RECORDED SNAPSHOT" };
  }
  if (scenario === "invalid") {
    return { verdict: "INVALID", reasonCode: "ASSET_ID_MISMATCH", explanation: "The synthetic configuration claims a different asset ID from the recorded DEX and coin index.", kind: "SYNTHETIC TEST CASE", claimedAssetId: market.assetId + 7, expectedAssetId: calculated, market };
  }
  if (scenario === "unknown") {
    return { verdict: "UNKNOWN", reasonCode: "SNAPSHOT_STALE", explanation: "At a simulated check 48 hours after capture, this snapshot is too old to verify current conformance.", kind: "SYNTHETIC TEST CASE", expectedAssetId: calculated, market };
  }
  if (scenario !== "recorded") return { verdict: "UNKNOWN", reasonCode: "UNSUPPORTED", explanation: "Unknown demo case.", kind: "SYNTHETIC TEST CASE" };
  return { verdict: "VALID", reasonCode: "NONE", explanation: "The DEX, coin, asset ID and collateral agree with the recorded public snapshot at capture time. This does not predict future order acceptance.", kind: "RECORDED SNAPSHOT", expectedAssetId: calculated, market };
}

export const DRIFT = {
  collateral: { code: "COLLATERAL_CHANGED", title: "Collateral moved; identity did not.", field: "DEX collateral token", before: "USDH · token 360", after: "USDC · token 0", explanation: "A DEX attribute changed. The market's DEX and coin can stay the same; integrations must refresh collateral mapping." },
  metadata: { code: "METADATA_CHANGED", title: "A market value changed.", field: "maxLeverage", before: "10", after: "12", explanation: "A value changed while the field shape stayed the same. This is ordinary metadata drift, not proof of an API schema break." },
  schema: { code: "SCHEMA_CHANGED", title: "The API shape changed.", field: "meta keys", before: "universe, collateralToken", after: "+ riskWeights", explanation: "A new metadata key appeared. SDK parsers should review it; this does not itself prove a trading failure." }
};

export function vectorExample(market) {
  return {
    input: market.vector.input,
    expected: {
      verdict: market.vector.expected.verdict,
      asset_id: market.vector.expected.asset_id,
      collateral_token: market.vector.expected.collateral_token,
      reason_codes: market.vector.expected.reason_codes
    },
    source_snapshot: market.vector.source_snapshot,
    evidence_references: market.vector.evidence_references,
    formula_version: market.vector.formula_version,
    reason_codes: market.vector.reason_codes
  };
}
