/**
 * Live verification harness (NOT committed): Phase 1 map inspector +
 * Phase 2 fields colouring against the dev server on :3000.
 *
 *   node .verify-inspector-fields.cjs
 *
 * Desktop (1440x900, light + dark) then phone (390x844, light + dark).
 * Screenshots → docs/screenshots/inspector-*.png, fields-*.png
 * Exit code 1 if any assertion fails.
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const { SignJWT } = require("jose");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "docs/screenshots";
const results = [];
let debugShot = 0;

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function readSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const m = fs.readFileSync(".env.local", "utf8").match(/^SESSION_SECRET=(.+)$/m);
  if (!m) throw new Error("SESSION_SECRET not found");
  return m[1].trim();
}

async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path });
  log(`  shot ${path}`);
  return path;
}

async function debugShotFn(page, why) {
  try {
    await shot(page, `verify-DEBUG-${++debugShot}-${why}`);
  } catch {}
}

async function waitForMap(page) {
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForFunction(() => window.__rieMaps && window.__rieMaps.main, null, {
    timeout: 30000,
  });
  // The map object exists before the style loads — wait until the loading
  // placeholder is gone AND the controls (rendered on style idle) are up.
  await page.waitForSelector("text=Loading map…", { state: "detached", timeout: 60000 });
  await page.waitForSelector('button[aria-label="Inspect map centre"]', { timeout: 60000 });
  await page.waitForTimeout(1000);
}

async function setTheme(page, want) {
  const current = await page.evaluate(
    () => document.documentElement.getAttribute("data-theme") || "light",
  );
  if (current === want) return;
  await page.click('button[aria-label="Toggle theme"]');
  await page.waitForFunction(
    (t) => document.documentElement.getAttribute("data-theme") === t,
    want,
    { timeout: 8000 },
  );
  await page.waitForTimeout(600);
}

async function jumpMap(page, center, zoom) {
  await page.evaluate(
    ([c, z]) => {
      const map = window.__rieMaps && window.__rieMaps.main;
      if (!map) throw new Error("window.__rieMaps.main missing");
      map.jumpTo({ center: c, zoom: z, duration: 0 });
    },
    [center, zoom],
  );
  await page.waitForTimeout(1200);
}

/** Reads fields paint/layout state from the live MapLibre map. */
function readPaint(page) {
  return page.evaluate(() => {
    const map = window.__rieMaps.main;
    const ser = (layer, prop, kind) => {
      try {
        if (!map.getLayer(layer)) return "NO_LAYER";
        const v = kind === "layout" ? map.getLayoutProperty(layer, prop) : map.getPaintProperty(layer, prop);
        return typeof v === "string" ? v : JSON.stringify(v);
      } catch (e) {
        return `ERR ${e.message}`;
      }
    };
    let feats = [];
    try {
      feats = map.queryRenderedFeatures({ layers: ["fields-fill"] });
    } catch {}
    return {
      fillColor: ser("fields-fill", "fill-color", "paint"),
      fillOpacity: ser("fields-fill", "fill-opacity", "paint"),
      lineColor: ser("fields-line", "line-color", "paint"),
      fillVisibility: ser("fields-fill", "visibility", "layout"),
      lineVisibility: ser("fields-line", "visibility", "layout"),
      renderedCount: feats.length,
      clsPresent: feats.some((f) => f.properties && f.properties.cls),
      sampleCls: feats.slice(0, 4).map((f) => f.properties && f.properties.cls),
    };
  });
}

/** Clicks Load fields for scope; resolves the fields JSON. */
async function loadFields(page) {
  const respP = page.waitForResponse(
    (r) =>
      r.url().includes("/api/fields") &&
      !r.url().includes("/pattern") &&
      r.request().method() === "POST",
    { timeout: 300000 },
  );
  await page.getByRole("button", { name: /load fields for scope/i }).click();
  const resp = await respP;
  const body = await resp.json().catch(() => null);
  if (resp.status() !== 200 || !body) {
    const msg = body && body.message ? `${body.code}: ${body.message}` : `HTTP ${resp.status()}`;
    throw new Error(`fields load failed — ${msg}`);
  }
  await page.waitForFunction(
    () => /\d[\d,]*\s+fields?/.test(document.body.innerText),
    { timeout: 20000 },
  );
  return body;
}

