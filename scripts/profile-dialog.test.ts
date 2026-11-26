import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { GET as sessionGet } from "../app/api/auth/session/route";
import { CAPABILITIES, PERMISSIONS, type Capability } from "../lib/auth/permissions";
import { guestCookie, ssoCookie, useOpenAuthGate, useReadyAuthGate } from "./test-session";

/**
 * Profile dialog (Part 2): the extended session payload (username, display
 * name, issued/expires — never the guest subject), the dialog's content
 * contract (capabilities list, quota readouts, admin password note, session
 * actions) and the shared login navigation helpers.
 */

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
}

function resetState(): void {
  process.env.RATE_LIMIT_PER_MIN = "10000";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.org";
  useReadyAuthGate();
  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
}

beforeEach(resetState);

async function call(
  handler: (request: Request) => Promise<Response>,
  request: Request,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await handler(request);
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function get(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

const read = (...parts: string[]): string =>
  readFileSync(join(__dirname, "..", "..", ...parts), "utf8");

test("session: SSO payload carries profile fields, never the raw subject", async () => {
  const result = await call(sessionGet, get("http://localhost/api/auth/session", await ssoCookie()));
  assert.equal(result.status, 200);
  const body = result.body!;
  assert.equal(body.role, "sso");
  assert.equal(body.name, "Test SSO");
  assert.equal(body.displayName, "Test SSO");
  assert.equal(body.username, "test-sso-user");
  assert.ok(Number.isInteger(body.issuedAt), "issuedAt epoch seconds");
  assert.ok(Number.isInteger(body.expiresAt), "expiresAt epoch seconds");
  assert.ok((body.expiresAt as number) > (body.issuedAt as number));
  assert.ok(body.capabilities);
  assert.ok(body.limits);
  assert.ok(body.usageToday);
  // Never leak the subject key, the token, or secrets.
  assert.equal(body.sub, undefined);
  assert.equal(body.token, undefined);
  const text = JSON.stringify(body).toLowerCase();
  assert.doesNotMatch(text, /session_secret|"cookie"|password/);
});

test("session: guest cookie exposes no username/subject", async () => {
  const result = await call(
    sessionGet,
    get("http://localhost/api/auth/session", await guestCookie("guest:profile-test-1")),
  );
  assert.equal(result.status, 200);
  const body = result.body!;
  assert.equal(body.role, "guest");
  assert.equal(body.displayName, "Guest");
  assert.equal(body.username, undefined, "the guest subject never leaves the server");
  assert.equal(body.sub, undefined);
  assert.ok(Number.isInteger(body.issuedAt), "guest cookie still has a session age");
  assert.ok(Number.isInteger(body.expiresAt));
});

test("session: ambient guest has no username and null issue/expiry", async () => {
  useOpenAuthGate();
  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  const result = await call(sessionGet, get("http://localhost/api/auth/session"));
  assert.equal(result.status, 200);
  const body = result.body!;
  assert.equal(body.role, "guest");
  assert.equal(body.username, undefined);
  assert.equal(body.issuedAt, null);
  assert.equal(body.expiresAt, null);
});

test("profile dialog: capability list, quotas, password note and actions", () => {
  const dialog = read("components", "shell", "ProfileDialog.tsx");
  // Every capability gets an allowed/locked row from the single policy table.
  assert.match(dialog, /CAPABILITIES\.map/);
  assert.match(dialog, /CAPABILITY_LABELS/);
  assert.match(dialog, /Available with an SSO ID/);
  assert.match(dialog, /PERMISSIONS\[role\]\.capabilities/);
  // Today's binding quotas (the "2 of 3 analyses left today" readouts).
  assert.match(dialog, /QuotaReadout kind="search"/);
  assert.match(dialog, /QuotaReadout kind="compare"/);
  assert.match(dialog, /QuotaReadout kind="aiSummary"/);
  assert.match(dialog, /showWhenFull/);
  // No fake password form — the note points at the administrator instead.
  assert.match(dialog, /Passwords are managed by your administrator\./);
  assert.doesNotMatch(dialog, /type="password"/);
  assert.doesNotMatch(dialog, /current password/i);
  // Session actions.
  assert.match(dialog, /Sign out/);
  assert.match(dialog, /Sign in with SSO/);
  assert.match(dialog, /Request access/);
  // Session identity + issue/expiry from the extended payload.
  assert.match(dialog, /username/);
  assert.match(dialog, /issuedAt/);
  assert.match(dialog, /expiresAt/);
  // Opens from the account menu and is a titled Radix dialog.
  const topbar = read("components", "shell", "TopBar.tsx");
  assert.match(topbar, /onSelect=\{\(\) => setProfileOpen\(true\)\}/);
  assert.match(topbar, /<ProfileDialog open=\{profileOpen\}/);
  const uiDialog = read("components", "ui", "Dialog.tsx");
  assert.match(uiDialog, /@radix-ui\/react-dialog/);
  assert.match(uiDialog, /DialogPrimitive\.Title/, "every dialog renders an accessible title");
});

test("capability inventory covers the policy table", () => {
  // The profile dialog iterates CAPABILITIES — keep the count in sync so a
  // new capability can't silently be missing from the access list.
  assert.equal(CAPABILITIES.length, 25);
  for (const id of CAPABILITIES as readonly Capability[]) {
    assert.ok(PERMISSIONS.sso.capabilities[id] === true, `sso holds ${id}`);
    assert.ok(typeof PERMISSIONS.guest.capabilities[id] === "boolean", `guest decides ${id}`);
  }
});

test("shared login navigation preserves the return path", () => {
  const nav = read("lib", "auth", "nav.ts");
  assert.match(nav, /export function goSignIn/);
  assert.match(nav, /export function goRequestAccess/);
  assert.match(nav, /mode=request/);
  assert.match(nav, /next=\$\{encodeURIComponent\(next\)\}/);
  // Both former copies (TopBar, FeatureLock) now import the shared helper.
  const featureLock = read("components", "ui", "FeatureLock.tsx");
  assert.match(featureLock, /import \{ goRequestAccess, goSignIn \} from "@\/lib\/auth\/nav"/);
  assert.doesNotMatch(featureLock, /function goSignIn\(\): void/);
  const topbar = read("components", "shell", "TopBar.tsx");
  assert.match(topbar, /import \{ goSignIn \} from "@\/lib\/auth\/nav"/);
  assert.doesNotMatch(topbar, /const goSignIn = \(\)/);
});
