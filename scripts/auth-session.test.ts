import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSessionCookieOptions,
  sessionCookieOptions,
  signSession,
  verifySession,
} from "../lib/auth/session";

/** Session JWTs: claims, expiry, tampering, wrong secret, cookie attributes. */

const SECRET = "test-session-secret-0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "another-session-secret-zzzzzzzzzzzzzzzzzzzzzzzzz";

test("signSession → verifySession round-trips every claim", async () => {
  const token = await signSession(
    { role: "sso", sub: "admin", name: "Admin User" },
    SECRET,
    3_600,
  );
  const claims = await verifySession(token, SECRET);
  assert.ok(claims);
  assert.equal(claims.role, "sso");
  assert.equal(claims.sub, "admin");
  assert.equal(claims.name, "Admin User");
  assert.ok(typeof claims.iat === "number");
  assert.ok(typeof claims.exp === "number");
  assert.ok(claims.exp > claims.iat);
});

test("guest role round-trips", async () => {
  const token = await signSession(
    { role: "guest", sub: "guest:0af2c6f4-0000-4000-8000-000000000001", name: "Guest" },
    SECRET,
    600,
  );
  const claims = await verifySession(token, SECRET);
  assert.ok(claims);
  assert.equal(claims.role, "guest");
  assert.equal(claims.name, "Guest");
});

test("expired tokens are rejected", async () => {
  const token = await signSession({ role: "sso", sub: "admin", name: "A" }, SECRET, -60);
  assert.equal(await verifySession(token, SECRET), null);
});

test("tampered tokens are rejected", async () => {
  const token = await signSession({ role: "sso", sub: "admin", name: "A" }, SECRET, 3_600);
  const [header, payload, signature] = token.split(".");
  assert.ok(header && payload && signature);
  // Swap a payload character — signature no longer matches.
  const evilPayload = payload.startsWith("e")
    ? `f${payload.slice(1)}`
    : `e${payload.slice(1)}`;
  const forged = `${header}.${evilPayload}.${signature}`;
  assert.equal(await verifySession(forged, SECRET), null);
  // Also: truncated signature.
  assert.equal(await verifySession(`${header}.${payload}.${signature.slice(0, -2)}`, SECRET), null);
});

test("wrong secret is rejected", async () => {
  const token = await signSession({ role: "sso", sub: "admin", name: "A" }, SECRET, 3_600);
  assert.equal(await verifySession(token, OTHER_SECRET), null);
});

test("garbage / empty tokens are rejected", async () => {
  assert.equal(await verifySession("", SECRET), null);
  assert.equal(await verifySession(null, SECRET), null);
  assert.equal(await verifySession(undefined, SECRET), null);
  assert.equal(await verifySession("not.a.jwt", SECRET), null);
  // A valid token with no secret configured (misconfigured gate) → null.
  const token = await signSession({ role: "guest", sub: "guest:x", name: "Guest" }, SECRET, 60);
  assert.equal(await verifySession(token, null), null);
});

test("unexpected role values are rejected", async () => {
  // Forged payload signed with the REAL secret but carrying a bad role —
  // claims are still shape-checked after signature verification.
  const { SignJWT } = await import("jose");
  const token = await new SignJWT({ role: "admin", name: "A" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("admin")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .sign(new TextEncoder().encode(SECRET));
  assert.equal(await verifySession(token, SECRET), null);
});

test("session cookies are httpOnly, SameSite=Lax, path / with a max-age", () => {
  const options = sessionCookieOptions(7_200);
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/");
  assert.equal(options.maxAge, 7_200);
  // NODE_ENV is not "production" under `node --test`.
  assert.equal(options.secure, process.env.NODE_ENV === "production");

  const cleared = clearSessionCookieOptions();
  assert.equal(cleared.maxAge, 0);
  assert.equal(cleared.httpOnly, true);
  assert.equal(cleared.path, "/");
  assert.ok(cleared.expires.getTime() <= 0);
});
