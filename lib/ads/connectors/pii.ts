/**
 * lib/ads/connectors/pii.ts
 *
 * Wave 42 — PII normalization + hashing for ad-platform Customer Match / Custom
 * Audiences. Meta and Google both require uploaded match keys (email, phone) to
 * be NORMALIZED then SHA-256 hashed (lowercase hex) BEFORE they leave our server —
 * raw PII must never be sent. This module is the single chokepoint, so every
 * connector hashes identically and correctly.
 *
 * Pure + deterministic → fully unit-tested against the providers' published
 * normalization rules.
 */
import { createHash } from "crypto"

/** SHA-256 → lowercase hex (the format both Meta and Google require). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

/** Normalize an email: trim + lowercase. (Gmail dot/plus stripping is NOT applied —
 *  both providers hash the address as-typed-but-lowercased.) Returns null if blank. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? "").trim().toLowerCase()
  return e && e.includes("@") ? e : null
}

/**
 * Normalize a phone to E.164 digits (country code + number, no '+', spaces, or
 * punctuation) — the form Meta/Google expect before hashing. Assumes US (+1) for
 * a bare 10-digit number. Returns null if it can't form a plausible number.
 */
export function normalizePhoneE164(raw: string | null | undefined, defaultCountry = "1"): string | null {
  let digits = (raw ?? "").replace(/[^\d]/g, "")
  if (!digits) return null
  if (digits.length === 10) digits = defaultCountry + digits          // bare US number
  // 11+ digits already include a country code.
  return digits.length >= 11 && digits.length <= 15 ? digits : null
}

export interface MatchKeyInput { email?: string | null; phone?: string | null }
export interface HashedMatchKey { email_sha256?: string; phone_sha256?: string }

/** Build a provider match-key from a contact, hashing every present identifier.
 *  Returns null if the contact has no usable identifier. */
export function hashMatchKey(input: MatchKeyInput): HashedMatchKey | null {
  const out: HashedMatchKey = {}
  const email = normalizeEmail(input.email)
  const phone = normalizePhoneE164(input.phone)
  if (email) out.email_sha256 = sha256Hex(email)
  if (phone) out.phone_sha256 = sha256Hex(phone)
  return out.email_sha256 || out.phone_sha256 ? out : null
}

/** Hash a batch of contacts; rows with no usable identifier are counted as rejected. */
export function hashAudienceMembers(rows: MatchKeyInput[]): { hashed: HashedMatchKey[]; rejected: number } {
  const hashed: HashedMatchKey[] = []
  let rejected = 0
  for (const r of rows) {
    const h = hashMatchKey(r)
    if (h) hashed.push(h)
    else rejected++
  }
  return { hashed, rejected }
}
