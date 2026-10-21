import { checkMarket, DRIFT, OFFICIAL_ASSET_IDS, validateDemo, vectorExample } from "./logic.mjs";

const $ = (id) => document.getElementById(id);
const marketSelect = $("marketSelect");
const runButton = $("runButton");
const resultPanel = $("result");
const evidence = $("evidence");
let demo = null;
let lastResult = null;
let toastTimer = null;
let integrityCheck = null;
let integrityVerdict = null;

function text(id, value) { $(id).textContent = String(value); }
function notice(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.style.boxShadow = isError ? "4px 4px 0 #ef8f78" : "4px 4px 0 #b9e06d";
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}
function currentMarket() { return demo?.markets[Number(marketSelect.value)] || null; }
function previewMarket() {
  const market = currentMarket();
  text("previewMarket", market ? market.coin : "—");
  text("previewCollateral", market ? market.collateralName : "—");
  text("previewAsset", market ? market.assetId : "—");
  text("sourcePreviewMarket", market ? market.coin : "—");
  text("sourcePreviewCollateral", market ? market.collateralName : "—");
  text("sourcePreviewAsset", market ? market.assetId : "—");
  $("previewAsset").closest(".market-facts").querySelector(".hip-note").textContent = market?.dex === "native" ? "(NATIVE)" : "(HIP-3)";
}
function currentCase() { return document.querySelector('input[name="case"]:checked')?.value || "recorded"; }
function reset({ resetControls = true } = {}) {
  if (resetControls && demo) {
    marketSelect.value = "0";
    document.querySelector('input[name="case"][value="recorded"]').checked = true;
  }
  lastResult = null;
  resultPanel.hidden = true;
  $("resultPlaceholder").hidden = false;
  evidence.hidden = true;
  $("evidenceButton").setAttribute("aria-expanded", "false");
  $("copyVector").disabled = true;
  $("downloadVector").disabled = true;
  text("vectorJson", "Run the check to inspect a recorded vector.");
  text("demoStatus", demo ? "Ready to check a recorded market." : "Recorded data is unavailable.");
}

function renderResult(result, market) {
  lastResult = result;
  resultPanel.hidden = false;
  $("resultPlaceholder").hidden = true;
  resultPanel.dataset.verdict = result.verdict;
  text("verdict", result.verdict);
  text("dataKind", result.kind);
  text("resultDex", market.dex === "native" ? "NATIVE" : market.dex.toUpperCase());
  text("resultCoin", market.coin);
  text("resultAsset", result.claimedAssetId ?? result.expectedAssetId ?? "—");
  text("resultExplanation", result.explanation);
  text("resultNetwork", demo.network.toUpperCase());
  text("resultCollateral", market.collateralName + " · token " + market.collateralToken);
  text("resultReason", result.reasonCode);
  text("resultTime", demo.capturedAt.replace("T", " ").replace(/\.\d+Z$/, "Z"));
  text("evidenceHash", demo.sourceSnapshotHash);
  text("evidenceEndpoint", demo.apiEndpoint);
  text("evidenceFormula", market.dexPosition === 0 ? "Native perp: asset ID = index in meta" : "HIP-3: 100000 + DEX index × 10000 + index in meta");
  text("evidenceNote", result.kind === "RECORDED SNAPSHOT"
    ? "The values below come from a recorded public API capture. This is a historical replay at capture time, not a live exchange check."
    : "Only the test condition was changed. The source market and timestamp remain recorded public data. " +
      (result.reasonCode === "ASSET_ID_MISMATCH" ? "Expected asset ID: " + result.expectedAssetId + "." : "The simulated check occurs 48 hours after capture."));
  text("vectorJson", JSON.stringify(vectorExample(market), null, 2));
  $("copyVector").disabled = false;
  $("downloadVector").disabled = false;
  text("demoStatus", "Check complete · " + result.kind.toLowerCase() + ".");
}

