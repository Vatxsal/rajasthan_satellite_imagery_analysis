/**
 * Reproduction probe for the two reported problems (NOT committed):
 *  A) no unified map inspector (empty-spot click / field click / keyboard)
 *  B) fields polygons stay orange after a cropping-pattern run
 *
 * SSO session (fields.pattern capability), live dev server, live CDSE pattern run.
 *   node .repro-inspector-fields.cjs
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const { SignJWT } = require("jose");

const BASE = process.env.BASE_URL || "http://localhost:3000";

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function readSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const m = fs.readFileSync(".env.local", "utf8").match(/^SESSION_SECRET=(.+)$/m);
  if (!m) throw new Error("SESSION_SECRET not found");
  return m[1].trim();
}

(async () => {
  const secret = readSecret();
  const token = await new SignJWT({ role: "sso", sub: "repro-sso", name: "Repro SSO" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));

  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: {
      cookies: [
        { name: "rse_session", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
      ],
    },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("PAGEERROR", String(e).slice(0, 200)));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForFunction(() => window.__rieMaps && window.__rieMaps.main, null, { timeout: 30000 });
  await page.waitForTimeout(2500);

  const inspectorEvidence = async (label) => {
    const found = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const btns = [...document.querySelectorAll("button")];
      const named = (needle) =>
        btns.filter((b) =>
          (b.getAttribute("aria-label") || "").includes(needle) ||
          (b.textContent || "").includes(needle),
        ).length;
      return {
        inspectCentreBtn: named("Inspect map centre"),
        inspectorCard: document.querySelectorAll('[data-map-inspector]').length,
        coordText: /\d{1,3}\.\d{4,}/.test(text),
        hasNominatimBtn: named("Look up place name"),
        sampleBtn: named("Sample NDVI here"),
        openGmaps: named("Open in Google Maps"),
      };
    });
    log(`evidence[${label}]:`, JSON.stringify(found));
    return found;
  };

  /* ---------------- A) inspector absence ---------------- */
  log("--- A) unified map inspector ---");
  await inspectorEvidence("initial");

  // 1. Empty-spot click (right of the panel, away from controls/markers).
  await page.mouse.click(1050, 480);
  await page.waitForTimeout(800);
  await inspectorEvidence("after empty-spot click");
  await page.screenshot({ path: "docs/screenshots/repro-a1-empty-click.png" });

  // 2. Keyboard path: focus the map canvas and press Enter.
  await page.evaluate(() => {
    const canvas = document.querySelector(".maplibregl-canvas");
    if (canvas) canvas.focus();
  });
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.className);
  log("map canvas focus class:", focused);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  await inspectorEvidence("after Enter on focused map");
  await page.screenshot({ path: "docs/screenshots/repro-a2-keyboard-enter.png" });

  // 3. No "Inspect map centre" keyboard/touch alternative exists anywhere.
  const centreBtn = await inspectorEvidence("keyboard alternative check");
  log("A-VERDICT:", centreBtn.inspectCentreBtn === 0 && centreBtn.inspectorCard === 0
    ? "REPRODUCED: no unified inspector, no centre button, no keyboard path"
    : "inspector elements found?!");

  /* ---------------- B) fields stay orange ---------------- */
  log("--- B) fields orange after pattern ---");
  await page.evaluate(() => {
    const map = window.__rieMaps.main;
    map.jumpTo({ center: [75.8, 26.79], zoom: 16, duration: 0 }); // Sanganer
  });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Fields & crops" }).click();
  await page.waitForSelector("text=Load fields for viewport", { timeout: 15000 });

  const respP = page.waitForResponse(
    (r) => r.url().includes("/api/fields") && !r.url().includes("/pattern") && r.request().method() === "POST",
    { timeout: 90000 },
  );
  await page.getByRole("button", { name: /load fields for viewport/i }).click();
  const resp = await respP;
  const body = await resp.json().catch(() => null);
  if (resp.status() !== 200) throw new Error(`fields load failed: ${body && body.code} ${body && body.message}`);
  log("fields loaded:", body.count, "area km2:", body.selectedAreaKm2);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "docs/screenshots/repro-b1-fields-loaded.png" });

  const readPaint = () =>
    page.evaluate(() => {
      const map = window.__rieMaps.main;
      const color = map.getPaintProperty("fields-fill", "fill-color");
      const opacity = map.getPaintProperty("fields-fill", "fill-opacity");
      const feats = map.queryRenderedFeatures({ layers: ["fields-fill"] });
      const props = feats.slice(0, 3).map((f) => ({ ...f.properties }));
      return {
        color: typeof color === "string" ? color : JSON.stringify(color),
        opacity,
        renderedCount: feats.length,
        sampleProps: props,
        hasLayers: !!map.getLayer("fields-fill"),
        sourceDataKind: map.getSource("fields-boundaries") ? "present" : "missing",
      };
    });

  log("paint before pattern:", JSON.stringify(await readPaint()));

  // pattern run (live CDSE — up to 5 min)
  const patP = page.waitForResponse(
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
  const patResp = await patP;
  const patText = await patResp.text();
  if (patText.includes('"type":"error"')) {
    log("PATTERN ERROR FRAME:", patText.match(/"message":"([^"]*)"/)?.[1] ?? patText.slice(0, 300));
    await page.screenshot({ path: "docs/screenshots/repro-b2-pattern-error.png" });
    throw new Error("pattern run failed — see log (this itself explains orange)");
  }
  const last = JSON.parse(patText.trim().split("\n").pop());
  log(`pattern ok: ${last.count} fields, classes=${JSON.stringify(last.classes)}, estPU=${last.estimatedPu}`);

  await page.waitForSelector("text=Cropping pattern", { timeout: 20000 });
  await page.waitForTimeout(2500);
  const after = await readPaint();
  log("paint after pattern:", JSON.stringify(after));
  await page.screenshot({ path: "docs/screenshots/repro-b2-fields-pattern.png" });

  const exprApplied = after.color.startsWith("[");
  const clsJoined = after.sampleProps.some((p) => p.cls && p.cls !== "unclassified");
  log("B-VERDICT:", exprApplied && clsJoined
    ? "paint expression applied + cls joined (NOT reproduced at paint level)"
    : `REPRODUCED: fill-color=${after.color}, cls joined=${clsJoined}, opacity=${after.opacity}`);

  // 4. field polygon click → still no inspector
  const fieldPt = await page.evaluate(() => {
    const map = window.__rieMaps.main;
    const feats = map.queryRenderedFeatures({ layers: ["fields-fill"] });
    if (!feats.length) return null;
    const g = feats[0].geometry;
    const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
    const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
    const lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    const p = map.project([lng, lat]);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  if (fieldPt) {
    await page.mouse.click(fieldPt.x, fieldPt.y);
    await page.waitForTimeout(800);
    const ev = await inspectorEvidence("after field polygon click");
    await page.screenshot({ path: "docs/screenshots/repro-a3-field-click.png" });
    log("A-field-VERDICT:", ev.inspectorCard === 0 ? "REPRODUCED: field click opens no inspector" : "inspector found");
  } else {
    log("no rendered field feature to click");
  }

  await browser.close();
  log("done");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
