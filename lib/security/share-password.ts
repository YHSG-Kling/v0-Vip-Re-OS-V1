/**
 * lib/security/share-password.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Password hashing for DOCUMENT SHARE LINKS (public.document_sharing_links).
 *
 * WHY THIS FILE EXISTS. `createDocumentShareLink` stored the share password with
 * `password_hash: data.password` — the raw string, in a column named "hash" —
 * and `accessSharedDocument` compared it with `link.password_hash !== password`.
 * A plaintext secret at rest, plus a comparison that leaks its answer through
 * timing. Migration m356 adds a CHECK that rejects anything not carrying the
 * envelope this module mints, so the plaintext shape cannot come back.
 *
 * WHY scrypt FROM node:crypto, and not bcrypt.
 *   - `bcrypt` and `bcryptjs` are both in package.json, but NEITHER is imported
 *     anywhere in app/, lib/, services/ or scripts/ — there is no established
 *     password-hashing convention in this repo to follow. What IS established is
 *     node:crypto: aes-256-gcm in lib/security/secret-crypto.ts, and
 *     `timingSafeEqual` in ~20 webhook verifiers. This stays on that road.
 *   - `bcrypt` is a native addon; adding a native binding to a Next.js server
 *     action's bundle is a deployment risk taken for no gain here.
 *   - scrypt is memory-hard, is in the standard library, and needs no package.
 *
 * ENVELOPE FORMAT (self-describing so parameters can be raised later without a
 * migration — an old row keeps verifying with the parameters it was written at):
 *
 *   scrypt$<N>$<r>$<p>$<salt-base64>$<derived-key-base64>
 *
 * The literal `scrypt$` prefix is what the database CHECK constraint keys on.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

/** Envelope prefix — must stay in sync with the m356 CHECK constraint. */
export const SHARE_PASSWORD_PREFIX = "scrypt$"

/** OWASP-suggested interactive scrypt parameters (N=2^14, r=8, p=1). */
const N = 16384
const R = 8
const P = 1
const KEYLEN = 32
const SALT_BYTES = 16

/** Guard: scryptSync throws if N*r*p exceeds the default 32 MiB maxmem. */
const MAXMEM = 64 * 1024 * 1024

/**
 * Hashes a share-link password. Returns null for an empty/absent password so the
 * caller can store NULL rather than a hash of "".
 */
export function hashSharePassword(password: string | null | undefined): string | null {
  if (typeof password !== "string" || password.length === 0) return null
  const salt = randomBytes(SALT_BYTES)
  const key = scryptSync(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
  return [SHARE_PASSWORD_PREFIX.slice(0, -1), N, R, P, salt.toString("base64"), key.toString("base64")].join("$")
}

/**
 * Constant-time verification against a stored envelope.
 *
 * Returns false — never throws — for a malformed envelope, a legacy PLAINTEXT
 * value written before m356, or a bad password. A legacy plaintext row is
 * treated as unverifiable ON PURPOSE: silently accepting it would keep the
 * plaintext path alive. Such a link must be re-created.
 */
export function verifySharePassword(
  stored: string | null | undefined,
  password: string | null | undefined,
): boolean {
  if (typeof stored !== "string" || stored.length === 0) return false
  if (typeof password !== "string" || password.length === 0) return false
  if (!stored.startsWith(SHARE_PASSWORD_PREFIX)) return false

  const parts = stored.split("$")
  // ["scrypt", N, r, p, salt, key]
  if (parts.length !== 6) return false

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (n < 2 || (n & (n - 1)) !== 0 || r < 1 || p < 1) return false
  // Refuse absurd work factors from a tampered row rather than hanging the request.
  if (n > 1 << 20 || r > 32 || p > 16) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], "base64")
    expected = Buffer.from(parts[5], "base64")
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let actual: Buffer
  try {
    actual = scryptSync(password.normalize("NFKC"), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    })
  } catch {
    return false
  }

  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
