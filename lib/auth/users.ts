/**
 * SSO user directory — parses the SSO_USERS env var (a JSON array of
 * { username, passwordHash, displayName? }) with zod. Node-runtime only
 * (routes/scripts); never imported by middleware or client code.
 *
 * Usernames are compared case-insensitively after trimming; the stored form
 * keeps whatever case the admin used. No user data is ever logged.
 */
import { z } from "zod";

export interface SsoUser {
  username: string;
  passwordHash: string;
  displayName?: string;
}

const ssoUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, "username must not be empty")
    .max(64, "username must be at most 64 characters"),
  passwordHash: z
    .string()
    .min(1, "passwordHash must not be empty")
    .max(512, "passwordHash is too long"),
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional(),
});

const ssoUsersSchema = z
  .array(ssoUserSchema)
  .min(1, "SSO_USERS must contain at least one user")
  .max(200, "SSO_USERS must contain at most 200 users");

export type ParseSsoUsersResult =
  | { users: SsoUser[]; error: null }
  | { users: null; error: string };

/**
 * Parses SSO_USERS. Empty/unset yields an empty list (every login attempt
 * then fails with the uniform credential error); malformed JSON or invalid
 * entries yield an error string the route turns into a 503 without leaking
 * contents (dev-only detail).
 */
export function parseSsoUsers(raw: string | undefined): ParseSsoUsersResult {
  const trimmed = raw?.trim();
  if (!trimmed) return { users: [], error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { users: null, error: "SSO_USERS is not valid JSON." };
  }
  const result = ssoUsersSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join(".") || "(root)";
    return { users: null, error: `SSO_USERS: ${where}: ${first?.message ?? "invalid entry"}.` };
  }
  return { users: result.data, error: null };
}

/** Trim + lowercase — the canonical form used for lookups and rate-limit keys. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Case-insensitive lookup against an already-parsed list. */
export function findUserByName(users: SsoUser[], normalizedUsername: string): SsoUser | null {
  for (const user of users) {
    if (normalizeUsername(user.username) === normalizedUsername) return user;
  }
  return null;
}
