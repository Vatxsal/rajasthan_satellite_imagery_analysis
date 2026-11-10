/**
 * Swipe "Satellite basemap" mode verification harness (untracked).
 *
 * Runs one full analysis (Alwar district), opens the Swipe tab, then:
 *  1. dates mode  — left/right halves carry the two Sentinel dates + A/B labels,
 *  2. basemap mode — right half swaps to Esri World Imagery (tileSize 256),
 *                   labels become "Sentinel-2 · <date>" / "Satellite basemap",
 *                   the verbatim note "Basemap imagery is from a different date"
 *                   shows on the map AND in the drawer, the attribution chip
 *                   credits Esri, the AOI outline stays on both halves,
 *                   light + dark screenshots captured,
 *  3. back to dates — right half restores the date-B Sentinel tiles (512px),
 *                   labels/note/attribution revert.
 *
 * Usage (dev server must be running):
 *   node scripts/verify-swipe-basemap.browser.cjs
 *
 * Env:
 *   BASE_URL     default http://localhost:3000
 *   CHROME_PATH  explicit Chrome binary
 */
const { chromium } = require("playwright-core");
const { PNG } = require("pngjs");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SHOT_DIR = path.join("docs", "screenshots");
const ART_DIR = path.join("artifacts", "swipe");
const NOTE_TEXT = "Basemap imagery is from a different date";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function log(line) {
  console.log(line);
}