/** Runs the cropping pattern to completion; resolves the result JSON. */
async function runPattern(page) {
  const respP = page.waitForResponse(
    async (r) => {
      if (!r.url().includes("/api/fields/pattern") || r.request().method() !== "POST") return false;
      try {
        const t = await r.text();
        return t.includes('"type":"result"') || t.includes('"type":"error"');
      } catch {
        return false;
      }
    },
    { timeout: 300000 },
  );
  await page.getByRole("button", { name: /run cropping pattern/i }).click();
  const resp = await respP;
  const text = await resp.text();
  if (text.includes('"type":"error"')) {
    const m = text.match(/"message":"([^"]*)"/);
    throw new Error(`pattern error frame: ${m ? m[1] : text.slice(0, 200)}`);
  }
  if (resp.status() !== 200) throw new Error(`pattern HTTP ${resp.status()}`);
  return JSON.parse(text.trim().split("\n").pop());
}

const inspectorCard = (page) => page.locator('[data-testid="map-inspector"]');
const phoneDialog = (page) => page.getByRole("dialog", { name: "Map inspector" });

async function inspectorState(page, phone) {
  const card = phone ? phoneDialog(page) : inspectorCard(page);
  const visible = (await card.count()) > 0 && (await card.first().isVisible());
  if (!visible) return { visible: false };
  const text = await card.first().innerText();
  return {
    visible: true,
    location: /section|location/i.test(text) && text.length > 0,
    hasLocationSection: (await card.first().locator('section[aria-label="Location"]').count()) > 0,
    hasFieldSection: (await card.first().locator('section[aria-label="Field"]').count()) > 0,
    hasActions: (await card.first().locator('section[aria-label="Actions"]').count()) > 0,
    copyCoords:
      (await card.first().locator('button[aria-label="Copy coordinates"]').count()) > 0,
    coord: /\d{1,3}\.\d{4,}/.test(text),
    text,
  };
}

/**
 * Screen point verified to hit a rendered field polygon: projects candidate
 * centroids, then confirms queryRenderedFeatures at that exact point (ring
 * averages can fall outside concave parcels). Safe box keeps the point away
 * from controls/panels/sheets. Returns null when nothing fits.
 */
function pickFieldPoint(page, box) {
  return page.evaluate((safe) => {
    const map = window.__rieMaps.main;
    let feats = [];
    try {
      feats = map.queryRenderedFeatures({ layers: ["fields-fill"] });
    } catch {
      return null;
    }
    for (const f of feats.slice(0, 60)) {
      const g = f.geometry;
      const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
      const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
      const lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
      const p = map.project([lng, lat]);
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (x < safe.x0 || x > safe.x1 || y < safe.y0 || y > safe.y1) continue;
      let hits = [];
      try {
        hits = map.queryRenderedFeatures({ point: [x, y], layers: ["fields-fill"] });
      } catch {
        hits = [];
      }
      if (hits.length > 0) {
        // project() is canvas-relative; Playwright clicks are viewport-relative.
        const rect = map.getCanvas().getBoundingClientRect();
        const vx = Math.round(rect.left + x);
        const vy = Math.round(rect.top + y);
        const el = document.elementFromPoint(vx, vy);
        return {
          x: vx,
          y: vy,
          diag: {
            canvas: { x, y },
            hitCount: hits.length,
            hitId: hits[0].id ?? null,
            propsKeys: Object.keys(hits[0].properties ?? {}),
            propsId: hits[0].properties?.id ?? null,
            element: el ? `${el.tagName}.${String(el.className).slice(0, 60)}` : null,
          },
        };
      }
    }
    return null;
  }, box);
}

