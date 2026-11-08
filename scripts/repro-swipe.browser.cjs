/**
 * Swipe-tab reproduction harness (untracked).
 *
 * Reproduces the reported "Swipe tab shows tinted/overlaid imagery" bug:
 *  - searches a district (default Alwar),
 *  - arms Compare,
 *  - deliberately picks LATER date as A and EARLIER date as B (reversed),
 *  - analyzes, opens the Swipe tab,
 *  - dumps layer stacks + raster tile URLs of every live map
 *    (window.__rieMaps: main + right, exposed dev-only by the bridge),
 *  - captures light/dark screenshots.
 *
 * Usage (dev server must be running):
 *   node scripts/repro-swipe.browser.cjs
 *
 * Env:
 *   BASE_URL     default http://localhost:3000
 *   CHROME_PATH  explicit Chrome binary
 *   DISTRICT     default Alwar
 *   OUT_DIR      default artifacts/swipe
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DISTRICT = process.env.DISTRICT || "Alwar";
const OUT_DIR = process.env.OUT_DIR || path.join("artifacts", "swipe");
const RUN_TAG = process.env.RUN_TAG || "repro";

function log(line) {
  console.log(line);
}

/** Dumps every live map's raster sources, layer stack and key paints. */
async function dumpMaps(page) {
  return page.evaluate(() => {
    const g = window.__rieMaps || {};
    const slots = Object.keys(g);
    const out = { slots, maps: {} };
    for (const slot of slots) {
      const map = g[slot];
      if (!map) continue;
      const style = map.getStyle();
      const rasterSources = {};
      const sourceIds = Object.keys(style.sources || {});
      for (const id of sourceIds) {
        const src = style.sources[id];
        if (src.type === "raster") {
          rasterSources[id] = {
            tiles: src.tiles || null,
            tileSize: src.tileSize || null,
            minzoom: src.minzoom,
            maxzoom: src.maxzoom,
          };
        }
      }
      const layers = (style.layers || [])
        .filter((l) => l.source !== "openmaptiles")
        .map((l) => {
        const entry = { id: l.id, type: l.type, source: l.source || null };
        entry.vis = (l.layout && l.layout.visibility) || "visible";
        if (l.type === "raster") {
          entry.paint = l.paint || {};
        }
        if (l.type === "fill") {
          entry.paint = {
            "fill-color": l.paint && l.paint["fill-color"],
            "fill-opacity": l.paint && l.paint["fill-opacity"],
          };
        }
        if (l.type === "line") {
          entry.paint = {
            "line-color": l.paint && l.paint["line-color"],
            "line-width": l.paint && l.paint["line-width"],
          };
        }
        return entry;
      });
      // Image sources (overlay) serialize coordinates in the style JSON.
      const imageSources = {};
      for (const [id, src] of Object.entries(style.sources || {})) {
        if (src.type === "image") {
          imageSources[id] = { url: src.url, coordinates: src.coordinates };
        }
      }
      out.maps[slot] = {
        center: [map.getCenter().lng, map.getCenter().lat],
        zoom: map.getZoom(),
        loaded: map.loaded(),
        rasterSources,
        imageSources,
        layers,
      };
    }
    // A/B chip texts + divider clip-path wrapper
    const labels = Array.from(document.querySelectorAll("span"))
      .map((s) => (s.textContent || "").trim())
      .filter((t) => /^[AB] · /.test(t));
    const clipWrappers = Array.from(document.querySelectorAll("div")).filter((d) => {
      const cp = d.style && d.style.clipPath;
      return cp && cp.includes("inset");
    }).map((d) => ({ clipPath: d.style.clipPath, canvases: d.querySelectorAll("canvas").length }));
    const totalCanvases = document.querySelectorAll("canvas").length;
    return { ...out, labels, clipWrappers, totalCanvases };
  });
}

