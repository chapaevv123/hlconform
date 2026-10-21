import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetId, checkMarket, DRIFT, validateDemo, vectorExample } from "../logic.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const demo = JSON.parse(readFileSync(join(root, "data", "demo.json"), "utf8"));
const source = JSON.parse(readFileSync(join(root, "data", "mainnet_snapshot.json"), "utf8"));

test("demo provenance matches full recorded snapshot", () => {
  assert.equal(validateDemo(demo), null);
  assert.equal(demo.sourceSnapshotHash, source.content_hash);
  assert.equal(demo.capturedAt, source.captured_at);
  assert.equal(demo.consistencyStatus, source.consistency_status);
});
test("full source bytes match the pinned file SHA-256", () => {
  const bytes = readFileSync(join(root, "data", "mainnet_snapshot.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), demo.sourceFileSha256);
});
test("each recorded excerpt row matches the full snapshot", () => {
  for (const market of demo.markets) {
    const dex = source.dexes[market.dexPosition];
    assert.equal(dex.name, market.dex === "native" ? "" : market.dex);
    assert.equal(dex.universe[market.index].name, market.coin);
    assert.equal(dex.collateral_token, market.collateralToken);
    assert.equal(source.spot_tokens.find((token) => token.index === market.collateralToken).name, market.collateralName);
  }
});
test("all curated recorded markets recompute the official asset formula", () => {
  for (const market of demo.markets) {
    assert.equal(assetId(market), market.assetId);
    assert.equal(checkMarket(demo, market).verdict, "VALID");
    assert.equal(market.vector.expected.asset_id, market.assetId);
  }
});
test("synthetic wrong ID is INVALID with explicit reason", () => {
  const result = checkMarket(demo, demo.markets[0], "invalid");
  assert.equal(result.verdict, "INVALID");
  assert.equal(result.reasonCode, "ASSET_ID_MISMATCH");
  assert.equal(result.kind, "SYNTHETIC TEST CASE");
  assert.notEqual(result.claimedAssetId, result.expectedAssetId);
});
test("synthetic stale snapshot is UNKNOWN, never VALID", () => {
  const result = checkMarket(demo, demo.markets[0], "unknown");
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.reasonCode, "SNAPSHOT_STALE");
});
test("tampered provenance is UNKNOWN", () => {
  const tampered = structuredClone(demo);
  tampered.markets[0].vector.source_snapshot = "bad";
  assert.equal(checkMarket(tampered, tampered.markets[0]).verdict, "UNKNOWN");
});
test("tampered vector network is UNKNOWN", () => {
  const tampered = structuredClone(demo);
  tampered.markets[0].vector.input.network = "testnet";
  assert.equal(checkMarket(tampered, tampered.markets[0]).verdict, "UNKNOWN");
});
test("recorded vector example is portable JSON", () => {
  const output = vectorExample(demo.markets[0]);
  assert.equal(JSON.parse(JSON.stringify(output)).expected.asset_id, 110000);
  assert.equal(output.source_snapshot, demo.sourceSnapshotHash);
  assert.ok(output.evidence_references.length > 0);
});
test("synthetic drift types stay distinct", () => {
  assert.equal(DRIFT.collateral.code, "COLLATERAL_CHANGED");
  assert.equal(DRIFT.metadata.code, "METADATA_CHANGED");
  assert.equal(DRIFT.schema.code, "SCHEMA_CHANGED");
});
test("native perp avoids HIP-3 offset", () => {
  const native = demo.markets.find((m) => m.dex === "native");
  assert.equal(native.assetId, native.index);
});
