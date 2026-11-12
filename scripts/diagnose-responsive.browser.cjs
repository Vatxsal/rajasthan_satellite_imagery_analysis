/** Responsive diagnosis: screenshots + metrics at the 6 required viewports. */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = path.join(__dirname, "..", "artifacts", "responsive");

const VIEWPORTS = [
  { name: "360x640", width: 360, height: 640 },
  { name: "390x844", width: 390, height: 844 },
  { name: "412x915", width: 412, height: 915 },
  { name: "430x932", width: 430, height: 932 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "844x390", width: 844, height: 390 }, // phone landscape
].filter((v) => !process.env.VP || process.env.VP.split(",").includes(v.name));

const METRICS_FILE = path.join(OUT, "metrics.json");
function loadReport() {
  try {
    return JSON.parse(fs.readFileSync(METRICS_FILE, "utf8"));
  } catch {
    return {};
  }
}

const METRICS_FN = () => {
  const doc = document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    // visually-hidden patterns (sr-only skip links etc.) are not touchable
    if (cs.clipPath === "inset(50%)" || /^rect\(0(px)?, 0(px)?, 0(px)?, 0(px)?\)$/.test(cs.clip)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // fully clipped by an overflow-hidden/auto ancestor → invisible & untouchable
  // (e.g. attribution links ellipsized inside .maplibregl-ctrl-attrib-inner)
  const clipped = (el) => {
    if (getComputedStyle(el).position === "fixed") return false;
    const r0 = el.getBoundingClientRect();
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      const clipX = cs.overflowX !== "visible";
      const clipY = cs.overflowY !== "visible";
      if (clipX || clipY) {
        const pr = p.getBoundingClientRect();
        if (clipX && (r0.right <= pr.left + 0.5 || r0.left >= pr.right - 0.5)) return true;
        if (clipY && (r0.bottom <= pr.top + 0.5 || r0.top >= pr.bottom - 0.5)) return true;
      }
      p = p.parentElement;
    }
    return false;
  };
  // inside a horizontally scrollable region → reachable by swiping the
  // container, so it is not a page-level overflow offender
  const inScrollableX = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
      p = p.parentElement;
    }
    return false;
  };
  const sel = (el) => {
    const parts = [];
    if (el.id) parts.push("#" + el.id);
    if (el.getAttribute("aria-label")) parts.push(`[aria-label="${el.getAttribute("aria-label").slice(0, 40)}"]`);
    if (el.className && typeof el.className === "string") {
      parts.push(el.className.split(/\s+/).slice(0, 5).join("."));
    }
    return (el.tagName.toLowerCase() + (parts.length ? " " + parts.join("") : "")).slice(0, 140);
  };

  // horizontal overflow offenders (skip elements translated off-screen vertically)
  const offenders = [];
  for (const el of document.querySelectorAll("body *")) {
    if (offenders.length >= 25) break;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh + 400) continue; // far offscreen vertically (closed sheets)
    if (clipped(el)) continue;
    if (inScrollableX(el)) continue;
    if (r.right > vw + 1 || r.left < -1) {
      offenders.push({ el: sel(el), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) });
    }
  }

  // inputs under 16px (iOS auto-zoom)
  const smallInputs = [];
  let inputCount = 0;
  for (const el of document.querySelectorAll("input, textarea, select")) {
    if (!visible(el)) continue;
    inputCount++;
    const fsPx = parseFloat(getComputedStyle(el).fontSize);
    if (fsPx < 16) smallInputs.push({ el: sel(el), fontSize: fsPx });
  }

  // touch targets under 44x44 (interactive, visible)
  const smallTargets = [];
  let targetCount = 0;
  for (const el of document.querySelectorAll("button, a, [role=button], [role=switch], [role=tab], input[type=checkbox], input[type=radio], input[type=range]")) {
    if (!visible(el)) continue;
    if (clipped(el)) continue;
    // WCAG 2.5.8 target-size exception: links inline in a sentence/text
    // (attribution fine print) are exempt from the 44px internal floor.
    if (el.tagName === "A" && getComputedStyle(el).display === "inline") continue;
    targetCount++;
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) {
      smallTargets.push({ el: sel(el), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }

  // vh-based sizing still in use (computed styles)
  const vhSized = [];
  for (const el of document.querySelectorAll("body *")) {
    if (vhSized.length >= 15) break;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    for (const prop of ["maxHeight", "height", "minHeight", "maxWidth", "width"]) {
      const v = cs[prop];
      if (v && v.endsWith("vh") && v !== "auto" && v !== "100vh" && v !== "0vh") {
        vhSized.push({ el: sel(el), prop, value: v });
      } else if (v === "100vh") {
        vhSized.push({ el: sel(el), prop, value: v });
      }
    }
  }

  // key landmark rects
  const rectOf = (q) => {
    const el = document.querySelector(q);
    if (!el || !visible(el)) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const mapCtrls = [...document.querySelectorAll(".maplibregl-ctrl, .maplibregl-ctrl-container, .maplibregl-canvas-container")]
    .filter(visible)
    .slice(0, 12)
    .map((el) => ({ el: sel(el), ...((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(el.getBoundingClientRect()) }));

  // can the page scroll horizontally?
  const beforeX = window.scrollX;
  window.scrollTo(60, window.scrollY);
  const scrollableX = window.scrollX > beforeX || window.scrollX > 0;
  window.scrollTo(beforeX, window.scrollY);

  return {
    viewportMeta: document.querySelector('meta[name="viewport"]')?.content ?? null,
    inner: { w: vw, h: vh },
    docScroll: { w: doc.scrollWidth, h: doc.scrollHeight, clientW: doc.clientWidth, clientH: doc.clientHeight },
    horizontalOverflowPx: doc.scrollWidth - doc.clientWidth,
    scrollableX,
    offenders,
    inputCount,
    smallInputs,
    targetCount,
    smallTargetsCount: smallTargets.length,
    smallTargets: smallTargets.slice(0, 20),
    vhSized,
    landmarks: {
      header: rectOf("header"),
      rail: rectOf('nav[aria-label="Tools"]'),
      leftAside: rectOf("aside"),
      mobileSheet: rectOf("section.fixed.inset-x-0"),
      panelSection: rectOf("section[aria-hidden]"),
      mapShell: rectOf(".map-shell"),
    },
    mapCtrls,
    bodyFontSize: getComputedStyle(document.body).fontSize,
    wordmark: (() => {
      const h1 = document.querySelector("header h1");
      if (!h1) return null;
      const r = h1.getBoundingClientRect();
      return { text: h1.textContent, w: Math.round(r.w || r.width), truncated: h1.scrollWidth > h1.clientWidth + 1 };
    })(),
  };
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const report = loadReport();
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  const browser = await chromium.launch(launch);

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: vp.width < 1024, hasTouch: vp.width < 1024 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

    // ---- login
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const loginMetrics = await page.evaluate(METRICS_FN).catch((e) => ({ error: String(e) }));
    await page.screenshot({ path: path.join(OUT, `login-${vp.name}.png`) });
    report[vp.name] = { login: loginMetrics };

    // ---- dashboard
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3500);
    const homeMetrics = await page.evaluate(METRICS_FN).catch((e) => ({ error: String(e) }));
    await page.screenshot({ path: path.join(OUT, `home-${vp.name}.png`) });
    report[vp.name].home = homeMetrics;

    // ---- mobile sheet open (only phone widths)
    if (vp.width < 1024) {
      const burger = page.locator('button[aria-label="Open panel"]').first();
      if (await burger.count()) {
        await burger.click().catch(() => {});
        await page.waitForTimeout(600);
        const sheetMetrics = await page.evaluate(METRICS_FN).catch((e) => ({ error: String(e) }));
        await page.screenshot({ path: path.join(OUT, `sheet-${vp.name}.png`) });
        report[vp.name].sheet = sheetMetrics;
      }
    }
    report[vp.name].pageErrors = errors;
    fs.writeFileSync(METRICS_FILE, JSON.stringify(report, null, 2));
    await ctx.close();
    console.log(`done ${vp.name}`);
  }

  await browser.close();

  // compact console summary
  for (const [name, r] of Object.entries(report)) {
    if (process.env.VP && !process.env.VP.split(",").includes(name)) continue;
    const h = r.home || {};
    console.log(
      `\n== ${name} ==`,
      `\n  viewportMeta: ${h.viewportMeta}`,
      `\n  overflowX: ${h.horizontalOverflowPx}px scrollableX=${h.scrollableX} docW=${h.docScroll?.w} clientW=${h.docScroll?.clientW}`,
      `\n  offenders: ${(h.offenders || []).length}` + (h.offenders || []).slice(0, 4).map((o) => `\n    ${o.el} right=${o.right}`).join(""),
      `\n  smallInputs: ${(h.smallInputs || []).length}/${h.inputCount} ` + (h.smallInputs || []).slice(0, 3).map((i) => `${i.el}@${i.fontSize}px`).join(", "),
      `\n  smallTargets: ${h.smallTargetsCount}/${h.targetCount}`,
      `\n  vhSized: ${(h.vhSized || []).map((v) => `${v.el}[${v.prop}=${v.value}]`).slice(0, 5).join(" | ")}`,
      `\n  landmarks: ${JSON.stringify(h.landmarks)}`,
      `\n  wordmark: ${JSON.stringify(h.wordmark)}`,
      `\n  errors: ${(r.pageErrors || []).length}`,
    );
  }
})().catch((e) => {
  console.error("DIAGNOSE CRASH:", e);
  process.exit(2);
});