function run() {
  if (!demo) { notice("Recorded data has not loaded.", true); return; }
  const market = currentMarket();
  if (!market) { notice("Choose a recorded market.", true); return; }
  const result = integrityVerdict === false
    ? { verdict: "UNKNOWN", reasonCode: "SNAPSHOT_INCONSISTENT", explanation: "The full recorded source failed integrity verification.", kind: "SOURCE UNVERIFIED", market }
    : checkMarket(demo, market, currentCase());
  if (result.verdict === "UNKNOWN" && result.reasonCode === "SNAPSHOT_INCONSISTENT") {
    text("demoStatus", "Source data is inconsistent; no result can be trusted.");
    $("demoStatus").classList.add("error");
  } else {
    $("demoStatus").classList.remove("error");
  }
  renderResult(result, market);
  resultPanel.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" });
}

async function copyText(value, label) {
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); copied = true; } catch { /* Try the local selection fallback. */ }
    }
    if (!copied) {
      const temp = document.createElement("textarea");
      temp.value = value; temp.style.position = "fixed"; temp.style.opacity = "0";
      document.body.append(temp);
      try { temp.select(); copied = document.execCommand("copy"); } finally { temp.remove(); }
    }
    if (!copied) throw new Error("clipboard denied");
    notice(label + " copied.");
  } catch { notice("Copy unavailable in this browser. Use Download Example instead.", true); }
}

function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notice("Example downloaded.");
}

