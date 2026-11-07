/**
 * Fixed-recipient dialog browser smoke.
 *
 *   1. Opens a share URL so a real result + drawer exist (cold analysis).
 *   2. Wide (1440): header label visible, fixed dialog assertions
 *      ("emailed to q***@example.org", no email input) + light-wide shot.
 *   3. Narrow (360): label hides (icon-only), dialog fully on-screen,
 *      light-narrow shot. (Resize only while the dialog is closed — the
 *      drawer unmounts across the 1024px desktop/mobile threshold.)
 *   4. Send flow at 1440: Turnstile → Send → 202 success wording → shot;
 *      "Send another" → 30s cooldown line + disabled Send; reopen →
 *      cooldown persists; wait out cooldown + fresh token → Send →
 *      202 alreadySent wording → shot.
 *   5. Dark theme: reopen at 1440 → dark-wide shot; resize to 360 (dialog
 *      closed) → reopen → dark-narrow shot → Esc closes.
 *
 * Usage: node scripts/verify-fixed-email.browser.cjs
 * Env:   BASE_URL (default http://localhost:3000), OUT_DIR, CHROME_PATH
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = process.env.OUT_DIR || path.join("artifacts", "email-fixed");

const AREA = "t-jaipur-bassi";
const LEVEL = "tehsil";
const DATE_A = "2026-10-10";
const DATE_B = "2026-10-25";
const HINT = "q***@example.org";

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
          (b) =>
            (b.textContent || "").includes("Send report") ||
            (b.textContent || "").includes("Try again"),
        )
      : null;
    return Boolean(button) && !button.disabled;
  });
}

/** DOM-level click — playwright's pointer pipeline can hang on overlay UI. */
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

async function openDialog(page) {
  await clickButton(page, "Send report to mail");
  const dialog = page.locator('[role="dialog"][aria-labelledby="email-report-title"]');
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  return dialog;
}

async function closeDialog(page, dialog) {
  await clickButton(page, "Done").catch(async () => {
    await clickButton(page, "Cancel");
  });
  await dialog.waitFor({ state: "hidden", timeout: 5000 });
}

async function waitTurnstileReady(page, seconds = 20) {
  let ready = await sendEnabled(page);
  for (let attempt = 0; attempt < seconds && !ready; attempt += 1) {
    await page.waitForTimeout(1000);
    ready = await sendEnabled(page);
    if (!ready && attempt === 4) {
      const frame = page.locator('iframe[src*="challenges.cloudflare.com"]');
      if ((await frame.count()) > 0) {
        log("clicking turnstile widget…");
        await frame.first().click({ timeout: 5000 }).catch(() => {});
      }
    }
  }
  return ready;
}

