/**
 * Untracked probe: where do field feature ids go missing?
 *   source features (querySourceFeatures) vs rendered (queryRenderedFeatures)
 *   vs feature-state round-trip.
 *   node .diag-geojson-id.cjs
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const { SignJWT } = require("jose");

const BASE = process.env.BASE_URL || "http://localhost:3000";

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

(async () => {
  const secret = fs.readFileSync(".env.local", "utf8").match(/^SESSION_SECRET=(.+)$/m)[1].trim();
  const token = await new SignJWT({ role: "sso", sub: "diag", name: "Diag" })
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
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForFunction(() => window.__rieMaps && window.__rieMaps.main, null, { timeout: 30000 });
  await page.waitForSelector("text=Loading map…", { state: "detached", timeout: 60000 });
  await page.waitForSelector('button[aria-label="Inspect map centre"]', { timeout: 60000 });

  // jump to Sanganer + load fields (pattern not needed for id diagnosis)
  await page.evaluate(() => {
    window.__rieMaps.main.jumpTo({ center: [75.8, 26.79], zoom: 16, duration: 0 });
  });
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Fields & crops" }).click();
  await page.waitForSelector("text=Load fields for scope", { timeout: 15000 });
  const respP = page.waitForResponse(
    (r) => r.url().includes("/api/fields") && !r.url().includes("/pattern") && r.request().method() === "POST",
    { timeout: 90000 },
  );
  await page.getByRole("button", { name: /load fields for scope/i }).click();
  const resp = await respP;
  const body = await resp.json();
  log("loaded:", body.count, "api feature0.id:", JSON.stringify(body.fields.features[0]?.id));
  await page.waitForTimeout(1500);

  const report = await page.evaluate(() => {
    const map = window.__rieMaps.main;
    const SRC_ID = "fields-boundaries";
    const out = {};
    out.sourceExists = Boolean(map.getSource(SRC_ID));
    try {
      const srcFeats = map.querySourceFeatures(SRC_ID);
      out.sourceCount = srcFeats.length;
      out.sourceIds = srcFeats.slice(0, 5).map((f) => f.id ?? null);
      out.sourcePropsKeys = srcFeats[0] ? Object.keys(srcFeats[0].properties ?? {}) : [];
    } catch (e) {
      out.sourceError = e.message;
    }
    try {
      const ren = map.queryRenderedFeatures({ layers: ["fields-fill"] });
      out.renderedCount = ren.length;
      out.renderedIds = ren.slice(0, 5).map((f) => f.id ?? null);
    } catch (e) {
      out.renderedError = e.message;
    }
    // feature-state round-trip with a source id (if any)
    const testId = out.sourceIds && out.sourceIds.find((v) => v !== null);
    if (testId !== undefined) {
      try {
        map.setFeatureState({ source: SRC_ID, id: testId }, { diagTest: true });
        out.featureState = JSON.stringify(map.getFeatureState({ source: SRC_ID, id: testId }));
      } catch (e) {
        out.featureStateError = e.message;
      }
    }
    // Does the source object expose its raw data?
    try {
      const src = map.getSource(SRC_ID);
      out.sourceClass = src ? src.constructor.name : null;
      out.hasGetData = typeof src?.getData === "function";
      if (out.hasGetData) {
        const data = src.getData();
        out.dataFeature0Id = data?.features?.[0]?.id ?? null;
        out.dataFeature0Keys = data?.features?.[0] ? Object.keys(data.features[0]) : [];
      }
    } catch (e) {
      out.dataError = e.message;
    }
    return out;
  });
  log("report:", JSON.stringify(report, null, 2));

  // Control: brand-new source with an id'd feature → does id survive?
  const control = await page.evaluate(async () => {
    const map = window.__rieMaps.main;
    const id = "diag-control-1";
    map.addSource("diag-id-test", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", id, geometry: { type: "Point", coordinates: [75.8, 26.79] }, properties: { a: 1 } },
        ],
      },
    });
    map.addLayer({ id: "diag-id-test-layer", type: "circle", source: "diag-id-test" });
    await new Promise((r) => setTimeout(r, 600));
    const ren = map.queryRenderedFeatures({ layers: ["diag-id-test-layer"] });
    const src = map.querySourceFeatures("diag-id-test");
    const result = {
      renderedId: ren[0] ? ren[0].id ?? null : "no-render",
      sourceId: src[0] ? src[0].id ?? null : "no-source",
    };
    map.removeLayer("diag-id-test-layer");
    map.removeSource("diag-id-test");
    return result;
  });
  log("control (fresh source with id):", JSON.stringify(control));

  await browser.close();
})().catch((e) => {
  console.error("DIAG FAIL:", e.message);
  process.exit(1);
});
