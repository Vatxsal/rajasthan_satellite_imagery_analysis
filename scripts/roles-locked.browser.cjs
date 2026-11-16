/**
 * Locked-state screenshots for guest vs SSO roles (uncommitted harness).
 * Runs against a local server with AUTH_REQUIRED=true and a real SESSION_SECRET.
 * Output → docs/screenshots/role-*.png
 *
 *   node scripts/roles-locked.browser.cjs
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const { SignJWT } = require("jose");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "docs/screenshots";
const SECRET = process.env.SESSION_SECRET;
const COOKIE = "rse_session";

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

async function forge(role, sub, name) {
  const key = new TextEncoder().encode(SECRET);
  const token = await new SignJWT({ role, sub, name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
  return token;
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

async function shoot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  log("shot", file);
}

function fixtureAnalyzeBody() {
  const stats = {
    metadata: {
      areaName: "Ajmer",
      areaLevel: "tehsil",
      areaId: "t-ajmer-ajmer",
      dateA: "2026-08-02",
      dateB: "2026-10-22",
      gapDays: 81,
      sceneA: { date: "2026-08-02", cloudCover: 3.2, satellite: "S2B", tileCount: 2 },
      sceneB: { date: "2026-10-22", cloudCover: 8.1, satellite: "S2A", tileCount: 2 },
      width: 400,
      height: 350,
      metersPerPixel: 10.4,
      coarse: false,
      sensitivity: "medium",
      minPatchHa: 0.2,
      engine: "v1",
      inputMode: "single",
      compositeWindowDays: 0,
      estimatedPu: 0,
      thresholds: {
        waterGainDMndwi: 0.15,
        waterLossDMndwi: -0.15,
        vegLossDNdvi: -0.2,
        vegGainDNdvi: 0.2,
        bareBuiltDNdbi: 0.1,
        bareBuiltDNdviMax: 0.25,
      },
      generatedAt: "2026-10-28T12:00:00.000Z",
    },
    classes: [
      { code: 0, label: "No change", color: [0, 0, 0], pixels: 100000, areaHa: 1000, areaKm2: 10, pctOfValid: 96 },
      { code: 2, label: "Vegetation loss", color: [220, 38, 38], pixels: 4000, areaHa: 40, areaKm2: 0.4, pctOfValid: 3.8 },
    ],
    validPct: 98.5,
    areaHa: 1040,
    validHa: 1024,
    changedHa: 40,
    tehsils: null,
    hotspots: [
      {
        centroid: [74.86, 26.58],
        bbox: [74.85, 26.57, 74.87, 26.59],
        areaHa: 12,
        classCode: 2,
        classLabel: "Vegetation loss",
        tehsilName: "Ajmer",
        polygon: null,
      },
    ],
    changeBbox: [74.85, 26.57, 74.87, 26.59],
    negligible: false,
    confidence: { high: 1200, medium: 1800, low: 1000 },
    eventsTotal: 1,
  };
  const frames = [
    { type: "stage", stage: "fetch-a" },
    { type: "stage", stage: "fetch-b" },
    { type: "stage", stage: "analyze" },
    {
      type: "result",
      key: "fixture-analyze-key",
      overlayUrl: "/api/compare/overlay?key=fixture-analyze-key",
      aiEnabled: true,
      stats,
      events: [
        {
          type: "Feature",
          id: "ev_fixture1",
          geometry: { type: "Point", coordinates: [74.86, 26.58] },
          properties: {
            classCode: 2,
            classLabel: "Vegetation loss",
            areaHa: 12,
            centroid: [74.86, 26.58],
            bbox: [74.85, 26.57, 74.87, 26.59],
          },
        },
      ],
    },
  ];
  return frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
}

async function mockAnalyze(page) {
  // Mock deployments refuse live CDSE runs (400 CDSE_CONFIG) — fulfil a
  // fixture NDJSON stream so the drawer can open for lock screenshots.
  await page.route("**/api/compare/analyze", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: fixtureAnalyzeBody(),
    }),
  );
  // Overlay artifact is not cached under the fixture key — a transparent PNG
  // keeps the map happy without a server round-trip.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.route("**/api/compare/overlay**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png }),
  );
}

