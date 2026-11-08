/**
 * Events-tab expiry repro harness (untracked, browser).
 *
 * Reproduces the reported bug: markers show on the map but the Events tab
 * says "Change events - 0 patches" + "This comparison result has expired."
 *
 *   Phase A: search Bassi tehsil, arm compare, pick 10 Oct + 25 Oct 2026,
 *            analyze, wait for the drawer + numbered .hs-marker overlays
 *            (the Events tab is deliberately NOT opened yet), then wait for
 *            artifacts/events/restart-done.txt.
 *   Phase B (after the dev/prod server was restarted with the file present):
 *            open the Events tab → the fetch misses the (now empty) server
 *            cache → dump header text, list rows, error banner, markers.
 *
 * Usage: node scripts/repro-events.browser.cjs
 * Env:   BASE_URL (default http://localhost:3000), OUT_DIR, CHROME_PATH
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = process.env.OUT_DIR || path.join("artifacts", "events");
const SIGNAL = path.join(OUT_DIR, "restart-done.txt");

function log(line) {
  console.log(line);
}

async function shoot(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  log(`SHOT ${name} -> ${file}`);
}

/** List header, rows, error banner, markers — the reported-symptom fields. */
async function dumpEventsState(page) {
  return page.evaluate(() => {
    const drawer = document.querySelector('[aria-label="Change detection results"]');
    const text = drawer ? drawer.textContent || "" : "";
    const headerMatch = text.match(/Change events[^]*?largest first|Change events —[^]*?Click one/);
    const bannerExpired = text.includes("expired") || text.includes("no longer cached");
    const rows = drawer ? drawer.querySelectorAll("ol li").length : 0;
    const loading = text.includes("Loading events");
    const markers = document.querySelectorAll(".hs-marker").length;
    const markerLabels = Array.from(document.querySelectorAll(".hs-marker")).map(
      (el) => el.getAttribute("aria-label") || el.textContent,
    );
    return {
      header: headerMatch ? headerMatch[0].replace(/\s+/g, " ").trim() : null,
      headerLine: (() => {
        const p = drawer && drawer.querySelector("p");
        return p ? (p.textContent || "").replace(/\s+/g, " ").trim() : null;
      })(),
      rows,
      loading,
      bannerExpired,
      expiredText: bannerExpired
        ? (text.match(/[^]*?(expired|no longer cached)[^]*?analysis again[^]*?/i) || [""])[0]
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300)
        : null,
      markers,
      markerLabels: markerLabels.slice(0, 12),
    };
  });
}

async function waitForSignal() {
  const started = Date.now();
  for (;;) {
    if (fs.existsSync(SIGNAL)) {
      log(`signal found after ${((Date.now() - started) / 1000).toFixed(0)}s`);
      fs.unlinkSync(SIGNAL);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const t = msg.text().slice(0, 300);
      consoleErrors.push(t);
      log(`CONSOLE ERROR: ${t}`);
    }
  });
  page.on("pageerror", (err) => consoleErrors.push(`PAGEERROR ${String(err).slice(0, 300)}`));

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 60000 });
    await page.waitForTimeout(5000);

    // 1. search Bassi tehsil (district Jaipur first)
    log("searching tehsil: Jaipur / Bassi");
    await page.selectOption("#filter-district", { label: "Jaipur" });
    await page.waitForSelector("#filter-tehsil", { timeout: 30000 });
    await page.selectOption("#filter-tehsil", { label: "Bassi" });
    const scenesPromise = page.waitForResponse(
      (r) => r.url().includes("/api/scenes") && r.request().method() === "POST",
      { timeout: 120000 },
    );
    await page.getByRole("button", { name: /search imagery/i }).click();
    const scenesResp = await scenesPromise;
    log(`scenes: ${scenesResp.status()}`);
    await page.waitForTimeout(2500);

    // 2. arm compare + expand scene cards
    await page.click('button[title="Compare two dates for this area"]');
    await page.waitForTimeout(500);
    const expandBtn = await page.$('button[aria-label="Show scene cards"]');
    if (expandBtn) await expandBtn.click();
    await page.waitForSelector('button[aria-label^="Date A: "]', { timeout: 30000 });
    const dates = await page.$$eval('button[aria-label^="Date A: "]', (els) =>
      els.map((el) => el.getAttribute("aria-label").replace("Date A: ", "")),
    );
    log(`scene dates (${dates.length}): ${dates.join(", ")}`);
    const wantA = "2026-10-10";
    const wantB = "2026-10-25";
    if (!dates.includes(wantA) || !dates.includes(wantB)) throw new Error("needed scenes not in strip");
    await page.click(`button[aria-label="Date A: ${wantA}"]`);
    await page.click(`button[aria-label="Date B: ${wantB}"]`);
    await page.waitForTimeout(400);

    // 3. analyze
    const analyzePromise = page.waitForResponse(
      (r) => r.url().includes("/api/compare/analyze") && r.request().method() === "POST",
      { timeout: 300000 },
    );
    await page.locator('button:has-text("Analyze")').first().click();
    const resp = await analyzePromise;
    log(`analyze: ${resp.status()} (stream continues)`);
    await page.waitForSelector('[aria-label="Change detection results"]', { timeout: 300000 });
    await page.waitForTimeout(5000);

    // 4. wait for numbered markers (change-map tab = default after run)
    await page.waitForSelector(".hs-marker", { timeout: 60000 });
    const markerCount = await page.$$eval(".hs-marker", (els) => els.length);
    log(`markers after analyze: ${markerCount} (Events tab NOT opened yet)`);
    await shoot(page, "phase-a-markers");

    // 5. wait for the external server restart signal
    log("waiting for restart signal file…");
    await waitForSignal();
    await page.waitForTimeout(2000);

    // 6. phase B: open the Events tab — fetch misses the cold cache
    log("opening Events tab…");
    const eventsFetch = page.waitForResponse(
      (r) => r.url().includes("/api/compare/events"),
      { timeout: 120000 },
    ).catch(() => null);
    await page.click('button[role="tab"][aria-label="Events"]');
    const evResp = await eventsFetch;
    if (evResp) log(`events fetch: HTTP ${evResp.status()}`);
    await page.waitForTimeout(3000);
    const dump = await dumpEventsState(page);
    log(`\n=== EVENTS STATE AFTER CACHE CLEAR ===\n${JSON.stringify(dump, null, 2)}`);
    await shoot(page, "phase-b-expired");
    log(`console/page errors: ${consoleErrors.length}`);
    consoleErrors.slice(0, 10).forEach((e) => log(`  ${e}`));

    // 7. sanity: overlay route also cold
    if (evResp) {
      const key = (evResp.url().match(/key=([a-f0-9]{64})/) || [])[1];
      if (key) {
        const overlay = await page.evaluate(async (k) => {
          const r = await fetch(`/api/compare/overlay?key=${k}&format=png`);
          return `${r.status}`;
        }, key);
        log(`overlay after cache clear: HTTP ${overlay}`);
      }
    }
    log("REPRO DONE");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((error) => {
  console.error("REPRO EVENTS CRASH:", error);
  process.exit(2);
});
