/**
 * Phase 5 email-dialog browser smoke (untracked, like its siblings).
 *
 *   1. Opens a share URL so a real result + drawer exist (cold analysis).
 *   2. Clicks the "Email report" header button → dialog assertions + light shot.
 *   3. Invalid address → client-side EMAIL_INVALID error state (no request).
 *   4. Valid address → Turnstile (always-pass test key) → send → success state
 *      with the masked recipient + light success shot.
 *   5. Done → dark theme → reopen → dark shot → Esc closes.
 *
 * Usage: node scripts/verify-email-dialog.browser.cjs
 * Env:   BASE_URL (default http://localhost:3000), OUT_DIR, CHROME_PATH
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = process.env.OUT_DIR || path.join("artifacts", "email-dialog");

const AREA = "t-jaipur-bassi";
const LEVEL = "tehsil";
const DATE_A = "2026-10-10";
const DATE_B = "2026-10-25";
const RECIPIENT = "qa.dialog@example.org";
const MASKED = "q***@example.org";

function log(line) {
  console.log(line);
}

async function shoot(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.screenshot({ path: file, timeout: 60000, animations: "disabled" });
      log(`SHOT ${name} -> ${file}`);
      return;
    } catch (error) {
      lastError = error;
      log(`screenshot retry ${attempt + 1} for ${name}: ${String(error).slice(0, 120)}`);
      await page.waitForTimeout(1500);
    }
  }
  throw lastError;
}

function shareUrl() {
  const params = new URLSearchParams({
    a: AREA,
    l: LEVEL,
    A: DATE_A,
    B: DATE_B,
    s: "medium",
    m: "0.2",
    im: "composite",
    tab: "events",
  });
  return `${BASE}/?${params.toString()}`;
}

async function dialogText(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="email-report-title"]');
    return dialog ? (dialog.textContent || "").replace(/\s+/g, " ").trim() : null;
  });
}

async function sendEnabled(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="email-report-title"]');
    const button = dialog
      ? Array.from(dialog.querySelectorAll("button")).find(
          (b) => (b.textContent || "").includes("Send report") || (b.textContent || "").includes("Try again"),
        )
      : null;
    return Boolean(button) && !button.disabled;
  });
}

/**
 * DOM-level click (element.click()) — playwright's pointer actionability
 * pipeline hung on this header in headless Chrome even though the button is
 * topmost and hittable (verified via elementFromPoint + raw mouse click).
 */
