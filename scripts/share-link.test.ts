import assert from "node:assert/strict";
import test from "node:test";
import { buildShareUrl, parseShareLink, type ShareLink } from "../lib/compare/shareLink";

/** Phase 2 deep links: round trip (email → URL → same analysis params),
 *  plus tampered/missing parameters that must never reach the store. */

const PARAMS = {
  areaId: "d-jaisalmer",
  level: "district" as const,
  dateA: "2026-01-01",
  dateB: "2026-02-01",
  sensitivity: "high" as const,
  minPatchHa: 0.5,
  inputMode: "single" as const,
};

const EXPECTED: ShareLink = {
  ...PARAMS,
  tab: "hotspots",
  eventId: null,
};

function parseUrl(url: string): ShareLink | null {
  return parseShareLink(new URL(url).search);
}

test("round trip: buildShareUrl → parseShareLink reproduces every parameter", () => {
  const url = buildShareUrl("https://example.org", PARAMS, {
    tab: "events",
    eventId: "ev_0123abcd",
  });
  assert.equal(
    url,
    "https://example.org/?a=d-jaisalmer&l=district&A=2026-01-01&B=2026-02-01&s=high&m=0.5&im=single&tab=events&e=ev_0123abcd",
  );
  assert.deepEqual(parseUrl(url), {
    ...EXPECTED,
    tab: "hotspots", // `events` is the email-facing alias of the Events tab
    eventId: "ev_0123abcd",
  });
});

test("round trip: tab variants and a trailing-slash origin", () => {
  const url = buildShareUrl("https://example.org/", PARAMS, { tab: "summary" });
  assert.ok(!url.includes("example.org//"));
  assert.equal(parseUrl(url)?.tab, "summary");
});

test("defaults: minimal a/l/A/B link fills medium, 0.2 ha, composite, Events tab", () => {
  const link = parseShareLink("?a=t-jaipur-amber&l=tehsil&A=2026-03-01&B=2026-04-01");
  assert.deepEqual(link, {
    areaId: "t-jaipur-amber",
    level: "tehsil",
    dateA: "2026-03-01",
    dateB: "2026-04-01",
    sensitivity: "medium",
    minPatchHa: 0.2,
    inputMode: "composite",
    tab: "hotspots",
    eventId: null,
  });
});

test("plain visit (no `a` param) is not a report link", () => {
  assert.equal(parseShareLink(""), null);
  assert.equal(parseShareLink("?tab=events&e=ev_0123abcd"), null);
  assert.equal(parseShareLink("?q=search&l=district"), null);
});

test("tampered parameters are rejected wholesale", () => {
  const good = "a=d-churu&l=district&A=2026-01-01&B=2026-02-01";
  const tampered = [
    "a=", // missing area
    "a=../../etc", // path traversal shape
    "a=d-churu%0d%0aBcc:x@y.z", // header-injection bytes
    "l=state", // unknown level
    "l=", // missing level
    `${good.slice(0, good.indexOf("A="))}A=2026-13-45&B=2026-02-01`, // impossible date
    "a=d-churu&l=district&A=2026-02-30&B=2026-03-01", // non-existent calendar day
    "a=d-churu&l=district&A=2026-01-01&B=2026-01-01", // identical dates
    `${good}&s=critical`, // bad sensitivity
    `${good}&m=0`, // below the 0.1 ha floor
    `${good}&m=1000`, // above the cap
    `${good}&im=triple`, // bad input mode
    `${good}&e=ev_zzzzzzzz`, // malformed event id
    `${good}&e=<script>`, // hostile event id
  ];
  for (const candidate of tampered) {
    assert.equal(parseShareLink(`?${candidate}`), null, `should reject: ${candidate}`);
  }
});

test("first-of-duplicated tab wins and must still be valid", () => {
  const link = parseShareLink("?a=d-churu&l=district&A=2026-01-01&B=2026-02-01&tab=bogus&tab=events");
  assert.equal(link, null); // first value is what get() reads
  const ok = parseShareLink("?a=d-churu&l=district&A=2026-01-01&B=2026-02-01&tab=events&tab=bogus");
  assert.equal(ok?.tab, "hotspots");
});

test("event ids must match the deterministic ev_XXXXXXXX shape", () => {
  const base = "?a=d-churu&l=district&A=2026-01-01&B=2026-02-01&e=";
  assert.equal(parseShareLink(`${base}ev_0123abcd`)?.eventId, "ev_0123abcd");
  // A malformed `e` fails the whole parse — never a half-open report.
  assert.equal(parseShareLink(`${base}ev_0123abc`), null); // 7 hex chars
  assert.equal(parseShareLink(`${base}0123abcd`), null); // missing prefix
  assert.equal(parseShareLink(`${base}nope`), null);
});

test("unknown extra parameters are ignored", () => {
  const link = parseShareLink(
    "?a=d-churu&l=district&A=2026-01-01&B=2026-02-01&utm_source=newsletter&fbclid=abc",
  );
  assert.equal(link?.areaId, "d-churu");
});
