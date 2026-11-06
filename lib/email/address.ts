/**
 * Server-side address helpers: the hashed rate-limit key (node:crypto) plus
 * re-exports of the pure helpers in ./addressCore.ts so existing imports
 * keep working. Browser code must import ./addressCore directly.
 */
import { createHash } from "node:crypto";
import { normalizeEmail } from "./addressCore";

export * from "./addressCore";

/** Stable key for per-address rate limits (hashed — the address is never stored). */
export function emailHash(email: string): string {
  return createHash("sha256").update(`rse-email-v1:${normalizeEmail(email)}`).digest("hex").slice(0, 32);
}
