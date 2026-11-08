/**
 * Events-tab expiry repro harness (untracked, API level).
 *
 * Phase A (server running): analyze Bassi 10 Oct vs 25 Oct 2026, then fetch
 * /api/compare/events and /api/compare/overlay for the returned key; logs
 * status + bodies and saves the key to artifacts/events/repro-key.json.
 * Phase B (after a dev-server restart): re-fetch the same endpoints and log
 * the expired responses (expected: 404 EVENTS_NOT_FOUND / OVERLAY_NOT_FOUND).
 *
 * Usage: node scripts/repro-events.api.cjs [a|b]
 * Env: BASE_URL (default http://localhost:3000)
 */
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = path.join("artifacts", "events");
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

function log(line) {
  console.log(line);
}

async function analyze() {
  const t0 = Date.now();
  const response = await fetch(`${BASE}/api/compare/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(BODY),
  });
  log(`analyze: HTTP ${response.status} ${response.headers.get("content-type")}`);
  if (!response.ok || !(response.headers.get("content-type") || "").includes("ndjson")) {
    log(`analyze body: ${(await response.text()).slice(0, 500)}`);
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
        if (frame.type === "stage") log(`  stage: ${frame.stage}`);
        if (frame.type === "error") {
          log(`  error: ${JSON.stringify(frame)}`);
          process.exit(1);
        }
        if (frame.type === "result") result = frame;
      }
      nl = buffer.indexOf("\n");
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!result) {
    log(`analyze: no result after ${secs}s`);
    process.exit(1);
  }
  log(
    `analyze result in ${secs}s: key=${result.key} hotspots=${result.stats.hotspots.length} ` +
      `negligible=${result.stats.negligible} changedHa=${result.stats.changedHa} ` +
      `hasEventsField=${"events" in result} overlayUrl=${result.overlayUrl}`,
  );
  const saved = { ...BODY, key: result.key, overlayUrl: result.overlayUrl, hotspots: result.stats.hotspots.length };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify(saved, null, 2));
  return saved;
}

async function fetchJson(label, url) {
  const t0 = Date.now();
  const response = await fetch(url);
  const text = await response.text();
  let body = text;
  try {
    const parsed = JSON.parse(text);
    body = JSON.stringify({
      code: parsed.code,
      message: parsed.message,
      total: parsed.total,
      key: parsed.key,
      eventCount: Array.isArray(parsed.events) ? parsed.events.length : undefined,
      firstId: Array.isArray(parsed.events) && parsed.events[0] ? parsed.events[0].id : undefined,
    });
  } catch {
    body = text.slice(0, 200);
  }
  log(`${label}: HTTP ${response.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${body}`);
  return response.status;
}

async function phaseA() {
  const saved = await analyze();
  await fetchJson("events ", `${BASE}/api/compare/events?key=${saved.key}&limit=100&offset=0`);
  await fetchJson("overlay", `${BASE}/api/compare/overlay?key=${saved.key}&format=png`);
  await fetchJson("summary", `${BASE}/api/compare/summary`);
}

async function phaseB() {
  if (!fs.existsSync(KEY_FILE)) {
    log("no saved key — run phase a first");
    process.exit(1);
  }
  const saved = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  log(`saved key from earlier run: ${saved.key} (hotspots shown on map: ${saved.hotspots})`);

  // Checked FIRST, while the cache is still cold after the restart.
  // 1. Legacy contract: key-only (no params) → 404 ANALYSIS_EXPIRED.
  const keyOnly = await fetchJson("events key-only", `${BASE}/api/compare/events?key=${saved.key}&limit=100&offset=0`);

  // 2. Tamper guard: params deriving a different key → 400, never a wrong merge.
  const qs = new URLSearchParams({
    areaId: saved.areaId,
    level: saved.level,
    dateA: saved.dateA,
    dateB: saved.dateB,
    sensitivity: saved.sensitivity,
    minPatchHa: String(saved.minPatchHa),
    inputMode: saved.inputMode,
    key: saved.key,
  });
  const tampered = new URLSearchParams(qs);
  tampered.set("minPatchHa", "0.5");
  const tamperedStatus = await fetchJson(
    "events tampered",
    `${BASE}/api/compare/events?${tampered}&limit=100&offset=0`,
  );

  // 3. THE FIX: parameters present → stateless recompute on the cold cache.
  const evOk = await fetchJson("events+params ", `${BASE}/api/compare/events?${qs}&limit=100&offset=0`);
  const ovOk = await fetchJson("overlay+params", `${BASE}/api/compare/overlay?${qs}&format=png`);
  const response = await fetch(`${BASE}/api/compare/summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      analysisKey: saved.key,
      language: "en",
      includeImages: false,
      areaId: saved.areaId,
      level: saved.level,
      dateA: saved.dateA,
      dateB: saved.dateB,
      sensitivity: saved.sensitivity,
      minPatchHa: saved.minPatchHa,
      inputMode: saved.inputMode,
    }),
  });
  const summaryStatus = response.status;
  const summaryBody = (await response.text()).slice(0, 200);
  log(`summary+params : HTTP ${summaryStatus} — ${summaryBody}`);
  // No GEMINI_API_KEY → the route answers 503 AI_DISABLED before any lookup;
  // that's environment config, not a recompute failure.
  const summaryOk = summaryStatus === 200 || (summaryStatus === 503 && summaryBody.includes("AI_DISABLED"));

  const ok = keyOnly === 404 && tamperedStatus === 400 && evOk === 200 && ovOk === 200 && summaryOk;
  log(
    ok
      ? "PHASE B PASS: legacy 404 kept, tamper rejected, cold cache recomputed statelessly (200s)"
      : `PHASE B FAIL (keyOnly=${keyOnly} tampered=${tamperedStatus} events=${evOk} overlay=${ovOk} summary=${summaryStatus})`,
  );
  process.exit(ok ? 0 : 1);
}

const phase = (process.argv[2] || "a").toLowerCase();
if (phase === "a") void phaseA();
else void phaseB();
