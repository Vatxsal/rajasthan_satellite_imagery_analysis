/**
 * Verify compare-panel fixes across widths (360/420/560), zoom (100%/125%),
 * themes (light/dark) and both basemaps (Map/Satellite).
 * Uncommitted verification harness. Screenshots → artifacts/panel-verify/.
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "artifacts/panel-verify";

// 125% browser zoom ≈ a 1440x900 screen rendering at 1152x720 CSS pixels.
const ZOOM_VIEWPORTS = [
  { zoom: "100", width: 1440, height: 900 },
  { zoom: "125", width: 1152, height: 720 },
];
const PANEL_WIDTHS = [360, 420, 560];

async function resizeViaHandle(page, drawer, targetWidth) {
  // Drag the left resize handle until the drawer is ~targetWidth wide.
  const handle = drawer.locator('[aria-label="Resize change detection panel"]').first();
  const handleBox = await handle.boundingBox().catch(() => null);
  const drawerBox = await drawer.boundingBox();
  if (!handleBox || !drawerBox) return;
  const startW = drawerBox.width;
  const delta = targetWidth - startW;
  if (Math.abs(delta) < 4) return;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 - delta, handleBox.y + handleBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
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

  const analyzeP = page
    .waitForResponse(async (r) => {
      if (!r.url().includes("/api/compare/analyze") || r.request().method() !== "POST") return false;
      // Streamed NDJSON — wait for the terminal result chunk, not the first stage event.
      try {
        const text = await r.text();
        return text.includes('"type":"result"');
      } catch {
        return false;
      }
    }, { timeout: 300000 })
    .then((r) => r);
  await page.locator('button:has-text("Analyze")').first().click();
  await analyzeP;
  console.log("analyze stream finished (result chunk seen)");

  await page.waitForSelector('[aria-label="Change detection results"]', { timeout: 60000 });
  await page.waitForTimeout(6000); // let fit animation settle
  const drawer = page.locator('[aria-label="Change detection results"]');

  // ---- Phase A: panel widths at 100% zoom, light theme, Map basemap ----
  for (const width of PANEL_WIDTHS) {
    await resizeViaHandle(page, drawer, width);
    const box = await drawer.boundingBox();
    console.log(`width ${width} -> actual ${box ? Math.round(box.width) : "n/a"}`);
    await page.screenshot({ path: `${OUT}/A-${width}-full-changemap.png` });
    await drawer.screenshot({ path: `${OUT}/A-${width}-drawer-changemap.png` });

    // hotspots tab at this width (rows + marker linkage)
    await drawer.getByRole("tab", { name: "Hotspots", exact: true }).click();
    await page.waitForTimeout(400);
    await drawer.screenshot({ path: `${OUT}/A-${width}-drawer-hotspots.png` });
    await drawer.getByRole("tab", { name: "Changes", exact: true }).click();
    await page.waitForTimeout(300);
  }

  // ---- Phase B: popup light + dark at 100% zoom ----
  await drawer.getByRole("tab", { name: "Hotspots", exact: true }).click();
  await page.waitForTimeout(400);
  await drawer.locator("ol li button").first().click();
  await page.waitForTimeout(1600);
  const popup = page.locator(".maplibregl-popup");
  const popupBox = await popup.boundingBox().catch(() => null);
  console.log("popup box", JSON.stringify(popupBox));
  await page.screenshot({ path: `${OUT}/B-popup-full-light.png` });
  if (popupBox) {
    const pad = 48;
    const clip = {
      x: Math.max(0, popupBox.x - pad),
      y: Math.max(0, popupBox.y - pad),
      width: Math.min(1440 - Math.max(0, popupBox.x - pad), popupBox.width + pad * 2),
      height: Math.min(900 - Math.max(0, popupBox.y - pad), popupBox.height + pad * 2),
    };
    await page.screenshot({ path: `${OUT}/B-popup-zoom-light.png`, clip });
  }

  await page.click('button[aria-label="Toggle theme"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/B-popup-full-dark.png` });
  if (popupBox) {
    const pad = 48;
    const clip = {
      x: Math.max(0, popupBox.x - pad),
      y: Math.max(0, popupBox.y - pad),
      width: Math.min(1440 - Math.max(0, popupBox.x - pad), popupBox.width + pad * 2),
      height: Math.min(900 - Math.max(0, popupBox.y - pad), popupBox.height + pad * 2),
    };
    await page.screenshot({ path: `${OUT}/B-popup-zoom-dark.png`, clip });
  }

  // ---- Phase C: markers on both basemaps (dark first) ----
  const drawerBox = await drawer.boundingBox();
  const mapClip = { x: 0, y: 0, width: Math.max(0, drawerBox.x), height: 900 };
  await page.screenshot({ path: `${OUT}/C-markers-dark-map.png`, clip: mapClip });
  await page.click('button[title="Satellite"]');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/C-markers-dark-satellite.png`, clip: mapClip });

  // back to Map basemap + light theme
  await page.click('button[title="Map"]');
  await page.waitForTimeout(500);
  await page.click('button[aria-label="Toggle theme"]');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/C-markers-light-map.png`, clip: mapClip });

  // ---- Phase D: stats + summary tabs, light, 100% zoom ----
  await drawer.getByRole("tab", { name: "Stats", exact: true }).click();
  await page.waitForTimeout(400);
  await drawer.screenshot({ path: `${OUT}/D-drawer-stats-light.png` });
  await drawer.getByRole("tab", { name: "Summary", exact: true }).click();
  await page.waitForTimeout(400);
  await drawer.screenshot({ path: `${OUT}/D-drawer-summary-light.png` });

  // ---- Phase E: 125% zoom emulation (smaller viewport), stats + hotspots ----
  await page.setViewportSize({ width: 1152, height: 720 });
  await page.waitForTimeout(800);
  await drawer.getByRole("tab", { name: "Stats", exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/E-z125-full-stats.png` });
  await drawer.screenshot({ path: `${OUT}/E-z125-drawer-stats.png` });
  await drawer.getByRole("tab", { name: "Hotspots", exact: true }).click();
  await page.waitForTimeout(400);
  await drawer.screenshot({ path: `${OUT}/E-z125-drawer-hotspots.png` });
  await drawer.getByRole("tab", { name: "Summary", exact: true }).click();
  await page.waitForTimeout(400);
  await drawer.screenshot({ path: `${OUT}/E-z125-drawer-summary.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);

  // ---- Phase F: marker <-> list hover linkage check (row 2; row 1 is selected) ----
  await drawer.getByRole("tab", { name: "Hotspots", exact: true }).click();
  await page.waitForTimeout(400);
  const secondRow = drawer.locator("ol li").nth(1);
  await secondRow.hover();
  await page.waitForTimeout(600);
  const hovered = await page.locator('.hs-marker[data-state="hover"]').count();
  const selected = await page.locator('.hs-marker[data-state="selected"]').count();
  console.log("hovered marker elements:", hovered, "selected:", selected);
  await page.screenshot({ path: `${OUT}/F-marker-row-hover.png` });

  await browser.close();
  console.log("done");
})().catch((e) => {
  console.error("VERIFY CRASH:", e);
  process.exit(2);
});