async function mockFields(page) {
  // Guests get 403 FORBIDDEN_ROLE on /api/fields — fulfil a fixture so the
  // loaded-boundaries section (and the pattern-run lock) renders.
  await page.route(
    (url) => url.pathname === "/api/fields",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          bbox: [74.85, 26.57, 74.87, 26.59],
          year: 2024,
          minConfidence: 69,
          selectedAreaKm2: 4.2,
          confidenceAvailable: true,
          count: 120,
          truncated: false,
          excluded: { confidence: 120, noConfidence: 3 },
          totalAreaM2: 4_200_000,
          fields: { type: "FeatureCollection", features: [] },
        }),
      }),
  );
}

async function openCompare(page) {
  await mockAnalyze(page);

  // Guests use district only as a parent — then drill to a tehsil for compare.
  await page.selectOption("#filter-district", { label: "Ajmer" });
  await page.waitForSelector("#filter-tehsil:not([disabled])", { timeout: 30000 });
  const tehsilOpts = await page.$$eval("#filter-tehsil option", (els) =>
    els.map((o) => ({ value: o.value, label: o.label })).filter((o) => o.value),
  );
  if (tehsilOpts.length === 0) throw new Error("no tehsil options under Ajmer");
  await page.selectOption("#filter-tehsil", tehsilOpts[0].value);
  log("tehsil", tehsilOpts[0].label);
  await page.waitForTimeout(400);

  // Mock adapter serves scenes in-process (no /api/scenes call).
  await page.getByRole("button", { name: /search imagery/i }).click();
  await page.waitForSelector('button[title="Compare two dates for this area"]', {
    timeout: 30000,
  });
  await page.waitForTimeout(800);

  await page.click('button[title="Compare two dates for this area"]');
  await page
    .locator('button[title^="Show scene cards"]')
    .first()
    .click()
    .catch(() => null);
  await page.waitForSelector('button[aria-label^="Date A: "]', { timeout: 30000 });
  const dates = await page.$$eval('button[aria-label^="Date A: "]', (els) =>
    els.map((el) => el.getAttribute("aria-label").replace("Date A: ", "")),
  );
  const sorted = [...dates].sort();
  const dateA = sorted[0];
  const dateB = sorted[sorted.length - 1];
  log(`pair ${dateA} -> ${dateB} (${dates.length} scenes)`);
  await page.click(`button[aria-label="Date A: ${dateA}"]`);
  await page.click(`button[aria-label="Date B: ${dateB}"]`);

  await page.locator('button:has-text("Analyze")').first().click();
  await page.waitForSelector('aside[aria-label="Change detection results"], section[aria-label="Change detection results"]', {
    timeout: 60000,
  });
  await page.waitForTimeout(2000);
  log("compare drawer open");
}

