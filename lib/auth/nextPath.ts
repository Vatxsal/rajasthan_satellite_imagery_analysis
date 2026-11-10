/**
 * Validates the `next` redirect target used by /login (middleware appends it
 * when an unauthenticated page request is bounced to sign-in, and the login
 * page navigates back to it after a successful login or guest session).
 *
 * Only same-origin RELATIVE paths are allowed: a single leading "/" and
 * nothing that could escape into another origin or a different URL scheme
 * when the browser resolves it. Hostile inputs (protocol-relative "//host",
 * backslashes (which http(s) URLs treat as "/"), absolute URLs,
 * "javascript:", control characters / CR-LF, over-long values) return null —
 * callers then fall back to "/".
 *
 * Edge-safe: no dependencies, imported by middleware.ts and client code.
 */
const MAX_NEXT_LENGTH = 2_048;

/** Control chars (incl. CR/LF/tab/DEL) — never valid in a path we redirect to. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function sanitizeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return null;
  // Must be a relative path: rejects "javascript:…", "https://evil", "evil".
  if (!raw.startsWith("/")) return null;
  // Protocol-relative "//evil.com" (and "///…") — another origin.
  if (raw.startsWith("//")) return null;
  // Backslashes: http(s) URL parsers normalise "\" to "/", so "/\evil.com"
  // and percent-encoded "%5c" escapes must be refused outright.
  if (raw.includes("\\")) return null;
  if (raw.includes("%5c") || raw.includes("%5C")) return null;
  if (hasControlChars(raw)) return null;
  return raw;
}

/** Convenience for callers that want a usable path unconditionally. */
export function nextPathOrFallback(raw: string | null | undefined): string {
  return sanitizeNextPath(raw) ?? "/";
}
