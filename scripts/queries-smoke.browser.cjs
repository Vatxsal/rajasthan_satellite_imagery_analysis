/**
 * Saved-queries UI smoke harness (uncommitted, like the other browser harnesses).
 * Runs against a local dev server (AUTH_REQUIRED=true, NEXT_PUBLIC_DATA_SOURCE=mock
 * recommended) with SESSION_SECRET read from .env.local. Drives guest + SSO flows
 * end to end and fails on any page error. Output → docs/screenshots/queries-*.png
 *
 *   node scripts/queries-smoke.browser.cjs
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

async function shoot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  log("shot", file);
}

async function openApp(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(2500);
  await setTheme(page, "light");
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

  const guestToken = await forge(secret, "guest", "guest:00000000-0000-4000-8000-000000000042", "Guest");
  const ssoToken = await forge(secret, "sso", "smoke-sso", "Smoke SSO");

  const newCtx = (token) =>
    browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: {
        cookies: [
          {
            name: COOKIE,
            value: token,
            domain: "localhost",
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
          },
        ],
      },
    });

  /* ----------------------------------------------------------- guest */
  {
    const ctx = await newCtx(guestToken);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => {
      pageErrors.push(`guest: ${String(e).slice(0, 300)}`);
      log("GUEST PAGEERROR:", String(e).slice(0, 200));
    });

    await openApp(page);

    // Empty state
    await page.click(rail("Saved queries"));
    await page.waitForSelector('text=No saved queries yet', { timeout: 15000 });
    expect(
      (await page.locator('text=of 5 saved · this browser').count()) > 0,
      "guest shows the 5-cap and browser-storage note",
    );
    await shoot(page, "queries-guest-empty");

    // Examples
    await page.click('button:has-text("Add example queries")');
    await page.waitForFunction(
      () => document.querySelectorAll('button[aria-label^="Run saved query"]').length === 4,
      null,
      { timeout: 15000 },
    );
    expect(true, "four example queries created");
    await shoot(page, "queries-guest-populated");

    // Search
    await page.fill('input[aria-label="Search saved queries"]', "bikaner");
    await page.waitForTimeout(300);
    const filtered = await page.locator('button[aria-label^="Run saved query"]').count();
    expect(filtered === 1, `search narrows to 1 row (got ${filtered})`);
    await page.fill('input[aria-label="Search saved queries"]', "");

    // Duplicate first row → now at the guest cap (5)
    await page.locator('button[aria-label^="Actions for"]').first().click();
    await page.locator('[role="menuitem"]:has-text("Duplicate")').click();
    await page.waitForFunction(
      () => document.querySelectorAll('button[aria-label^="Run saved query"]').length === 5,
      null,
      { timeout: 10000 },
    );
    expect(true, "duplicate fills the guest list to 5");

    // Save dialog from Filters — prefilled + compare locked for guests
    await page.click(rail("Search & filters"));
    await page.click('button[aria-label="Save current filters as a query"]');
    await page.waitForSelector('div[role="dialog"]', { timeout: 10000 });
    const dialog = page.locator('div[role="dialog"]');
    const nameValue = await dialog.locator("#save-query-name").inputValue();
    expect(nameValue.includes("Rajasthan"), `name prefilled from filters ("${nameValue}")`);
    expect(
      (await dialog.locator('text=Guests run change detection').count()) > 0,
      "guest dialog shows the locked compare state",
    );
    await shoot(page, "queries-guest-save-dialog");

    // At the cap → limit error stays in the dialog
    await dialog.locator('button:has-text("Save query")').click();
    await page.waitForSelector('text=You can save up to 5 queries', { timeout: 10000 });
    expect(true, "cap surfaces as an inline dialog error");
    await shoot(page, "queries-guest-limit-error");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Run the first query → applies to Filters and searches
    await page.click(rail("Saved queries"));
    await page.locator('button[aria-label^="Run saved query"]').first().click();
    await page.waitForTimeout(1500);
    const districtValue = await page.locator("#filter-district").inputValue();
    expect(districtValue !== "", `Run selects the query's district (value "${districtValue}")`);
    await page.click(rail("Saved queries"));
    await page.waitForTimeout(300);
    const applied = await page.locator('button:has-text("Applied")').count();
    expect(applied > 0, "row shows the Applied state after Run");
    await shoot(page, "queries-guest-run-applied");

    // Row menu screenshot
    await page.click(rail("Saved queries"));
    await page.locator('button[aria-label^="Actions for"]').first().click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    await shoot(page, "queries-guest-row-menu");

    // Delete → confirm → Undo toast restores the row
    await page.locator('[role="menuitem"]:has-text("Delete")').click();
    await page.waitForSelector('text=Delete saved query?', { timeout: 5000 });
    await shoot(page, "queries-guest-delete-confirm");
    await page.locator('div[role="dialog"] button:has-text("Delete")').click();
    await page.waitForSelector('button:has-text("Undo")', { timeout: 5000 });
    expect(true, "delete shows the Undo toast");
    await shoot(page, "queries-guest-undo-toast");
    await page.locator('button:has-text("Undo")').click();
    await page.waitForFunction(
      () => document.querySelectorAll('button[aria-label^="Run saved query"]').length === 5,
      null,
      { timeout: 10000 },
    );
    expect(true, "Undo restores the deleted query");

    await ctx.close();
  }

  /* ------------------------------------------------------------- sso */
  {
    const ctx = await newCtx(ssoToken);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => {
      pageErrors.push(`sso: ${String(e).slice(0, 300)}`);
      log("SSO PAGEERROR:", String(e).slice(0, 200));
    });

    await openApp(page);
    await page.click(rail("Saved queries"));
    await page.waitForSelector('text=No saved queries yet', { timeout: 15000 });
    expect(
      (await page.locator('text=of 50 saved').count()) > 0,
      "SSO sees the 50-cap (separate subject key from the guest list)",
    );
    await shoot(page, "queries-sso-empty");

    // Save dialog: compare tuning available (no lock) and creates fine
    await page.click(rail("Search & filters"));
    await page.click('button[aria-label="Save current filters as a query"]');
    await page.waitForSelector('div[role="dialog"]', { timeout: 10000 });
    const dialog = page.locator('div[role="dialog"]');
    expect(
      (await dialog.locator('text=Guests run change detection').count()) === 0,
      "SSO dialog does not show the guest lock note",
    );
    expect(
      (await dialog.locator("#save-query-sensitivity").count()) > 0,
      "SSO dialog exposes sensitivity controls",
    );
    await shoot(page, "queries-sso-save-dialog");
    await dialog.locator('button:has-text("Save query")').click();
    await page.waitForSelector('text=Saved “', { timeout: 10000 });
    await page.click(rail("Saved queries"));
    await page.waitForFunction(
      () => document.querySelectorAll('button[aria-label^="Run saved query"]').length === 1,
      null,
      { timeout: 10000 },
    );
    expect(true, "SSO save persists a query");
    await shoot(page, "queries-sso-populated");

    await ctx.close();
  }

  await browser.close();
  if (pageErrors.length > 0) {
    console.error("PAGE ERRORS:\n" + pageErrors.join("\n"));
    process.exit(1);
  }
  log("done — no page errors");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