(async () => {
  if (!SECRET) {
    console.error("SESSION_SECRET is required (pass the same value as .env.local)");
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);

  const guestToken = await forge(
    "guest",
    "guest:00000000-0000-4000-8000-000000000099",
    "Guest",
  );
  const ssoToken = await forge("sso", "screenshot-sso", "Screenshot SSO");

  /* ---------------------------------------------------------- guest */
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: {
        cookies: [
          {
            name: COOKIE,
            value: guestToken,
            domain: "localhost",
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
          },
        ],
      },
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => log("GUEST PAGEERROR:", String(e).slice(0, 200)));

    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 30000 });
    await page.waitForTimeout(2500);
    await setTheme(page, "light");

    // Session payload sanity
    const session = await page.evaluate(async () => {
      const r = await fetch("/api/auth/session");
      return r.json();
    });
    log(
      "guest session:",
      session.role,
      "caps",
      session.capabilities ? Object.keys(session.capabilities).length : "none",
    );

    // 1. Filters: district lock + quota readout
    await shoot(page, "role-guest-filters-district-lock");

    // 2. FeatureLock popover open (district)
    const lockBtn = page
      .locator('button[aria-label^="District-level compare"]')
      .first();
    if (await lockBtn.count()) {
      await lockBtn.click();
      await page.waitForTimeout(400);
      await shoot(page, "role-guest-featurelock-popover");
      await page.keyboard.press("Escape");
    }

    // 3. TopBar account menu: GeoTIFF (SSO only) + quota readouts
    const menuTrigger = page
      .locator('header button[aria-haspopup="menu"], header button[aria-label*="ccount"], header button[aria-label*="ser"]')
      .last();
    await menuTrigger.click().catch(() => {});
    await page.waitForTimeout(500);
    const geotiffItem = page.locator('text=GeoTIFF (SSO only)').first();
    if (await geotiffItem.count()) {
      await shoot(page, "role-guest-topbar-menu-geotiff");
    } else {
      // menu may not have opened — try every header button until the item appears
      const headerButtons = page.locator("header button");
      const n = await headerButtons.count();
      for (let i = 0; i < n; i++) {
        await headerButtons.nth(i).click().catch(() => {});
        await page.waitForTimeout(350);
        if (await page.locator('text=GeoTIFF (SSO only)').count()) break;
      }
      await shoot(page, "role-guest-topbar-menu-geotiff");
    }
    await page.keyboard.press("Escape");

    // 4. Fields: pattern lock (guest 403s on /api/fields — fulfil a fixture so
    // the loaded-boundaries section renders the pattern-run lock).
    const fieldsTab = page.locator('nav[aria-label="Tools"] button[aria-label="Fields & crops"]');
    if (await fieldsTab.count()) {
      await mockFields(page);
      await fieldsTab.click();
      await page.waitForTimeout(500);
      const loadBtn = page.getByRole("button", { name: /load fields for viewport/i });
      if (await loadBtn.count()) {
        await loadBtn.click();
        await page
          .waitForSelector('button:has-text("Run cropping pattern")', { timeout: 15000 })
          .catch(() => null);
      }
      const patLock = page
        .locator('button[aria-label^="Cropping pattern — available with an SSO ID"]')
        .first();
      if (await patLock.count()) {
        await patLock.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
      } else {
        log("fields pattern lock not found");
      }
      await shoot(page, "role-guest-fields-pattern-lock");
    }

    // Back to filters so #filter-district is mounted for the compare flow
    const filtersTab = page.locator(
      'nav[aria-label="Tools"] button[aria-label="Search & filters"]',
    );
    if (await filtersTab.count()) await filtersTab.click();
    await page.waitForTimeout(400);

    // 5. Compare locks — default tab is Changes (export section lives there)
    await openCompare(page);

    // Export section (Changes tab, bottom of drawer)
    const exportLock = page.locator(
      'aside[aria-label="Change detection results"] button[aria-label^="Change-map export"], section[aria-label="Change detection results"] button[aria-label^="Change-map export"]',
    );
    if (await exportLock.count()) {
      await exportLock.first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shoot(page, "role-guest-compare-export-lock");
      await exportLock.first().click();
      await page.waitForTimeout(400);
      await shoot(page, "role-guest-compare-export-popover");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    } else {
      log("export lock not found");
    }

    // Stats: expand Method & settings so sensitivity / min-patch locks show
    const statsTab = page.locator('button:has-text("Stats")').first();
    if (await statsTab.count()) {
      await statsTab.click();
      await page.waitForTimeout(600);
      const expand = page.locator('button[aria-label="Expand controls and thresholds"]').first();
      if (await expand.count()) {
        await expand.click();
        await page.waitForTimeout(500);
      }
      const sensLock = page.locator('button[aria-label^="Adjust sensitivity"]').first();
      if (await sensLock.count()) {
        await sensLock.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
      }
      await shoot(page, "role-guest-compare-stats-locks");
    }

    const summaryTab = page.locator('button:has-text("Summary")').first();
    if (await summaryTab.count()) {
      await summaryTab.click();
      await page.waitForTimeout(800);
      await shoot(page, "role-guest-compare-summary-ai-lock");
    }

    // 6. Rail has NO System status tab for guest
    const guestStatus = await page
      .locator('nav[aria-label="Tools"] button[aria-label="System status"]')
      .count();
    log("guest sees System status tab:", guestStatus);

    await ctx.close();
  }

  /* ------------------------------------------------------------ sso */
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: {
        cookies: [
          {
            name: COOKIE,
            value: ssoToken,
            domain: "localhost",
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
          },
        ],
      },
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => log("SSO PAGEERROR:", String(e).slice(0, 200)));

    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 30000 });
    await page.waitForTimeout(2500);
    await setTheme(page, "light");

    const session = await page.evaluate(async () => {
      const r = await fetch("/api/auth/session");
      return r.json();
    });
    log(
      "sso session:",
      session.role,
      "caps",
      session.capabilities ? Object.keys(session.capabilities).length : "none",
    );

    const compareAside = page.locator('aside[aria-label="Change detection results"]');

    // SSO sees System status; open it and wait for the payload
    const statusTab = page.locator('nav[aria-label="Tools"] button[aria-label="System status"]');
    const statusCount = await statusTab.count();
    log("sso status tab count:", statusCount, "compare aside:", await compareAside.count());
    if (statusCount) {
      const statusResponse = page
        .waitForResponse((r) => r.url().includes("/api/system/status") && r.status() === 200, {
          timeout: 30000,
        })
        .catch(() => null);
      await statusTab.click();
      await statusResponse;
      await page.waitForFunction(
        () => document.body.innerText.includes("System status"),
        null,
        { timeout: 15000 },
      ).catch(() => null);
      await page.waitForTimeout(800);
      log(
        "sso status shoot — url:",
        page.url(),
        "compare aside:",
        await compareAside.count(),
      );
      await shoot(page, "role-sso-system-status");
    } else {
      log("SSO missing System status tab");
    }

    // SSO TopBar: GeoTIFF (10 m) enabled — open the account menu
    let menuOpen = false;
    const accountBtn = page.locator('header button[aria-label^="Account"]').first();
    if (await accountBtn.count()) {
      await accountBtn.click().catch(() => {});
      await page.waitForTimeout(400);
      menuOpen = (await page.locator("text=GeoTIFF (10 m)").count()) > 0;
    }
    if (!menuOpen) {
      const headerButtons = page.locator("header button");
      const hn = await headerButtons.count();
      for (let i = 0; i < hn; i++) {
        const btn = headerButtons.nth(i);
        if ((await btn.getAttribute("aria-label")) === "Toggle theme") continue;
        await btn.click().catch(() => {});
        await page.waitForTimeout(350);
        if (await page.locator("text=GeoTIFF (10 m)").count()) {
          menuOpen = true;
          break;
        }
      }
    }
    log("sso topbar menu open:", menuOpen);
    await shoot(page, "role-sso-topbar-menu");
    await page.keyboard.press("Escape");

    // SSO filters: district enabled (no lock) — select one so tehsil is reachable
    const filtersTab = page.locator(
      'nav[aria-label="Tools"] button[aria-label="Search & filters"]',
    );
    if (await filtersTab.count()) await filtersTab.click();
    await page.waitForTimeout(500);
    await page.selectOption("#filter-district", { label: "Ajmer" }).catch(() => null);
    await page.waitForTimeout(600);
    log(
      "sso district lock count (want 0):",
      await page.locator('button[aria-label^="District-level compare"]').count(),
      "tehsil disabled:",
      await page
        .locator("#filter-tehsil")
        .isDisabled()
        .catch(() => "n/a"),
    );
    await shoot(page, "role-sso-filters-district-open");

    await ctx.close();
  }

  await browser.close();
  log("done");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
