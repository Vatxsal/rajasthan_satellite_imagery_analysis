/**
 * Phase 3 detail-UI verification (Ajmer district).
 *
 * Usage (a server must be running, with the real SESSION_SECRET):
 *   npm run build && npm start
 *   SESSION_SECRET=<.env.local value> node scripts/detail-ui.browser.cjs
 *
 * Env overrides:
 *   BASE_URL            target origin (default http://localhost:3000)
 *   CHROME_PATH         explicit Chrome binary (otherwise system Chrome)
 *   COMPARE_OUT_DIR     screenshot dir (default artifacts/detail-ui)
 *   COMPARE_DISTRICT    district label (default Ajmer)
 *
 * Flow (no real detail run ever starts — the estimate route is fulfilled
 * with a fixture, so zero CDSE renders/quota are burned):
 *   1. SSO session (forged JWT) → district search → arm Compare.
 *   2. The Quick/Smart/Detailed picker renders; a district defaults to Smart.
 *   3. Pick two scene dates → switch to Detailed → Analyze opens the
 *      estimate/confirm card → assert the fixture numbers → Cancel.
 *   4. Same with the Smart default (4 of 9 blocks).
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const { SignJWT } = require("jose");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DISTRICT = process.env.COMPARE_DISTRICT || "Ajmer";
const OUT_DIR = process.env.COMPARE_OUT_DIR || path.join("artifacts", "detail-ui");
const SECRET = process.env.SESSION_SECRET;
const COOKIE = "rse_session";

const consoleErrors = [];
const pageErrors = [];
const results = [];

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

async function forge(role, sub, name) {
  const key = new TextEncoder().encode(SECRET);
  return new SignJWT({ role, sub, name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

async function shoot(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  log("shot", file);
}

/** Fulfils the estimate route with a plausible card (blocks, PU, warning). */
function mockEstimate(page) {
  return page.route("**/api/compare/detail/estimate", async (route) => {
    const body = route.request().postDataJSON();
    const smart = body && body.detail === "smart";
    const payload = smart
      ? {
          detail: "smart",
          blocksTotal: 9,
          blocksSelected: 4,
          screeningPu: 4.17,
          blocksPu: 32.5,
          estimatedPu: 36.67,
          cap: 500,
          overQuickLimit: true,
        }
      : {
          detail: "detailed",
          blocksTotal: 9,
          blocksSelected: 9,
          screeningPu: 0,
          blocksPu: 73.13,
          estimatedPu: 73.13,
          cap: 500,
          overQuickLimit: true,
        };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
}

async function pickerValue(page) {
  return page.evaluate(() => {
    const group = document.querySelector('[aria-label="Detail level"]');
    if (!group) return null;
    const active = group.querySelector("button[aria-pressed='true']");
    return active ? active.textContent.trim() : null;
  });
}

async function openCardAndCancel(page, tag, expectBlocks) {
  await page.locator('button:has-text("Analyze")').first().click();
  await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
  await page.waitForSelector('button:has-text("Run ·")', { timeout: 20000 });
  const blocks = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const text = dialog ? dialog.textContent : "";
    const match = text ? text.match(/(\d+) of (\d+) \(native 10 m\)/) : null;
    return match ? `${match[1]} of ${match[2]}` : null;
  });
  log(`${tag}: estimate card blocks = ${blocks}`);
  results.push({ tag, blocks, expected: expectBlocks });
  await shoot(page, `estimate_${tag}_1440`);
  await page.locator('button:has-text("Cancel")').first().click();
  await page.waitForFunction(
    () => !document.querySelector('[role="dialog"]'),
    { timeout: 10000 },
  );
}

(async () => {
  if (!SECRET) {
    console.error("SESSION_SECRET is required (pass the same value as .env.local).");
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const token = await forge("sso", "detail-ui", "Detail UI");

  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addCookies([{ name: COOKIE, value: token, url: BASE }]);
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 300)));
  await mockEstimate(page);

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(4000);

  // 1. district search (real catalogue — no analysis starts here).
  await page.selectOption("#filter-district", { label: DISTRICT });
  const scenesPromise = page.waitForResponse(
    (r) => r.url().includes("/api/scenes") && r.request().method() === "POST",
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: /search imagery/i }).click();
  log(`scenes: ${(await scenesPromise).status()}`);
  await page.waitForTimeout(1500);

  // 2. arm compare; the picker shows and a district defaults to Smart.
  await page.click('button[title="Compare two dates for this area"]');
  await page.waitForSelector('[aria-label="Detail level"]', { timeout: 30000 });
  const defaulted = await pickerValue(page);
  log(`picker default for district: ${defaulted}`);
  results.push({ tag: "district-default", blocks: defaulted, expected: "Smart" });

  // 3. two scene dates (real catalogue days — no analysis runs).
  await page.waitForSelector('button[aria-label^="Date A: "]', { timeout: 30000 });
  const dates = await page.$$eval('button[aria-label^="Date A: "]', (els) =>
    els.map((el) => el.getAttribute("aria-label").replace("Date A: ", "")),
  );
  if (dates.length < 2) throw new Error(`Not enough scene dates (${dates.length}).`);
  await page.waitForTimeout(1500);
  await shoot(page, "picker_default_smart_1440");

  // Smart (the district default) → estimate fixture "4 of 9".
  await page.click(`button[aria-label="Date A: ${dates[0]}"]`);
  await page.click(`button[aria-label="Date B: ${dates[dates.length - 1]}"]`);
  await openCardAndCancel(page, "smart", "4 of 9");

  // Switch to Detailed → estimate fixture "9 of 9".
  const group = page.locator('[aria-label="Detail level"]');
  await group.locator('button:has-text("Detailed")').click();
  const switched = await pickerValue(page);
  log(`picker switched to: ${switched}`);
  results.push({ tag: "picker-detailed", blocks: switched, expected: "Detailed" });
  await openCardAndCancel(page, "detailed", "9 of 9");

  log(`\nresults: ${JSON.stringify(results, null, 2)}`);
  log(`console errors: ${consoleErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e) => log(`  ${e}`));
  log(`page errors: ${pageErrors.length}`);
  pageErrors.slice(0, 10).forEach((e) => log(`  ${e}`));

  await browser.close();
  const ok =
    pageErrors.length === 0 &&
    results.every(
      (r) => r.blocks === r.expected || String(r.blocks) === String(r.expected),
    );
  process.exit(ok ? 0 : 1);
})().catch((error) => {
  console.error("DETAIL UI VERIFY CRASH:", error);
  process.exit(2);
});
