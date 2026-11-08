/**
 * AI-summary end-to-end repro harness (untracked).
 *
 * Analyzes Bassi (tehsil) 10→25 Oct 2026, then exercises
 * GET /api/health/gemini and POST /api/compare/summary with
 * {en,hi} x {images on,off}, logging status/code/message/detail/model.
 *
 * Usage: node scripts/repro-summary.api.cjs
 * Env: BASE_URL (default http://localhost:3000)
 */
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = path.join("artifacts", "summary");
const KEY_FILE = path.join(OUT_DIR, "repro-key.json");

const BODY = {
  areaId: "t-jaipur-bassi",
  level: "tehsil",
  dateA: "2026-10-10",
  dateB: "2026-10-25",
  sensitivity: "medium",
  minPatchHa: 0.2,
  inputMode: "composite",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function analyze() {
  const t0 = Date.now();
  const response = await fetch(`${BASE}/api/compare/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(BODY),
  });
  console.log(`analyze: HTTP ${response.status}`);
  if (!response.ok || !(response.headers.get("content-type") || "").includes("ndjson")) {
    console.log(`analyze body: ${(await response.text()).slice(0, 500)}`);
    process.exit(1);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        const frame = JSON.parse(line);
        if (frame.type === "stage") console.log(`  stage: ${frame.stage}`);
        if (frame.type === "error") {
          console.log(`  error: ${JSON.stringify(frame)}`);
          process.exit(1);
        }
        if (frame.type === "result") result = frame;
      }
      nl = buffer.indexOf("\n");
    }
  }
  if (!result) {
    console.log(`analyze: no result after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(1);
  }
  console.log(
    `analyze ok in ${((Date.now() - t0) / 1000).toFixed(1)}s: key=${result.key} changedHa=${result.stats.changedHa} ` +
      `gap=${result.stats.metadata.gapDays}d scenes=${result.stats.metadata.sceneA?.satellite}/${result.stats.metadata.sceneB?.satellite}`,
  );
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify({ ...BODY, key: result.key }, null, 2));
  return result;
}

async function health() {
  const t0 = Date.now();
  const response = await fetch(`${BASE}/api/health/gemini`);
  const text = await response.text();
  console.log(`health/gemini: HTTP ${response.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${text.slice(0, 300)}`);
}

async function summary(key, language, includeImages) {
  const t0 = Date.now();
  let response = await fetch(`${BASE}/api/compare/summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ analysisKey: key, language, includeImages, ...BODY }),
  });
  if (response.status === 429) {
    console.log(`  rate limited by our own guard — waiting 65s`);
    await sleep(65_000);
    response = await fetch(`${BASE}/api/compare/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisKey: key, language, includeImages, ...BODY }),
    });
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* raw */
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!response.ok) {
    console.log(
      `summary(${language}, images=${includeImages}): HTTP ${response.status} in ${secs}s — ` +
        `code=${parsed?.code} msg=${JSON.stringify(parsed?.message)} detail=${JSON.stringify(parsed?.detail)}`,
    );
    return;
  }
  const s = parsed.summary;
  const devanagari = /[\u0900-\u097F]/.test(s.overview);
  console.log(
    `summary(${language}, images=${includeImages}): HTTP 200 in ${secs}s — model=${parsed.model} ` +
      `cached=${parsed.cached} imageCount=${parsed.imageCount} imagesFallback=${parsed.imagesFallback} ` +
      `devanagari=${devanagari}`,
  );
  console.log(`  overview: ${s.overview.replace(/\s+/g, " ").slice(0, 180)}`);
  console.log(`  visualObservations: ${JSON.stringify(s.visualObservations).slice(0, 220)}`);
}

(async () => {
  let key;
  if (process.env.SKIP_ANALYZE && fs.existsSync(KEY_FILE)) {
    key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8")).key;
    console.log(`reusing key ${key}`);
  } else {
    key = (await analyze()).key;
  }
  await health();
  await summary(key, "en", true);
  await sleep(20_000);
  await summary(key, "en", false);
  await sleep(20_000);
  await summary(key, "hi", true);
  await sleep(20_000);
  await summary(key, "hi", false);
  console.log("done");
})().catch((e) => {
  console.error("REPRO_FAIL:", e);
  process.exit(2);
});