function openFieldsTab(page) {
  return page.getByRole("button", { name: "Fields & crops" }).click();
}

/** Phone: bottom tab bar → panel sheet → "Fields" tab. */
async function openFieldsTabPhone(page) {
  await page.locator('nav[aria-label="Sections"] button', { hasText: "Filters" }).click();
  await page.getByRole("dialog", { name: "Panel" }).waitFor({ timeout: 10000 });
  await page.getByRole("tab", { name: "Fields", exact: true }).click();
  await page.waitForSelector("text=Load fields for scope", { timeout: 20000 });
}

/* ══════════════════════════════════ desktop ══════════════════════════════ */
async function desktopFlow(browser, secret) {
  const token = await new SignJWT({ role: "sso", sub: "verify-sso", name: "Verify SSO" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(secret));

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: {
      cookies: [
        {
          name: "rse_session",
          value: token,
          domain: "localhost",
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        },
      ],
    },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("PAGEERROR:", String(e).slice(0, 200)));
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().includes("/api/")) {
      log(`HTTP ${r.status()} ${r.url().slice(0, 120)}`);
    }
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForMap(page);
  await setTheme(page, "light");

  /* ── Phase 1: inspector ─────────────────────────────────────────── */
  log("── P1 desktop ──");
  const centreBtn = page.locator('button[aria-label="Inspect map centre"]');
  check("P1 centre button exists", (await centreBtn.count()) > 0);

  // empty-spot click
  await page.mouse.click(1050, 480);
  try {
    await inspectorCard(page).waitFor({ state: "visible", timeout: 6000 });
  } catch {}
  let st = await inspectorState(page, false);
  check("P1 click opens inspector", st.visible);
  check("P1 Location section", st.visible && st.hasLocationSection);
  check("P1 no Field section (no fields yet)", st.visible && !st.hasFieldSection);
  check("P1 Copy coordinates", st.visible && st.copyCoords);
  check("P1 Actions section", st.visible && st.hasActions);
  check("P1 coordinates rendered", st.visible && st.coord);
  await shot(page, "inspector-empty-click");

  // Esc closes
  await page.keyboard.press("Escape");
  try {
    await inspectorCard(page).waitFor({ state: "detached", timeout: 4000 });
  } catch {}
  st = await inspectorState(page, false);
  check("P1 Esc closes", !st.visible);

  // keyboard path: native focus on the inspect-centre control + Enter
  await centreBtn.focus();
  await page.keyboard.press("Enter");
  try {
    await inspectorCard(page).waitFor({ state: "visible", timeout: 5000 });
  } catch {}
  st = await inspectorState(page, false);
  check("P1 keyboard (focus control + Enter) opens", st.visible);
  await shot(page, "inspector-keyboard");
  await page.keyboard.press("Escape");
  try {
    await inspectorCard(page).waitFor({ state: "detached", timeout: 4000 });
  } catch {}

  // centre button
  await centreBtn.click();
  try {
    await inspectorCard(page).waitFor({ state: "visible", timeout: 5000 });
  } catch {}
  st = await inspectorState(page, false);
  check("P1 centre button opens", st.visible);
  await shot(page, "inspector-centre-button");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* ── Phase 2: fields colouring ──────────────────────────────────── */
  log("── P2 desktop ──");
  await jumpMap(page, [75.8, 26.79], 16); // Sanganer
  await openFieldsTab(page);
  await page.waitForSelector("text=Load fields for scope", { timeout: 15000 });

  const fields = await loadFields(page);
  check("P2 fields loaded", fields.count > 0, `count=${fields.count}, km²=${fields.selectedAreaKm2}`);
  await page.waitForTimeout(1500);
  const scopeText = await page.evaluate(() => document.body.innerText);
  check(
    "P2 scope caption",
    /Analysis area: current view \([\d.]+ km²\)/.test(scopeText),
    scopeText.match(/Analysis area:[^\n]*/)?.[0],
  );
  await shot(page, "fields-loaded");

  // grouping on (default off) → group colour-by + group small multiples
  await page.locator("label", { hasText: "Group similar curves" }).click();
  await page.waitForTimeout(300);

  // pattern run
  const t0 = Date.now();
  const result = await runPattern(page);
  log(`  pattern took ${Math.round((Date.now() - t0) / 1000)}s`);
  check(
    "P2 pattern result",
    result.count > 0 && result.months.length === 12,
    `${result.count} fields, ${result.months.length} months, ${result.estimatedPu} PU`,
  );
  await page.waitForSelector("text=Cropping pattern", { timeout: 20000 });
  await page.waitForTimeout(2500);

  let paint = await readPaint(page);
  check("P2 fill-color is an expression", paint.fillColor.startsWith("["), paint.fillColor.slice(0, 80));
  check("P2 fill-color NOT orange #C2410C", paint.fillColor !== "#C2410C");
  check("P2 fill colours by cls", paint.fillColor.includes('"cls"'));
  check("P2 base wash 0.18", paint.fillOpacity.includes("0.18") && !paint.fillOpacity.includes("0.05"));
  check("P2 outlines coloured too", paint.lineColor.includes('"cls"'), paint.lineColor.slice(0, 60));
  check("P2 parcels rendered", paint.renderedCount > 0 && paint.clsPresent, `n=${paint.renderedCount}, cls=${JSON.stringify(paint.sampleCls)}`);

  const bodyText = await page.evaluate(() => document.body.innerText);
  check("P2 PU label", /est\.\s*about [\d.]+ PU/.test(bodyText), bodyText.match(/est\.[^\n]*/)?.[0]);
  const CLASS_LABELS = ["Fallow", "Kharif only", "Rabi only", "Double-cropped", "Zaid", "Evergreen", "Unclassified"];
  const chipLabels = await page
    .locator('div[role="group"][aria-label] button[aria-pressed]')
    .evaluateAll(
      (els, labels) =>
        [...new Set(els.map((e) => e.closest('[role="group"]').getAttribute("aria-label")))].filter(
          (l) => labels.includes(l),
        ),
      CLASS_LABELS,
    );
  check("P2 legend chips", chipLabels.length >= 1, chipLabels.join(", "));
  // .section-label renders uppercase — innerText reflects the CSS transform
  check("P2 small multiples (by class)", /mean ndvi by pattern/i.test(bodyText));
  check("P2 small multiples (by group)", /mean ndvi by group/i.test(bodyText));
  await shot(page, "fields-pattern-map");

  // colour-by: group
  await page
    .getByRole("group", { name: "Colour parcels by" })
    .getByRole("button", { name: "Group", exact: true })
    .click();
  await page.waitForTimeout(700);
  paint = await readPaint(page);
  check("P2 colour-by group", paint.fillColor.includes('"group"'), paint.fillColor.slice(0, 90));
  await shot(page, "fields-colourby-group");

  // colour-by: confidence (expr, or the honest fallback note if the COG is down)
  await page
    .getByRole("group", { name: "Colour parcels by" })
    .getByRole("button", { name: "Confidence", exact: true })
    .click();
  await page.waitForTimeout(700);
  paint = await readPaint(page);
  const confText = await page.evaluate(() => document.body.innerText);
  check(
    "P2 colour-by confidence",
    paint.fillColor.includes('"confidence"') || /Confidence is unavailable/.test(confText),
    paint.fillColor.includes('"confidence"') ? "expression" : "fallback note",
  );
  await shot(page, "fields-colourby-confidence");

  // back to pattern
  await page
    .getByRole("group", { name: "Colour parcels by" })
    .getByRole("button", { name: "Pattern", exact: true })
    .click();
  await page.waitForTimeout(500);

  // outline-only mode
  await page
    .getByRole("group", { name: "Parcel style" })
    .getByRole("button", { name: "Outline only" })
    .click();
  await page.waitForTimeout(700);
  paint = await readPaint(page);
  check(
    "P2 outline mode hides fill",
    paint.fillVisibility === "none" && paint.lineVisibility !== "none",
    `fill=${paint.fillVisibility}, line=${paint.lineVisibility}`,
  );
  await shot(page, "fields-outline-mode");
  await page
    .getByRole("group", { name: "Parcel style" })
    .getByRole("button", { name: "Fill + outline" })
    .click();
  await page.waitForTimeout(500);

  // legend filter: isolate the first classified chip
  const filterLabel = chipLabels.find((l) => l && l !== "Unclassified");
  if (filterLabel) {
    const chipGroup = page.getByRole("group", { name: filterLabel, exact: true });
    await chipGroup.locator("button").first().click(); // toggle → isolate
    await page.waitForTimeout(800);
    paint = await readPaint(page);
    const txt = await page.evaluate(() => document.body.innerText);
    check("P2 filter mutes others", paint.fillOpacity.includes("0.05"), paint.fillOpacity.slice(0, 140));
    check("P2 filter list note", /Showing \d+ of \d+ fields/.test(txt), txt.match(/Showing[^\n]*/)?.[0]);
    await shot(page, "fields-legend-filter");

    const showAll = page.getByRole("button", { name: "Show all" });
    check("P2 Show all appears", (await showAll.count()) > 0);
    await showAll.click();
    await page.waitForTimeout(600);
    paint = await readPaint(page);
    const txt2 = await page.evaluate(() => document.body.innerText);
    check("P2 Show all clears", !paint.fillOpacity.includes("0.05") && !/Showing \d+ of \d+ fields/.test(txt2));
  } else {
    check("P2 legend filter", false, "no classified chip found");
  }

  // row click → fly + select
  const firstRow = page.locator("div.max-h-48 button").first();
  if ((await firstRow.count()) > 0) {
    await firstRow.click();
    await page.waitForTimeout(1200);
    const rowActive = await firstRow.evaluate((el) => el.className.includes("border-accent"));
    check("P2 row click selects", rowActive);
    const sparkline = page.locator('[aria-label="12-month NDVI curve"]');
    check("P2 field detail sparkline", (await sparkline.count()) > 0);
  }

  // field polygon click → Phase 1 inspector with Field section
  const pt = await pickFieldPoint(page, { x0: 640, x1: 1350, y0: 60, y1: 700 });
  log("field point:", JSON.stringify(pt));
  if (pt) {
    await page.mouse.click(pt.x, pt.y);
    try {
      await inspectorCard(page).waitFor({ state: "visible", timeout: 6000 });
    } catch {}
    st = await inspectorState(page, false);
    check("P2 field click opens inspector", st.visible);
    check("P2 inspector Field section", st.visible && st.hasFieldSection);
    check("P2 inspector Location retained", st.visible && st.hasLocationSection);
    await shot(page, "inspector-field");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  } else {
    check("P2 field polygon click", false, "no polygon in safe box");
  }

  // dark
  await setTheme(page, "dark");
  await shot(page, "fields-pattern-dark");
  await setTheme(page, "light");

  // agri year 2026–27 (honest provisional + archive note)
  await page
    .getByRole("group", { name: "Agri year" })
    .getByRole("button", { name: "2026–27" })
    .click();
  await page.waitForTimeout(600);
  const y26 = await page.evaluate(() => document.body.innerText);
  check("P2 2026 provisional note", /Provisional/.test(y26), y26.match(/Provisional[^\n]*/)?.[0]?.slice(0, 140));
  check(
    "P2 2026 archive note",
    /archive also publishes 2024–25 and 2025–26 boundaries only/.test(y26),
  );
  await shot(page, "fields-year-2026-banner");

  const f26 = await loadFields(page);
  check("P2 2026 loads 0 fields (archive has none)", f26.count === 0, `count=${f26.count}`);
  const y26b = await page.evaluate(() => document.body.innerText);
  check(
    "P2 2026 zero-field honest note",
    /No 2026–27 field boundaries in the archive yet/.test(y26b),
    y26b.match(/No 2026[^\n]*/)?.[0]?.slice(0, 140),
  );
  await shot(page, "fields-year-2026-empty");

  await ctx.close();
}