async function shoot(page, name) {
  const file = path.join(OUT_DIR, `${RUN_TAG}_${name}.png`);
  await page.screenshot({ path: file });
  log(`SHOT ${name} -> ${file}`);
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
    const text = msg.text();
    if (text.includes("[swipe")) log(`CONSOLE ${msg.type()}: ${text.slice(0, 500)}`);
    if (msg.type() === "error") {
      const t = text.slice(0, 300);
      consoleErrors.push(t);
      log(`CONSOLE ERROR: ${t}`);
    }
  });
  page.on("pageerror", (err) => {
    const t = `PAGEERROR ${String(err).slice(0, 300)}`;
    consoleErrors.push(t);
    log(t);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) log(`NAVIGATED: ${frame.url()}`);
  });
  page.on("crash", () => log("PAGE CRASHED"));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 60000 });
  await page.waitForTimeout(5000);

  // 1. district search
  log(`searching district: ${DISTRICT}`);
  await page.selectOption("#filter-district", { label: DISTRICT });
  const scenesPromise = page.waitForResponse(
    (r) => r.url().includes("/api/scenes") && r.request().method() === "POST",
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: /search imagery/i }).click();
  const scenesResp = await scenesPromise;
  log(`scenes: ${scenesResp.status()}`);
  await page.waitForTimeout(2500);

  // diagnostics: what did the search yield / is the arm button there?
  const armBtn = await page.$('button[title="Compare two dates for this area"]');
  log(`arm button present: ${Boolean(armBtn)}`);
  if (!armBtn) {
    await shoot(page, "diag_no_arm_button");
    const info = await page.evaluate(() => {
      const strip = document.querySelector('section[aria-label="Search results"]');
      return {
        stripText: strip ? strip.textContent.slice(0, 500) : null,
        titles: Array.from(document.querySelectorAll("button[title]")).map((b) => b.title).slice(0, 30),
      };
    });
    log(`diag: ${JSON.stringify(info, null, 2)}`);
    await browser.close();
    process.exit(1);
  }

  // 2. arm compare (strip collapses to slim → expand it to reach A/B buttons)
  await page.click('button[title="Compare two dates for this area"]');
  await page.waitForTimeout(500);
  const expandBtn = await page.$('button[aria-label="Show scene cards"]');
  if (expandBtn) {
    await expandBtn.click();
    log("expanded scene cards strip");
  }
  await page.waitForSelector('button[aria-label^="Date A: "]', { timeout: 30000 });

  const dates = await page.$$eval('button[aria-label^="Date A: "]', (els) =>
    els.map((el) => el.getAttribute("aria-label").replace("Date A: ", "")),
  );
  log(`scene dates (${dates.length}): ${dates.join(", ")}`);

  // 3. reversed pick: LATER as A, EARLIER as B (the normalization bug case)
  const sorted = [...dates].sort();
  if (sorted.length < 2) throw new Error("Need at least 2 scene dates.");
  const earlier = sorted[0];
  const later = sorted[sorted.length - 1];
  const wantA = later; // deliberately reversed
  const wantB = earlier;
  log(`picking A=${wantA} (LATER) B=${wantB} (EARLIER) — reversed on purpose`);
  await page.click(`button[aria-label="Date A: ${wantA}"]`);
  await page.click(`button[aria-label="Date B: ${wantB}"]`);
  await page.waitForTimeout(400);

  // 4. analyze
  const analyzePromise = page.waitForResponse(
    (r) => r.url().includes("/api/compare/analyze") && r.request().method() === "POST",
    { timeout: 300000 },
  );
  await page.locator('button:has-text("Analyze")').first().click();
  const resp = await analyzePromise;
  log(`analyze: ${resp.status()} (headers — stream continues)`);
  if (resp.status() !== 200) {
    const body = await resp.text().catch(() => "");
    log(`analyze FAILED: ${body.slice(0, 500)}`);
    await browser.close();
    process.exit(1);
  }
  try {
    // Desktop renders this as <aside>, mobile as <section> — match either.
    await page.waitForSelector('[aria-label="Change detection results"]', {
      timeout: 300000,
    });
  } catch (e) {
    log(`drawer never opened: ${e.message.slice(0, 200)}`);
    const diag = await page.evaluate(() => {
      const sections = Array.from(document.querySelectorAll("section")).map((s) => ({
        aria: s.getAttribute("aria-label"),
        visible: !!(s.offsetWidth || s.offsetHeight),
      }));
      const analyzeBtn = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("Analyze"),
      );
      const strip = document.querySelector('section[aria-label="Search results"]');
      return {
        url: location.href,
        hasRieMaps: Boolean(window.__rieMaps),
        rieMapSlots: Object.keys(window.__rieMaps || {}),
        sections,
        analyzeBtn: analyzeBtn
          ? { text: analyzeBtn.textContent, disabled: analyzeBtn.disabled }
          : null,
        stripText: strip ? strip.textContent.slice(0, 1200) : null,
      };
    });
    log(`diag: ${JSON.stringify(diag, null, 2)}`);
    log(`collected errors so far: ${consoleErrors.length}`);
    consoleErrors.slice(0, 20).forEach((e2) => log(`  ${e2}`));
    await shoot(page, "diag_no_drawer");
    await browser.close();
    process.exit(1);
  }
  await page.waitForTimeout(5000);

  // 5. open Swipe tab
  await page.click('button[role="radio"], button:has-text("Swipe")').catch(() => null);
  await page.waitForTimeout(3500);

  // 6. dump + screenshots
  const dump = await dumpMaps(page);
  log(`\n=== SWIPE DUMP ===\n${JSON.stringify(dump, null, 2)}`);
  await shoot(page, "swipe_light_1440");
  await page.click('button[aria-label="Toggle theme"]');
  await page.waitForTimeout(1200);
  await shoot(page, "swipe_dark_1440");

  log(`\nconsole/page errors: ${consoleErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e) => log(`  ${e}`));

  await browser.close();
  process.exit(0);
})().catch((error) => {
  console.error("REPRO SWIPE CRASH:", error);
  process.exit(2);
});
