/**
 * Access gate — Edge middleware (jose-verified session cookie).
 *
 * States (from lib/auth/config.ts, read straight from process.env so the
 * Edge runtime never pulls in the full zod env schema):
 *
 *   misconfigured — AUTH_REQUIRED=true but SESSION_SECRET missing/short:
 *                   FAIL CLOSED. Page requests (including /login) get a
 *                   plain "Authentication is not configured" page, APIs get
 *                   503 AUTH_NOT_CONFIGURED. Only /api/health/* and static
 *                   assets stay up.
 *   off           — AUTH_REQUIRED=false (dev/test or explicit opt-out):
 *                   everything passes; a valid session still redirects an
 *                   already-signed-in user away from /login to "/".
 *   ready          — gate on + usable secret:
 *                   - public paths: /login, /api/auth/*, /api/access-request,
 *                     /api/health/*, static assets → through
 *                   - signed-in user opening /login → redirect "/"
 *                   - unauthenticated /api/* → 401 { code: "UNAUTHENTICATED" }
 *                     (never a redirect — API clients must not receive HTML)
 *                   - unauthenticated pages → /login?next=<path+query>
 *                     (sanitised by sanitizeNextPath; emailed deep links such
 *                     as /?a=…&A=…&B=…&tab=events survive the round trip)
 *
 * The matcher below only skips the heavy compiled bundles; classification of
 * "static vs route" happens here so public files (images, robots.txt, fonts)
 * never bounce to /login.
 */
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, authGateState, sessionSecret } from "@/lib/auth/config";
import { sanitizeNextPath } from "@/lib/auth/nextPath";
import { verifySession } from "@/lib/auth/session";

/** Static files served straight through (also excluded in the matcher). */
function isStaticAsset(pathname: string): boolean {
  if (pathname.startsWith("/_next/static/")) return true;
  if (pathname.startsWith("/_next/image/")) return true;
  if (pathname === "/favicon.ico") return true;
  if (pathname.startsWith("/fonts/")) return true;
  // Any other file with an extension (public images, og.png, robots.txt, …).
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return lastSegment.includes(".");
}

function isPublicApi(pathname: string): boolean {
  if (pathname.startsWith("/api/auth/")) return true;
  if (pathname === "/api/access-request") return true;
  if (pathname.startsWith("/api/health/")) return true;
  return false;
}

function notConfiguredPage(): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Authentication is not configured</title>
</head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F5F1;color:#1B1D22;font-family:Arial,Helvetica,sans-serif;">
<main style="max-width:28rem;padding:2rem;text-align:center;">
<h1 style="font-size:1.25rem;margin:0 0 .75rem;">Authentication is not configured</h1>
<p style="margin:0;font-size:.95rem;line-height:1.5;color:#4B4E56;">
This deployment requires a session, but <code>SESSION_SECRET</code> is missing or too short.
Set it (32+ characters) and redeploy.
</p>
</main>
</body>
</html>`;
  return new NextResponse(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}

function notConfiguredApi(): NextResponse {
  return NextResponse.json(
    { code: "AUTH_NOT_CONFIGURED", message: "Authentication is not configured." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

function unauthenticatedApi(): NextResponse {
  return NextResponse.json(
    { code: "UNAUTHENTICATED", message: "Not signed in." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const state = authGateState();

  if (state === "misconfigured") {
    // Fail closed: never serve the dashboard. Health probes and static files
    // stay available so monitoring and error pages keep working.
    if (pathname.startsWith("/api/health/") || isStaticAsset(pathname)) {
      return NextResponse.next();
    }
    if (pathname.startsWith("/api/")) return notConfiguredApi();
    return notConfiguredPage();
  }

  const signedIn = await verifySession(
    request.cookies.get(AUTH_COOKIE)?.value,
    sessionSecret(),
  );

  // /login is always reachable; signed-in visitors bounce to the dashboard.
  if (pathname === "/login") {
    if (signedIn) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (state === "off") return NextResponse.next();
  if (isStaticAsset(pathname) || isPublicApi(pathname)) return NextResponse.next();

  if (!signedIn) {
    if (pathname.startsWith("/api/")) return unauthenticatedApi();
    const loginUrl = new URL("/login", request.url);
    // Keep path + query (emailed deep links) behind the same-origin
    // sanitizer; anything hostile collapses to "/".
    loginUrl.searchParams.set("next", sanitizeNextPath(pathname + search) ?? "/");
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Skip only the compiled bundles; everything else is classified above.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
