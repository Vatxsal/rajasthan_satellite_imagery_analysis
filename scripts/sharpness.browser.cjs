/**
 * Sharpness evidence — native tile PNGs + map viewport at z13/14/15.
 *
 * Usage (dev server on :3000, default env):
 *   TAG=before node scripts/sharpness.browser.cjs   # run BEFORE a change
 *   TAG=after  node scripts/sharpness.browser.cjs   # run AFTER the change
 *
 * For each zoom in ZOOMS:
 *  - phase-sharp-z{z}-{TAG}.png       map viewport at that zoom (Jaipur centre)
 *  - phase-sharp-tile-z{z}-{TAG}.png  the raw XYZ tile PNG the map consumes
 * When both tags exist it also writes phase-sharp-z{z}-compare.png
 * (before | after side by side, labelled).
 *
 * The tile params (date/areaId/level/composite) are learned from the first
 * /api/tiles request the app makes, so before/after fetch the exact same tile.
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "docs/screenshots";
const TAG = process.env.TAG || "";
const ZOOMS = [13, 14, 15];
// Jaipur city centre — dense urban fabric (buildings/roads) at 8-10 m/px.
const CENTER = [75.7873, 26.9124];

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

/** Web-mercator XYZ tile containing a lon/lat at zoom z. */
function tileOf(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

/** Side-by-side before/after compare image via an offscreen canvas page. */
async function composeCompare(browser, z) {
  const beforePath = `${OUT}/phase-sharp-z${z}-before.png`;
  const afterPath = `${OUT}/phase-sharp-z${z}-after.png`;
  if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) return false;
  const page = await browser.newPage({ viewport: { width: 2960, height: 960 } });
  const b64 = (p) => fs.readFileSync(p).toString("base64");
  await page.setContent(
    `<body style="margin:0;background:#111;font-family:sans-serif">
      <div style="display:flex;gap:8px;padding:8px">
        <div><div style="color:#fff;font-size:20px;padding:4px">BEFORE — z${z}</div>
          <img id="a" src="data:image/png;base64,${b64(beforePath)}" style="width:1440px;height:900px;object-fit:cover"></div>
        <div><div style="color:#fff;font-size:20px;padding:4px">AFTER — z${z}</div>
          <img id="b" src="data:image/png;base64,${b64(afterPath)}" style="width:1440px;height:900px;object-fit:cover"></div>
      </div>
    </body>`,
    { waitUntil: "load" },
  );
  await page.waitForTimeout(300);
  const out = `${OUT}/phase-sharp-z${z}-compare.png`;
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 2960, height: 960 } });
  await page.close();
  log(`composed ${out}`);
  return true;
}

(async () => {
  if (TAG !== "before" && TAG !== "after") {
    log("TAG env var required (before|after)");
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
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 30000 });
    await page.waitForTimeout(2500);

    await page.selectOption("#filter-district", "d-jaipur");
    await page.waitForSelector("#filter-tehsil", { timeout: 15000 });

    // First tile URL the app requests carries the exact date/area params.
    let tileUrl = null;
    page.on("response", (r) => {
      if (!tileUrl && r.url().includes("/api/tiles/") && r.url().includes("areaId=")) {
        tileUrl = r.url();
      }
    });

    const scenesP = page.waitForResponse(
      (r) => r.url().includes("/api/scenes") && r.request().method() === "POST",
      { timeout: 120000 },
    );
    await page.getByRole("button", { name: /search imagery/i }).click();
    await scenesP;
    await page.waitForTimeout(1200);
    await page.locator('button[title^="Show scene cards"]').first().click().catch(() => null);
    await page.waitForSelector('div[role="button"][aria-pressed]', { timeout: 30000 });
    await page.locator('div[role="button"][aria-pressed]').first().click();
    log("scene activated — waiting for tiles");
    await page.waitForTimeout(6000);

    if (!tileUrl) throw new Error("no /api/tiles request observed (imagery not rendering?)");
    const u = new URL(tileUrl);
    const params = u.search; // ?date=…&composite=…&areaId=…&level=…
    log(`tile params ${params}`);
    const date = u.searchParams.get("date");

    for (const z of ZOOMS) {
      await page.evaluate(
        ([center, zoom]) => {
          const map = window.__rieMaps && window.__rieMaps.main;
          if (!map) throw new Error("window.__rieMaps.main missing");
          map.jumpTo({ center, zoom, duration: 0 });
        },
        [CENTER, z],
      );
      // Wait until /api/tiles traffic settles (fresh zoom) then paint.
      await page.waitForTimeout(z === 15 ? 6000 : 4000);
      const shot = `${OUT}/phase-sharp-z${z}-${TAG}.png`;
      await page.screenshot({ path: shot });
      log(`shot ${shot}`);

      const { x, y } = tileOf(CENTER[0], CENTER[1], z);
      const tileUrlZ = `${BASE}/api/tiles/${z}/${x}/${y}.png${params}`;
      const resp = await page.request.get(tileUrlZ, { timeout: 60000 });
      const skip = resp.headers()["x-tile-skip"] || "";
      const body = await resp.body();
      const tilePath = `${OUT}/phase-sharp-tile-z${z}-${TAG}.png`;
      if (skip) {
        log(`tile z${z} skipped (${skip}) — ${body.length}B saved anyway`);
      } else {
        log(`tile z${z} ${resp.status()} ${body.length}B`);
      }
      fs.writeFileSync(tilePath, body);
      log(`shot ${tilePath}`);
    }
    log(`DATE=${date}`);
  } finally {
    await browser.close();
  }

  const browser2 = await chromium.launch(
    process.env.CHROME_PATH ? { headless: true, executablePath: process.env.CHROME_PATH } : { headless: true, channel: "chrome" },
  );
  try {
    for (const z of ZOOMS) await composeCompare(browser2, z);
  } finally {
    await browser2.close();
  }
  log("DONE");
})().catch((e) => {
  console.error("SHARPNESS_FAIL:", e);
  process.exit(2);
});
