/**
 * Fields & cropping-pattern screenshots — three agricultural sites against a
 * LIVE dev server (Source Cooperative PMTiles + CDSE monthly NDVI).
 *
 *   npm run dev                     # separate shell, port 3000
 *   node scripts/fields-sites.browser.cjs
 *
 * Flow per site: guest login once → Fields tab → jump the map to a ≤25 km²
 * viewport → Load fields for viewport → Run cropping pattern → select the
 * first parcel → screenshot. Output → docs/screenshots/fields-*.png
 *
 * SITE=<slug> runs a single site (retry/diagnosis runs).
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "docs/screenshots";

const SITES = [
  {
    slug: "ganganagar",
    label: "Sri Ganganagar (canal farmland)",
    center: [73.88, 29.9],
    alt: [73.95, 29.85],
  },
  {
    slug: "bhilwara",
    label: "Bhilwara (southern Rajasthan cotton belt)",
    center: [74.6, 25.35],
    alt: [74.7, 25.45],
  },
  {
    slug: "sanganer",
    label: "Sanganer, Jaipur (peri-urban fields)",
    center: [75.8, 26.79],
    alt: [75.75, 26.72],
  },
];

const only = process.env.SITE;
const SITES_TO_RUN = only ? SITES.filter((s) => s.slug === only) : SITES;

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
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
    { timeout: 5000 },
  );
}

/** Jumps the main map (dev debug handle) and waits for the move to settle. */
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

/** Clicks Load fields; resolves {count} or throws on error/zero fields. */
async function loadFields(page) {
  const respP = page.waitForResponse(
    (r) =>
      r.url().includes("/api/fields") &&
      !r.url().includes("/pattern") &&
      r.request().method() === "POST",
    { timeout: 90000 },
  );
  await page.getByRole("button", { name: /load fields for viewport/i }).click();
  const resp = await respP;
  const body = await resp.json().catch(() => null);
  if (resp.status() !== 200 || !body) {
    const msg = body && body.message ? `${body.code}: ${body.message}` : `HTTP ${resp.status()}`;
    throw new Error(`fields load failed — ${msg}`);
  }
  // Panel header: "N fields"
  await page.waitForFunction(
    () => /\d[\d,]*\s+fields?/.test(document.body.innerText),
    { timeout: 20000 },
  );
  return body;
}

/** Runs the pattern to completion; resolves the result JSON or throws. */
async function runPattern(page) {
  const respP = page.waitForResponse(
    async (r) => {
      if (!r.url().includes("/api/fields/pattern") || r.request().method() !== "POST") {
        return false;
      }
      try {
        const text = await r.text();
        return text.includes('"type":"result"') || text.includes('"type":"error"');
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
  const last = text.trim().split("\n").pop();
  return JSON.parse(last);
}

async function shootSite(page, site) {
  log(`▶ ${site.slug} — ${site.label}`);
  await jumpMap(page, site.center, 16);

  await page.getByRole("button", { name: "Fields & crops" }).click();
  await page.waitForSelector("text=Load fields for viewport", { timeout: 15000 });

  let fields;
  try {
    fields = await loadFields(page);
  } catch (e) {
    log(`  primary center empty/failed (${e.message}) — trying alt center`);
    await jumpMap(page, site.alt, 16);
    fields = await loadFields(page);
  }
  log(`  fields: ${fields.count} (truncated=${Boolean(fields.truncated)})`);
  if (!fields.count) throw new Error(`${site.slug}: zero fields at both centers`);
  await page.waitForTimeout(1500); // let boundary layers paint

  const loadedShot = `${OUT}/fields-${site.slug}-loaded.png`;
  await page.screenshot({ path: loadedShot });
  log(`  shot ${loadedShot}`);

  const result = await runPattern(page);
  log(
    `  pattern: ${result.count} fields, ${result.months.length} months, ` +
      `est ${result.estimatedPu} PU`,
  );
  await page.waitForSelector("text=Cropping pattern", { timeout: 20000 });
  await page.waitForTimeout(2000); // chips + class-coloured map paint

  // Select the first parcel → NDVI sparkline detail card.
  const firstRow = page.locator("div.max-h-48 button").first();
  await firstRow.click().catch(() => log("  (no field row to select)"));
  await page.waitForSelector('[aria-label="12-month NDVI curve"]', { timeout: 10000 }).catch(
    () => log("  (sparkline did not appear)"),
  );
  await page.waitForTimeout(800);

  const shot = `${OUT}/fields-${site.slug}-pattern.png`;
  await page.screenshot({ path: shot });
  log(`  shot ${shot}`);
  return result;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => log("PAGEERROR:", String(e).slice(0, 200)));

  // ── auth: guest entry (AUTH_REQUIRED=true) ──────────────────────────
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Wait for either the guest button (login page) or the map canvas (already
  // in); the /login redirect races the initial goto.
  await page.waitForSelector('button:has-text("Continue as guest"), canvas', {
    timeout: 30000,
  });
  if ((await page.locator('button:has-text("Continue as guest")').count()) > 0) {
    await page.getByRole("button", { name: /continue as guest/i }).click();
  }
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForFunction(() => window.__rieMaps && window.__rieMaps.main, {
    timeout: 30000,
  });
  await page.waitForTimeout(2500);
  await setTheme(page, "light");

  const puRuns = [];
  for (const site of SITES_TO_RUN) {
    try {
      const result = await shootSite(page, site);
      puRuns.push({ site: site.slug, fields: result.count, pu: result.estimatedPu });
    } catch (e) {
      log(`  ✖ ${site.slug}: ${e.message}`);
      await page
        .screenshot({ path: `${OUT}/fields-${site.slug}-DEBUG.png` })
        .catch(() => {});
      if (process.env.STRICT) {
        await browser.close();
        process.exit(1);
      }
    }
  }

  log("PU runs:", JSON.stringify(puRuns));
  await browser.close();
})();
