import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CSV_BYTES,
  MAX_HTML_BYTES,
  assertHtmlBudget,
  buildEventsCsv,
  buildReportEmailData,
  buildSubject,
  renderReportEmail,
  sanitizeSubject,
} from "../lib/email/template";
import { buildFixtures, DEEP_LINK } from "../lib/email/template/fixtures";

/** Report template contract: hostile input is escaped, subjects stay
 *  single-line ≤90 chars, every fixture fits the 100 KB HTML budget,
 *  the plain-text alternative carries the same facts, Hindi renders,
 *  and the no-summary fixture shows the fallback line. */

const hostileFeature: GeoJSON.Feature = {
  type: "Feature",
  id: "ev_deadbeef",
  geometry: { type: "Point", coordinates: [75.7123, 26.8531] },
  properties: {
    id: "ev_deadbeef",
    classCode: 2,
    classLabel: 'Loss <b>bold</b> & "quoted"',
    areaHa: 12.3,
    centroid: [75.7123, 26.8531],
    confidence: "high",
    tehsilName: 'Bassi"><img src=x onerror=alert(2)>',
  },
};

function fixtureInput(name: string) {
  const fixture = buildFixtures().find((entry) => entry.name === name);
  assert.ok(fixture, `fixture ${name}`);
  return fixture.input;
}

