/** Quick probe: what happens after Analyze? Dumps state + screenshot. */
const { chromium } = require("playwright-core");
const BASE = process.env.BASE_URL || "http://localhost:3000";

(async () => {
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 400)));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      console.log(`CONSOLE ${m.type()}:`, m.text().slice(0, 300));
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.selectOption("#filter-district", { label: "Ajmer" });
  const scenesP = page.waitForResponse(
    (r) => r.url().includes("/api/scenes") && r.request().method() === "POST",
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: /search imagery/i }).click();
  await scenesP;
  await page.waitForTimeout(1000);
  await page.click('button[title="Compare two dates for this area"]');
  await page.locator('button[title^="Show scene cards"]').first().click().catch(() => null);
  await page.waitForSelector('button[aria-label^="Date A: "]', { timeout: 30000 });
  const dates = await page.$$eval('button[aria-label^="Date A: "]', (els) =>
    els.map((el) => el.getAttribute("aria-label").replace("Date A: ", "")),
  );
  const sorted = [...dates].sort();
  await page.click(`button[aria-label="Date A: ${sorted[0]}"]`);
  await page.click(`button[aria-label="Date B: ${sorted[sorted.length - 1]}"]`);
  const analyzeP = page.waitForResponse(
    (r) => r.url().includes("/api/compare/analyze") && r.request().method() === "POST",
    { timeout: 300000 },
  );
  await page.locator('button:has-text("Analyze")').first().click();
  const resp = await analyzeP;
  console.log("analyze=", resp.status());
  const bodyText = await resp.text().catch(() => "");
  console.log("analyze body head:", bodyText.slice(0, 300));
  await page.waitForTimeout(8000);
  const count = await page.locator('[aria-label="Change detection results"]').count();
  const visible = count ? await page.locator('[aria-label="Change detection results"]').isVisible() : false;
  console.log("drawer count:", count, "visible:", visible);
  const anyAside = await page.$$eval("aside, section", (els) =>
    els.map((el) => el.getAttribute("aria-label") || el.tagName).slice(0, 20),
  );
  console.log("landmarks:", JSON.stringify(anyAside));
  await page.screenshot({ path: "artifacts/panel-verify/probe-after-analyze.png", fullPage: false });
  await browser.close();
})().catch((e) => {
  console.error("PROBE CRASH:", e);
  process.exit(2);
});
