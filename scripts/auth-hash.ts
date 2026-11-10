/**
 * npm run auth:hash -- "<password>"
 *
 * Prints a scrypt passwordHash for pasting into the SSO_USERS env var.
 * The password itself is never echoed, stored or logged — only the hash
 * (which is safe to commit nowhere: keep it in Vercel's env, not in git).
 */
import { readFileSync } from "node:fs";
import { hashPassword } from "../lib/auth/passwords";

const MIN_PASSWORD_LENGTH = 8;

const usageText = 'Usage: npm run auth:hash -- "<password>"  (or pipe it: echo -n "pw" | npm run auth:hash)';

function usage(): never {
  console.error(usageText);
  process.exit(1);
}

/** argv first; when omitted, read the password from stdin (avoids the npm-on-
 *  Windows cmd.exe space-escaping quirk for passwords that contain spaces). */
function readPassword(): string | undefined {
  const arg = process.argv[2];
  if (typeof arg === "string" && arg.length > 0) return arg;
  try {
    const stdin = readFileSync(0, "utf8").replace(/\r?\n$/, "");
    if (stdin.length > 0) return stdin;
  } catch {
    // no stdin (e.g. detached shell) → fall through to usage
  }
  return undefined;
}

const password = readPassword();
if (typeof password !== "string" || password.length === 0) usage();
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}

console.log(hashPassword(password));