function fmtShort(iso) {
  const [y, m, d] = iso.split("-");
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeout = 30000, interval = 500, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label} (last=${JSON.stringify(last)})`);
}

const failures = [];
function check(cond, label, extra) {
  const suffix = extra ? ` — ${extra}` : "";
  if (cond) log(`  PASS ${label}`);
  else {
    failures.push(`${label}${suffix}`);
    log(`  FAIL ${label}${suffix}`);
  }
}

/** Left/right raster source tiles + tileSize, plus chip/note/attribution texts. */
async function snapshot(page) {
  return page.evaluate((noteText) => {
    const g = window.__rieMaps || {};
    const src = (m, id) => {
      const s = m && m.getSource(id);
      return s && s.tiles ? { tiles: s.tiles[0], tileSize: s.tileSize || null } : null;
    };
    const texts = Array.from(document.querySelectorAll("span")).map((s) =>
      (s.textContent || "").trim(),
    );
    const labels = texts.filter((t) => /^(A · |B · |Sentinel-2 · |Satellite basemap$)/.test(t));
    const notes = texts.filter((t) => t === noteText);
    const attribution = texts.find((t) => t.includes("Contains modified Copernicus Sentinel data")) || null;
    const outlineVis = (m, id) =>
      m && m.getLayer(id) ? m.getLayoutProperty(id, "visibility") || "visible" : null;
    return {
      left: src(g.left, "swipe-left-tiles"),
      right: src(g.right, "swipe-right-tiles"),
      labels,
      noteCount: notes.length,
      attribution,
      outlineLeft: outlineVis(g.left, "swipe-left-outline-line"),
      outlineRight: outlineVis(g.right, "swipe-right-outline-line"),
    };
  }, NOTE_TEXT);
}

/** Blue-dominant pixels matching the EMPTY_TILE wash signature. */
function probeBlue(png) {
  const { width, height, data } = png;
  const bugs = [];
  let samples = 0;
  for (let i = 0; i <= 11; i++) {
    for (let j = 0; j <= 6; j++) {
      const x = Math.round(24 + (i * 960) / 11);
      const y = Math.round(40 + (j * 672) / 6);
      if (x >= width || y >= height) continue;
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      samples += 1;
      if (b >= 200 && r <= 160 && g <= 160 && b - g >= 60) bugs.push({ x, y, r, g, b });
    }
  }
  return { bugs, samples };
}

(async () => {
  fs.mkdirSync(ART_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (err) => {
    pageErrors.push(String(err).slice(0, 300));
    log(`PAGEERROR: ${pageErrors[pageErrors.length - 1]}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") log(`CONSOLE ERROR: ${msg.text().slice(0, 300)}`);
  });

  try {
    // ---------------------------------------------------------- setup
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 60000 });
    await page.waitForTimeout(5000);

    log("searching Alwar…");
    await page.selectOption("#filter-district", { label: "Alwar" });
    const scenesPromise = page.waitForResponse(
      (r) => r.url().includes("/api/scenes") && r.request().method() === "POST",
      { timeout: 120000 },
    );
    await page.getByRole("button", { name: /search imagery/i }).click();
    const scenesResp = await scenesPromise;
    log(`scenes: ${scenesResp.status()}`);
    await page.waitForTimeout(2500);

    await page.click('button[title="Compare two dates for this area"]');
    await page.waitForTimeout(500);
    const expandBtn = await page.$('button[aria-label="Show scene cards"]');
    if (expandBtn) await expandBtn.click();
    await page.waitForSelector('button[aria-label^="Date A: "]', { timeout: 30000 });
    const dates = await page.$$eval('button[aria-label^="Date A: "]', (els) =>
      els.map((el) => el.getAttribute("aria-label").replace("Date A: ", "")),
    );
    log(`scene dates (${dates.length}): ${dates.join(", ")}`);
    if (dates.length < 2) throw new Error("need ≥2 scene dates");
    const sorted = [...dates].sort();
    const earlier = sorted[0];
    const later = sorted[sorted.length - 1];
    await page.click(`button[aria-label="Date A: ${later}"]`);
    await page.click(`button[aria-label="Date B: ${earlier}"]`);
    await page.waitForTimeout(400);

    // ---------------------------------------------------------- analyze
    const analyzePromise = page.waitForResponse(
      (r) => r.url().includes("/api/compare/analyze") && r.request().method() === "POST",
      { timeout: 300000 },
    );
    await page.locator('button:has-text("Analyze")').first().click();
    const resp = await analyzePromise;
    log(`analyze: ${resp.status()}`);
    if (resp.status() !== 200) {
      const body = await resp.text().catch(() => "");
      throw new Error(`analyze failed: ${body.slice(0, 300)}`);
    }
    await page.waitForSelector('[aria-label="Change detection results"]', { timeout: 300000 });
    await page.waitForTimeout(5000);

    // ---------------------------------------------------------- swipe tab
    await page.locator('button:has-text("Swipe")').first().click();
    await page.waitForTimeout(4000);
    await waitFor(
      () =>
        page.evaluate(() => {
          const g = window.__rieMaps || {};
          return Boolean(
            g.left && g.left.getSource("swipe-left-tiles") &&
              g.right && g.right.getSource("swipe-right-tiles"),
          );
        }),
      { timeout: 60000, label: "swipe tile sources attached on both maps" },
    );
    await page.waitForTimeout(2000);

    // ---------------------------------------------------------- 1. dates mode
    log("\n===== dates mode =====");
    let snap = await snapshot(page);
    check(Boolean(snap.left && snap.left.tiles.includes(`date=${earlier}`)), "left tiles = earlier date", snap.left && snap.left.tiles);
    check(Boolean(snap.right && snap.right.tiles.includes(`date=${later}`)), "right tiles = later date", snap.right && snap.right.tiles);
    check(snap.left && snap.left.tileSize === 512, "left tileSize 512", String(snap.left && snap.left.tileSize));
    check(snap.labels.includes(`A · ${fmtShort(earlier)}`), "label A shows earlier date", snap.labels.join(" | "));
    check(snap.labels.includes(`B · ${fmtShort(later)}`), "label B shows later date", snap.labels.join(" | "));
    check(snap.noteCount === 0, "no basemap note in dates mode", String(snap.noteCount));
    check(Boolean(snap.attribution && !snap.attribution.includes("Esri")), "attribution has no Esri in dates mode", snap.attribution);
    check(snap.outlineLeft === "visible" && snap.outlineRight === "visible", "outlines visible", `${snap.outlineLeft}/${snap.outlineRight}`);

    // dates-mode evidence shot (wait until both halves actually paint)
    await waitFor(
      () => page.evaluate(() => {
        const g = window.__rieMaps || {};
        const count = (m, layer) => {
          if (!m || !m.getLayer(layer)) return 0;
          try { return m.queryRenderedFeatures({ layers: [layer] }).length; } catch { return 0; }
        };
        return count(g.left, "swipe-left-outline-line") > 0 && count(g.right, "swipe-right-outline-line") > 0;
      }),
      { timeout: 30000, label: "outline features painted on both halves" },
    );
    await page.waitForTimeout(5000); // sentinel tiles finish streaming
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const datesShot = path.join(SHOT_DIR, "phase-sharp-swipe-dates-light.png");
    await page.screenshot({ path: datesShot });
    log(`SHOT ${datesShot}`);

    // ---------------------------------------------------------- 2. basemap mode
    log("\n===== basemap mode =====");
    await page.getByRole("group", { name: "Swipe right-hand side" })
      .getByRole("button", { name: "Satellite basemap" }).click();
    await waitFor(
      async () => {
        const s = await snapshot(page);
        return Boolean(s.right && s.right.tiles.includes("arcgisonline.com"));
      },
      { timeout: 20000, label: "right half switched to Esri tiles" },
    );
    await page.waitForTimeout(6000); // let Sentinel + Esri tiles finish rendering

    snap = await snapshot(page);
    check(Boolean(snap.right && snap.right.tiles.includes("arcgisonline.com")), "right tiles = Esri World Imagery", snap.right && snap.right.tiles);
    check(snap.right && snap.right.tileSize === 256, "right tileSize 256", String(snap.right && snap.right.tileSize));
    check(Boolean(snap.left && snap.left.tiles.includes(`date=${earlier}`)), "left tiles unchanged (earlier date)", snap.left && snap.left.tiles);
    check(snap.left && snap.left.tileSize === 512, "left tileSize still 512", String(snap.left && snap.left.tileSize));
    check(snap.labels.includes(`Sentinel-2 · ${fmtShort(earlier)}`), "left label = Sentinel-2 · date", snap.labels.join(" | "));
    check(snap.labels.includes("Satellite basemap"), "right label = Satellite basemap", snap.labels.join(" | "));
    check(!snap.labels.some((t) => t.startsWith("A · ") || t.startsWith("B · ")), "old A/B labels gone", snap.labels.join(" | "));
    check(snap.noteCount >= 1, "verbatim note visible on the map", String(snap.noteCount));
    check(Boolean(snap.attribution && snap.attribution.includes("Imagery © Esri")), "attribution credits Esri", snap.attribution);
    check(snap.outlineLeft === "visible" && snap.outlineRight === "visible", "outlines still visible on both halves", `${snap.outlineLeft}/${snap.outlineRight}`);

    // drawer: note + control state
    const drawer = await page.evaluate((noteText) => {
      const group = Array.from(document.querySelectorAll('[role="group"]')).find(
        (el) => el.getAttribute("aria-label") === "Swipe right-hand side",
      );
      const pressed = group
        ? Array.from(group.querySelectorAll("button")).map((b) => ({
            text: (b.textContent || "").trim(),
            pressed: b.getAttribute("aria-pressed"),
          }))
        : [];
      const body = document.body.innerText;
      return { pressed, noteInDrawer: body.includes(noteText) };
    }, NOTE_TEXT);
    check(
      drawer.pressed.some((b) => b.text === "Satellite basemap" && b.pressed === "true"),
      "drawer control shows Satellite basemap pressed",
      JSON.stringify(drawer.pressed),
    );
    check(drawer.noteInDrawer, "verbatim note present in the drawer");

    // screenshots (light + dark) + blue-wash probe
    const lightFile = path.join(SHOT_DIR, "phase-sharp-swipe-basemap-light.png");
    const lightBuf = await page.screenshot({ path: lightFile });
    log(`SHOT ${lightFile}`);
    const { bugs, samples } = probeBlue(PNG.sync.read(lightBuf));
    check(bugs.length === 0, `no blue-wash pixels (${samples} probes)`, JSON.stringify(bugs.slice(0, 5)));

    await page.click('button[aria-label="Toggle theme"]');
    await page.waitForTimeout(1500);
    const darkFile = path.join(SHOT_DIR, "phase-sharp-swipe-basemap-dark.png");
    await page.screenshot({ path: darkFile });
    log(`SHOT ${darkFile}`);
    const darkProbe = probeBlue(PNG.sync.read(fs.readFileSync(darkFile)));
    check(darkProbe.bugs.length === 0, `no blue-wash pixels in dark theme (${darkProbe.samples} probes)`, JSON.stringify(darkProbe.bugs.slice(0, 5)));
    await page.click('button[aria-label="Toggle theme"]');
    await page.waitForTimeout(800);

    // ---------------------------------------------------------- 3. back to dates
    log("\n===== back to dates mode =====");
    await page.getByRole("group", { name: "Swipe right-hand side" })
      .getByRole("button", { name: "Date B" }).click();
    await waitFor(
      async () => {
        const s = await snapshot(page);
        return Boolean(s.right && s.right.tiles.includes(`date=${later}`));
      },
      { timeout: 20000, label: "right half restored to date B tiles" },
    );
    await page.waitForTimeout(1000);
    snap = await snapshot(page);
    check(Boolean(snap.right && snap.right.tiles.includes(`date=${later}`)), "right tiles = later date again", snap.right && snap.right.tiles);
    check(snap.right && snap.right.tileSize === 512, "right tileSize back to 512", String(snap.right && snap.right.tileSize));
    check(snap.labels.includes(`B · ${fmtShort(later)}`), "label B restored", snap.labels.join(" | "));
    check(snap.noteCount === 0, "basemap note gone after switch back", String(snap.noteCount));
    check(Boolean(snap.attribution && !snap.attribution.includes("Esri")), "attribution without Esri again", snap.attribution);

    check(pageErrors.length === 0, "no page errors", pageErrors.join(" | "));

    fs.writeFileSync(
      path.join(ART_DIR, "verify-basemap-dump.json"),
      JSON.stringify({ earlier, later, failures, pageErrors }, null, 2),
    );
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  log("\n===== SUMMARY =====");
  if (failures.length === 0) {
    log("ALL CHECKS PASSED");
    process.exit(0);
  }
  failures.forEach((f) => log(`FAIL ${f}`));
  process.exit(1);
})().catch((error) => {
  console.error("VERIFY BASEMAP CRASH:", error);
  process.exit(2);
});
