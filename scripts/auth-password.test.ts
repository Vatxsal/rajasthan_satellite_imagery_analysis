import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../lib/auth/passwords";

/** scrypt password hashing: format, verification, and the wrong-password paths. */

const HASH_FORMAT = /^scrypt\$N=\d+,r=\d+,p=\d+,len=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/;

test("hashPassword produces the documented single-string format", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.match(stored, HASH_FORMAT);
  assert.ok(stored.startsWith("scrypt$"));
});

test("hashPassword uses a per-call random salt (same password, different hashes)", () => {
  const a = hashPassword("same-password-123");
  const b = hashPassword("same-password-123");
  assert.notEqual(a, b);
  // ...but both verify.
  assert.equal(verifyPassword("same-password-123", a), true);
  assert.equal(verifyPassword("same-password-123", b), true);
});

test("verifyPassword accepts the correct password", () => {
  const stored = hashPassword("s3cure-Passw0rd!");
  assert.equal(verifyPassword("s3cure-Passw0rd!", stored), true);
});

test("verifyPassword rejects wrong passwords", () => {
  const stored = hashPassword("s3cure-Passw0rd!");
  assert.equal(verifyPassword("s3cure-Passw0rd", stored), false);
  assert.equal(verifyPassword("S3cure-Passw0rd!", stored), false);
  assert.equal(verifyPassword("", stored), false);
  assert.equal(verifyPassword("completely-different", stored), false);
});

test("verifyPassword rejects tampered hashes without throwing", () => {
  const stored = hashPassword("s3cure-Passw0rd!");
  const parts = stored.split("$");
  // Flip a character in the MIDDLE of the hash component — the final base64
  // char sits in a padding quantum and may decode to the same bytes.
  const hash = parts[3]!;
  const index = Math.floor(hash.length / 2);
  const original = hash[index]!;
  const replacement = original === "A" ? "B" : "A";
  const tamperedHash = hash.slice(0, index) + replacement + hash.slice(index + 1);
  const tampered = [parts[0], parts[1], parts[2], tamperedHash].join("$");
  assert.notEqual(tamperedHash, hash);
  assert.equal(verifyPassword("s3cure-Passw0rd!", tampered), false);
  // The original still verifies.
  assert.equal(verifyPassword("s3cure-Passw0rd!", stored), true);
});

test("verifyPassword rejects malformed stored values (unknown-user path)", () => {
  // The route passes "" for unknown usernames — must be false, must not throw,
  // and must still perform a scrypt derivation (dummy-hash path).
  assert.equal(verifyPassword("anything", ""), false);
  assert.equal(verifyPassword("anything", "not-a-hash"), false);
  assert.equal(verifyPassword("anything", "bcrypt$N=1$aa$bb"), false);
  assert.equal(verifyPassword("anything", 'scrypt$N=x,r=8,p=1,len=64$aa$bb'), false);
});

test("verifyPassword rejects a hash whose params are out of policy", () => {
  // N below the minimum (1024) must not be honoured.
  const stored = hashPassword("s3cure-Passw0rd!");
  const parts = stored.split("$");
  const weakParams = "N=8,r=8,p=1,len=64";
  const weak = [parts[0]!, weakParams, parts[2]!, parts[3]!].join("$");
  assert.equal(verifyPassword("s3cure-Passw0rd!", weak), false);
});

test("empty password never verifies", () => {
  const stored = hashPassword("s3cure-Passw0rd!");
  assert.equal(verifyPassword("", stored), false);
  assert.equal(hashPassword.length >= 1, true);
  assert.throws(() => hashPassword(""));
});
