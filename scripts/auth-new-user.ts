/**
 * npm run auth:new-user -- --username <name> [--display "Name"]
 *
 * Generates a strong random password, hashes it, and prints BOTH the
 * password (once) and the JSON entry to paste into SSO_USERS. Nothing is
 * written to disk; the plaintext password exists only in this output.
 */
import { randomInt } from "node:crypto";
import { hashPassword } from "../lib/auth/passwords";
import { normalizeUsername } from "../lib/auth/users";

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
/** Unambiguous alphabet (no 0/O, 1/l/I) + a few symbols. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%_-=";
const PASSWORD_LENGTH = 20;

function usage(): never {
  console.error('Usage: npm run auth:new-user -- --username <name> [--display "Name"]');
  process.exit(1);
}

function parseArgs(argv: string[]): { username: string; display?: string } {
  let username: string | undefined;
  let display: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--username") {
      username = argv[++i];
    } else if (arg === "--display") {
      display = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }
  if (!username) usage();
  return { username, display };
}

/** Unbiased random password: one crypto.randomInt per character. */
function generatePassword(): string {
  let out = "";
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

const { username: rawUsername, display } = parseArgs(process.argv.slice(2));
const username = normalizeUsername(rawUsername);
if (!USERNAME_PATTERN.test(username)) {
  console.error(
    "Username must be 2-64 chars: lowercase letters/digits, then letters, digits, dot, underscore or dash.",
  );
  process.exit(1);
}
/** Strip control chars and `^` — npm on Windows escapes spaces as `^` when
 *  forwarding --display "Some Name" through cmd, which would otherwise land
 *  verbatim in the display name. Also collapses whitespace. */
const cleanDisplay = display
  ?.replace(/[\x00-\x1f\x7f^]/g, "")
  .replace(/\s+/g, " ")
  .trim();
if (cleanDisplay !== undefined && (cleanDisplay.length === 0 || cleanDisplay.length > 80)) {
  console.error("--display must be 1-80 characters.");
  process.exit(1);
}

const password = generatePassword();
const entry: Record<string, string> = {
  username,
  passwordHash: hashPassword(password),
};
if (cleanDisplay) entry.displayName = cleanDisplay;

console.log("");
console.log(`Password for "${username}" (shown ONCE — copy it now, it is not saved):`);
console.log(password);
console.log("");
console.log("Add this entry to your SSO_USERS env var (a JSON array):");
console.log(JSON.stringify(entry));
console.log("");
console.log("Then save SSO_USERS in Vercel (Sensitive) and redeploy.");
