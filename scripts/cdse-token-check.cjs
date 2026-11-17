/**
 * Live CDSE token check — mirrors lib/cdse/auth.ts requestToken() exactly.
 * Prints ONLY: env-var presence/length, HTTP statuses, and success/failure.
 * Never prints the client id or the client secret.
 *
 * Usage (from the repo root):  node scripts/cdse-token-check.cjs
 */
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const stripQuotes = (value) => {
  const trimmed = (value ?? "").trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return (quoted ? quoted[2] : trimmed).trim();
};

(async () => {
  const tokenUrl = process.env.CDSE_TOKEN_URL;
  const clientId = stripQuotes(process.env.CDSE_CLIENT_ID);
  const clientSecret = stripQuotes(process.env.CDSE_CLIENT_SECRET);

  console.log("CDSE_CLIENT_ID: defined=" + Boolean(clientId) + " len=" + clientId.length);
  console.log("CDSE_CLIENT_SECRET: defined=" + Boolean(clientSecret) + " len=" + clientSecret.length);
  console.log("CDSE_TOKEN_URL: " + (tokenUrl || "(unset)"));

  if (!clientId || !clientSecret) {
    console.log("RESULT: FAIL (missing env var)");
    process.exitCode = 1;
    return;
  }

  let response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.log("RESULT: FAIL (network error: " + (error && error.name) + ")");
    process.exitCode = 1;
    return;
  }

  const text = await response.text().catch(() => "");
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }

  console.log("token endpoint: HTTP " + response.status);
  if (response.ok && parsed.access_token) {
    console.log("RESULT: SUCCESS (token HTTP " + response.status + ")");
    return;
  }

  // Safe: upstream error fields only — the response never echoes the secret.
  console.log(
    "RESULT: FAIL (token HTTP " +
      response.status +
      (parsed.error ? " error=" + parsed.error : "") +
      (parsed.error_description
        ? " description=" + String(parsed.error_description).replace(/\s+/g, " ").slice(0, 160)
        : "") +
      ")",
  );
  process.exitCode = 1;
})();
