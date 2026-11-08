/**
 * Focused verification for the fix/lint-build-errors branch (uncommitted harness):
 *   (A) map → list hover linking (row highlights when map polygon/circle hovered)
 *   (B) list → map hover linking (accent ring + bigger marker on row hover)
 *   (C) class visibility toggle → overlay recolour (hide + roundtrip)
 *   (D) same checks in dark theme + screenshots for manual review
 *
 * Usage (production server must be running):
 *   NEXT_PUBLIC_DATA_SOURCE=cdse npm start   (or mock)
 *   node scripts/verify-fixes.browser.cjs
 *
 * Env: BASE_URL, CHROME_PATH, OUT_DIR (default artifacts/fixes)
 */
const { chromium } = require("playwright-core");
const { PNG } = require("pngjs");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = process.env.OUT_DIR || path.join("artifacts", "fixes");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

function diffPng(aBuf, bBuf, threshold = 12) {
  const a = PNG.sync.read(aBuf);
  const b = PNG.sync.read(bBuf);
  if (a.width !== b.width || a.height !== b.height) return -1;
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > threshold ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > threshold ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > threshold
    ) {
      changed += 1;
    }
  }
  return changed;
}

async function clipBox(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas.maplibregl-canvas") || document.querySelector("canvas");
    const r = canvas.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
}

async function shot(page, name, clip) {
  const file = path.join(OUT_DIR, `${name}.png`);
  const buf = await page.screenshot(clip ? { path: file, clip } : { path: file });
  console.log(`SHOT ${name} -> ${file}`);
  return buf;
}

/** Waits until two consecutive clipped screenshots are visually stable. */
async function stableShot(page, name, clip, { tries = 10, wait = 900, maxDiff = 120 } = {}) {
  let prev = await page.screenshot({ clip });
  for (let i = 0; i < tries; i++) {
    await page.waitForTimeout(wait);
    const next = await page.screenshot({ clip });
    const d = diffPng(prev, next);
    if (d >= 0 && d <= maxDiff) {
      const file = path.join(OUT_DIR, `${name}.png`);
      fs.writeFileSync(file, next);
      console.log(`SHOT ${name} -> ${file} (stable, control diff=${d})`);
      return { buf: next, control: d };
    }
    prev = next;
  }
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, prev);
  console.log(`SHOT ${name} -> ${file} (UNSTABLE after ${tries} tries)`);
  return { buf: prev, control: -1 };
}

