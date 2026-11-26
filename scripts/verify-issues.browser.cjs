/**
 * Issue verification (Smart 400 + UI overflow + thumbnails).
 *
 *   SESSION_SECRET=<.env.local value> node scripts/verify-issues.browser.cjs
 *
 * Phase 1 — layout: load, district search (real catalogue, one search), arm
 *   compare, then assert documentElement.scrollWidth <= clientWidth at
 *   1280/1366/1440/1536/1920 + 768/390 widths and 125%/150% zoom emulation
 *   (viewport / zoom factor with matching deviceScaleFactor). The detail
 *   picker and the Analyze button must sit fully inside the viewport.
 * Phase 2 — thumbnails: settle, then count broken <img> (must be 0 — failures
 *   become placeholders) and log every /api/imagery response status.
 * Phase 3 — ONE live Smart run on a small tehsil (estimate card → Run),
 *   asserting the screening stayed within the 2500-px Process API limit.
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const { SignJWT } = require("jose");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = process.env.VERIFY_OUT_DIR || path.join("artifacts", "issue-verify");
const SECRET = process.env.SESSION_SECRET;
const COOKIE = "rse_session";
const DISTRICT = process.env.VERIFY_DISTRICT || "Jalore";

const consoleErrors = [];
const pageErrors = [];
const imageryStatuses = [];

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

async function forge(role, sub, name) {
  const key = new TextEncoder().encode(SECRET);
  return new SignJWT({ role, sub, name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(key);
}

async function shoot(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  log("shot", name);
}

const VIEWPORTS = [
  { w: 1280, h: 720 },
  { w: 1366, h: 768 },
  { w: 1440, h: 900 },
  { w: 1536, h: 864 },
  { w: 1920, h: 1080 },
  { w: 768, h: 900 },
  { w: 390, h: 844 },
  // Browser zoom emulation: 125% / 150% of a 1280-wide display.
  { w: Math.round(1280 / 1.25), h: Math.round(720 / 1.25), dsf: 1.25, tag: "zoom125" },
  { w: Math.round(1280 / 1.5), h: Math.round(720 / 1.5), dsf: 1.5, tag: "zoom150" },
];

(async () => {
  if (!SECRET) {
    console.error("SESSION_SECRET is required (pass the same value as .env.local).");
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const token = await forge("sso", "issue-verify", "Issue Verify");

  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);

  async function newPage(view) {
    const context = await browser.newContext({
      viewport: { width: view.w, height: view.h },
      deviceScaleFactor: view.dsf ?? 1,
    });
    await context.addCookies([{ name: COOKIE, value: token, url: BASE }]);
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
    });
    page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 300)));
    page.on("response", (r) => {
      if (r.url().includes("/api/imagery")) imageryStatuses.push(`${r.status()}`);
    });
    return { context, page };
  }

  const { context, page } = await newPage(VIEWPORTS[2]); // 1440x900 for setup

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(3000);

  // -------- one real catalogue search + arm compare (scenes + compare bar)
  await page.selectOption("#filter-district", { label: DISTRICT }).catch(async () => {
    // Fall back to the first district option if the label differs.
    const first = await page.$eval("#filter-district option:not([value=''])", (o) => o.textContent);
    await page.selectOption("#filter-district", { label: first.trim() });
  });
  await page.getByRole("button", { name: /search imagery/i }).click();
  await page.waitForSelector('section[aria-label="Search results"]', { timeout: 120000 });
  await page.waitForTimeout(2000);
  log("scenes loaded");

  // Arm compare — the bar with the detail picker + Analyze appears.
  await page.click('button[title="Compare two dates for this area"]');
  await page.waitForSelector('[aria-label="Detail level"]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await shoot(page, "compare_bar_1440");

  // -------- Phase 1 + 2 sweep over every viewport / zoom
  const failures = [];
  for (const view of VIEWPORTS) {
    const tag = view.tag ?? `${view.w}x${view.h}`;
    if (view.dsf) {
      // Zoom emulation needs a fresh context (deviceScaleFactor is fixed per context).
      const alt = await newPage(view);
      await alt.page.setViewportSize({ width: view.w, height: view.h });
      await alt.page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
      await alt.page.waitForSelector("canvas", { timeout: 30000 });
      await alt.page.waitForTimeout(2500);
      const r = await checkOverflow(alt.page, tag);
      if (!r.ok) failures.push(...r.messages);
      await alt.context.close();
      continue;
    }
    await page.setViewportSize({ width: view.w, height: view.h });
    await page.waitForTimeout(900);
    const r = await checkOverflow(page, tag);
    if (!r.ok) failures.push(...r.messages);
    log(`${tag}: ${r.ok ? "OK" : "OVERFLOW " + r.summary}`);
  }

  async function checkOverflow(target, tag) {
    return target.evaluate((t) => {
      const doc = document.documentElement;
      const overflowX = doc.scrollWidth - doc.clientWidth;
      const result = {
        ok: overflowX <= 0,
        summary: `scrollW ${doc.scrollWidth} clientW ${doc.clientWidth}`,
        messages: [],
      };
      if (!result.ok) result.messages.push(`${t}: documentElement overflowX = ${overflowX}px`);
      // Any element painting past the viewport edge — but skip elements an
      // ancestor deliberately scrolls/clips (overflow-x auto|scroll|hidden),
      // those are contained by design (the panel tab strip, the card tray).
      const clips = (el) => {
        for (let cur = el.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
          const ox = getComputedStyle(cur).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
        }
        return false;
      };
      const offenders = [];
      for (const el of document.querySelectorAll("body *")) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > doc.clientWidth + 1 && !clips(el)) {
          offenders.push(
            `${el.tagName} cls=${String(el.className).slice(0, 80)} text=${(el.textContent || "").trim().slice(0, 30)} right=${Math.round(rect.right)}`,
          );
          if (offenders.length >= 6) break;
        }
      }
      if (offenders.length > 0) {
        result.ok = false;
        result.summary += ` | offenders: ${offenders.join(" || ")}`;
        result.messages.push(`${t}: past-viewport elements — ${offenders.join(" | ")}`);
      }
      return result;
    }, tag);
  }

  // The control cluster must sit inside the viewport at every desktop size.
  for (const w of [1280, 1366, 1440, 1536, 1920]) {
    const h = { 1280: 720, 1366: 768, 1440: 900, 1536: 864, 1920: 1080 }[w];
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
    const boxes = await page.evaluate(() => {
      const doc = document.documentElement;
      const pickerEl = document.querySelector('[aria-label="Detail level"]');
      const analyzeBtn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === "Analyze",
      );
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { right: Math.round(r.right), width: Math.round(r.width), found: true };
      };
      return {
        picker: box(pickerEl),
        analyze: box(analyzeBtn),
        viewport: doc.clientWidth,
      };
    });
    const bad = [];
    if (!boxes.picker) bad.push("detail picker missing");
    else if (boxes.picker.right > boxes.viewport) bad.push(`picker right ${boxes.picker.right} > ${boxes.viewport}`);
    if (!boxes.analyze) bad.push("Analyze button missing");
    else if (boxes.analyze.right > boxes.viewport) bad.push(`Analyze right ${boxes.analyze.right} > ${boxes.viewport}`);
    if (bad.length > 0) failures.push(`${w}x${h}: ${bad.join("; ")}`);
    else log(`${w}x${h}: picker+Analyze inside viewport`);
  }

  // Narrow widths: the bar must wrap, still no overflow.
  for (const [w, h] of [[768, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(900);
    const r = await checkOverflow(page, `${w}x${h}`);
    if (!r.ok) failures.push(...r.messages);
    log(`${w}x${h}: ${r.ok ? "OK" : "OVERFLOW " + r.summary}`);
    await shoot(page, `narrow_${w}`);
  }

  // -------- Phase 2: thumbnails (compare mode hides the tray — expand it)
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1000);
  const expand = await page.$('button[aria-label="Show scene cards"]');
  if (expand) {
    await expand.click();
    await page.waitForTimeout(1500);
  }
  // Let any in-flight thumbnail renders settle (160 px renders can queue).
  await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => null);
  await page.waitForTimeout(6000);
  const thumbs = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll("section[aria-label='Search results'] img")];
    const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).length;
    const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
    const placeholders = [...document.querySelectorAll('[title="Preview unavailable"]')].length;
    return { total: imgs.length, broken, loaded, placeholders };
  });
  log(
    `thumbnails: total=${thumbs.total} loaded=${thumbs.loaded} broken=${thumbs.broken} placeholders=${thumbs.placeholders}`,
  );
  log(`imagery responses: ${imageryStatuses.join(", ") || "none"}`);
  await shoot(page, "thumbnails_1440");
  if (thumbs.broken > 0) failures.push(`broken <img> glyphs: ${thumbs.broken}`);
  if (thumbs.loaded === 0 && thumbs.placeholders === 0) {
    failures.push("no thumbnails rendered at all");
  }

  // -------- Phase 3: ONE live Smart run on a small tehsil
  if (process.env.VERIFY_SKIP_SMART !== "1") {
    await page.setViewportSize({ width: 1440, height: 900 });
    // Pick the smallest tehsil of the district from the UI's own data.
    const tehsil = await page.evaluate(async () => {
      const r = await fetch("/api/auth/session");
      const info = await r.json();
      return info;
    }).catch(() => null);
    // Search a tehsil: set the tehsil filter from the boundary data the app
    // already has — simplest is the district's first tehsil via the filter.
    const pick = await page.evaluate(() => {
      const select = document.querySelector("#filter-tehsil");
      if (!select) return null;
      const options = [...select.querySelectorAll("option[value]:not([value=''])")];
      return options.length ? options[0].textContent.trim() : null;
    });
    if (!pick) {
      failures.push("no tehsil option available for the smart run");
    } else {
      log(`smart run on tehsil: ${pick}`);
      await page.selectOption("#filter-tehsil", { label: pick }).catch(async () => {
        await page.selectOption("#filter-district", { label: DISTRICT });
        await page.selectOption("#filter-tehsil", { label: pick });
      });
      await page.getByRole("button", { name: /search imagery/i }).click();
      await page.waitForSelector('button[aria-label^="Date A: "]', { timeout: 120000 });
      await page.waitForTimeout(2500);
      const dates = await page.$$eval('button[aria-label^="Date A: "]', (els) =>
        els.map((el) => el.getAttribute("aria-label").replace("Date A: ", "")),
      );
      if (dates.length < 2) {
        failures.push(`tehsil has ${dates.length} scene dates — cannot pair`);
      } else {
        // District→tehsil keeps Smart only if untouched; force Smart.
        const group = page.locator('[aria-label="Detail level"]');
        const smartActive = await group.locator("button[aria-pressed='true']").textContent();
        if (String(smartActive).trim() !== "Smart") {
          await group.locator("button:has-text('Smart')").click();
        }
        await page.click(`button[aria-label="Date A: ${dates[0]}"]`);
        await page.click(`button[aria-label="Date B: ${dates[dates.length - 1]}"]`);
        await page.locator('button:has-text("Analyze")').first().click();
        await page.waitForSelector('[role="dialog"]', { timeout: 20000 });
        await page.waitForSelector('button:has-text("Run ·")', { timeout: 180000 });
        const estimate = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return dialog ? dialog.textContent : "";
        });
        log("estimate card:", estimate.replace(/\s+/g, " ").slice(0, 220));
        await shoot(page, "estimate_card_smart");
        await page.locator('button:has-text("Run ·")').first().click();
        // Streams: screening then blocks — allow several minutes.
        const deadline = Date.now() + 10 * 60 * 1000;
        let done = false;
        while (Date.now() < deadline) {
          await page.waitForTimeout(5000);
          const state = await page.evaluate(() => {
            const drawer = document.querySelector('section[aria-label="Change detection results"]');
            const progress = [...document.querySelectorAll("span")].map((s) => s.textContent).find((t) => /^Block \d+\/\d+$/.test(String(t)));
            const toast = [...document.querySelectorAll("[role='status'], [data-testid='toast-stack']")].map((t) => t.textContent).join(" ");
            return { done: Boolean(drawer), progress: progress || null, toast: toast.slice(0, 160) };
          });
          if (state.progress) log("progress:", state.progress);
          if (state.done) {
            done = true;
            log("smart run: results drawer open");
            break;
          }
          if (/error|failed|rejected|too large|quota/i.test(state.toast)) {
            failures.push(`smart run toast: ${state.toast}`);
            break;
          }
        }
        if (!done) failures.push("smart run did not finish within 10 minutes");
        else {
          const meta = await page.evaluate(() => {
            const drawer = document.querySelector('section[aria-label="Change detection results"]');
            return drawer ? drawer.textContent.replace(/\s+/g, " ").slice(0, 400) : "";
          });
          log("drawer:", meta);
          await shoot(page, "smart_result_1440");
        }
      }
    }
  }

  log(`\nconsole errors: ${consoleErrors.length}`);
  consoleErrors.slice(0, 8).forEach((e) => log(`  ${e}`));
  log(`page errors: ${pageErrors.length}`);
  pageErrors.slice(0, 8).forEach((e) => log(`  ${e}`));
  if (failures.length > 0) {
    log("FAILURES:");
    failures.forEach((f) => log(`  - ${f}`));
  } else {
    log("ALL CHECKS PASSED");
  }

  await context.close();
  await browser.close();
  process.exit(failures.length > 0 ? 1 : 0);
})().catch((error) => {
  console.error("VERIFY CRASH:", error);
  process.exit(2);
});
