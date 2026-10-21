import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const product = fileURLToPath(new URL("../..", import.meta.url));
const site = join(product, "site");
const qa = join(product, "qa");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!existsSync(chromePath)) throw new Error("Installed Chrome unavailable");
mkdirSync(qa, { recursive: true });
const profile = mkdtempSync(join(product, ".chrome-qa-"));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const name = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const target = resolve(site, "." + name);
  if (!target.startsWith(resolve(site) + sep)) { res.writeHead(403).end(); return; }
  try {
    const bytes = readFileSync(target);
    const type = { ".html": "text/html", ".css": "text/css", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" }[extname(target)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" }).end(bytes);
  } catch { res.writeHead(404).end("Not found"); }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;
const baseUrl = process.env.HLCONFORM_QA_BASE_URL || "http://127.0.0.1:" + port + "/";
const browser = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--remote-debugging-port=0", "--user-data-dir=" + profile,
  "about:blank"
], { stdio: "ignore", windowsHide: true });
let socket;
let serial = 0;
const pending = new Map();
const errors = [];
function command(method, params = {}) {
  return new Promise((done, fail) => {
    const id = ++serial;
    pending.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); fail(new Error("CDP timeout: " + method)); } }, 12000);
  });
}
async function evaluate(expression) {
  const response = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error("Page exception: " + JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
async function until(expression, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await delay(120);
  }
  throw new Error("Page condition timed out: " + expression);
}
async function screenshot(filename) {
  const result = await command("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(qa, filename), Buffer.from(result.data, "base64"));
}
async function clickAt(id) {
  await evaluate(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({block:'center',behavior:'instant'})`);
  const rect = await evaluate(`document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().toJSON()`);
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
try {
  let endpoint;
  for (let i = 0; i < 100; i++) {
    const file = join(profile, "DevToolsActivePort");
    if (existsSync(file)) {
      const [debugPort] = readFileSync(file, "utf8").trim().split("\n");
      const targets = await (await fetch("http://127.0.0.1:" + debugPort + "/json/list")).json();
      endpoint = targets.find((x) => x.type === "page")?.webSocketDebuggerUrl;
      if (endpoint) break;
    }
    if (browser.exitCode !== null) throw new Error("Chrome exited before DevTools connected");
    await delay(100);
  }
  if (!endpoint) throw new Error("Chrome DevTools endpoint unavailable");
  socket = new WebSocket(endpoint);
  await new Promise((ok, fail) => { socket.addEventListener("open", ok, { once: true }); socket.addEventListener("error", fail, { once: true }); });
  socket.addEventListener("message", (event) => {
    const packet = JSON.parse(event.data);
    if (packet.id && pending.has(packet.id)) {
      const p = pending.get(packet.id); pending.delete(packet.id);
      packet.error ? p.fail(new Error(packet.error.message)) : p.done(packet.result || {});
    } else if (packet.method === "Runtime.exceptionThrown") errors.push(packet.params.exceptionDetails.text);
    else if (packet.method === "Runtime.consoleAPICalled" && packet.params.type === "error") errors.push("console.error");
  });
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: qa });
  await command("Page.setDownloadBehavior", { behavior: "allow", downloadPath: qa });
  await command("Page.navigate", { url: baseUrl });
  await until("document.readyState === 'complete' && !document.getElementById('runButton').disabled");
  if (!(await evaluate("document.querySelector('.terrain-art').complete && document.querySelector('.terrain-art').naturalWidth > 0 && document.querySelector('.ecosystem-brand img').naturalWidth > 0"))) throw new Error("Visual assets failed to load");
  const initial = await evaluate("({title:document.title,button:document.getElementById('runButton').getBoundingClientRect().toJSON(),options:document.getElementById('marketSelect').options.length,width:document.documentElement.scrollWidth})");
  if (initial.options !== 4 || initial.button.bottom > 900 || initial.width > 1440) throw new Error("Desktop first-view failure: " + JSON.stringify(initial));
  await screenshot("desktop_initial.png");
  await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  if (!(await evaluate("window.matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.documentElement).scrollBehavior === 'auto'"))) throw new Error("Reduced-motion preference was not respected");
  await command("Emulation.setEmulatedMedia", { features: [] });
  await evaluate("document.getElementById('runButton').click()");
  await until("!document.getElementById('result').hidden && document.getElementById('verdict').textContent === 'VALID'");
  const valid = await evaluate("({verdict:verdict.textContent,asset:resultAsset.textContent,kind:dataKind.textContent,reason:resultReason.textContent})");
  if (valid.asset !== "110000" || valid.kind !== "RECORDED SNAPSHOT") throw new Error("Recorded check incorrect: " + JSON.stringify(valid));
  await evaluate("document.getElementById('evidenceButton').click()");
  if (!(await evaluate("!document.getElementById('evidence').hidden"))) throw new Error("Evidence did not open");
  await until("document.getElementById('integrityStatus').textContent.startsWith('VERIFIED')");
  await delay(450);
  await screenshot("desktop_result.png");
  await command("Browser.grantPermissions", { origin: new URL(baseUrl).origin, permissions: ["clipboardReadWrite"] });
  await clickAt("copyResult");
  await until("document.getElementById('toast').textContent.includes('Result copied')");
  const copiedResult = await evaluate("navigator.clipboard.readText()");
  if (JSON.parse(copiedResult).asset_id !== 110000) throw new Error("Copied result does not contain the expected asset ID");
  await clickAt("copyVector");
  await until("document.getElementById('toast').textContent.includes('Vector copied')");
  const copiedVector = await evaluate("navigator.clipboard.readText()");
  if (JSON.parse(copiedVector).expected.asset_id !== 110000) throw new Error("Copied vector is incorrect");
  await screenshot("desktop_developers.png");
  await evaluate("document.querySelector('input[name=\"case\"][value=\"invalid\"]').click();document.getElementById('runButton').click()");
  await until("document.getElementById('verdict').textContent === 'INVALID'");
  const invalid = await evaluate("({reason:resultReason.textContent,kind:dataKind.textContent})");
  if (invalid.reason !== "ASSET_ID_MISMATCH" || invalid.kind !== "SYNTHETIC TEST CASE") throw new Error("Invalid case incorrect");
  await evaluate("document.querySelector('input[name=\"case\"][value=\"unknown\"]').click();document.getElementById('runButton').click()");
  await until("document.getElementById('verdict').textContent === 'UNKNOWN'");
  if (await evaluate("document.getElementById('resultReason').textContent") !== "SNAPSHOT_STALE") throw new Error("Unknown case incorrect");
  await evaluate("document.getElementById('resetButton').click()");
  if (await evaluate("!document.getElementById('result').hidden")) throw new Error("Reset failed");
  await evaluate("document.getElementById('marketSelect').value='1';document.getElementById('marketSelect').dispatchEvent(new Event('change'));document.getElementById('runButton').click()");
  await until("document.getElementById('resultAsset').textContent === '120000'");
  if (await evaluate("document.getElementById('resultCollateral').textContent") !== "USDH · token 360") throw new Error("Market switch did not update collateral");
  await evaluate("document.getElementById('resetButton').click()");
  await evaluate("document.querySelector('[data-drift=\"schema\"]').click()");
  if (!(await evaluate("document.getElementById('driftPanel').textContent.includes('SCHEMA_CHANGED')"))) throw new Error("Drift tab failed");
  await evaluate("document.getElementById('toast').hidden=true");
  await evaluate("document.getElementById('driftPanel').scrollIntoView({block:'center',behavior:'instant'})");
  await screenshot("desktop_drift.png");
  if (!(await evaluate("document.getElementById('sourceButton').href === 'https://github.com/chapaevv123/hlconform' && document.getElementById('githubLink').href === 'https://github.com/chapaevv123/hlconform'"))) throw new Error("GitHub links incorrect");
  if (!(await evaluate("[...document.querySelectorAll('nav a[href^=\"#\"]')].every(a=>document.querySelector(a.getAttribute('href')))"))) throw new Error("Broken internal navigation");
  await evaluate("document.getElementById('runButton').focus()");
  await until("document.activeElement?.id === 'runButton'");
  await command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await command("Input.dispatchKeyEvent", { type: "char", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13 });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await until("!document.getElementById('result').hidden && !document.getElementById('downloadVector').disabled && document.getElementById('verdict').textContent === 'VALID'");
  await clickAt("downloadVector");
  const { readdirSync } = await import("node:fs");
  let downloads = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    downloads = readdirSync(qa).filter((name) => name.endsWith("-vector.json"));
    if (downloads.length) break;
    await delay(150);
  }
  if (!downloads.length) throw new Error("Vector download not found: " + JSON.stringify({status:await evaluate("({disabled:downloadVector.disabled,toast:toast.textContent,href:location.href})"),files:readdirSync(qa)}));
  const downloaded = JSON.parse(readFileSync(join(qa, downloads[0]), "utf8"));
  if (downloaded.expected.asset_id !== 110000) throw new Error("Downloaded vector incorrect");
  await command("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: baseUrl });
  await until("document.readyState === 'complete' && !document.getElementById('runButton').disabled");
  const wide = await evaluate("({width:document.documentElement.scrollWidth,viewport:window.innerWidth,button:document.getElementById('runButton').getBoundingClientRect().toJSON()})");
  if (wide.width > wide.viewport || wide.button.bottom > 1080) throw new Error("1920px desktop failure: " + JSON.stringify(wide));
  await screenshot("desktop_1920.png");
  await command("Emulation.setDeviceMetricsOverride", { width: 820, height: 1180, deviceScaleFactor: 1, mobile: true });
  await command("Page.navigate", { url: baseUrl });
  await until("document.readyState === 'complete' && !document.getElementById('runButton').disabled");
  const tablet = await evaluate("({width:document.documentElement.scrollWidth,viewport:window.innerWidth,button:document.getElementById('runButton').getBoundingClientRect().toJSON()})");
  if (tablet.width > tablet.viewport) throw new Error("Tablet horizontal overflow: " + JSON.stringify(tablet));
  await screenshot("tablet_initial.png");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await command("Page.navigate", { url: baseUrl });
  await until("document.readyState === 'complete' && !document.getElementById('runButton').disabled");
  const mobile = await evaluate("({width:document.documentElement.scrollWidth,viewport:window.innerWidth,button:document.getElementById('runButton').getBoundingClientRect().toJSON()})");
  if (mobile.width > mobile.viewport || mobile.button.bottom > 844) throw new Error("Mobile first-view failure: " + JSON.stringify(mobile));
  await screenshot("mobile_initial.png");
  await evaluate("document.getElementById('runButton').click()");
  await until("document.getElementById('verdict').textContent === 'VALID'");
  await delay(450);
  await screenshot("mobile_result.png");
  const report = { base_url: baseUrl, desktop: initial, desktop_1920: wide, recorded: valid, synthetic_invalid: invalid, tablet, mobile,
    checks: ["1440px desktop first-screen CTA", "visual assets loaded", "reduced motion", "recorded VALID", "evidence drawer and full snapshot SHA verification", "copy result and read clipboard", "copy vector and read clipboard", "synthetic INVALID", "synthetic UNKNOWN", "reset", "market switch with USDH collateral", "synthetic schema drift tab", "real GitHub links", "internal navigation targets", "keyboard Enter activates check", "vector download JSON", "1920px desktop first-screen CTA", "tablet no horizontal overflow", "mobile first-screen CTA", "mobile recorded VALID", "no horizontal overflow"],
    downloaded_vector: downloads[0], console_errors: errors, screenshots: ["desktop_initial.png", "desktop_result.png", "desktop_developers.png", "desktop_drift.png", "desktop_1920.png", "tablet_initial.png", "mobile_initial.png", "mobile_result.png"] };
  const reportName = process.env.HLCONFORM_QA_BASE_URL ? "public_browser_qa.json" : "browser_qa.json";
  writeFileSync(join(qa, reportName), JSON.stringify(report, null, 2));
  if (errors.length) throw new Error("Browser console errors: " + errors.join(", "));
  console.log(JSON.stringify({ pass: true, report: join(qa, reportName), screenshots: report.screenshots }));
} finally {
  if (socket) socket.close();
  browser.kill();
  server.close();
  const resolvedProfile = realpathSync(profile);
  if (!resolvedProfile.startsWith(realpathSync(product) + sep) || !basename(resolvedProfile).startsWith(".chrome-qa-")) throw new Error("Refusing to remove unexpected Chrome test profile");
  for (let i = 0; i < 10; i++) {
    try { rmSync(resolvedProfile, { recursive: true, force: true }); break; }
    catch { await delay(250); }
  }
}
