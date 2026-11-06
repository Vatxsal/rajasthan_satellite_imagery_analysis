/**
 * Phase 2 deep-link browser smoke (untracked, like its sibling harnesses).
 *
 *   Phase 1: open a share URL WITHOUT `e=` → the report link must resolve
 *            the Bassi tehsil, set the date pair from the link, run the
 *            analysis, land on the Events tab, and show the
 *            "Opened from an emailed report" banner.
 *   Phase 2: re-open WITH `e=<id>` taken from the phase-1 result frame →
 *            same analysis + the top event's map popup focused.
 *
 * Usage: node scripts/verify-sharelink.browser.cjs
 * Env:   BASE_URL (default http://localhost:3000), OUT_DIR, CHROME_PATH
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = process.env.OUT_DIR || path.join("artifacts", "share-link");

const AREA = "t-jaipur-bassi";
const LEVEL = "tehsil";
const DATE_A = "2026-10-10";
const DATE_B = "2026-10-25";

function log(line) {
  console.log(line);
}

async function shoot(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  log(`SHOT ${name} -> ${file}`);
}

function shareUrl(eventId) {
  const params = new URLSearchParams({
    a: AREA,
    l: LEVEL,
    A: DATE_A,
    B: DATE_B,
    s: "medium",
    m: "0.2",
    im: "composite",
    tab: "events",
  });
  if (eventId) params.set("e", eventId);
  return `${BASE}/?${params.toString()}`;
}

async function dumpDrawerState(page) {
  return page.evaluate(() => {
    const drawer = document.querySelector('[aria-label="Change detection results"]');
    const text = drawer ? drawer.textContent || "" : "";
    const eventsTab = document.querySelector('button[role="tab"][aria-label="Events"]');
    const district = document.querySelector("#filter-district");
    const tehsil = document.querySelector("#filter-tehsil");
    const headerLine = (() => {
      const p = drawer && drawer.querySelector("p");
      return p ? (p.textContent || "").replace(/\s+/g, " ").trim() : null;
    })();
    const dateLine = (() => {
      const ps = drawer ? drawer.querySelectorAll("header p") : [];
      return ps.length > 1 ? (ps[ps.length - 1].textContent || "").trim() : null;
    })();
    return {
      drawerPresent: Boolean(drawer),
      banner: text.includes("Opened from an emailed report"),
      eventsTabSelected: eventsTab ? eventsTab.getAttribute("aria-selected") : null,
      rows: drawer ? drawer.querySelectorAll("ol li").length : 0,
      markers: document.querySelectorAll(".hs-marker").length,
      district: district && district.selectedOptions[0] ? district.selectedOptions[0].textContent : null,
      tehsil: tehsil && tehsil.selectedOptions[0] ? tehsil.selectedOptions[0].textContent : null,
      headerLine,
      dateLine,
    };
  });
}

function eventIdFromStream(body) {
  const frames = body
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const result = frames.find((frame) => frame.type === "result");
  if (!result) {
    const err = frames.find((frame) => frame.type === "error");
    throw new Error(`no result frame in analyze stream (error frame: ${JSON.stringify(err)})`);
  }
  const feature = Array.isArray(result.events) ? result.events[0] : null;
  if (!feature) throw new Error("result frame has no events");
  const id = feature.id || (feature.properties && feature.properties.id);
  if (!id) throw new Error("top event has no id");
  return String(id);
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
    // ── Phase 1: report link without an event id ──────────────────────────
    log(`phase 1: ${shareUrl(null)}`);
    const analyze1 = page.waitForResponse(
      (r) => r.url().includes("/api/compare/analyze") && r.request().method() === "POST",
      { timeout: 300000 },
    );
    await page.goto(shareUrl(null), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 60000 });
    const resp1 = await analyze1;
    log(`phase 1 analyze: HTTP ${resp1.status()}`);
    await page.waitForSelector('[aria-label="Change detection results"]', { timeout: 300000 });
    await page.waitForSelector(".hs-marker", { timeout: 60000 });
    await page.waitForTimeout(3000);

    const phase1 = await dumpDrawerState(page);
    log(`\n=== PHASE 1 ===\n${JSON.stringify(phase1, null, 2)}`);
    await shoot(page, "phase1-events-tab");
    if (!phase1.banner) throw new Error("phase 1: share banner missing");
    if (phase1.eventsTabSelected !== "true") throw new Error("phase 1: Events tab not active");
    if (phase1.rows < 1) throw new Error("phase 1: no event rows");
    if (phase1.markers < 1) throw new Error("phase 1: no map markers");
    if ((phase1.tehsil || "").trim() !== "Bassi") throw new Error(`phase 1: tehsil not Bassi (${phase1.tehsil})`);

    const eventId = eventIdFromStream(await resp1.text());
    log(`phase 1 top event id: ${eventId}`);

    // ── Phase 2: same link + focused event ────────────────────────────────
    log(`phase 2: ${shareUrl(eventId)}`);
    const analyze2 = page.waitForResponse(
      (r) => r.url().includes("/api/compare/analyze") && r.request().method() === "POST",
      { timeout: 300000 },
    );
    await page.goto(shareUrl(eventId), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 60000 });
    const resp2 = await analyze2;
    log(`phase 2 analyze: HTTP ${resp2.status()}`);
    await page.waitForSelector('[aria-label="Change detection results"]', { timeout: 300000 });
    await page.waitForSelector(".maplibregl-popup .hs-pop", { timeout: 60000 });
    await page.waitForTimeout(1500);

    const phase2 = await dumpDrawerState(page);
    const popupText = await page.evaluate(() => {
      const pop = document.querySelector(".maplibregl-popup .hs-pop");
      return pop ? (pop.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400) : null;
    });
    log(`\n=== PHASE 2 ===\n${JSON.stringify({ ...phase2, popupText }, null, 2)}`);
    await shoot(page, "phase2-event-popup");
    if (!phase2.banner) throw new Error("phase 2: share banner missing");
    if (!popupText || !popupText.includes("#")) throw new Error("phase 2: popup missing or has no rank");

    log(`console/page errors: ${consoleErrors.length}`);
    consoleErrors.slice(0, 10).forEach((e) => log(`  ${e}`));
    log("SHARE-LINK SMOKE PASSED");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((error) => {
  console.error("SHARE-LINK SMOKE CRASH:", error);
  process.exit(2);
});
