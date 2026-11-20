/**
 * Smoke harness: arm polygon tool, draw 3 points, verify HUD metrics,
 * finish, verify the shape card, exercise Backspace-undo, delete the shape —
 * then the Phase 3/4/5 flow: analyze (mock-source error contract), save,
 * shapefile download, reload persistence, and GeoJSON import.
 * Uncommitted verification harness. Screenshots → artifacts/draw-verify/.
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const { SignJWT } = require("jose");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "artifacts/draw-verify";

function readSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  return fs.readFileSync(".env.local", "utf8").match(/^SESSION_SECRET=(.+)$/m)[1].trim();
}

function fail(message) {
  console.error("FAIL:", message);
  process.exit(1);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const token = await new SignJWT({ role: "sso", sub: "draw-smoke", name: "Draw Smoke" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(readSecret()));
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = "chrome";
  // Software GL: a contended GPU (long-running local Chrome) wedges the
  // headless renderer before any page JS can run.
  launch.args = ["--disable-gpu", "--use-angle=swiftshader"];
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: {
      cookies: [
        { name: "rse_session", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
      ],
    },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLEERROR:", m.text().slice(0, 300));
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(3500);

  // Open the Draw tab from the desktop rail.
  const railDraw = page.locator('nav[aria-label="Tools"] button[aria-label="Draw & analyze"]');
  if ((await railDraw.count()) === 0) fail("rail Draw button not found");
  await railDraw.click();
  await page.waitForSelector('[data-testid="draw-tool-polygon"]', { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/01-draw-panel.png` });

  // Arm the polygon tool.
  await page.click('[data-testid="draw-tool-polygon"]');
  await page.waitForSelector('[data-testid="draw-hud"]', { timeout: 5000 });
  const hudBefore = await page.locator('[data-testid="draw-hud"]').innerText();
  console.log("hud (armed):", hudBefore.replace(/\n/g, " | "));
  if (!/Tap the map to start/i.test(hudBefore)) fail("expected idle hint in HUD");
  await page.screenshot({ path: `${OUT}/02-armed.png` });

  // Zoom in so the test triangle stays well under the 100 km² / 25 km limits.
  for (let i = 0; i < 6; i++) {
    await page.click('button[title="Zoom in"]');
    await page.waitForTimeout(320);
  }
  await page.waitForTimeout(800);

  // Three taps on the map (small triangle near the view centre).
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) fail("no canvas box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const points = [
    [cx - 45, cy - 30],
    [cx + 45, cy - 30],
    [cx, cy + 40],
  ];
  for (const [x, y] of points) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(500);
  const draft = await page.evaluate(() => {
    const features = window.__rieDraw?.getSnapshot() ?? [];
    return features.map((f) => ({
      type: f.geometry.type,
      mode: f.properties.mode,
      drawing: f.properties.currentlyDrawing === true,
      positions:
        f.geometry.type === "Polygon"
          ? f.geometry.coordinates[0].length
          : f.geometry.type === "LineString"
            ? f.geometry.coordinates.length
            : null,
    }));
  });
  console.log("snapshot:", JSON.stringify(draft));
  const hudDrawing = await page.locator('[data-testid="draw-hud"]').innerText();
  console.log("hud (3 points):", hudDrawing.replace(/\n/g, " | "));
  if (!/Vertices\s*3/i.test(hudDrawing)) fail("expected 3 vertices in HUD");
  if (!/Shape is valid/i.test(hudDrawing)) fail("expected valid shape: " + hudDrawing);
  await page.screenshot({ path: `${OUT}/03-drawing.png` });

  // Backspace removes the last vertex…
  await page.mouse.move(cx, cy);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(400);
  const hudUndo = await page.locator('[data-testid="draw-hud"]').innerText();
  console.log("hud (backspace):", hudUndo.replace(/\n/g, " | "));
  if (!/Vertices\s*2/i.test(hudUndo)) fail("expected Backspace to drop to 2 vertices");
  // …and a fresh click brings it back to 3.
  await page.mouse.click(points[2][0], points[2][1]);
  await page.waitForTimeout(400);

  // Finish via the touch-visible button.
  const finish = page.locator('[data-testid="draw-finish"]');
  if (await finish.isDisabled()) fail("Finish disabled for a valid shape");
  await finish.click();
  await page.waitForSelector('[data-testid="shape-card"]', { timeout: 5000 });
  const card = await page.locator('[data-testid="shape-card"]').innerText();
  const cardName = await page
    .locator('[data-testid="shape-card"] input[aria-label="Shape name"]')
    .inputValue();
  console.log("card name:", cardName);
  console.log("card:", card.replace(/\n/g, " | "));
  if (cardName !== "Shape 1") fail(`expected Shape 1, got "${cardName}"`);
  if (!/Valid shape/.test(card)) fail("expected valid badge in card");
  if (!/Area/.test(card) || !/Perimeter/.test(card)) fail("expected metrics in card");
  await page.screenshot({ path: `${OUT}/04-shape-card.png` });

  // Shape list shows the row; delete removes it.
  const rows = page.locator('[data-testid="draw-shape-row"]');
  if ((await rows.count()) !== 1) fail("expected 1 shape row");
  await page.click('[data-testid="shape-delete"]');
  await page.waitForTimeout(500);
  if ((await page.locator('[data-testid="shape-card"]').count()) !== 0) fail("card should close on delete");
  if ((await rows.count()) !== 0) fail("row should disappear on delete");
  const empty = await page.locator("text=No shapes yet").count();
  if (empty === 0) fail("empty state missing after delete");
  await page.screenshot({ path: `${OUT}/05-after-delete.png` });

  // Rectangle: two taps finish it automatically and open the card.
  await page.click('[data-testid="draw-tool-rectangle"]');
  await page.waitForTimeout(300);
  await page.mouse.click(cx - 60, cy - 40);
  await page.waitForTimeout(300);
  await page.mouse.click(cx + 60, cy + 40);
  await page.waitForSelector('[data-testid="shape-card"]', { timeout: 5000 });
  const rectName = await page
    .locator('[data-testid="shape-card"] input[aria-label="Shape name"]')
    .inputValue();
  console.log("rectangle card:", rectName);
  if (rectName !== "Shape 1") fail(`rectangle should restart naming at Shape 1, got ${rectName}`);
  await page.screenshot({ path: `${OUT}/06-rectangle.png` });
  await page.click('[data-testid="shape-delete"]');
  await page.waitForTimeout(400);

  // Circle: centre tap + edge tap.
  await page.click('[data-testid="draw-tool-circle"]');
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  await page.mouse.click(cx + 55, cy);
  await page.waitForSelector('[data-testid="shape-card"]', { timeout: 5000 });
  const circleName = await page
    .locator('[data-testid="shape-card"] input[aria-label="Shape name"]')
    .inputValue();
  console.log("circle card:", circleName);
  if (circleName !== "Shape 1") fail(`circle should restart naming at Shape 1, got ${circleName}`);
  await page.screenshot({ path: `${OUT}/07-circle.png` });

  // Select: close the card, switch tools, then click the shape on the map
  // to reselect it via the select mode.
  await page.click('[aria-label="Close shape card"]');
  await page.waitForTimeout(300);
  if ((await page.locator('[data-testid="shape-card"]').count()) !== 0) {
    fail("card should close via its X button");
  }
  await page.click('[data-testid="draw-tool-select"]');
  await page.waitForTimeout(400);
  await page.mouse.click(cx, cy); // circle centre → select it
  await page.waitForTimeout(700);
  if ((await page.locator('[data-testid="shape-card"]').count()) === 0) {
    fail("select tool should open the card for the clicked shape");
  }
  console.log("select re-opened card");
  await page.screenshot({ path: `${OUT}/08-select.png` });

  // With the tool idle again, clicking a drawn shape still opens its card
  // (mapEvents td- path) and the inspector must NOT claim the click.
  await page.click('[data-testid="shape-delete"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="draw-tool-select"]'); // toggle off
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(700);
  const emptyAgain = await page.locator("text=No shapes yet").count();
  if (emptyAgain === 0) fail("shapes should be empty at the end");
  await page.screenshot({ path: `${OUT}/09-final.png` });

  // ============ Phase 3/4/5: analyze → save → download → reload → import ====
  await page.click('[data-testid="draw-tool-polygon"]');
  await page.waitForTimeout(300);
  for (const [x, y] of points) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(300);
  }
  await page.click('[data-testid="draw-finish"]');
  await page.waitForSelector('[data-testid="shape-card"]', { timeout: 5000 });

  // Analyze (Phase 3): mock source streams an error into the card.
  await page.click('[data-testid="shape-analyze"]');
  await page.waitForSelector('[data-testid="shape-analysis"][role="alert"]', {
    timeout: 20000,
  });
  const analyzeErr = await page.locator('[data-testid="shape-analysis"]').innerText();
  console.log("analyze (mock):", analyzeErr.replace(/\n/g, " "));
  if (!/Sentinel-2|NEXT_PUBLIC_DATA_SOURCE/.test(analyzeErr)) {
    fail("unexpected analyze error: " + analyzeErr);
  }

  // Save (Phase 4): the button flips to Saved and the panel gains a row.
  await page.click('[data-testid="shape-save"]');
  await page.waitForTimeout(400);
  const saveText = await page.locator('[data-testid="shape-save"]').innerText();
  if (!/Saved/.test(saveText)) fail(`Save should read "Saved ✓", got "${saveText}"`);
  if ((await page.locator('[data-testid="draw-saved-row"]').count()) !== 1) {
    fail("expected 1 saved row after save");
  }
  await page.screenshot({ path: `${OUT}/10-saved.png` });

  // Download (Phase 4): a real .zip from POST /api/shapes/export (SSO cap).
  const downloadPromise = page.waitForEvent("download", { timeout: 20000 });
  await page.click('[data-testid="shape-download"]');
  const download = await downloadPromise;
  const zipName = download.suggestedFilename();
  if (!zipName.endsWith(".zip")) fail("download should be a .zip, got " + zipName);
  const zipSize = fs.statSync(await download.path()).size;
  if (zipSize < 300) fail("zip suspiciously small: " + zipSize);
  console.log("download:", zipName, zipSize, "bytes");

  // The saved copy outlives the session's draw state (browser-local storage).
  await page.click('[data-testid="shape-delete"]');
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(4000); // map binding must exist before loading a saved shape
  await railDraw.click();
  await page.waitForSelector('[data-testid="draw-tool-polygon"]', { timeout: 10000 });
  if ((await page.locator('[data-testid="draw-saved-row"]').count()) !== 1) {
    fail("saved shape should survive reload");
  }
  await page.screenshot({ path: `${OUT}/11-after-reload.png` });

  // Load it back onto the empty map.
  await page.click('[data-testid="draw-saved-row"]');
  await page.waitForSelector('[data-testid="shape-card"]', { timeout: 5000 });
  console.log("saved shape reloaded onto map");
  await page.click('[aria-label="Close shape card"]');
  await page.waitForTimeout(300);

  // Import a GeoJSON square anchored to a point guaranteed inside a district.
  const path = require("node:path");
  const turf = require("@turf/turf");
  const districts = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "data", "boundaries", "districts.geojson"), "utf8"),
  );
  const inside = turf.pointOnFeature(turf.feature(districts.features[0].geometry));
  const [ix, iy] = inside.geometry.coordinates;
  const d = 0.005;
  const fc = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Imported field" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [ix - d, iy - d],
              [ix + d, iy - d],
              [ix + d, iy + d],
              [ix - d, iy + d],
              [ix - d, iy - d],
            ],
          ],
        },
      },
    ],
  };
  const importPath = `${OUT}/import-square.geojson`;
  fs.writeFileSync(importPath, JSON.stringify(fc));
  await page.setInputFiles('[data-testid="draw-import-input"]', importPath);
  await page.waitForSelector('[data-testid="draw-import-notice"]', { timeout: 10000 });
  const importNotice = await page.locator('[data-testid="draw-import-notice"]').innerText();
  console.log("import:", importNotice);
  if (!/Imported 1/.test(importNotice)) fail("import failed: " + importNotice);
  if ((await page.locator('[data-testid="draw-shape-row"]').count()) !== 2) {
    fail("expected 2 shape rows (loaded + imported)");
  }
  await page.screenshot({ path: `${OUT}/12-imported.png` });

  await browser.close();
  console.log("draw smoke OK");
})().catch((e) => {
  console.error("VERIFY CRASH:", e);
  process.exit(2);
});
