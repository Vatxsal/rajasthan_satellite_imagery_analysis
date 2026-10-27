/**
 * Change-detection visual verification (Ajmer district).
 *
 * Usage (a server must be running):
 *   npm run build && npm start
 *   node scripts/compare.browser.cjs
 *
 * Env overrides:
 *   BASE_URL            target origin (default http://localhost:3000)
 *   CHROME_PATH         explicit Chrome binary (otherwise system Chrome)
 *   COMPARE_OUT_DIR     screenshot dir (default artifacts/compare)
 *   COMPARE_DISTRICT    district label (default Ajmer)
 *
 * Flow: search Ajmer → arm Compare → pair 1 (early Aug vs late Oct 2026) and
 * pair 2 (8-day gap) → per pair: light/dark screenshots at 1440×900 plus a
 * 1280×720 light shot, layout metrics, swipe-tab check (two canvases).
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DISTRICT = process.env.COMPARE_DISTRICT || "Ajmer";
const OUT_DIR = process.env.COMPARE_OUT_DIR || path.join("artifacts", "compare");
const RUN_TAG = process.env.COMPARE_TAG || "run";

const pairs = [];
const consoleErrors = [];
const pageErrors = [];

function log(line) {
  console.log(line);
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Picks the two pairs; falls back gracefully and reports what it chose. */
function choosePairs(dates) {
  const set = new Set(dates);
  const sorted = [...dates].sort();
  const result = [];

  const aug = sorted.find((d) => d >= "2026-08-01" && d <= "2026-08-15");
  const octLate = sorted.filter((d) => d >= "2026-10-16").pop();
  if (aug && octLate) {
    result.push({ name: "aug-oct", dateA: aug, dateB: octLate });
  } else if (sorted.length >= 2) {
    result.push({ name: "fallback-span", dateA: sorted[0], dateB: sorted[sorted.length - 1] });
  }

  let eight = null;
  for (let i = sorted.length - 1; i >= 0 && !eight; i--) {
    const d = new Date(`${sorted[i]}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 8);
    const other = fmtDate(d);
    if (set.has(other)) eight = { dateA: other, dateB: sorted[i] };
  }
  if (eight) {
    result.push({ name: "gap8", ...eight });
  } else if (result.length > 0 && sorted.length >= 2) {
    // nearest-gap fallback
    let best = null;
    for (let i = 1; i < sorted.length; i++) {
      const gap = (Date.parse(sorted[i]) - Date.parse(sorted[i - 1])) / 86_400_000;
      if (!best || gap < best.gap) best = { dateA: sorted[i - 1], dateB: sorted[i], gap };
    }
    if (best) result.push({ name: "fallback-gap", dateA: best.dateA, dateB: best.dateB });
  }
  return result;
}

async function metrics(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const drawer = document.querySelector('section[aria-label="Change detection results"]');
    const strip = document.querySelector('section[aria-label="Search results"]');
    const panel = document.querySelector("aside");
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    const mainR = rect(main);
    const drawerR = rect(drawer);
    const stripR = rect(strip);
    const panelR = rect(panel);
    let covered = 0;
    if (drawerR) covered += drawerR.height;
    if (stripR && drawerR) covered += stripR.height;
    else if (stripR) covered += stripR.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      viewport: `${vw}x${vh}`,
      mainWidth: mainR ? Math.round(mainR.width) : 0,
      mapWidthPct: mainR ? Math.round((mainR.width / vw) * 1000) / 10 : 0,
      mapVisiblePct:
        mainR ? Math.round(((mainR.height - covered) * mainR.width * 100) / (vw * vh) * 10) / 10 : 0,
      drawerHeight: drawerR ? Math.round(drawerR.height) : 0,
      drawerPctViewport: drawerR ? Math.round((drawerR.height / vh) * 100) : 0,
      stripHeight: stripR ? Math.round(stripR.height) : 0,
      leftPanelWidth: panelR ? Math.round(panelR.width) : 0,
      canvases: document.querySelectorAll("canvas").length,
    };
  });
}

async function shoot(page, name) {
  const file = path.join(OUT_DIR, `${RUN_TAG}_${name}.png`);
  await page.screenshot({ path: file });
  const m = await metrics(page);
  log(`SHOT ${name} -> ${file}`);
  log(`  metrics ${JSON.stringify(m)}`);
  pairs.push({ name, ...m });
  return m;
}

async function runPair(page, pair) {
  log(`\n=== pair ${pair.name}: A=${pair.dateA} B=${pair.dateB} ===`);

  await page.click(`button[aria-label="Date A: ${pair.dateA}"]`);
  await page.click(`button[aria-label="Date B: ${pair.dateB}"]`);

  const analyzeRespPromise = page.waitForResponse(
    (r) => r.url().includes("/api/compare/analyze") && r.request().method() === "POST",
    { timeout: 180000 },
  );
  await page.locator('button:has-text("Analyze")').first().click();
  const resp = await analyzeRespPromise;
  log(`analyze response: ${resp.status()}`);
  if (resp.status() !== 200) {
    const body = await resp.text().catch(() => "");
    log(`analyze FAILED: ${body.slice(0, 400)}`);
    return false;
  }

  await page.waitForSelector('section[aria-label="Change detection results"]', {
    timeout: 60000,
  });
  await page.waitForTimeout(3500); // overlay image + tiles settle

  // light 1440
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(800);
  await shoot(page, `${pair.name}_1440_light`);

  // dark 1440
  await page.click('button[aria-label="Toggle theme"]');
  await page.waitForTimeout(1200);
  await shoot(page, `${pair.name}_1440_dark`);

  // light 1280
  await page.click('button[aria-label="Toggle theme"]');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(1200);
  await shoot(page, `${pair.name}_1280_light`);

  // swipe tab: second canvas must mount
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(600);
  await page.click('button[role="radio"], button:has-text("Swipe")').catch(() => null);
  await page.waitForTimeout(2500);
  const swipeCanvases = await page.evaluate(() => document.querySelectorAll("canvas").length);
  log(`swipe canvases: ${swipeCanvases}`);
  await shoot(page, `${pair.name}_swipe_1440`);
  // back to Change map
  await page.locator('button:has-text("Change map")').first().click().catch(() => null);
  await page.waitForTimeout(600);
  return true;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 300)));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(4000);

  // 1. district search
  await page.selectOption("#filter-district", { label: DISTRICT });
  const scenesPromise = page.waitForResponse(
    (r) => r.url().includes("/api/scenes") && r.request().method() === "POST",
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: /search imagery/i }).click();
  const scenesResp = await scenesPromise;
  log(`scenes: ${scenesResp.status()}`);
  await page.waitForTimeout(1500);

  // 2. arm compare mode
  await page.click('button[title="Compare two dates for this area"]');
  await page.waitForSelector('button[aria-label^="Date A: "]', { timeout: 30000 });

  const dates = await page.$$eval('button[aria-label^="Date A: "]', (els) =>
    els.map((el) => el.getAttribute("aria-label").replace("Date A: ", "")),
  );
  log(`scene dates (${dates.length}): ${dates.slice(0, 40).join(", ")}`);

  const chosen = choosePairs(dates);
  if (chosen.length === 0) throw new Error("No scene dates available for pairs.");

  // baseline shot before any run (layout with compare bar)
  await shoot(page, "baseline_no_result_1440");

  for (const pair of chosen) {
    await runPair(page, pair);
  }

  log(`\nconsole errors: ${consoleErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e) => log(`  ${e}`));
  log(`page errors: ${pageErrors.length}`);
  pageErrors.slice(0, 10).forEach((e) => log(`  ${e}`));
  log(`\nmetrics table:\n${JSON.stringify(pairs, null, 2)}`);

  await browser.close();
  const failed = pageErrors.length > 0;
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error("COMPARE VERIFY CRASH:", error);
  process.exit(2);
});
