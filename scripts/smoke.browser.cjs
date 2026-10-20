/**
 * Headless-browser end-to-end smoke test.
 *
 * Usage (production server or a deployed URL must be running):
 *   npm run build && npm start          # local
 *   node scripts/smoke.browser.cjs      # against http://localhost:3000
 *   BASE_URL=https://app.vercel.app node scripts/smoke.browser.cjs
 *
 * Env overrides:
 *   BASE_URL     target origin (default http://localhost:3000)
 *   CHROME_PATH  explicit Chrome binary (otherwise system Chrome via channel)
 *   SMOKE_DATE   YYYY-MM-DD scene date for the render check (default 2026-10-10)
 *
 * Covers: security headers, CSP enforcement, basemap switch, address search,
 * scene search, streamed thumbnail + download render, zero page/CSP errors.
 */
const { chromium } = require("playwright-core");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SMOKE_DATE = process.env.SMOKE_DATE || "2026-10-10";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

(async () => {
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const cspViolations = [];
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const okByHost = {};

  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to (connect|load|script|style|font|image)/i.test(text)) {
      if (!text.includes("example.com")) cspViolations.push(text.slice(0, 300));
    } else if (msg.type() === "error") {
      consoleErrors.push(text.slice(0, 300));
    }
  });
  page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 300)));
  page.on("requestfailed", (req) => {
    const why = req.failure()?.errorText || "";
    if (why.includes("ERR_ABORTED")) return; // cancelled by basemap switch = normal
    if (req.url().includes("example.com")) return; // deliberate CSP probe
    failedRequests.push(`${req.url().slice(0, 120)} :: ${why}`);
  });
  page.on("response", (res) => {
    try {
      const host = new URL(res.url()).host;
      (okByHost[host] ||= { ok: 0, bad: 0 });
      res.status() < 400 ? okByHost[host].ok++ : okByHost[host].bad++;
    } catch {}
  });

  // 1. Load home
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  check("home loads", true);
  check("map canvas exists", (await page.locator("canvas").count()) > 0);
  const mapHost = okByHost["tiles.openfreemap.org"] || { ok: 0 };
  check("basemap style/tiles fetched (openfreemap)", mapHost.ok > 0, `${mapHost.ok} ok`);

  // 2. Security headers
  const sec = await page.evaluate(async () => {
    const r = await fetch("/", { method: "GET" });
    return {
      csp: r.headers.get("content-security-policy"),
      nosniff: r.headers.get("x-content-type-options"),
    };
  });
  check("CSP header served", Boolean(sec.csp && sec.csp.includes("default-src 'self'")));
  check("nosniff header served", sec.nosniff === "nosniff");

  // 3. Basemap switcher → Esri imagery host
  await page.click('[aria-label="Basemap"]');
  await page.waitForTimeout(4000);
  const esri = okByHost["server.arcgisonline.com"] || { ok: 0, bad: 0 };
  check("esri imagery tiles load after basemap switch", esri.ok > 0, `${esri.ok} ok / ${esri.bad} bad`);

  // 4. Address search → Nominatim (connect-src)
  await page.fill('input[placeholder="Search address or place…"]', "Jaipur");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  const nom = okByHost["nominatim.openstreetmap.org"] || { ok: 0, bad: 0 };
  check("nominatim reachable (connect-src)", nom.ok > 0, `${nom.ok} ok / ${nom.bad} bad`);

  // 5. District → scene search (POST /api/scenes)
  const scenesPromise = page.waitForResponse(
    (r) => r.url().includes("/api/scenes") && r.request().method() === "POST",
    { timeout: 60000 },
  );
  await page.selectOption("#filter-district", { label: "Jaipur" });
  await page.getByRole("button", { name: /search imagery/i }).click();
  const scenesResp = await scenesPromise;
  let sceneCount = 0;
  if (scenesResp.status() === 200) {
    const body = await scenesResp.json().catch(() => ({}));
    sceneCount = (body.scenes || []).length;
  }
  check(
    "scene search returns scenes",
    scenesResp.status() === 200 && sceneCount > 0,
    `status=${scenesResp.status()} scenes=${sceneCount}`,
  );

  // 6. Thumbnail (GET /api/imagery, streamed) renders in a card
  const thumbResp = await page
    .waitForResponse((r) => r.url().includes("/api/imagery") && r.status() === 200, {
      timeout: 90000,
    })
    .catch(() => null);
  check("scene thumbnail fetch 200 (streamed imagery)", Boolean(thumbResp));

  // 7. Download-style POST render through the browser (same-origin + stream)
  const dl = await page.evaluate(async (date) => {
    const r = await fetch("/api/imagery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        districtId: "d-jaipur",
        date,
        composite: "true-color",
        size: 640,
        format: "png",
      }),
    });
    return { status: r.status, type: r.headers.get("content-type"), len: (await r.blob()).size };
  }, SMOKE_DATE);
  check(
    "POST imagery render via browser",
    dl.status === 200 && dl.type === "image/png" && dl.len > 1000,
    `status=${dl.status} bytes=${dl.len}`,
  );

  // 8. CSP stays enforced (out-of-policy probe must be refused)
  const enforced = await page.evaluate(async () => {
    return await new Promise((resolve) => {
      const img = new Image();
      img.onerror = () => resolve(true);
      img.onload = () => resolve(false);
      img.src = "https://example.com/x.png"; // not in img-src
      setTimeout(() => resolve(null), 3000);
    });
  });
  check("CSP actively blocks out-of-policy img", enforced === true, String(enforced));

  // 9. Error-free page
  check("no CSP violations", cspViolations.length === 0, cspViolations[0] || "");
  check("no page errors", pageErrors.length === 0, pageErrors[0] || "");
  check("no failed requests", failedRequests.length === 0, failedRequests[0] || "");
  check("no console errors", consoleErrors.length === 0, consoleErrors[0] || "");

  console.log("\nHost traffic:", JSON.stringify(okByHost, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSMOKE: ${results.length - failed.length}/${results.length} passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("SMOKE CRASH:", e);
  process.exit(2);
});
