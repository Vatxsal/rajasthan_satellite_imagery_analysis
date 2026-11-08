/**
 * Reproduce compare-panel UI defects: squeezed panel, default popup, markers.
 * Uncommitted diagnostic harness. Screenshots → artifacts/panel-repro/.
 */
const { chromium } = require("playwright-core");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "artifacts/panel-repro";

(async () => {
  require("node:fs").mkdirSync(OUT, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));

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
  console.log(`pair ${dateA} -> ${dateB}`);
  await page.click(`button[aria-label="Date A: ${dateA}"]`);
  await page.click(`button[aria-label="Date B: ${dateB}"]`);

  const analyzeP = page.waitForResponse(
    (r) => r.url().includes("/api/compare/analyze") && r.request().method() === "POST",
    { timeout: 300000 },
  );
  await page.locator('button:has-text("Analyze")').first().click();
  const analyzeResp = await analyzeP;
  console.log(`analyze=${analyzeResp.status()}`);

  await page.waitForSelector('[aria-label="Change detection results"]', { timeout: 60000 });
  await page.waitForTimeout(4000);
  // settle the map after the fit animation
  await page.waitForTimeout(2500);

  const drawer = page.locator('[aria-label="Change detection results"]');

  // ---- 1. change-map tab (default), light theme
  await page.screenshot({ path: `${OUT}/01-full-light-changemap.png` });
  await drawer.screenshot({ path: `${OUT}/02-drawer-light-changemap.png` });
  const drawerBox = await drawer.boundingBox();
  console.log("drawer box", JSON.stringify(drawerBox));
  await page.screenshot({
    path: `${OUT}/03-map-markers-light.png`,
    clip: { x: 0, y: 0, width: drawerBox.x, height: 900 },
  });

  // ---- 2. hotspot popup (list click)
  await drawer.getByRole("button", { name: "Hotspots", exact: true }).click();
  await page.waitForTimeout(600);
  await drawer.screenshot({ path: `${OUT}/04-drawer-hotspots.png` });
  await drawer.locator("ol li button").first().click();
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${OUT}/05-full-light-popup.png` });
  const popup = page.locator(".maplibregl-popup");
  if (await popup.count()) {
    const box = await popup.boundingBox();
    console.log("popup box", JSON.stringify(box));
    if (box) {
      const pad = 40;
      await page.screenshot({
        path: `${OUT}/06-popup-zoom-light.png`,
        clip: {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: Math.min(1440 - Math.max(0, box.x - pad), box.width + pad * 2),
          height: Math.min(900 - Math.max(0, box.y - pad), box.height + pad * 2),
        },
      });
    }
  } else {
    console.log("NO POPUP OPENED");
  }

  // ---- 3. dark theme popup + markers
  await page.click('button[aria-label="Toggle theme"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/07-full-dark-popup.png` });
  if (await popup.count()) {
    const box = await popup.boundingBox();
    if (box) {
      const pad = 40;
      await page.screenshot({
        path: `${OUT}/08-popup-zoom-dark.png`,
        clip: {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: Math.min(1440 - Math.max(0, box.x - pad), box.width + pad * 2),
          height: Math.min(900 - Math.max(0, box.y - pad), box.height + pad * 2),
        },
      });
    }
  }

  // ---- 4. satellite basemap markers (dark)
  await page.click('button[title="Satellite"]');
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: `${OUT}/09-markers-dark-satellite.png`,
    clip: { x: 0, y: 0, width: drawerBox.x, height: 900 },
  });

  // ---- 5. statistics + summary tabs (light) for overlap evidence
  await page.click('button[title="Map"]');
  await page.waitForTimeout(400);
  await page.click('button[aria-label="Toggle theme"]');
  await page.waitForTimeout(700);
  await drawer.getByRole("button", { name: "Statistics", exact: true }).click();
  await page.waitForTimeout(400);
  await drawer.screenshot({ path: `${OUT}/10-drawer-light-stats.png` });
  await drawer.getByRole("button", { name: "Summary", exact: true }).click();
  await page.waitForTimeout(400);
  await drawer.screenshot({ path: `${OUT}/11-drawer-light-summary.png` });

  await browser.close();
  console.log("done");
})().catch((e) => {
  console.error("REPRO CRASH:", e);
  process.exit(2);
});