async function clickButton(page, label) {
  const ok = await page.evaluate((text) => {
    const scope =
      document.querySelector('[role="dialog"][aria-labelledby="email-report-title"]') || document;
    const button = Array.from(scope.querySelectorAll("button")).find((b) => {
      const name = (b.getAttribute("aria-label") || b.textContent || "").replace(/\s+/g, " ").trim();
      return name === text || name.includes(text);
    });
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, label);
  if (!ok) throw new Error(`clickButton failed: ${label}`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const t = msg.text().slice(0, 300);
      consoleErrors.push(t);
      log(`CONSOLE ERROR: ${t}`);
    }
  });
  page.on("pageerror", (err) => consoleErrors.push(`PAGEERROR ${String(err).slice(0, 300)}`));
  page.on("response", async (r) => {
    if (r.url().includes("/api/compare/email/config")) {
      const body = await r.text().catch(() => "");
      log(`CONFIG: HTTP ${r.status()} ${body.slice(0, 300)}`);
    }
  });

  try {
    // ── Analysis via share link (opens the drawer with a real result) ─────
    log(`open ${shareUrl()}`);
    const analyze = page.waitForResponse(
      (r) => r.url().includes("/api/compare/analyze") && r.request().method() === "POST",
      { timeout: 300000 },
    );
    await page.goto(shareUrl(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 60000 });
    const analyzeResp = await analyze;
    log(`analyze: HTTP ${analyzeResp.status()}`);
    await page.waitForSelector('[aria-label="Change detection results"]', { timeout: 300000 });
    await page.waitForTimeout(2000);

    // ── Open the dialog ───────────────────────────────────────────────────
    const mailButton = page.locator('button[aria-label="Email report"]');
    let buttonReady = false;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      if (await mailButton.isVisible().catch(() => false)) {
        buttonReady = true;
        break;
      }
      await page.waitForTimeout(1000);
    }
    if (!buttonReady) {
      const diag = await page.evaluate(async () => {
        try {
          const r = await fetch("/api/compare/email/config");
          return { status: r.status, body: (await r.text()).slice(0, 300) };
        } catch (e) {
          return { error: String(e) };
        }
      });
      throw new Error(`mail button missing; config diag=${JSON.stringify(diag)}`);
    }
    await clickButton(page, "Email report");
    const dialog = page.locator('[role="dialog"][aria-labelledby="email-report-title"]');
    await dialog.waitFor({ state: "visible", timeout: 10000 });

    const openText = await dialogText(page);
    log(`dialog open text: ${(openText || "").slice(0, 400)}`);
    if (!openText || !openText.includes("Email report")) throw new Error("dialog heading missing");
    if (!openText.includes(".email-preview")) throw new Error("console preview note missing");
    if (!openText.includes("Used only to send you this report")) throw new Error("consent line missing");
    const langDefault = await page.evaluate(() => {
      const en = document.querySelector('[role="dialog"] [aria-label="Report language"] button');
      return en ? en.textContent : null;
    });
    if ((langDefault || "").trim() !== "English") {
      throw new Error(`language default not English (got ${langDefault})`);
    }
    await shoot(page, "dialog-light");

    // ── Turnstile (always-pass test key) must verify before any submit ───
    let enabled = await sendEnabled(page);
    if (!enabled) {
      for (let attempt = 0; attempt < 15 && !enabled; attempt += 1) {
        await page.waitForTimeout(1000);
        enabled = await sendEnabled(page);
        if (!enabled && attempt === 4) {
          const frame = page.locator('iframe[src*="challenges.cloudflare.com"]');
          if ((await frame.count()) > 0) {
            log("clicking turnstile widget…");
            await frame.first().click({ timeout: 5000 }).catch(() => {});
          }
        }
      }
    }
    if (!enabled) throw new Error("send button still disabled (turnstile token missing)");
    log("turnstile token ready");

    // ── Invalid address → client-side error, no network ──────────────────
    await page.fill("#email-report-recipient", "not-an-email");
    const noRequest = page.waitForRequest(
      (r) => r.url().includes("/api/compare/email") && r.method() === "POST",
      { timeout: 4000 },
    ).catch(() => null);
    await clickButton(page, "Send report");
    await page.waitForTimeout(600);
    const errText = await dialogText(page);
    if (!errText || !errText.includes("Enter a valid email address")) {
      throw new Error(`client validation error missing (got: ${(errText || "").slice(0, 300)})`);
    }
    if (await noRequest) throw new Error("invalid address should not hit the API");
    log("client EMAIL_INVALID state OK");

    // ── Valid address → send → success ────────────────────────────────────
    await page.fill("#email-report-recipient", RECIPIENT);

    const sendResponse = page.waitForResponse(
      (r) => r.url().includes("/api/compare/email") && r.request().method() === "POST",
      { timeout: 300000 },
    );
    await clickButton(page, "Send report");
    const sendResp = await sendResponse;
    log(`send: HTTP ${sendResp.status()}`);
    if (sendResp.status() !== 202) {
      const body = await sendResp.text().catch(() => "");
      throw new Error(`send failed: HTTP ${sendResp.status()} ${body.slice(0, 300)}`);
    }
    await page.waitForFunction(
      (masked) => {
        const dialogEl = document.querySelector('[role="dialog"][aria-labelledby="email-report-title"]');
        return Boolean(dialogEl && (dialogEl.textContent || "").includes(masked));
      },
      MASKED,
      { timeout: 300000 },
    );
    const successText = await dialogText(page);
    log(`success text: ${(successText || "").slice(0, 300)}`);
    await shoot(page, "dialog-success-light");

    // ── Done → dark theme → reopen → dark shot → Esc ─────────────────────
    await clickButton(page, "Done");
    await dialog.waitFor({ state: "hidden", timeout: 5000 });

    await page.evaluate(() => document.querySelector('button[aria-label="Toggle theme"]')?.click());
    await page.waitForTimeout(600);
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    if (theme !== "dark") throw new Error(`theme toggle failed (data-theme=${theme})`);

    await clickButton(page, "Email report");
    await dialog.waitFor({ state: "visible", timeout: 10000 });
    // Let the widget re-verify so the dark shot shows a ready state.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (await sendEnabled(page)) break;
      await page.waitForTimeout(1000);
    }
    await shoot(page, "dialog-dark");

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 5000 });
    log("Esc closes dialog OK");

    const relevantErrors = consoleErrors.filter(
      (e) => !e.includes("forwardRef") && !e.includes("SlotClone"),
    );
    log(`console/page errors: ${relevantErrors.length}`);
    relevantErrors.slice(0, 10).forEach((e) => log(`  ${e}`));
    if (relevantErrors.length > 0) throw new Error("unexpected console errors");
    log("EMAIL-DIALOG SMOKE PASSED");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((error) => {
  console.error("EMAIL-DIALOG SMOKE CRASH:", error);
  process.exit(2);
});
