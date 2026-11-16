/**
 * Untracked probe: does the live pattern stream ship per-field `series`
 * (needed by the panel's small multiples + sparklines)?
 *   node .probe-pattern-series.cjs
 */
const fs = require("node:fs");
const { SignJWT } = require("jose");

function readSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const m = fs.readFileSync(".env.local", "utf8").match(/^SESSION_SECRET=(.+)$/m);
  if (!m) throw new Error("SESSION_SECRET not found");
  return m[1].trim();
}

(async () => {
  const secret = readSecret();
  const token = await new SignJWT({ role: "sso", sub: "probe", name: "Probe" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));

  const res = await fetch("http://localhost:3000/api/fields/pattern", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `rse_session=${token}` },
    body: JSON.stringify({
      bbox: [75.784, 26.781, 75.816, 26.799], // Sanganer z16 viewport (~6 km²)
      year: 2025,
      grouping: true,
      minConfidence: 69,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log("HTTP", res.status, text.slice(0, 300));
    process.exit(1);
  }
  const last = JSON.parse(text.trim().split("\n").pop());
  const rows = last.fields || [];
  const withSeries = rows.filter((r) => Array.isArray(r.series) && r.series.length > 0);
  console.log("count:", last.count, "rows:", rows.length, "withSeries:", withSeries.length);
  if (rows[0]) {
    console.log("row0 keys:", Object.keys(rows[0]).join(","));
    console.log("row0.series:", JSON.stringify(rows[0].series)?.slice(0, 120));
    console.log("row0.cls:", rows[0].cls, "group:", rows[0].group, "validMonths:", rows[0].validMonths);
  }
  console.log("classes:", JSON.stringify(last.classes));
  console.log("grouping:", JSON.stringify(last.grouping));
})().catch((e) => {
  console.error("PROBE FAIL:", e.message);
  process.exit(1);
});
