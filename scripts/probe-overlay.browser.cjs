/**
 * Instrumented probe: why does the class-visibility recolour show 0px change?
 * Instruments blob creation + compare API fetches, histograms the base overlay,
 * then tests boost-off / class-hide with and without a map interaction.
 * Uncommitted diagnostic harness.
 */
const { chromium } = require("playwright-core");
const { PNG } = require("pngjs");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "artifacts/fixes";

const PALETTE = {
  waterGain: [56, 132, 255],
  waterLoss: [226, 183, 45],
  vegLoss: [227, 99, 44],
  vegGain: [45, 164, 78],
  bareBuilt: [170, 70, 190],
  masked: [165, 165, 165],
};

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
    ) changed++;
  }
  return changed;
}

(async () => {
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleMsgs = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

  await page.addInitScript(() => {
    window.__blobs = [];
    window.__revokes = [];
    window.__cmpFetches = [];
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj) => {
      const u = origCreate(obj);
      window.__blobs.push({ url: u, size: obj && obj.size, t: Date.now() });
      return u;
    };
    const origRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u) => {
      window.__revokes.push(u);
      return origRevoke(u);
    };
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      try {
        const u = String((args[0] && args[0].url) || args[0]);
        if (u.includes("/api/compare/")) window.__cmpFetches.push(u);
      } catch {}
      return origFetch.apply(this, args);
    };
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
  const scenesResp = await scenesP;
  const scenesBody = await scenesResp.json().catch(() => ({ scenes: [] }));
  console.log(`scenes=${(scenesBody.scenes || []).length}`);
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
  const text = await analyzeResp.text();
  let result = null;
  for (const line of text.split("\n").reverse()) {
    const s = line.trim();
    if (!s) continue;
    try {
      const j = JSON.parse(s);
      if (j && j.overlayUrl) { result = j; break; }
    } catch {}
  }
  if (!result) throw new Error("no final frame with overlayUrl in analyze stream");
  console.log(`overlayUrl=${result.overlayUrl}`);
  const pcts = (result.stats?.classes || []).map((c) => `${c.code}:${c.pctOfValid.toFixed(1)}%`).join(" ");
  console.log(`stats classes pct — ${pcts}`);

  // ---- histogram of the raw overlay PNG
  const hist = await page.evaluate(async (args) => {
    const r = await fetch(args.url);
    const bmp = await createImageBitmap(await r.blob());
    const cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const counts = {};
    let alpha0 = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) { alpha0++; continue; }
      const k = `${d[i]},${d[i + 1]},${d[i + 2]}`;
      counts[k] = (counts[k] || 0) + 1;
    }
    const palette = {};
    for (const [name, rgbv] of Object.entries(args.palette)) {
      palette[name] = counts[rgbv.join(",")] || 0;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    return { total: d.length / 4, alpha0, palette, top, width: cv.width, height: cv.height };
  }, { url: result.overlayUrl, palette: PALETTE });
  console.log(`overlay ${hist.width}x${hist.height} total=${hist.total} alpha0=${hist.alpha0}`);
  console.log("palette hits:", JSON.stringify(hist.palette));
  console.log("top colors:", JSON.stringify(hist.top));

  await page.waitForSelector('[aria-label="Change detection results"]', { timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(3500);

  // clip: map canvas minus the bottom scene strip
  const clip = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.maplibregl-canvas") || document.querySelector("canvas");
    const c = canvas.getBoundingClientRect();
    const strip = document.querySelector('section[aria-label="Search results"]');
    const s = strip ? strip.getBoundingClientRect() : null;
    const h = s && s.top > c.top ? Math.max(100, s.top - c.top) : c.height;
    return { x: Math.round(c.x), y: Math.round(c.y), width: Math.round(c.width), height: Math.round(h) };
  });
  console.log("clip", JSON.stringify(clip));

  const shot = (name) => page.screenshot({ clip, path: `${OUT}/${name}.png` });
  // stable baseline
  let prev = await page.screenshot({ clip });
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(900);
    const next = await page.screenshot({ clip });
    if (diffPng(prev, next) <= 60) { prev = next; break; }
    prev = next;
  }
  fsWrite(`${OUT}/p0_idle.png`, prev);
  const idle = prev;
  console.log("baseline settled");

  const blobsBefore = await page.evaluate(() => window.__blobs.length);

  // ---- A) boost OFF
  const boostBtn = page.locator('[aria-label="Change detection results"] button[title*="dilates"]');
  const boostTitle = await boostBtn.getAttribute("title");
  const boostBefore = await boostBtn.getAttribute("aria-checked");
  console.log(`boost switch: aria-checked=${boostBefore} title="${boostTitle}"`);
  await boostBtn.click();
  await page.waitForTimeout(1500);
  const boostPressed = await boostBtn.getAttribute("aria-checked");
  const aBuf = await shot("p1_boost_off");
  console.log(`A boost-off diff=${diffPng(idle, aBuf)} aria-checked=${boostPressed}`);

  // back on
  await boostBtn.click();
  await page.waitForTimeout(1500);
  const bBuf = await shot("p2_boost_on");
  console.log(`B boost-on-again diff=${diffPng(idle, bBuf)}`);

  // ---- C) hide veg-loss (scoped, pct>1)
  const legendBtns = page.locator('[aria-label="Change detection results"] button[title^="Hide "]');
  const n = await legendBtns.count();
  console.log(`drawer Hide buttons: ${n}`);
  let pick = null;
  for (let i = 0; i < n; i++) {
    const b = legendBtns.nth(i);
    const title = await b.getAttribute("title");
    const pct = parseFloat(((await b.innerText()).match(/([\d.]+)\s*%/) || [])[1] || "0");
    console.log(`  btn[${i}] "${title}" pct=${pct}`);
    if (!pick && pct > 1) pick = { b, title, pct };
  }
  if (!pick) throw new Error("no legend class with pct>1");
  await pick.b.click();
  await page.waitForTimeout(1500);
  const cBuf = await shot("p3_class_hidden");
  console.log(`C hide "${pick.title}" diff=${diffPng(idle, cBuf)}`);

  // ---- D) force a map interaction (repaint), then shoot again
  await page.mouse.move(clip.x + 40, clip.y + 40);
  await page.mouse.move(clip.x + 60, clip.y + 60);
  await page.waitForTimeout(1200);
  const dBuf = await shot("p4_after_interaction");
  console.log(`D after-mouse-move diff-vs-idle=${diffPng(idle, dBuf)} diff-vs-C=${diffPng(cBuf, dBuf)}`);

  const blobs = await page.evaluate(() => window.__blobs.map((b) => b.size));
  const revokes = await page.evaluate(() => window.__revokes.length);
  const cmpFetches = await page.evaluate(() => window.__cmpFetches);
  console.log(`blob creations after baseline: ${blobs.length - blobsBefore} sizes=${JSON.stringify(blobs)}`);
  console.log(`revokes=${revokes}`);
  console.log(`compare fetches: ${JSON.stringify(cmpFetches)}`);
  console.log(`console errors/warnings (${consoleMsgs.length}):`);
  consoleMsgs.slice(0, 20).forEach((m) => console.log("   " + m));
  console.log(`page errors (${pageErrors.length}):`);
  pageErrors.slice(0, 10).forEach((m) => console.log("   " + m));

  await browser.close();
})().catch((e) => {
  console.error("PROBE CRASH:", e);
  process.exit(2);
});

function fsWrite(p, buf) {
  require("node:fs").writeFileSync(p, buf);
}
