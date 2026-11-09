/**
 * Swipe-tab verification harness (untracked).
 *
 * Verifies the Option B two-clean-maps fix end to end:
 *  - searches an area (Alwar district, then Behror tehsil),
 *  - arms Compare, deliberately picks LATER date as A and EARLIER as B,
 *  - analyzes, opens the Swipe tab,
 *  - asserts: main map has no date-A scene layer/overlay above tiles,
 *    left/right secondary maps carry swipe-*-tiles for the normalized
 *    A=earlier/B=later dates, clip wrappers, neutral outline layers,
 *    composite + outline toggles, dev tile badge counts, attribution chip,
 *    and NO blue-wash pixels (EMPTY_TILE regression) in a screenshot grid,
 *  - captures light/dark screenshots into docs/screenshots/.
 *
 * Usage (dev server must be running):
 *   node scripts/verify-swipe.browser.cjs
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

function checker(tag, failures) {
  return (cond, label, extra) => {
    const suffix = extra ? ` — ${extra}` : "";
    if (cond) log(`  PASS ${label}`);
    else {
      failures.push(`${tag}: ${label}${suffix}`);
      log(`  FAIL ${label}${suffix}`);
    }
  };
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
      for (const id of Object.keys(style.sources || {})) {
        const src = style.sources[id];
        if (src.type === "raster") {
          rasterSources[id] = { tiles: src.tiles || null, tileSize: src.tileSize || null };
        }
      }
      const layers = (style.layers || [])
        .filter((l) => l.source !== "openmaptiles")
        .map((l) => {
          const entry = { id: l.id, type: l.type, source: l.source || null };
          entry.vis = (l.layout && l.layout.visibility) || "visible";
          if (l.type === "raster") entry.paint = l.paint || {};
          if (l.type === "line") {
            entry.paint = {
              "line-color": l.paint && l.paint["line-color"],
              "line-width": l.paint && l.paint["line-width"],
            };
          }
          return entry;
        });
      const imageSources = {};
      for (const [id, src] of Object.entries(style.sources || {})) {
        if (src.type === "image") imageSources[id] = { url: src.url };
      }
      out.maps[slot] = {
        center: [map.getCenter().lng, map.getCenter().lat],
        zoom: map.getZoom(),
        rasterSources,
        imageSources,
        layers,
      };
    }
    const labels = Array.from(document.querySelectorAll("span"))
      .map((s) => (s.textContent || "").trim())
      .filter((t) => /^[AB] · /.test(t));
    const clipWrappers = Array.from(document.querySelectorAll("div")).filter((d) => {
      const cp = d.style && d.style.clipPath;
      return cp && cp.includes("inset");
    }).map((d) => ({ clipPath: d.style.clipPath, canvases: d.querySelectorAll("canvas").length }));
    const badge = document.querySelector('button[title^="Tile fetch counts"]');
    const attribution = Array.from(document.querySelectorAll("span")).map((s) =>
      (s.textContent || "").trim(),
    ).find((t) => t.includes("Contains modified Copernicus Sentinel data")) || null;
    return {
      ...out,
      labels,
      clipWrappers,
      badgeText: badge ? badge.textContent.trim() : null,
      attribution,
      theme: document.documentElement.getAttribute("data-theme") || "light",
    };
  });
}

/** Blue-dominant pixels matching the EMPTY_TILE wash signature. */
function probeBlue(png) {
  const { width, height, data } = png;
  const bugs = [];
  let samples = 0;
  const xs = [];
  const ys = [];
  for (let i = 0; i <= 11; i++) xs.push(Math.round(24 + (i * 960) / 11));
  for (let i = 0; i <= 6; i++) ys.push(Math.round(40 + (i * 672) / 6));
  for (const x of xs) {
    for (const y of ys) {
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

async function ensureTheme(page, want) {
  const current = await page.evaluate(
    () => document.documentElement.getAttribute("data-theme") || "light",
  );
  if (current !== want) {
    await page.click('button[aria-label="Toggle theme"]');
    await page.waitForTimeout(800);
  }
}

async function runArea(browser, opts) {
  const failures = [];
  const check = checker(opts.tag, failures);
  log(`\n===== AREA ${opts.tag} (district=${opts.district}, tehsil=${opts.tehsil || "-"}) =====`);

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
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 60000 });
    await page.waitForTimeout(5000);
    await ensureTheme(page, "light");

    // ---------------------------------------------------------- search
    log("searching…");
    await page.selectOption("#filter-district", { label: opts.district });
    if (opts.tehsil) {
      await page.waitForSelector("#filter-tehsil", { timeout: 30000 });
      await page.selectOption("#filter-tehsil", { label: opts.tehsil });
    }
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

    // ---------------------------------------------------------- reversed picks
    const sorted = [...dates].sort();
    const earlier = sorted[0];
    const later = sorted[sorted.length - 1];
    log(`picking A=${later} (LATER) B=${earlier} (EARLIER) — normalization must swap`);
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
    const styleState = await page.evaluate(() => {
      const m = window.__rieMaps && window.__rieMaps.main;
      return m ? m.isStyleLoaded() : null;
    });
    log(`main.isStyleLoaded() right after swipe click: ${styleState}`);
    await page.waitForTimeout(4000);

    await waitFor(
      async () =>
        page.evaluate(() => {
          const g = window.__rieMaps || {};
          return Boolean(g.left && g.right && g.main);
        }),
      { timeout: 30000, label: "left/right/main debug maps" },
    );
    // Map instances exist before their style loads — wait until both have
    // actually attached their tile sources (and outline, same effect flush).
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

    // ---------------------------------------------------------- assertions
    const dump = await dumpMaps(page);
    const left = dump.maps.left;
    const right = dump.maps.right;
    const main = dump.maps.main;
    check(Boolean(left && right && main), "debug maps registered (main/left/right)", dump.slots.join(","));

    // 1. layer cleanup: no date-A scene layer / no compare layers on main
    const mainIds = main ? main.layers.map((l) => l.id) : [];
    check(!mainIds.some((id) => id.includes("compare-scene-a")), "main map has no compare-scene-a layer");
    // Tab-gated visibility applies immediately or via the deferred idle sync —
    // wait for it before trusting the dump below.
    try {
      await waitFor(
        () =>
          page.evaluate(() => {
            const m = (window.__rieMaps || {}).main;
            if (!m) return false;
            const vis = (id) => {
              const l = m.getStyle().layers.find((x) => x.id === id);
              if (!l) return "none";
              return (l.layout && l.layout.visibility) || "visible";
            };
            return vis("compare-overlay-layer") === "none" && vis("compare-hotspot-fill") === "none";
          }),
        { timeout: 20000, label: "tab-gated main layers hidden after swipe switch" },
      );
      check(true, "main-map overlay + hotspots hidden during swipe");
    } catch (e) {
      check(false, "main-map overlay + hotspots hidden during swipe", e.message.slice(0, 140));
    }

    // 2. secondary maps: raw tiles per normalized date + neutral outline
    const leftSrc = left && left.rasterSources["swipe-left-tiles"];
    const rightSrc = right && right.rasterSources["swipe-right-tiles"];
    check(Boolean(leftSrc), "left map has swipe-left-tiles source");
    check(Boolean(rightSrc), "right map has swipe-right-tiles source");
    const leftUrl = leftSrc && leftSrc.tiles && leftSrc.tiles[0];
    const rightUrl = rightSrc && rightSrc.tiles && rightSrc.tiles[0];
    check(
      Boolean(leftUrl && leftUrl.includes(`date=${earlier}`)),
      "left (A) tiles use the EARLIER date",
      leftUrl,
    );
    check(
      Boolean(rightUrl && rightUrl.includes(`date=${later}`)),
      "right (B) tiles use the LATER date",
      rightUrl,
    );
    check(
      Boolean(leftUrl && leftUrl.includes("composite=true-color") && rightUrl && rightUrl.includes("composite=true-color")),
      "tiles default to true-color composite",
    );

    // 3. A/B labels reflect normalization
    const labelA = dump.labels.find((t) => t.startsWith("A · "));
    const labelB = dump.labels.find((t) => t.startsWith("B · "));
    check(Boolean(labelA && labelA.includes(fmtShort(earlier))), "label A shows the earlier date", labelA);
    check(Boolean(labelB && labelB.includes(fmtShort(later))), "label B shows the later date", labelB);

    // 4. clip wrappers: exactly two halves, each with a canvas
    check(dump.clipWrappers.length === 2, "exactly two clip wrappers", String(dump.clipWrappers.length));
    // Chrome serializes unitless zeros as "0px".
    const leftClip = dump.clipWrappers.find((w) => /^inset\(0(px)? [\d.]+%(px)? 0(px)? 0(px)?\)$/.test(w.clipPath));
    const rightClip = dump.clipWrappers.find((w) => /^inset\(0(px)? 0(px)? 0(px)? [\d.]+%(px)?\)$/.test(w.clipPath));
    check(Boolean(leftClip && leftClip.canvases === 1), "left wrapper clips left half with 1 canvas", JSON.stringify(leftClip));
    check(Boolean(rightClip && rightClip.canvases === 1), "right wrapper clips right half with 1 canvas", JSON.stringify(rightClip));

    // 5. secondary maps carry ONLY swipe-* (no app compare/overlay/selection layers)
    const banned = ["compare-", "selection", "imagery", "hotspot", "choropleth", "shimmer"];
    for (const [slot, mapObj] of [["left", left], ["right", right]]) {
      const bad = (mapObj ? mapObj.layers : []).map((l) => l.id).filter((id) => banned.some((b) => id.includes(b)));
      check(bad.length === 0, `${slot} map has no app overlay/selection layers`, bad.join(","));
    }

    // 6. outline layers present + visible, neutral colour
    for (const [slot, mapObj] of [["left", left], ["right", right]]) {
      const line = mapObj && mapObj.layers.find((l) => l.id === `swipe-${slot}-outline-line`);
      check(Boolean(line), `${slot} map has the AOI outline line layer`);
      check(Boolean(line) && line.vis === "visible", `${slot} outline visible by default`);
      check(
        Boolean(line) && String(line.paint && line.paint["line-color"]) === "rgb(75, 85, 99)",
        `${slot} outline colour is neutral grey`,
        line ? String(line.paint && line.paint["line-color"]) : "n/a",
      );
    }

    // 7. attribution chip
    check(Boolean(dump.attribution && dump.attribution.includes("Copernicus")), "attribution chip shown", dump.attribution);

    // badge counts per date (poll — tiles stream in; badge mounts with the tally)
    let badgeText = dump.badgeText;
    const wantDays = [earlier.slice(5), later.slice(5)];
    try {
      await waitFor(
        async () => {
          const text = await page.evaluate(() => {
            const badge = document.querySelector('button[title^="Tile fetch counts"]');
            return badge ? badge.textContent.trim() : null;
          });
          badgeText = text;
          if (!text) return false;
          return wantDays.every((day) => {
            const m = text.match(new RegExp(`${day} (\\d+) ok( (\\d+) skip)?`));
            if (!m) return false;
            const ok = Number(m[1]);
            const skip = m[3] ? Number(m[3]) : 0;
            return ok + skip >= 1;
          });
        },
        { timeout: 60000, label: "badge counts for both dates" },
      );
      check(true, "dev tile badge shows fetched tiles for both dates", badgeText);
    } catch (e) {
      check(false, "dev tile badge shows fetched tiles for both dates", `${badgeText} (${e.message.slice(0, 80)})`);
    }
    if (badgeText && badgeText.includes("429")) log(`  WARN rate-limited tiles: ${badgeText}`);

    // 8. composite toggle (True colour → False colour → back)
    const falseColour = page.getByRole("group", { name: "Swipe imagery composite" })
      .getByRole("button", { name: "False colour" });
    await falseColour.click();
    await page.waitForTimeout(800);
    let urls = await page.evaluate(() => {
      const g = window.__rieMaps;
      const t = (m, id) => {
        const s = m && m.getSource(id);
        return s && s.tiles ? s.tiles[0] : null;
      };
      return { left: t(g.left, "swipe-left-tiles"), right: t(g.right, "swipe-right-tiles") };
    });
    check(
      Boolean(urls.left && urls.left.includes("composite=false-color") && urls.right && urls.right.includes("composite=false-color")),
      "composite switch reloads both halves as false-colour",
      JSON.stringify(urls),
    );
    await page.getByRole("group", { name: "Swipe imagery composite" })
      .getByRole("button", { name: "True colour" }).click();
    await page.waitForTimeout(800);
    urls = await page.evaluate(() => {
      const g = window.__rieMaps;
      const t = (m, id) => {
        const s = m && m.getSource(id);
        return s && s.tiles ? s.tiles[0] : null;
      };
      return { left: t(g.left, "swipe-left-tiles"), right: t(g.right, "swipe-right-tiles") };
    });
    check(
      Boolean(urls.left && urls.left.includes("composite=true-color") && urls.right && urls.right.includes("composite=true-color")),
      "composite switch restores true-colour on both halves",
    );

    // 9. outline toggle off/on
    const outlineSwitch = page.locator('button[role="switch"]:has-text("Area outline")');
    await outlineSwitch.click();
    await page.waitForTimeout(600);
    let outlineVis = await page.evaluate(() => {
      const g = window.__rieMaps;
      const vis = (m, id) => (m && m.getLayer(id) ? m.getLayoutProperty(id, "visibility") || "visible" : null);
      return { left: vis(g.left, "swipe-left-outline-line"), right: vis(g.right, "swipe-right-outline-line") };
    });
    check(outlineVis.left === "none" && outlineVis.right === "none", "outline switch hides both outlines", JSON.stringify(outlineVis));
    await outlineSwitch.click();
    await page.waitForTimeout(600);
    outlineVis = await page.evaluate(() => {
      const g = window.__rieMaps;
      const vis = (m, id) => (m && m.getLayer(id) ? m.getLayoutProperty(id, "visibility") || "visible" : null);
      return { left: vis(g.left, "swipe-left-outline-line"), right: vis(g.right, "swipe-right-outline-line") };
    });
    check(outlineVis.left === "visible" && outlineVis.right === "visible", "outline switch restores both outlines", JSON.stringify(outlineVis));

    // 10. screenshots (light) + blue-wash pixel probe
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const lightFile = path.join(SHOT_DIR, `swipe-${opts.tag}-light.png`);
    const lightBuf = await page.screenshot({ path: lightFile });
    log(`SHOT ${lightFile}`);
    const { bugs, samples } = probeBlue(PNG.sync.read(lightBuf));
    check(bugs.length === 0, `no blue-wash pixels (${samples} probes)`, JSON.stringify(bugs.slice(0, 5)));

    // 11. dark screenshot
    await page.click('button[aria-label="Toggle theme"]');
    await page.waitForTimeout(1500);
    const darkFile = path.join(SHOT_DIR, `swipe-${opts.tag}-dark.png`);
    await page.screenshot({ path: darkFile });
    log(`SHOT ${darkFile}`);
    const darkProbe = probeBlue(PNG.sync.read(fs.readFileSync(darkFile)));
    check(darkProbe.bugs.length === 0, `no blue-wash pixels in dark theme (${darkProbe.samples} probes)`, JSON.stringify(darkProbe.bugs.slice(0, 5)));

    fs.writeFileSync(
      path.join(ART_DIR, `verify-${opts.tag}-dump.json`),
      JSON.stringify({ dump, failures, pageErrors }, null, 2),
    );
    log(`dump → ${path.join(ART_DIR, `verify-${opts.tag}-dump.json`)}`);
    check(pageErrors.length === 0, "no page errors", pageErrors.join(" | "));
    return failures;
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  fs.mkdirSync(ART_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);

  const failures = [];
  try {
    failures.push(...(await runArea(browser, { tag: "alwar", district: "Alwar" })));
    // Fresh minute window for the tile rate limiter before the next burst.
    log("\nwaiting 61s for the tile rate-limit window to reset…");
    await sleep(61_000);
    failures.push(
      ...(await runArea(browser, { tag: "behror", district: "Alwar", tehsil: "Behror" })),
    );
  } finally {
    await browser.close();
  }

  log("\n===== SUMMARY =====");
  if (failures.length === 0) {
    log("ALL CHECKS PASSED");
    fs.writeFileSync(path.join(ART_DIR, "verify-summary.json"), JSON.stringify({ ok: true, failures: [] }, null, 2));
    process.exit(0);
  }
  failures.forEach((f) => log(`FAIL ${f}`));
  fs.writeFileSync(path.join(ART_DIR, "verify-summary.json"), JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
})().catch((error) => {
  console.error("VERIFY SWIPE CRASH:", error);
  process.exit(2);
});
