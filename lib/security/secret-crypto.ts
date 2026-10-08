// lib/security/secret-crypto.ts
// ─────────────────────────────────────────────────────────────────────────────
// AT-REST ENCRYPTION for per-tenant secrets (smtp_password, provider api_key/api_secret,
// OAuth access/refresh tokens). AES-256-GCM (authenticated encryption) keyed by
// SECRETS_ENCRYPTION_KEY.
//
// Three properties:
//   • BACKWARD-COMPATIBLE READS — encryptSecret writes a self-describing `enc:v1:…` envelope;
//     decryptSecret returns any value that is NOT that envelope verbatim, so a legacy plaintext
//     row keeps working. A read NEVER rewrites, re-encrypts or "repairs" the stored value.
//     Legacy plaintext is REPORTED by the posture census (lib/security/credential-rotation.ts
//     reportSecretStoragePosture — a count of non-envelope values per store column).
//   • FAIL-CLOSED WRITES (owner, wave 139: "secrets FAIL CLOSED when SECRETS_ENCRYPTION_KEY … is
//     absent — refuse NEW writes … never plaintext") — with no key, encryptSecret THROWS the typed
//     SecretStorageRefusedError. It never returns the plaintext, never silently downgrades. The
//     refusal carries no part of the secret. Callers turn it into a typed refusal of the write and
//     raise the platform incident (credential-rotation.ts raiseSecretStorageIncident).
//     WAS: "FAIL-SAFE — with no key, encryptSecret is a NO-OP (returns plaintext)". That stored new
//     tenant secrets in plaintext and reported success (finding R-2, wave 138F).
//   • DUAL-KEY READ (rotation) — encrypt always uses the CURRENT key. decrypt tries the current key,
//     then SECRETS_ENCRYPTION_KEY_PREVIOUS. The envelope carries no key id, so the GCM auth tag is
//     what tells the keys apart: a wrong key fails authentication and the next key is tried, never a
//     garbled plaintext. Same current+previous shape as the webhook-secret rotation survivor
//     (lib/platform/tenant-webhooks-core.ts activeWebhookSecrets). Rotation = set the new key as
//     current, the old one as previous; existing envelopes keep decrypting. This is not a KMS.
//
// Pure + deterministic given the key (except the random IV).

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto"

const PREFIX = "enc:v1:"

function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null
  // Accept a raw 32-byte hex/base64 key, or derive 32 bytes from any passphrase via SHA-256.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex")
  try { const b = Buffer.from(raw, "base64"); if (b.length === 32) return b } catch { /* not base64 */ }
  return createHash("sha256").update(raw).digest()
}

function keyBytes(): Buffer | null {
  return parseKey(process.env.SECRETS_ENCRYPTION_KEY)
}

/** Keys a READ may try, current first. The previous key is read-only: nothing encrypts with it. */
function readKeys(): Array<{ key: Buffer; which: "current" | "previous" }> {
  const out: Array<{ key: Buffer; which: "current" | "previous" }> = []
  const current = keyBytes()
  if (current) out.push({ key: current, which: "current" })
  const previous = parseKey(process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS)
  if (previous && !(current && previous.equals(current))) out.push({ key: previous, which: "previous" })
  return out
}

/** Why a NEW secret write was refused. One code per cause; the incident names it. */
export type SecretStorageRefusalCode = "secrets_key_missing"

/**
 * The typed refusal of a NEW secret write. Its message names the missing configuration and NEVER
 * any part of the secret, so it is safe to log, return to a caller, or put in an incident.
 */
class SecretStorageRefusedError extends Error {
  readonly code: SecretStorageRefusalCode
  constructor(code: SecretStorageRefusalCode) {
    super("Secret storage refused: SECRETS_ENCRYPTION_KEY is not configured, so a new secret cannot be stored encrypted (and is never stored in plaintext).")
    this.name = "SecretStorageRefusedError"
    this.code = code
  }
}

export function isSecretStorageRefused(e: unknown): e is SecretStorageRefusedError {
  return e instanceof SecretStorageRefusedError
}

/** Is an encryption key configured? A caller may ask BEFORE a side effect it cannot undo
 *  (an OAuth refresh exchange, a provider handshake) so it never obtains a secret it cannot store. */
export function isEncryptionConfigured(): boolean {
  return keyBytes() !== null
}

/** Is this value already an encrypted envelope? */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX)
}

/** Encrypt a NEW secret to `enc:v1:<iv_b64>:<tag_b64>:<ct_b64>`. Empty / already-encrypted values
 *  pass through. With no key it THROWS SecretStorageRefusedError — FAIL CLOSED, never plaintext. */
export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === "") return plaintext ?? null
  if (isEncrypted(plaintext)) return plaintext
  const key = keyBytes()
  if (!key) throw new SecretStorageRefusedError("secrets_key_missing")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`
}

/** Decrypt a stored secret. A NON-envelope value is returned verbatim (legacy plaintext keeps
 *  working; nothing is rewritten). An envelope is opened with the current key, then the previous
 *  one. Throws when no key opens it (tampered, or neither key is the one it was sealed with) —
 *  a silent corruption can't pass. */
export function decryptSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (!isEncrypted(value)) return value // plaintext passthrough
  const keys = readKeys()
  if (keys.length === 0) throw new Error("SECRETS_ENCRYPTION_KEY required to decrypt an encrypted secret")
  const [, , ivB64, tagB64, ctB64] = value.split(":")
  const iv = Buffer.from(ivB64 ?? "", "base64")
  const tag = Buffer.from(tagB64 ?? "", "base64")
  const ct = Buffer.from(ctB64 ?? "", "base64")
  for (const { key } of keys) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
    } catch { /* GCM auth failed under this key — try the next */ }
  }
  throw new Error(`encrypted secret did not authenticate under ${keys.map((k) => k.which).join(" or ")} SECRETS_ENCRYPTION_KEY (tampered, or sealed with a key no longer configured)`)
}