async function readHoveredRank(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("ol li button"));
    const idx = rows.findIndex((b) => b.className.includes("border-accent/50"));
    return idx >= 0 ? idx + 1 : null;
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(4000);

  // ---- setup: Ajmer search + arm compare (wide window for a ~2-month pair)
  await page.selectOption("#filter-district", { label: "Ajmer" });
  await page.fill("#filter-from", "2026-08-01").catch(() => null);
  const scenesPromise = page.waitForResponse(
    (r) => r.url().includes("/api/scenes") && r.request().method() === "POST",
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: /search imagery/i }).click();
  const scenesResp = await scenesPromise;
  const scenesBody = await scenesResp.json().catch(() => ({ scenes: [] }));
  const sceneCount = (scenesBody.scenes || []).length;
  console.log(`scenes: ${scenesResp.status()} count=${sceneCount}`);
  check("scene search returns scenes", scenesResp.status() === 200 && sceneCount > 0, `count=${sceneCount}`);
  await page.waitForTimeout(1500);

  await page.click('button[title="Compare two dates for this area"]');
  // compare mode starts with the strip collapsed — expand the scene cards
  await page.locator('button[title^="Show scene cards"]').first().click().catch(() => null);
  await page.waitForSelector('button[aria-label^="Date A: "]', { timeout: 30000 });

  const dates = await page.$$eval('button[aria-label^="Date A: "]', (els) =>
    els.map((el) => el.getAttribute("aria-label").replace("Date A: ", "")),
  );
  console.log(`scene dates (${dates.length}): ${dates.join(", ")}`);
  const sorted = [...dates].sort();
  const aug = sorted.find((d) => d >= "2026-08-01" && d <= "2026-08-15");
  const octLate = sorted.filter((d) => d >= "2026-10-16").pop();
  const dateA = aug || sorted[0];
  const dateB = octLate || sorted[sorted.length - 1];
  if (!dateA || !dateB || dateA === dateB) throw new Error("Could not pick two distinct dates.");
  const gapDays = Math.round((Date.parse(dateB) - Date.parse(dateA)) / 86400000);
  console.log(`pair: ${dateA} -> ${dateB} (${gapDays} days)`);

  await page.click(`button[aria-label="Date A: ${dateA}"]`);
  await page.click(`button[aria-label="Date B: ${dateB}"]`);

  const analyzePromise = page.waitForResponse(
    (r) => r.url().includes("/api/compare/analyze") && r.request().method() === "POST",
    { timeout: 300000 },
  );
  await page.locator('button:has-text("Analyze")').first().click();
  const analyzeResp = await analyzePromise;
  console.log(`analyze: ${analyzeResp.status()} ${analyzeResp.status() !== 200 ? await analyzeResp.text() : ""}`);
  check("analyze 200", analyzeResp.status() === 200, `status=${analyzeResp.status()}`);
  // desktop renders an <aside>, mobile a <section> — match either
  try {
    await page.waitForSelector('[aria-label="Change detection results"]', { timeout: 8000 });
  } catch {
    await page.locator('button:has-text("Show results")').first().click().catch(() => null);
    await page.waitForSelector('[aria-label="Change detection results"]', { timeout: 30000 });
  }
  await page.waitForTimeout(4000);

  // ---- open Hotspots tab
  await page.locator('button:has-text("Hotspots")').first().click();
  await page.waitForTimeout(600);
  const rowCount = await page.locator("ol li button").count();
  check("hotspot rows rendered", rowCount > 0, `${rowCount} rows`);

  const clip = await clipBox(page);
  console.log(`map clip: ${JSON.stringify(clip)}`);

  // ================= TEST B-first target discovery is risky? No: A first (row -> map)
  const { buf: base, control } = await stableShot(page, "01_hotspots_idle_light", clip);
  check("control stable (light)", control >= 0 && control <= 120, `control=${control}`);

  // ---- (B) list -> map: hover row 1
  const row1 = page.locator("ol li button").first();
  await row1.hover();
  await page.waitForTimeout(700);
  const row1Class = await row1.evaluate((el) => el.className);
  check("row hover state class applied", row1Class.includes("border-accent/50"), row1Class.slice(-80));
  const hoverBuf = await page.screenshot({ clip, path: path.join(OUT_DIR, "02_row1_hover_light.png") });
  const dRowMap = diffPng(base, hoverBuf);
  check("list -> map: map pixels change on row hover", dRowMap > 30, `changed=${dRowMap}px`);

  // clear hover
  await page.mouse.move(20, 20);
  await page.waitForTimeout(700);
  const cleared = !(await row1.evaluate((el) => el.className.includes("border-accent/50")));
  check("row hover clears on leave", cleared);

  // ---- (A) map -> list: grid scan the map canvas until a row highlights
  await page.mouse.move(clip.x + 4, clip.y + 4);
  await page.waitForTimeout(300);
  let found = null;
  const step = 14;
  const x0 = clip.x + 8;
  const y0 = clip.y + 8;
  const x1 = clip.x + clip.width - 8;
  const y1 = clip.y + clip.height - 8;
  scan: for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      await page.mouse.move(x, y);
      const rank = await readHoveredRank(page);
      if (rank !== null) {
        found = { rank, x, y };
        break scan;
      }
    }
    if (y - y0 > 40 && y % (step * 20) < step) {
      process.stdout.write(`scan y=${Math.round(y)}\n`);
    }
  }
  check("map -> list: row highlights on map hover", Boolean(found), found ? `rank=${found.rank} @${found.x},${found.y}` : "no row highlighted across full-canvas scan");
  if (found) {
    await shot(page, "03_map_hover_row_highlight_light"); // full page: shows highlighted row + accent ring
    await page.mouse.move(clip.x + 4, clip.y + 4);
    await page.waitForTimeout(500);
    check("map hover clears on leave", (await readHoveredRank(page)) === null);
  }

  // ================= (C) class visibility toggle (Change map tab, light)
  await page.locator('button:has-text("Change map")').first().click();
  await page.waitForTimeout(800);
  const { buf: cmBase, control: cmControl } = await stableShot(page, "04_changemap_idle_light", clip);
  check("control stable (change map)", cmControl >= 0 && cmControl <= 120, `control=${cmControl}`);

  // pick a class that actually has pixels (legend rows show "% of valid")
  const hideBtn = await (async () => {
    const buttons = page.locator('button[title^="Hide "]');
    const n = await buttons.count();
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      const pct = parseFloat(((await b.innerText()).match(/([\d.]+)\s*%/) || [])[1] || "0");
      if (pct > 1) return b;
    }
    return buttons.first();
  })();
  const hideTitle = await hideBtn.getAttribute("title");
  const legendLabel = hideTitle.replace("Hide ", "");
  const pressedBefore = await hideBtn.getAttribute("aria-pressed");
  await hideBtn.click();
  await page.waitForTimeout(1200);
  const showBtn = page.locator(`button[title="Show ${legendLabel}"]`);
  const pressedAfter = await showBtn.getAttribute("aria-pressed").catch(() => null);
  check("legend toggle flips aria-pressed", pressedBefore === "true" && pressedAfter === "false", `${hideTitle} -> aria-pressed=${pressedAfter}`);
  const hiddenBuf = await page.screenshot({ clip, path: path.join(OUT_DIR, "05_class_hidden_light.png") });
  const dHidden = diffPng(cmBase, hiddenBuf);
  check("class hide recolours overlay", dHidden > 300, `changed=${dHidden}px`);

  // roundtrip
  await showBtn.click();
  await page.waitForTimeout(1200);
  const restoredBuf = await page.screenshot({ clip, path: path.join(OUT_DIR, "06_class_restored_light.png") });
  const dRestored = diffPng(cmBase, restoredBuf);
  check("class restore returns to baseline", dRestored >= 0 && dRestored <= 120, `changed=${dRestored}px`);

  // ================= (D) dark theme
  await page.click('button[aria-label="Toggle theme"]');
  await page.waitForTimeout(1800);
  await shot(page, "07_changemap_idle_dark", clip);

  // dark: class toggle again
  const hideDark = page.locator('button[title^="Hide "]').first();
  const darkLabel = (await hideDark.getAttribute("title")).replace("Hide ", "");
  await hideDark.click();
  await page.waitForTimeout(1200);
  const dDark = diffPng(cmBase, await page.screenshot({ clip, path: path.join(OUT_DIR, "08_class_hidden_dark.png") }));
  check("dark: class hide recolours overlay", dDark > 300, `changed=${dDark}px`);
  await page.locator(`button[title="Show ${darkLabel}"]`).click();
  await page.waitForTimeout(1000);

  // dark: row -> map hover
  await page.locator('button:has-text("Hotspots")').first().click();
  await page.waitForTimeout(600);
  const { buf: darkIdle } = await stableShot(page, "09_hotspots_idle_dark", clip);
  const rowDark = page.locator("ol li button").nth(Math.min(1, rowCount - 1));
  await rowDark.hover();
  await page.waitForTimeout(700);
  const dDarkHover = diffPng(darkIdle, await page.screenshot({ clip, path: path.join(OUT_DIR, "10_row_hover_dark.png") }));
  check("dark: list -> map pixels change on row hover", dDarkHover > 30, `changed=${dDarkHover}px`);

  // dark: map -> list scan (short — same mechanism, one confirmation)
  await page.mouse.move(clip.x + 4, clip.y + 4);
  await page.waitForTimeout(300);
  let foundDark = null;
  darkScan: for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      await page.mouse.move(x, y);
      const rank = await readHoveredRank(page);
      if (rank !== null) {
        foundDark = { rank, x, y };
        break darkScan;
      }
    }
  }
  check("dark: map -> list row highlight", Boolean(foundDark), foundDark ? `rank=${foundDark.rank}` : "no row highlighted");
  if (foundDark) await shot(page, "11_map_hover_dark");
  await page.mouse.move(20, 20);

  check("no page errors", pageErrors.length === 0, pageErrors[0] || "");
  check("no console errors", consoleErrors.length === 0, consoleErrors[0] || "");

  const failed = results.filter((r) => !r.ok);
  console.log(`\nVERIFY FIXES: ${results.length - failed.length}/${results.length} passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("VERIFY CRASH:", e);
  process.exit(2);
});