test("hostile names are escaped in HTML and never become live markup", async () => {
  const base = fixtureInput("all-events");
  const data = buildReportEmailData({
    ...base,
    areaName: 'Evil <script>alert(1)</script> Lagoon',
    events: [hostileFeature],
    summary: {
      ...base.summary!,
      overview: "Watch </script><script>alert(3)</script> end.",
    },
  });
  const rendered = await renderReportEmail(data);

  assert.ok(!rendered.html.includes("<script>alert"), "no raw script tag");
  assert.ok(!rendered.html.includes("<img src=x onerror"), "no raw injected tag");
  assert.ok(rendered.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(rendered.html.includes("&lt;img src=x onerror=alert(2)&gt;"));
  // The subject/preheader carry the name as data — what matters is that the
  // HTML body never renders it as markup (asserted above) and the subject
  // stays single-line (asserted in the subject test).
});

test("subject is single-line, ≤90 chars, even with header-injection input", () => {
  const hostile = buildSubject(
    "Jaisalmer\r\nBcc: victim@example.org",
    "2026-10-10",
    "2026-10-25",
  );
  // Newlines collapse to spaces — no way to split the header, so the
  // residual "Bcc:" text is inert data inside a single subject line.
  assert.ok(!/[\r\n]/.test(hostile), "no CR/LF in subject");
  assert.ok(!/[\r\n].*:/m.test(hostile), "no smuggled header line");
  assert.ok(hostile.length <= 90);

  const long = buildSubject(
    "A".repeat(200),
    "2026-10-10",
    "2026-10-25",
  );
  assert.ok(long.length <= 90, `length ${long.length}`);
  assert.ok(long.endsWith("…"), "truncated with an ellipsis");

  assert.equal(sanitizeSubject("  spaced \n out  "), "spaced out");
});

test("every fixture renders under the 100 KB HTML budget with non-empty text", async () => {
  for (const fixture of buildFixtures()) {
    const data = buildReportEmailData(fixture.input);
    const rendered = await renderReportEmail(data);
    const bytes = Buffer.byteLength(rendered.html, "utf8");
    assert.ok(
      bytes <= MAX_HTML_BYTES,
      `${fixture.name}: ${bytes} bytes > ${MAX_HTML_BYTES}`,
    );
    assert.ok(rendered.text.trim().length > 0, `${fixture.name}: empty text part`);
    assert.doesNotThrow(() => assertHtmlBudget(rendered.html), fixture.name);
  }
});

test("plain-text alternative carries the same facts without HTML", async () => {
  const rendered = await renderReportEmail(buildReportEmailData(fixtureInput("all-events")));
  assert.ok(rendered.text.includes("Bassi"), "area name present");
  assert.ok(rendered.text.includes("486.7"), "changed hectares present");
  assert.ok(rendered.text.includes("486.7 ha") || /486\.7\s*ha/i.test(rendered.text));
  assert.ok(!/<[a-z][^>]*>/i.test(rendered.text), "no HTML tags in the text part");
});

test("the Hindi fixture renders Devanagari copy with lang=hi", async () => {
  const rendered = await renderReportEmail(buildReportEmailData(fixtureInput("hindi")));
  assert.match(rendered.html, /<html[^>]*lang="hi"/);
  assert.match(rendered.html, /[\u0900-\u097F]/, "Devanagari in the HTML");
  assert.match(rendered.text, /[\u0900-\u097F]/, "Devanagari in the text part");
});

test("the no-summary fixture shows the fallback line, not a blank section", async () => {
  const rendered = await renderReportEmail(
    buildReportEmailData(fixtureInput("no-summary")),
  );
  assert.ok(
    rendered.html.includes("The AI summary could not be generated for this report."),
    "English fallback copy",
  );
  assert.ok(rendered.text.includes("The AI summary could not be generated for this report."));
});

test("fixed mode carries the alert-recipient footer and the IST request line", async () => {
  const rendered = await renderReportEmail(buildReportEmailData(fixtureInput("fixed-mode")));
  // The plain-text part is hard-wrapped — flatten before matching phrases.
  const parts = [rendered.html, rendered.text].map((part) => part.replace(/\s+/g, " "));
  for (const part of parts) {
    assert.ok(
      part.includes("You received this because a report was requested on"),
      "fixed consent footer",
    );
    assert.ok(part.includes("This mailbox is configured as the alert recipient"), "fixed wording");
    assert.match(part, /Requested: \d{1,2} \w{3} \d{4}, \d{2}:\d{2} IST/, "IST timestamp");
    assert.ok(
      !part.includes("you requested a report for this address"),
      "open-mode consent must not appear",
    );
  }
});

test("open mode keeps the typed-address consent footer", async () => {
  const rendered = await renderReportEmail(buildReportEmailData(fixtureInput("all-events")));
  const parts = [rendered.html, rendered.text].map((part) => part.replace(/\s+/g, " "));
  for (const part of parts) {
    assert.ok(part.includes("you requested a report for this address"), "open consent footer");
    assert.ok(
      !part.includes("configured as the alert recipient"),
      "fixed wording must not appear",
    );
    assert.ok(!part.includes("Requested:"), "no request line in open mode");
  }
});

test("the Hindi fixed fixture renders the Devanagari footer and request line", async () => {
  const rendered = await renderReportEmail(
    buildReportEmailData(fixtureInput("fixed-mode-hindi")),
  );
  const parts = [rendered.html, rendered.text].map((part) => part.replace(/\s+/g, " "));
  for (const part of parts) {
    assert.ok(part.includes("अनुरोध:"), "Hindi request line");
    assert.ok(part.includes("अलर्ट प्राप्तकर्ता"), "Hindi fixed footer");
    assert.ok(!part.includes("अनुरोधित रिपोर्ट के कारण"), "Hindi open consent must not appear");
  }
});

test("events.csv is RFC-4180 escaped, CRLF, capped at 1 MB", () => {
  const hostile: GeoJSON.Feature = {
    type: "Feature",
    id: 'ev_1"quoted',
    geometry: { type: "Point", coordinates: [75.7, 26.8] },
    properties: {
      id: 'ev_1"quoted',
      classLabel: 'Bare, "built-up"\nsecond line',
      areaHa: 5,
      confidence: "high",
      tehsilName: 'Bassi, "West"',
      centroid: [75.7, 26.8],
    },
  };
  const csv = buildEventsCsv([hostile], DEEP_LINK);
  const lines = csv.split("\r\n");
  assert.equal(
    lines[0],
    "id,class,area_ha,confidence,tehsil,lat,lon,link",
  );
  assert.ok(csv.endsWith("\r\n"));
  const row = lines[1]!;
  assert.ok(row.includes('"Bare, ""built-up""'), `quoted cell: ${row}`);
  assert.ok(!/(?<!")\n/.test(row), "embedded newline stays inside quotes");
  assert.ok(csv.includes(`${DEEP_LINK}&e=`), "per-event deep link column");

  // Size cap: a flood of long rows stops before the 1 MB ceiling.
  const flood: GeoJSON.Feature[] = Array.from({ length: 4_000 }, (_, index) => ({
    type: "Feature" as const,
    id: `ev_${index}`,
    geometry: { type: "Point" as const, coordinates: [75.7, 26.8] },
    properties: {
      id: `ev_${index}`,
      classLabel: "Vegetation loss",
      areaHa: 1,
      confidence: "high",
      tehsilName: "N".repeat(600),
      centroid: [75.7, 26.8],
    },
  }));
  const big = buildEventsCsv(flood, DEEP_LINK);
  assert.ok(
    Buffer.byteLength(big, "utf8") <= MAX_CSV_BYTES,
    `csv ${Buffer.byteLength(big, "utf8")} > ${MAX_CSV_BYTES}`,
  );
  assert.ok(big.split("\r\n").length > 100, "cap still yields many rows");
});

test("assertHtmlBudget rejects anything over the cap", () => {
  assert.throws(
    () => assertHtmlBudget("a".repeat(MAX_HTML_BYTES + 1)),
    /EMAIL_HTML_TOO_LARGE/,
  );
  assert.doesNotThrow(() => assertHtmlBudget("a".repeat(100)));
});

test("Phase 5: event sub-labels, method line and caveats reach the report", async () => {
  const rendered = await renderReportEmail(buildReportEmailData(fixtureInput("all-events")));
  // Flatten whitespace AND unescape &amp; so the same phrases match HTML + text.
  const parts = [rendered.html, rendered.text].map((part) =>
    part.replace(/\s+/g, " ").replace(/&amp;/g, "&"),
  );
  for (const part of parts) {
    assert.ok(part.includes("Likely harvest / crop cycle"), "event sub-label");
    assert.ok(part.includes("Method: legacy thresholds"), "method line rules token");
    assert.ok(part.includes("Reliability & caveats"), "caveats heading");
    assert.ok(part.includes("Legacy thresholds only"), "legacy caveat");
    assert.ok(part.includes("Confidence tiers are relative"), "tiers caveat");
  }
});

test("Phase 5: fused evidence shows orbit/prior/terrain and SAR-skip caveats", async () => {
  const data = buildReportEmailData(fixtureInput("fused-evidence"));
  assert.ok(data.method, "method parts present");
  assert.equal(data.method?.rules, "fused evidence rules");
  const rendered = await renderReportEmail(data);
  const parts = [rendered.html, rendered.text].map((part) => part.replace(/\s+/g, " "));
  for (const part of parts) {
    assert.ok(part.includes("Method: fused evidence rules"), "rules token");
    assert.ok(part.includes("Sentinel-1 ASC"), "orbit");
    assert.ok(part.includes("±6 d median"), "S1 window");
    assert.ok(part.includes("WorldCover 2021"), "prior on");
    assert.ok(part.includes("COPERNICUS_30 shadow mask"), "terrain");
    assert.ok(!part.includes("Legacy thresholds only"), "no legacy caveat when fused");
  }

  const skipped = buildReportEmailData({
    ...fixtureInput("fused-evidence"),
    evidence: {
      s1: { skipped: "no scene within window" },
      s1WindowDays: null,
      worldCover: false,
      terrain: false,
      demInstance: null,
    },
  });
  const renderedSkipped = await renderReportEmail(skipped);
  const skipParts = [renderedSkipped.html, renderedSkipped.text].map((part) =>
    part.replace(/\s+/g, " "),
  );
  for (const part of skipParts) {
    assert.ok(
      part.includes("Sentinel-1 unavailable (no scene within window)"),
      "skip reason in method line",
    );
    assert.ok(part.includes("no scene within window"), "skip caveat");
    assert.ok(part.includes("No land-cover prior was read"), "prior-off caveat");
    assert.ok(part.includes("No terrain shadow mask"), "terrain-off caveat");
  }
});