async function verifyFullSnapshot() {
  if (integrityCheck) return integrityCheck;
  text("integrityStatus", "Verifying recorded file…");
  integrityCheck = (async () => {
    try {
      const response = await fetch("./data/mainnet_snapshot.json", { cache: "no-store" });
      if (!response.ok) throw new Error("snapshot HTTP " + response.status);
      const bytes = await response.arrayBuffer();
      const hashBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const fileHash = [...hashBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (fileHash !== demo.sourceFileSha256) throw new Error("recorded file hash mismatch");
      const full = JSON.parse(new TextDecoder().decode(bytes));
      if (full.content_hash !== demo.sourceSnapshotHash || full.captured_at !== demo.capturedAt || full.consistency_status !== "CONSISTENT") throw new Error("snapshot provenance mismatch");
      for (const market of demo.markets) {
        const dex = full.dexes?.[market.dexPosition];
        const token = full.spot_tokens?.find((item) => item.index === market.collateralToken);
        if (!dex || dex.name !== (market.dex === "native" ? "" : market.dex) ||
            dex.universe?.[market.index]?.name !== market.coin || dex.collateral_token !== market.collateralToken ||
            token?.name !== market.collateralName) throw new Error("recorded market excerpt mismatch");
      }
      text("integrityStatus", "VERIFIED · full file SHA-256 and market excerpt");
      integrityVerdict = true;
      return true;
    } catch (error) {
      integrityVerdict = false;
      text("integrityStatus", "FAILED · " + error.message);
      resultPanel.dataset.verdict = "UNKNOWN";
      text("verdict", "UNKNOWN");
      text("resultReason", "SNAPSHOT_INCONSISTENT");
      text("resultExplanation", "The full recorded source could not be verified. Treat this result as UNKNOWN.");
      text("evidenceNote", "Source verification failed; the displayed market cannot be trusted as a verified recorded snapshot.");
      text("demoStatus", "Source integrity failed · UNKNOWN.");
      $("demoStatus").classList.add("error");
      if (lastResult) lastResult = { ...lastResult, verdict: "UNKNOWN", reasonCode: "SNAPSHOT_INCONSISTENT", explanation: "Source integrity failed." };
      return false;
    }
  })();
  return integrityCheck;
}

function renderDrift(key) {
  const item = DRIFT[key];
  if (!item) return;
  const panel = $("driftPanel");
  panel.replaceChildren();
  const add = (tag, className, value, parent = panel) => {
    const node = document.createElement(tag); node.className = className; node.textContent = value; parent.append(node); return node;
  };
  add("span", "kind", item.code + " / " + item.field);
  add("h3", "", item.title);
  const values = add("div", "drift-values", "");
  const before = add("div", "", "", values); add("small", "", "BEFORE / SYNTHETIC", before); add("strong", "", item.before, before);
  add("span", "", "→", values);
  const after = add("div", "", "", values); add("small", "", "AFTER / SYNTHETIC", after); add("strong", "", item.after, after);
  add("p", "", item.explanation);
  for (const button of document.querySelectorAll(".drift-tab")) {
    const active = button.dataset.drift === key;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

runButton.addEventListener("click", run);
$("resetButton").addEventListener("click", () => reset());
marketSelect.addEventListener("change", () => { reset({ resetControls: false }); previewMarket(); });
document.querySelectorAll('input[name="case"]').forEach((input) => input.addEventListener("change", () => reset({ resetControls: false })));
$("evidenceButton").addEventListener("click", () => {
  evidence.hidden = !evidence.hidden;
  $("evidenceButton").setAttribute("aria-expanded", String(!evidence.hidden));
  if (!evidence.hidden) void verifyFullSnapshot();
});
$("copyResult").addEventListener("click", () => {
  if (!lastResult) return notice("Run the check first.", true);
  const market = currentMarket();
  copyText(JSON.stringify({ verdict: lastResult.verdict, reason_code: lastResult.reasonCode,
    market: market.coin, dex: market.dex, asset_id: lastResult.claimedAssetId ?? lastResult.expectedAssetId,
    expected_asset_id: lastResult.expectedAssetId, collateral_token: market.collateralToken,
    source_snapshot: demo.sourceSnapshotHash, captured_at: demo.capturedAt, data_kind: lastResult.kind }, null, 2), "Result");
});
$("copyVector").addEventListener("click", () => {
  if (!lastResult) return notice("Run the check first.", true);
  copyText(JSON.stringify(vectorExample(currentMarket()), null, 2), "Vector");
});
$("downloadVector").addEventListener("click", () => {
  if (!lastResult) return notice("Run the check first.", true);
  downloadJson(vectorExample(currentMarket()), "hlconform-" + currentMarket().coin.replace(/[^a-zA-Z0-9-]/g, "-") + "-vector.json");
});
document.querySelectorAll(".drift-tab").forEach((button) => button.addEventListener("click", () => renderDrift(button.dataset.drift)));
$("heroSourceButton")?.addEventListener("click", () => {
  $("developers").scrollIntoView({ behavior: "smooth" });
  $("sourceButton").focus({ preventScroll: true });
});
renderDrift("collateral");
runButton.disabled = true;
marketSelect.disabled = true;
$("copyVector").disabled = true;
$("downloadVector").disabled = true;
try {
  const response = await fetch("./data/demo.json", { cache: "no-store" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const data = await response.json();
  const problem = validateDemo(data);
  if (problem) throw new Error(problem);
  demo = data;
  const recordedAt = data.capturedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC");
  text("placeholderTime", recordedAt);
  text("sourcePreviewTime", recordedAt);
  marketSelect.replaceChildren();
  for (const [index, market] of data.markets.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = market.coin + " · " + market.collateralName;
    marketSelect.append(option);
  }
  previewMarket();
  runButton.disabled = false;
  marketSelect.disabled = false;
  text("demoStatus", "Ready · recorded " + data.network + " snapshot from " + data.capturedAt.slice(0, 10) + ".");
} catch (error) {
  $("demoStatus").classList.add("error");
  text("demoStatus", "Recorded demo data could not load. Start the local HTTP server and refresh. " + error.message);
  marketSelect.replaceChildren();
  const option = document.createElement("option"); option.textContent = "Data unavailable"; marketSelect.append(option);
}
