/**
 * Screenshot harness for the two fixes on fix/summary-and-method-panel:
 *  - Stats tab "Method & settings" card (single-column redesign) at drawer
 *    widths 360/420/560 × light/dark, collapsed + expanded (+ thresholds).
 *  - Summary tab: real success (light/dark) + mocked error states.
 * Output → docs/screenshots/.
 * Uncommitted harness (like the other *.browser.cjs scripts).
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "docs/screenshots";
const WIDTHS = [360, 420, 560];

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

async function setTheme(page, want) {
  const current = await page.evaluate(() => document.documentElement.getAttribute("data-theme") || "light");
  if (current === want) return;
  await page.click('button[aria-label="Toggle theme"]');
  await page.waitForFunction((t) => document.documentElement.getAttribute("data-theme") === t, want, { timeout: 5000 });
}

async function resizeViaHandle(page, drawer, targetWidth) {
  const handle = drawer.locator('[aria-label="Resize change detection panel"]').first();
  const handleBox = await handle.boundingBox().catch(() => null);
  const drawerBox = await drawer.boundingBox();
  if (!handleBox || !drawerBox) return;
  const delta = targetWidth - drawerBox.width;
  if (Math.abs(delta) < 4) return;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 - delta, handleBox.y + handleBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(350);
}

async function clickSummaryAction(page) {
  const action = page
    .locator('button:has-text("Generate summary"), button:has-text("Regenerate summary"), button:has-text("Retry")')
    .first();
  const wait = page.waitForResponse(
    (r) => r.url().includes("/api/compare/summary") && r.request().method() === "POST",
    { timeout: 180000 },
  );
  await action.click();
  return wait;
}

async function mockSummary(page, status, body) {
  await page.unroute("**/api/compare/summary").catch(() => {});
  await page.route("**/api/compare/summary", (route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => log("PAGEERROR:", String(e).slice(0, 200)));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(3000);
  await setTheme(page, "light");

  await page.selectOption("#filter-district", { label: "Ajmer" });
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
  await analyzeP;
  log("analyze response received");

  await page.waitForSelector('[aria-label="Change detection results"]', { timeout: 120000 });
  await page.waitForTimeout(5000);
  const drawer = page.locator('[aria-label="Change detection results"]');
  const card = page.locator('[aria-label="Method and settings"]');

  // ---- Stats: Method & settings card matrix -------------------------------
  await page.click('button[role="tab"][aria-label="Stats"]');
  await page.waitForSelector('[aria-label="Method and settings"]', { timeout: 15000 });
  const collapse = () =>
    page
      .locator('button[aria-label="Collapse controls and thresholds"]')
      .click({ timeout: 3000 })
      .catch(() => {});
  const expand = () => page.locator('button[aria-label="Expand controls and thresholds"]').click();

  for (const width of WIDTHS) {
    await collapse();
    await resizeViaHandle(page, drawer, width);
    for (const theme of ["light", "dark"]) {
      await setTheme(page, theme);
      await page.waitForTimeout(250);
      await card.screenshot({ path: `${OUT}/method-card-${width}-${theme}.png` });
      log(`shot method-card-${width}-${theme}`);

      await expand();
      await page.waitForTimeout(350);
      await card.screenshot({ path: `${OUT}/method-card-${width}-${theme}-expanded.png` });
      log(`shot method-card-${width}-${theme}-expanded`);

      if (width === 420 && theme === "light") {
        await page.locator('button:has-text("Thresholds used")').click();
        await page.waitForTimeout(250);
        await page.locator('button:has-text("Advanced")').click();
        await page.waitForTimeout(350);
        await card.screenshot({ path: `${OUT}/method-card-420-light-thresholds-advanced.png` });
        log("shot method-card-420-light-thresholds-advanced");
        await page.locator('button:has-text("Advanced")').click();
        await page.locator('button:has-text("Thresholds used")').click();
        await page.waitForTimeout(200);
      }
      await collapse();
      await page.waitForTimeout(200);
    }
  }

  // ---- Summary: real success --------------------------------------------
  await setTheme(page, "light");
  await page.click('button[role="tab"][aria-label="Summary"]');
  await page.waitForSelector('button:has-text("Generate summary")', { timeout: 15000 });
  const ensureSwitch = await page.locator('button[role="switch"][aria-checked="false"]').count();
  if (ensureSwitch) await page.locator('button[role="switch"][aria-checked="false"]').click();
  log("generating real summary…");
  const okResp = await clickSummaryAction(page);
  log(`summary POST → ${okResp.status()}`);
  await page.waitForSelector('text=AI-generated summary', { timeout: 60000 });
  await page.waitForTimeout(400);
  await drawer.screenshot({ path: `${OUT}/summary-success-light.png` });
  log("shot summary-success-light");
  await setTheme(page, "dark");
  await page.waitForTimeout(300);
  await drawer.screenshot({ path: `${OUT}/summary-success-dark.png` });
  log("shot summary-success-dark");
  await setTheme(page, "light");

  // ---- Summary: mocked error states --------------------------------------
  const states = [
    {
      name: "rate-limited",
      status: 429,
      body: { code: "AI_RATE_LIMITED", message: "Free-tier limit reached; try again in 60 seconds." },
      waitText: "AI_RATE_LIMITED",
    },
    {
      name: "unavailable",
      status: 502,
      body: { code: "AI_UNAVAILABLE", message: "The AI service is unavailable right now. Try again shortly." },
      waitText: "AI_UNAVAILABLE",
    },
    {
      name: "auth",
      status: 401,
      body: { code: "AI_AUTH", message: "The AI API key is invalid or lacks access to this model." },
      waitText: "AI_AUTH",
    },
    {
      name: "try-without-images",
      status: 400,
      body: { code: "AI_BAD_REQUEST", message: "The AI service rejected the request. Try again shortly." },
      waitText: "AI_BAD_REQUEST",
      requireButton: "Try without images",
    },
  ];
  for (const state of states) {
    await mockSummary(page, state.status, state.body);
    const resp = await clickSummaryAction(page);
    log(`${state.name}: POST → ${resp.status()}`);
    await page.waitForSelector(`text=${state.waitText}`, { timeout: 30000 });
    if (state.requireButton) {
      await page.waitForSelector(`button:has-text("${state.requireButton}")`, { timeout: 10000 });
    }
    await page.waitForTimeout(300);
    await drawer.screenshot({ path: `${OUT}/summary-error-${state.name}.png` });
    log(`shot summary-error-${state.name}`);
  }
  await page.unroute("**/api/compare/summary").catch(() => {});

  await browser.close();
  log("DONE");
})().catch((e) => {
  console.error("SCREENSHOT_FAIL:", e);
  process.exit(2);
});
