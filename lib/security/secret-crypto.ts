// lib/security/secret-crypto.ts
// ─────────────────────────────────────────────────────────────────────────────
// AT-REST ENCRYPTION for per-tenant secrets (smtp_password, provider api_key/api_secret,
// OAuth access/refresh tokens) that are stored PLAINTEXT today. AES-256-GCM (authenticated
// encryption) keyed by SECRETS_ENCRYPTION_KEY.
//
// Two properties make adoption SAFE for a live app:
//   • BACKWARD-COMPATIBLE — encryptSecret writes a self-describing `enc:v1:…` envelope;
//     decryptSecret returns any value that is NOT that envelope verbatim. So a reader can be
//     switched to decryptSecret first (it passes plaintext through), then writers switched to
//     encryptSecret — existing plaintext rows keep working throughout the migration.
//   • FAIL-SAFE — with no key configured, encryptSecret is a NO-OP (returns plaintext) so a
//     missing key never silently breaks writes; isEncryptionConfigured() lets callers require it.
//
// Pure + deterministic given the key (except the random IV) — unit-tested via roundtrip +
// plaintext passthrough + tamper detection.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto"

const PREFIX = "enc:v1:"

function keyBytes(): Buffer | null {
  const raw = process.env.SECRETS_ENCRYPTION_KEY
  if (!raw) return null
  // Accept a raw 32-byte hex/base64 key, or derive 32 bytes from any passphrase via SHA-256.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex")
  try { const b = Buffer.from(raw, "base64"); if (b.length === 32) return b } catch { /* not base64 */ }
  return createHash("sha256").update(raw).digest()
}

/** Is an encryption key configured? Callers handling NEW secrets should require this. */
export function isEncryptionConfigured(): boolean {
  return keyBytes() !== null
}

/** Is this value already an encrypted envelope? */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX)
}

/** Encrypt a secret to `enc:v1:<iv_b64>:<tag_b64>:<ct_b64>`. No-op (returns input) if no key
 *  or the value is empty / already encrypted. */
export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === "") return plaintext ?? null
  if (isEncrypted(plaintext)) return plaintext
  const key = keyBytes()
  if (!key) return plaintext // fail-safe: never block a write on a missing key
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`
}

/** Decrypt a secret. Returns any NON-envelope value verbatim (backward compatible with plaintext).
 *  Throws on a tampered/corrupt envelope (GCM auth failure) so a silent corruption can't pass. */
export function decryptSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (!isEncrypted(value)) return value // plaintext passthrough
  const key = keyBytes()
  if (!key) throw new Error("SECRETS_ENCRYPTION_KEY required to decrypt an encrypted secret")
  const [, , ivB64, tagB64, ctB64] = value.split(":")
  const iv = Buffer.from(ivB64, "base64")
  const tag = Buffer.from(tagB64, "base64")
  const ct = Buffer.from(ctB64, "base64")
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
}
