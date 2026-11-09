/**
 * Phase 6 screenshots — legacy vs fused change detection on three tehsils
 * (Phalodi/Jodhpur, Sanganer/Jaipur, Sangod/Kota) against a LIVE dev server
 * (CDSE + S1 + WorldCover + DEM in fused mode).
 *
 * Run per rule mode (server env is cached per process — restart between modes):
 *   $env:CHANGE_RULES='legacy'; npm run dev          # separate shell
 *   $env:EXPECT_RULES='legacy'; node scripts/phase6-sites.browser.cjs
 *   ...kill server, restart with CHANGE_RULES='fused', EXPECT_RULES='fused'…
 *
 * The rules mode actually used is read back from the method card ("Rules"
 * row) and MUST match EXPECT_RULES — a stale getServerEnv cache or a
 * swallowed env override fails the run instead of writing mislabelled files.
 * Output → docs/screenshots/phase6-{tehsil}-{rules}[-method].png
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "docs/screenshots";
const EXPECT_RULES = process.env.EXPECT_RULES || "";

const SITES = [
  { slug: "phalodi", district: "d-jodhpur", tehsil: "t-jodhpur-phalodi" },
  { slug: "sanganer", district: "d-jaipur", tehsil: "t-jaipur-sanganer" },
  { slug: "sangod", district: "d-kota", tehsil: "t-kota-sangod" },
];

// SITE=<slug> runs a single site (retry/diagnosis runs).
const only = process.env.SITE;
const SITES_TO_RUN = only ? SITES.filter((s) => s.slug === only) : SITES;

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

async function setTheme(page, want) {
  const current = await page.evaluate(
    () => document.documentElement.getAttribute("data-theme") || "light",
  );
  if (current === want) return;
  await page.click('button[aria-label="Toggle theme"]');
  await page.waitForFunction(
    (t) => document.documentElement.getAttribute("data-theme") === t,
    want,
    { timeout: 5000 },
  );
}

/** Runs one site end-to-end and writes the two screenshots. */
async function shootSite(page, site, rules) {
  log(`── ${site.slug} (district ${site.district}, tehsil ${site.tehsil})`);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(2500);
  await setTheme(page, "light");

  await page.selectOption("#filter-district", site.district);
  await page.waitForSelector("#filter-tehsil", { timeout: 15000 });
  await page.selectOption("#filter-tehsil", site.tehsil);

  const scenesP = page.waitForResponse(
    (r) => r.url().includes("/api/scenes") && r.request().method() === "POST",
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: /search imagery/i }).click();
  await scenesP;
  await page.waitForTimeout(1200);

  await page.click('button[title="Compare two dates for this area"]');
  await page.locator('button[title^="Show scene cards"]').first().click().catch(() => null);
  await page.waitForSelector('button[aria-label^="Date A: "]', { timeout: 30000 });
  const dates = await page.$$eval('button[aria-label^="Date A: "]', (els) =>
    els.map((el) => el.getAttribute("aria-label").replace("Date A: ", "")),
  );
  if (dates.length === 0) throw new Error(`${site.slug}: no scene dates`);
  const sorted = [...dates].sort();
  const dateA = sorted[0];
  const dateB = sorted[sorted.length - 1];
  log(`pair ${dateA} -> ${dateB}`);
  await page.click(`button[aria-label="Date A: ${dateA}"]`);
  await page.click(`button[aria-label="Date B: ${dateB}"]`);

  const analyzeP = page.waitForResponse(
    (r) => r.url().includes("/api/compare/analyze") && r.request().method() === "POST",
    { timeout: 300000 },
  );
  await page.locator('button:has-text("Analyze")').first().click();
  const analyzeResp = await analyzeP;
  // streamAnalyze: headers (and status) arrive immediately, the NDJSON body
  // keeps streaming for the whole fetch-a/fetch-b/analyze run — the real
  // completion signal is the results drawer below, not this response.
  log(`analyze headers → ${analyzeResp.status()}`);
  if (analyzeResp.status() !== 200) {
    const body = await analyzeResp.text().catch(() => "");
    throw new Error(`${site.slug}: analyze HTTP ${analyzeResp.status()} ${body.slice(0, 300)}`);
  }

  try {
    await page.waitForSelector('[aria-label="Change detection results"]', {
      timeout: 300000, // streaming analyze can run several minutes on CDSE
    });
  } catch (e) {
    await page
      .screenshot({ path: `${OUT}/phase6-${site.slug}-${rules}-DEBUG.png` })
      .catch(() => {});
    const text = await page
      .evaluate(() => document.body.innerText.slice(0, 1200))
      .catch(() => "(unavailable)");
    log(`DRAWER_TIMEOUT for ${site.slug}: ${text.replace(/\s+/g, " ").slice(0, 600)}`);
    throw e;
  }
  await page.waitForTimeout(4000);

  await page.click('button[role="tab"][aria-label="Stats"]');
  const card = page.locator('[aria-label="Method and settings"]');
  await card.waitFor({ state: "visible", timeout: 20000 });
  const cardText = await card.innerText();

  // Rules row actually used by this run — must match the server env we set.
  const detected = cardText.includes("fused")
    ? "fused"
    : cardText.includes("ml")
      ? "ml"
      : cardText.includes("legacy")
        ? "legacy"
        : "unknown";
  if (!EXPECT_RULES) throw new Error("EXPECT_RULES env var is required");
  if (detected !== EXPECT_RULES) {
    throw new Error(
      `${site.slug}: method card says rules=${detected}, expected ${EXPECT_RULES} ` +
        `(stale server env? restart dev server with CHANGE_RULES=${EXPECT_RULES})`,
    );
  }
  log(`rules row ok: ${detected}`);

  await page.waitForTimeout(1500); // let the overlay finish painting
  const shot = `${OUT}/phase6-${site.slug}-${rules}.png`;
  await page.screenshot({ path: shot });
  log(`shot ${shot}`);
  const methodShot = `${OUT}/phase6-${site.slug}-${rules}-method.png`;
  await card.screenshot({ path: methodShot });
  log(`shot ${methodShot}`);
}

(async () => {
  if (!EXPECT_RULES) {
    log("EXPECT_RULES not set (legacy|fused) — refusing to guess the label");
    process.exit(2);
  }
  if (SITES_TO_RUN.length === 0) {
    log(`SITE=${only} matches no known site (${SITES.map((s) => s.slug).join(", ")})`);
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => log("PAGEERROR:", String(e).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") log("CONSOLE:", m.text().slice(0, 240));
  });

  try {
    for (const site of SITES_TO_RUN) {
      await shootSite(page, site, EXPECT_RULES);
    }
  } finally {
    await browser.close();
  }
  log("DONE");
})().catch((e) => {
  console.error("SCREENSHOT_FAIL:", e);
  process.exit(2);
});
