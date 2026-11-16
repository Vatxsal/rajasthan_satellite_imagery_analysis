/**
 * Paint-instrumentation probe for the orange-fields root cause (NOT committed).
 *   node .probe-paint.cjs
 * Wraps map.setPaintProperty/setLayoutProperty/addLayer to log every fields
 * paint write, tests classFillExpression() manually, then runs a real pattern
 * run and reports exactly what syncFieldsMap wrote and what stuck.
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const { SignJWT } = require("jose");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function readSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  return fs.readFileSync(".env.local", "utf8").match(/^SESSION_SECRET=(.+)$/m)[1].trim();
}

(async () => {
  const token = await new SignJWT({ role: "sso", sub: "probe", name: "Probe" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(readSecret()));

  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: [{ name: "rse_session", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }] },
  });
  const page = await ctx.newPage();
  const consoles = [];
  page.on("console", (m) => consoles.push(`[${m.type()}] ${m.text()}`.slice(0, 300)));
  page.on("pageerror", (e) => consoles.push(`[pageerror] ${String(e).slice(0, 300)}`));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__rieMaps && window.__rieMaps.main, null, { timeout: 30000 });
  await page.waitForTimeout(2000);

  await page.evaluate(() => {
    const map = window.__rieMaps.main;
    map.jumpTo({ center: [75.8, 26.79], zoom: 16, duration: 0 });
    window.__paintLog = [];
    const wrap = (obj, name, extra) => {
      if (!obj || typeof obj[name] !== "function") return;
      const orig = obj[name].bind(obj);
      obj[name] = (...args) => {
        try {
          const r = orig(...args);
          const [a, b] = args;
          const sig = extra === "addLayer"
            ? `addLayer(${args[0]?.id})`
            : extra === "setData"
              ? `setData(features=${args[0]?.features?.length})`
              : `${a}.${b}=${JSON.stringify(args[2]).slice(0, 260)}`;
          window.__paintLog.push({ sig, ok: true, t: Date.now() });
          return r;
        } catch (e) {
          window.__paintLog.push({
            sig: `${a}.${b ?? ""}=${JSON.stringify(args[2] ?? args[1]).slice(0, 260)}`,
            ok: false, err: String(e).slice(0, 400), t: Date.now(),
          });
          throw e;
        }
      };
    };
    wrap(map, "setPaintProperty");
    wrap(map, "setLayoutProperty");
    wrap(map, "addLayer", "addLayer");
    wrap(map.getSource("fields-boundaries"), "setData", "setData");
  });
  await page.waitForTimeout(1000);

  // ---- manual expression test (no React in the way) ----
  const manual = await page.evaluate(() => {
    const map = window.__rieMaps.main;
    const expr = ["match", ["get", "cls"],
      "fallow", "#A8A29E", "kharif-only", "#16A34A", "rabi-only", "#2563EB",
      "double-cropped", "#9333EA", "zaid", "#D97706", "evergreen", "#0F766E",
      "unclassified", "#9CA3AF"];
    const out = { hasLayer: !!map.getLayer("fields-fill") };
    try {
      map.setPaintProperty("fields-fill", "fill-color", expr);
      out.err = null;
    } catch (e) { out.err = String(e).slice(0, 500); }
    const back = map.getPaintProperty("fields-fill", "fill-color");
    out.back = typeof back === "string" ? back : JSON.stringify(back);
    return out;
  });
  log("manual expression test:", JSON.stringify(manual));

  // ---- load fields ----
  await page.getByRole("button", { name: "Fields & crops" }).click();
  await page.waitForSelector("text=Load fields for viewport", { timeout: 15000 });
  const respP = page.waitForResponse((r) => r.url().includes("/api/fields") && !r.url().includes("/pattern") && r.request().method() === "POST", { timeout: 90000 });
  await page.getByRole("button", { name: /load fields for viewport/i }).click();
  const resp = await respP;
  log("fields:", resp.status());
  await page.waitForTimeout(1200);
  await page.evaluate(() => { window.__paintLog = []; });

  // ---- pattern run ----
  const patP = page.waitForResponse(
    async (r) => {
      if (!r.url().includes("/api/fields/pattern") || r.request().method() !== "POST") return false;
      try { const t = await r.text(); return t.includes('"type":"result"') || t.includes('"type":"error"'); } catch { return false; }
    },
    { timeout: 300000 },
  );
  await page.getByRole("button", { name: /run cropping pattern/i }).click();
  const patResp = await patP;
  const patText = await patResp.text();
  log("pattern frame:", patText.includes('"type":"error"') ? "ERROR" : "ok");
  await page.waitForTimeout(3000);

  const after = await page.evaluate(() => {
    const map = window.__rieMaps.main;
    const c = map.getPaintProperty("fields-fill", "fill-color");
    const o = map.getPaintProperty("fields-fill", "fill-opacity");
    const lc = map.getPaintProperty("fields-line", "line-color");
    return {
      color: typeof c === "string" ? c : JSON.stringify(c),
      opacity: o,
      lineColor: typeof lc === "string" ? lc : JSON.stringify(lc),
      log: (window.__paintLog || []).map((e) => `${e.ok ? "OK " : "ERR"} ${e.sig}${e.err ? " !! " + e.err : ""}`),
    };
  });
  log("after pattern paint:", JSON.stringify({ color: after.color, opacity: after.opacity, lineColor: after.lineColor.slice(0, 120) }));
  log("--- paint log during pattern sync ---");
  after.log.forEach((l) => log("  ", l));

  // force another sync via visibility toggle
  await page.evaluate(() => { window.__paintLog = []; });
  const toggle = page.locator('button[aria-label="Show field boundaries"]').first();
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(400);
    await toggle.click();
    await page.waitForTimeout(600);
  }
  const afterToggle = await page.evaluate(() => {
    const map = window.__rieMaps.main;
    const c = map.getPaintProperty("fields-fill", "fill-color");
    return {
      color: typeof c === "string" ? c : JSON.stringify(c),
      log: (window.__paintLog || []).map((e) => `${e.ok ? "OK " : "ERR"} ${e.sig}${e.err ? " !! " + e.err : ""}`),
    };
  });
  log("--- paint log during visibility toggle sync ---");
  afterToggle.log.forEach((l) => log("  ", l));
  log("color after toggle:", afterToggle.color.slice(0, 200));

  log("--- console (filtered) ---");
  consoles.filter((c) => /error|invalid|warn|expression|throw/i.test(c)).slice(0, 25).forEach((c) => log("  ", c));

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
