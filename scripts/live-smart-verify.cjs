/**
 * ONE live Smart-mode verification against the running server (small tehsil).
 *   SESSION_SECRET=<.env.local value> node scripts/live-smart-verify.cjs
 * Direct API calls (no browser flakiness): scenes → estimate → analyze with
 * confirm, streaming the NDJSON progress. Prints the screening resolution,
 * blocks and final stats — asserts the run completed without the old
 * 400 COMMON_BAD_PAYLOAD failure.
 */
const { SignJWT } = require("jose");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SECRET = process.env.SESSION_SECRET;
const COOKIE = "rse_session";
const AREA_ID = process.env.SMART_AREA || "t-jalor-ahore";
const LEVEL = "tehsil";

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

async function forge(role, sub, name) {
  const key = new TextEncoder().encode(SECRET);
  return new SignJWT({ role, sub, name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(key);
}

async function post(path, body, timeoutMs) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: BASE,
      Cookie: `${COOKIE}=${globalThis.__token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

(async () => {
  if (!SECRET) {
    console.error("SESSION_SECRET is required.");
    process.exit(2);
  }
  globalThis.__token = await forge("sso", "live-smart", "Live Smart");
  const failures = [];

  // 1. Two scene dates over the tehsil (free catalogue search).
  const fromDate = process.env.SMART_FROM || "2026-01-01";
  const toDate = process.env.SMART_TO || "2026-03-31";
  const scenesResp = await post("/api/scenes", {
    tehsilId: AREA_ID,
    fromDate,
    toDate,
    maxCloudCover: 60,
    composite: "true-color",
  }, 60_000);
  if (!scenesResp.ok) {
    console.error(`scenes search failed: ${scenesResp.status}`);
    process.exit(2);
  }
  const scenes = (await scenesResp.json()).scenes ?? [];
  if (scenes.length < 2) {
    console.error(`only ${scenes.length} scenes over ${AREA_ID} in range`);
    process.exit(2);
  }
  const dateA = scenes[0].date;
  const dateB = scenes[scenes.length - 1].date;
  log(`scenes: ${scenes.length}; pair ${dateA} -> ${dateB}`);

  // 2. Estimate (runs/joins the ~screening pass, cached for the run).
  log("estimate (screening)…");
  const estStart = Date.now();
  const estResp = await post("/api/compare/detail/estimate", {
    areaId: AREA_ID,
    level: LEVEL,
    dateA,
    dateB,
    detail: "smart",
  }, 15 * 60_000);
  if (!estResp.ok) {
    const text = await estResp.text().catch(() => "");
    failures.push(`estimate failed: ${estResp.status} ${text.slice(0, 300)}`);
  } else {
    const estimate = await estResp.json();
    log(
      `estimate: ${estimate.blocksSelected}/${estimate.blocksTotal} blocks, ` +
        `${estimate.estimatedPu} PU (screening ${estimate.screeningPu}), ` +
        `screening ~${estimate.screeningMeters} m — took ${Math.round((Date.now() - estStart) / 1000)}s`,
    );
    if (estimate.screeningMeters == null) failures.push("estimate has no screeningMeters");
  }

  // 3. The ONE confirmed Smart run, streaming progress.
  log("analyze (detail=smart, confirm)…");
  const runResp = await post("/api/compare/analyze", {
    areaId: AREA_ID,
    level: LEVEL,
    dateA,
    dateB,
    detail: "smart",
    confirm: true,
  }, 15 * 60_000);
  if (!runResp.ok || !(runResp.headers.get("content-type") ?? "").includes("ndjson")) {
    const text = await runResp.text().catch(() => "");
    failures.push(`analyze failed: ${runResp.status} ${text.slice(0, 300)}`);
  } else {
    const reader = runResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result = null;
    let errorFrame = null;
    const blockFrames = [];
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
          if (frame.type === "stage" && frame.stage === "block") {
            blockFrames.push(`${frame.index}/${frame.total}`);
          } else if (frame.type === "stage") {
            log(`stage: ${frame.stage}`);
          } else if (frame.type === "error") {
            errorFrame = frame;
          } else if (frame.type === "result") {
            result = frame;
          }
        }
        nl = buffer.indexOf("\n");
      }
    }
    if (blockFrames.length > 0) {
      log(`blocks streamed: ${blockFrames.length} (${blockFrames[0]} … ${blockFrames[blockFrames.length - 1]})`);
    }
    if (errorFrame) {
      failures.push(`error frame: ${errorFrame.code} ${errorFrame.message}`);
    }
    if (!result) {
      failures.push("stream ended without a result frame");
    } else {
      const stats = result.stats;
      const meta = stats.metadata;
      log(
        `result: mode=${result.detail?.mode} blocks=${result.detail?.blocks}/${result.detail?.blocksTotal} ` +
          `res=${Math.round(meta.metersPerPixel)} m changed=${stats.changedHa?.toFixed?.(2) ?? stats.changedHa} ha ` +
          `events=${stats.eventsTotal} tiles=${result.detail ? "yes" : "no"}`,
      );
      if (result.detail?.mode !== "smart") failures.push("result is not smart mode");
      if (meta.detail !== "smart") failures.push("metadata.detail missing");
      if (result.detail?.tiles == null) failures.push("no tile template on the result");
      // The 2500-px guard: the run must never have failed with the old
      // COMMON_BAD_PAYLOAD — reaching a result frame is the assertion.
      log("stream completed — no COMMON_BAD_PAYLOAD");
    }
  }

  if (failures.length > 0) {
    log("FAILURES:");
    failures.forEach((f) => log(`  - ${f}`));
    process.exit(1);
  }
  log("LIVE SMART RUN PASSED");
})().catch((error) => {
  console.error("LIVE SMART VERIFY CRASH:", error);
  process.exit(2);
});