/* ═══════════════════════════════════ phone ═══════════════════════════════ */
async function phoneFlow(browser, secret) {
  const token = await new SignJWT({ role: "sso", sub: "verify-sso-m", name: "Verify SSO" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(secret));

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
    storageState: {
      cookies: [
        {
          name: "rse_session",
          value: token,
          domain: "localhost",
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        },
      ],
    },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("PAGEERROR:", String(e).slice(0, 200)));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForMap(page);
  await setTheme(page, "light");

  log("── P1 phone ──");
  await page.touchscreen.tap(120, 300);
  try {
    await phoneDialog(page).waitFor({ state: "visible", timeout: 6000 });
  } catch {}
  let st = await inspectorState(page, true);
  check("P1m tap opens sheet", st.visible);
  check("P1m sheet Location section", st.visible && st.hasLocationSection);
  await shot(page, "inspector-mobile-sheet");
  await page.keyboard.press("Escape");
  try {
    await phoneDialog(page).waitFor({ state: "detached", timeout: 4000 });
  } catch {}
  st = await inspectorState(page, true);
  check("P1m Escape closes sheet", !st.visible);

  log("── P2 phone ──");
  await jumpMap(page, [75.8, 26.79], 16);
  await openFieldsTabPhone(page);
  const fields = await loadFields(page);
  check("P2m fields loaded", fields.count > 0, `count=${fields.count}`);
  const t0 = Date.now();
  const result = await runPattern(page);
  log(`  pattern took ${Math.round((Date.now() - t0) / 1000)}s`);
  check("P2m pattern result", result.count > 0, `${result.count} fields`);
  await page.waitForSelector("text=Cropping pattern", { timeout: 20000 });
  await page.waitForTimeout(2500);

  let paint = await readPaint(page);
  check("P2m fill-coloured", paint.fillColor.startsWith("[") && paint.fillColor.includes('"cls"'));
  await shot(page, "fields-mobile");

  // Close the panel sheet — its backdrop would intercept the theme toggle and
  // later map taps (and the shot below shows the map un-dimmed).
  await page.keyboard.press("Escape");
  try {
    await page.getByRole("dialog", { name: "Panel" }).waitFor({ state: "detached", timeout: 5000 });
  } catch {}
  await page.waitForTimeout(500);
  await shot(page, "fields-mobile-map");

  await setTheme(page, "dark");
  await shot(page, "fields-mobile-dark");
  await setTheme(page, "light");

  // field tap → sheet with Field section (sheet occupies the lower half —
  // pick a polygon in the upper map area)
  const pt = await pickFieldPoint(page, { x0: 30, x1: 360, y0: 70, y1: 330 });
  if (pt) {
    await page.touchscreen.tap(pt.x, pt.y);
    try {
      await phoneDialog(page).waitFor({ state: "visible", timeout: 8000 });
    } catch {}
    st = await inspectorState(page, true);
    check("P2m field tap opens sheet", st.visible);
    check("P2m sheet Field section", st.visible && st.hasFieldSection);
    await shot(page, "inspector-mobile-field");
  } else {
    check("P2m field tap", false, "no polygon in upper safe box");
  }

  await ctx.close();
}

/* ═══════════════════════════════════ main ════════════════════════════════ */
(async () => {
  const secret = readSecret();
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);

  try {
    await desktopFlow(browser, secret);
    await phoneFlow(browser, secret);
  } catch (error) {
    log("FATAL:", error.message);
    results.push({ name: "harness fatal", ok: false, detail: error.message });
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  log("── summary ──");
  for (const r of results) log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