async function waitForCooldown(page, seconds = 50) {
  for (let attempt = 0; attempt < seconds; attempt += 1) {
    const text = await dialogText(page);
    if (!text || !text.includes("You can send another report in")) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function postSend(page, expectWording) {
  const response = page.waitForResponse(
    (r) => r.url().includes("/api/compare/email") && r.request().method() === "POST",
    { timeout: 300000 },
  );
  await clickButton(page, "Send report");
  const resp = await response;
  log(`send: HTTP ${resp.status()}`);
  if (resp.status() !== 202) {
    const body = await resp.text().catch(() => "");
    throw new Error(`send failed: HTTP ${resp.status()} ${body.slice(0, 300)}`);
  }
  await page.waitForFunction(
    (wording) => {
      const el = document.querySelector('[role="dialog"][aria-labelledby="email-report-title"]');
      return Boolean(el && (el.textContent || "").includes(wording));
    },
    expectWording,
    { timeout: 60000 },
  );
  log(`wording OK: ${expectWording}`);
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
      log(`CONFIG: HTTP ${r.status()} ${body.slice(0, 400)}`);
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
    await page.waitForSelector('button[aria-label="Send report to mail"]', { timeout: 60000 });
    await page.waitForTimeout(2000);

    // ── Phase A: wide — header label + fixed dialog assertions ────────────
    const labelSpan = page.locator('button[aria-label="Send report to mail"] span');
    if (!(await labelSpan.isVisible())) throw new Error("label should be visible at 1440px");
    log("header button label visible at 1440px");

    let dialog = await openDialog(page);
    const openText = await dialogText(page);
    log(`dialog open text: ${(openText || "").slice(0, 400)}`);
    if (!openText || !openText.includes("Send report to mail")) {
      throw new Error("fixed dialog heading missing");
    }
    if (!openText.includes(`This comparison will be emailed to ${HINT}`)) {
      throw new Error("recipient hint line missing");
    }
    if (await page.locator("#email-report-recipient").count()) {
      throw new Error("fixed mode must not render an email input");
    }
    if (openText.includes("Used only to send you this report")) {
      throw new Error("open-mode consent line should not appear in fixed mode");
    }
    const langDefault = await page.evaluate(() => {
      const en = document.querySelector('[role="dialog"] [aria-label="Report language"] button');
      return en ? en.textContent : null;
    });
    if ((langDefault || "").trim() !== "English") {
      throw new Error(`language default not English (got ${langDefault})`);
    }
    await shoot(page, "fixed-dialog-light-wide");
    await closeDialog(page, dialog);

    // ── Phase B: narrow — icon-only header label + dialog fully on-screen ─
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(600);
    await page.waitForSelector('button[aria-label="Send report to mail"]', { timeout: 15000 });
    if (await labelSpan.isVisible()) {
      throw new Error("header label should hide below the @sm container width");
    }
    log("header label hidden at 360px (icon-only)");
    dialog = await openDialog(page);
    const box = await dialog.boundingBox();
    if (!box) throw new Error("dialog bounding box missing");
    if (box.x < 0 || box.x + box.width > 361 || box.y < 0 || box.y + box.height > 741) {
      throw new Error(`dialog overflows the 360x740 viewport: ${JSON.stringify(box)}`);
    }
    log(`narrow dialog box OK: ${JSON.stringify(box)}`);
    await shoot(page, "fixed-dialog-light-narrow");
    await closeDialog(page, dialog);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(600);
    await page.waitForSelector('button[aria-label="Send report to mail"]', { timeout: 15000 });

    // ── Phase C: send flow at 1440 ────────────────────────────────────────
    dialog = await openDialog(page);
    if (!(await waitTurnstileReady(page))) {
      throw new Error("send button still disabled (turnstile token missing)");
    }
    log("turnstile token ready");
    await postSend(page, `Report sent to ${HINT}. It can take a minute; check spam.`);
    await shoot(page, "fixed-success-light");

    // "Send another" → 30s cooldown (persists across dialog close/reopen)
    await clickButton(page, "Send another");
    await page.waitForTimeout(300);
    let text = await dialogText(page);
    if (!text || !text.includes("You can send another report in")) {
      throw new Error(`cooldown line missing (got: ${(text || "").slice(0, 200)})`);
    }
    if (await sendEnabled(page)) throw new Error("Send should be disabled during cooldown");
    log("cooldown line + disabled Send OK");
    // "Send another" reset the dialog to idle → close via Cancel, not Done.
    await clickButton(page, "Cancel");
    await dialog.waitFor({ state: "hidden", timeout: 5000 });

    dialog = await openDialog(page);
    const reopenText = await dialogText(page);
    if (!reopenText || !reopenText.includes("You can send another report in")) {
      throw new Error("cooldown should survive dialog reopen");
    }
    if (await sendEnabled(page)) throw new Error("Send should stay disabled across reopen");
    log("cooldown persists across reopen");

    // Wait out cooldown + fresh token → duplicate → alreadySent
    if (!(await waitForCooldown(page, 50))) throw new Error("cooldown never expired");
    if (!(await waitTurnstileReady(page))) throw new Error("token missing after cooldown");
    await postSend(page, "This report was already sent a few minutes ago.");
    await shoot(page, "fixed-already-sent");
    await closeDialog(page, dialog);

    // ── Phase D: dark theme (resize only with the dialog closed) ──────────
    await page.evaluate(() => document.querySelector('button[aria-label="Toggle theme"]')?.click());
    await page.waitForTimeout(600);
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    if (theme !== "dark") throw new Error(`theme toggle failed (data-theme=${theme})`);

    dialog = await openDialog(page);
    await waitTurnstileReady(page);
    await shoot(page, "fixed-dialog-dark-wide");
    await closeDialog(page, dialog);

    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(600);
    await page.waitForSelector('button[aria-label="Send report to mail"]', { timeout: 15000 });
    dialog = await openDialog(page);
    const darkBox = await dialog.boundingBox();
    if (!darkBox || darkBox.x + darkBox.width > 361 || darkBox.y + darkBox.height > 741) {
      throw new Error(`dark dialog overflows 360x740: ${JSON.stringify(darkBox)}`);
    }
    await shoot(page, "fixed-dialog-dark-narrow");

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 5000 });
    log("Esc closes dialog OK");

    const relevantErrors = consoleErrors.filter(
      (e) => !e.includes("forwardRef") && !e.includes("SlotClone"),
    );
    log(`console/page errors: ${relevantErrors.length}`);
    relevantErrors.slice(0, 10).forEach((e) => log(`  ${e}`));
    if (relevantErrors.length > 0) throw new Error("unexpected console errors");
    log("FIXED-EMAIL SMOKE PASSED");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((error) => {
  console.error("FIXED-EMAIL SMOKE CRASH:", error);
  process.exit(2);
});
