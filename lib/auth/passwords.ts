/**
 * Password hashing — scrypt from node:crypto (Node-runtime only; never
 * imported by middleware or client code).
 *
 * Stored form (one string, safe to put in the SSO_USERS JSON):
 *   scrypt$N=16384,r=8,p=1,len=64$<salt-base64>$<hash-base64>
 * The per-user salt is random 16 bytes; parameters travel with the hash so
 * they can be raised later without invalidating existing entries.
 *
 * Timing: verifyPassword() ALWAYS runs one scrypt derivation — even when the
 * stored value is missing or malformed — so callers can pair it with a dummy
 * hash for unknown usernames and keep the work (and therefore the response
 * time) identical for valid and invalid users.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/** scrypt needs ~128·N·r bytes (16 MB here); raise the default 32 MB cap for headroom. */
const MAXMEM = 64 * 1024 * 1024;

const ALGORITHM = "scrypt";

interface ParsedHash {
  salt: Buffer;
  hash: Buffer;
}

/** Generates a fresh passwordHash for `password` (random salt each call). */
export function hashPassword(password: string): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return `${ALGORITHM}$N=${N},r=${R},p=${P},len=${KEY_LENGTH}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function parseStored(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return null;
  const [, params, saltB64, hashB64] = parts;
  const n = Number(/(?:^|,)N=(\d+)/.exec(params ?? "")?.[1]);
  const r = Number(/(?:^|,)r=(\d+)/.exec(params ?? "")?.[1]);
  const p = Number(/(?:^|,)p=(\d+)/.exec(params ?? "")?.[1]);
  const len = Number(/(?:^|,)len=(\d+)/.exec(params ?? "")?.[1]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || !Number.isInteger(len)) {
    return null;
  }
  if (n < 1_024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16 || len < 16 || len > 256) {
    return null;
  }
  try {
    const salt = Buffer.from(saltB64 ?? "", "base64");
    const hash = Buffer.from(hashB64 ?? "", "base64");
    if (salt.length < 8 || hash.length !== len) return null;
    return { salt, hash };
  } catch {
    return null;
  }
}

function scryptOf(password: string, salt: Buffer, length: number, n: number, r: number, p: number): Buffer {
  return scryptSync(password.normalize("NFKC"), salt, length, {
    N: n,
    r,
    p,
    maxmem: MAXMEM,
  });
}

/**
 * Dummy hash used for unknown usernames: a real hash of random bytes, so the
 * scrypt work matches a genuine verification (lazily generated once per
 * process — its plaintext never exists).
 */
let dummy: ParsedHash | null = null;
function getDummy(): ParsedHash {
  if (!dummy) {
    const parsed = parseStored(hashPassword(randomBytes(24).toString("base64")));
    if (!parsed) throw new Error("failed to build dummy hash");
    dummy = parsed;
  }
  return dummy;
}

/**
 * Verifies `password` against `stored`. Returns false (never throws) for a
 * wrong password, a malformed stored value, or an empty password — after
 * performing the same scrypt work in every case.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== "string" || password.length === 0) {
    // Still burn one derivation so an empty password is not distinguishable
    // by timing from a wrong one.
    const d = getDummy();
    scryptOf("", d.salt, d.hash.length, N, R, P);
    return false;
  }
  const parsed = typeof stored === "string" ? parseStored(stored) : null;
  if (!parsed) {
    const d = getDummy();
    scryptOf(password, d.salt, d.hash.length, N, R, P);
    return false;
  }
  const candidate = scryptOf(password, parsed.salt, parsed.hash.length, N, R, P);
  if (candidate.length !== parsed.hash.length) return false;
  return timingSafeEqual(candidate, parsed.hash);
}
