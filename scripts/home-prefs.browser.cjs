/**
 * Home / Profile / Preferences screenshots (uncommitted harness).
 * Runs against a local server with AUTH_REQUIRED=true and a real SESSION_SECRET.
 * Output → docs/screenshots/home-*.png, profile-*.png, preferences-*.png
 *
 *   node scripts/home-prefs.browser.cjs
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
  return new SignJWT({ role, sub, name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

async function shoot(browser, name, { width, height, theme, token, hash }) {
  const context = await browser.newContext({
    viewport: { width, height },
    ...(token
      ? {
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
        }
      : {}),
  });
  // Prime the persisted theme before the app boots (works where no toggle
  // button is visible, e.g. the compact mobile bar).
  await context.addInitScript((wanted) => {
    try {
      localStorage.setItem("rie-theme", JSON.stringify({ state: { theme: wanted }, version: 0 }));
    } catch {
      /* private mode — the click fallback below handles it */
    }
  }, theme);

  const page = await context.newPage();
  page.on("pageerror", (e) => log("PAGEERROR", name, String(e).slice(0, 160)));

  await page.goto(`${BASE}${hash || ""}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  if (hash) {
    // Name-scoped: the phone BottomSheet also carries role="dialog".
    const dialogName = hash === "#profile" ? "Profile" : "Preferences";
    await page.getByRole("dialog", { name: dialogName }).waitFor({ timeout: 15000 });
  }
  await page.waitForTimeout(2200);

  const applied = await page.evaluate(
    () => document.documentElement.getAttribute("data-theme") || "light",
  );
  if (applied !== theme) {
    await page.click('button[aria-label="Toggle theme"]').catch(() => {});
    await page.waitForFunction(
      (t) => document.documentElement.getAttribute("data-theme") === t,
      theme,
      { timeout: 5000 },
    ).catch(() => log("theme fallback missed for", name, "wanted", theme, "got", applied));
  }

  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  log("shot", file, `${width}x${height}`, theme, hash || "");
  await context.close();
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

  const desktop = { width: 1440, height: 900 };
  const mobile = { width: 390, height: 844 };
  const only = process.argv[2]; // optional shot-name filter
  const want = (name) => !only || only.split(",").includes(name);
  const take = (name, opts) => (want(name) ? shoot(browser, name, opts) : Promise.resolve());

  // Home: the new wordmark home link, desktop + mobile × light + dark.
  await take("home-desktop-light", { ...desktop, theme: "light", token: guestToken });
  await take("home-desktop-dark", { ...desktop, theme: "dark", token: guestToken });
  await take("home-mobile-light", { ...mobile, theme: "light", token: guestToken });
  await take("home-mobile-dark", { ...mobile, theme: "dark", token: guestToken });

  // Dialog deep links: /#profile (SSO identity) and /#preferences (guest sees
  // the locked Change/Reports sections).
  await take("profile-desktop-dark", {
    ...desktop,
    theme: "dark",
    token: ssoToken,
    hash: "#profile",
  });
  await take("preferences-desktop-light", {
    ...desktop,
    theme: "light",
    token: guestToken,
    hash: "#preferences",
  });
  await take("preferences-mobile-dark", {
    ...mobile,
    theme: "dark",
    token: guestToken,
    hash: "#preferences",
  });

  await browser.close();
  log("done");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
