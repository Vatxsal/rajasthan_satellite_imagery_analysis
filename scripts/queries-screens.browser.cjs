/**
 * Saved-queries screenshot harness (uncommitted, like the other browser harnesses).
 * Complements queries-smoke.browser.cjs with the dark + mobile coverage:
 * desktop-dark empty/populated/save-dialog and mobile light/dark shots.
 * Runs against a local dev server with SESSION_SECRET read from .env.local.
 * Output → docs/screenshots/queries-*.png
 *
 *   node scripts/queries-screens.browser.cjs [shot-name,...]
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const { SignJWT } = require("jose");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "docs/screenshots";
const COOKIE = "rse_session";

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function readSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const text = fs.readFileSync(".env.local", "utf8");
  const match = text.match(/^SESSION_SECRET=(.+)$/m);
  if (!match) throw new Error("SESSION_SECRET not found in .env.local");
  return match[1].trim();
}

async function forge(secret, role, sub, name) {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ role, sub, name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

function expect(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
  log("ok —", message);
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

const rail = (label) => `nav[aria-label="Tools"] button[aria-label="${label}"]`;

(async () => {
  const secret = readSecret();
  fs.mkdirSync(OUT, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const pageErrors = [];

  const guestToken = await forge(secret, "guest", "guest:00000000-0000-4000-8000-000000000043", "Guest");

  const newCtx = async (viewport, theme) => {
    const ctx = await browser.newContext({
      viewport,
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
    await ctx.addInitScript((wanted) => {
      try {
        localStorage.setItem("rie-theme", JSON.stringify({ state: { theme: wanted }, version: 0 }));
      } catch {
        /* private mode — the setTheme fallback handles it */
      }
    }, theme);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => {
      const msg = String(e).slice(0, 200);
      pageErrors.push(msg);
      log("PAGEERROR", msg);
    });
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 30000 });
    await page.waitForTimeout(2500);
    await setTheme(page, theme);
    return { ctx, page };
  };

  // Mobile: the panel opens as a bottom sheet whose rail uses short labels
  // ("Saved", "Filters") while the hidden desktop rail keeps aria-labels.
  // The tabs carry role="tab" and a sr-only suffix, so match by substring.
  const mobileTab = (label) => `button[role="tab"]:has-text("${label}"):visible`;

  const openPanel = async (page) => {
    await page.locator('button[aria-label="Open panel"]').first().click();
    await page.locator(mobileTab("Saved")).waitFor({ timeout: 10000 });
  };

  const gotoSaved = async (page, mobile) => {
    await page.click(mobile ? mobileTab("Saved") : rail("Saved queries"));
    await page.waitForFunction(
      () =>
        !!document.querySelector('[aria-label^="Run saved query"]') ||
        [...document.querySelectorAll("p")].some((p) =>
          (p.textContent || "").includes("No saved queries yet"),
        ),
      null,
      { timeout: 10000 },
    );
  };

  const addExamples = async (page) => {
    await page.click('button:has-text("Add example queries")');
    await page.waitForFunction(
      () => document.querySelectorAll('button[aria-label^="Run saved query"]').length === 4,
      null,
      { timeout: 10000 },
    );
  };

  const shoot = async (page, name) => {
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    log("shot", file);
  };

  const desktop = { width: 1440, height: 900 };
  const mobile = { width: 390, height: 844 };
  const only = process.argv[2];
  const want = (name) => !only || only.split(",").includes(name);

  /* ---------------------------------------------- desktop · dark · guest */
  {
    const { ctx, page } = await newCtx(desktop, "dark");
    if (want("queries-desktop-dark-empty")) {
      await gotoSaved(page);
      expect(
        (await page.locator("text=No saved queries yet").count()) === 1,
        "desktop dark empty state visible",
      );
      await shoot(page, "queries-desktop-dark-empty");
    }
    if (want("queries-desktop-dark-populated")) {
      await addExamples(page);
      await shoot(page, "queries-desktop-dark-populated");
    }
    if (want("queries-desktop-dark-save-dialog")) {
      await page.click(rail("Search & filters"));
      await page.click('button[aria-label="Save current filters as a query"]');
      await page.waitForSelector('div[role="dialog"]', { timeout: 10000 });
      await shoot(page, "queries-desktop-dark-save-dialog");
      await page.locator('div[role="dialog"] button:has-text("Cancel")').click();
    }
    await ctx.close();
  }

  /* ------------------------------------------------- mobile · light · guest */
  if (want("queries-mobile-light-populated")) {
    const { ctx, page } = await newCtx(mobile, "light");
    await openPanel(page);
    await gotoSaved(page, true);
    await addExamples(page);
    await shoot(page, "queries-mobile-light-populated");
    await ctx.close();
  }

  /* -------------------------------------------------- mobile · dark · guest */
  if (want("queries-mobile-dark-save-dialog")) {
    const { ctx, page } = await newCtx(mobile, "dark");
    await openPanel(page);
    await page.click(mobileTab("Filters"));
    await page.click('button[aria-label="Save current filters as a query"]');
    await page.waitForSelector('div[role="dialog"]', { timeout: 10000 });
    await shoot(page, "queries-mobile-dark-save-dialog");
    await ctx.close();
  }

  expect(pageErrors.length === 0, `no page errors (${pageErrors.length})`);
  await browser.close();
  log("done");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
