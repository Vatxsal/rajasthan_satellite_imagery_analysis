/**
 * Recipient address handling — the pure helpers (validation, normalisation,
 * masked display) shared by server routes AND the client dialog. No node
 * built-ins here so browser code can import it; the hashed rate-limit key
 * (emailHash) lives in ./address.ts because it needs node:crypto.
 */

/** Max RFC 5321 path length. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Practical validation: one @, no whitespace/commas/angle brackets, dotted
 * domain. Deliberately stricter than RFC 5322 (no quoted local parts, no
 * comments) — real report recipients are plain mailbox addresses, and the
 * tight class blocks header-injection tricks.
 */
const EMAIL_PATTERN = /^[^\s@,;:<>"[\]\\]+@[^\s@,;:<>"[\]\\]+\.[^\s@,;:<>"[\]\\]+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(raw: string): boolean {
  if (/[\r\n]/.test(raw)) return false;
  const email = normalizeEmail(raw);
  if (!email || email.length > EMAIL_MAX_LENGTH) return false;
  return EMAIL_PATTERN.test(email);
}

/** Display form for success messages: a***@gmail.com. */
export function maskEmail(email: string): string {
  const value = normalizeEmail(email);
  const at = value.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!domain) return "***";
  return `${local.charAt(0)}***@${domain}`;
}

/** Extracts the bare address from `Name <addr@example.org>` (or returns the input). */
export function emailAddressOf(from: string): string {
  const match = from.match(/<([^<>]+)>/);
  return (match ? match[1] : from).trim();
}

/** True when EMAIL_FROM holds a usable mailbox (bare or with display name). */
export function isValidFromField(from: string): boolean {
  return isValidEmail(emailAddressOf(from));
}
