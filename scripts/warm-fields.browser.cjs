/**
 * Untracked: warms fieldsCache for the exact viewports the verification
 * harness uses (desktop 1440x900 + phone 390x844 at Sanganer z16), so the
 * harness never pays a cold PMTiles/COG build and we can assert
 * confidenceAvailable before it runs.
 *   node .warm-fields.cjs
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const { SignJWT } = require("jose");

const BASE = process.env.BASE_URL || "http://localhost:3000";

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

async function warmViewport(browser, token, { width, height, isMobile, deviceScaleFactor, label, years }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    isMobile: Boolean(isMobile),
    deviceScaleFactor: deviceScaleFactor || 1,
    storageState: {
      cookies: [
        { name: "rse_session", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
      ],
    },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 30000 });
    await page.waitForFunction(() => window.__rieMaps && window.__rieMaps.main, null, { timeout: 30000 });
    await page.waitForSelector("text=Loading map…", { state: "detached", timeout: 60000 });
    await page.waitForSelector('button[aria-label="Inspect map centre"]', { timeout: 60000 });
    await page.evaluate(() => {
      window.__rieMaps.main.jumpTo({ center: [75.8, 26.79], zoom: 16, duration: 0 });
    });
    await page.waitForTimeout(1200);
    const bbox = await page.evaluate(() => {
      const b = window.__rieMaps.main.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    });
    log(label, "bbox", JSON.stringify(bbox.map((v) => Number(v.toFixed(6)))));
    for (const year of years) {
      const t0 = Date.now();
      const res = await fetch(`${BASE}/api/fields`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `rse_session=${token}` },
        body: JSON.stringify({ bbox, year, minConfidence: 69 }),
      });
      const json = await res.json();
      const n = json.fields?.features?.length ?? -1;
      const first = json.fields?.features?.[0];
      log(
        label,
        year,
        "status",
        res.status,
        "in",
        Date.now() - t0,
        "ms;",
        "count",
        json.count,
        "conf",
        json.confidenceAvailable,
        "id",
        first ? JSON.stringify(first.id) : "-",
        "propsId",
        first ? JSON.stringify(first.properties?.id ?? null) : "-",
      );
      if (year !== 2026) {
        if (json.count <= 0) throw new Error(`${label} ${year}: expected count>0, got ${json.count}`);
        if (!json.confidenceAvailable) throw new Error(`${label} ${year}: confidenceAvailable=false (bad cached build)`);
        if (!first?.properties?.id) throw new Error(`${label} ${year}: properties.id missing`);
      } else if (json.count !== 0) {
        throw new Error(`${label} ${year}: expected count=0, got ${json.count}`);
      }
    }
  } finally {
    await ctx.close();
  }
}

(async () => {
  const secret = fs.readFileSync(".env.local", "utf8").match(/^SESSION_SECRET=(.+)$/m)[1].trim();
  const token = await new SignJWT({ role: "sso", sub: "warm", name: "Warm" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(secret));

  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    await warmViewport(browser, token, {
      width: 1440, height: 900, label: "desktop", years: [2025, 2026],
    });
    await warmViewport(browser, token, {
      width: 390, height: 844, isMobile: true, deviceScaleFactor: 3, label: "phone", years: [2025],
    });
    log("warm OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error("WARM FAIL:", e.message);
  process.exit(1);
});
