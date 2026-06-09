/**
 * lib/compliance/client-text-guard.ts
 *
 * Wave 54 — the SINGLE source of truth for "is this text safe to show a client".
 * Pure, no imports — shared by the client-facing producers (which sanitize any
 * untrusted field they interpolate) AND the autonomous-manager eval harness (which
 * audits the same rule). One definition → producers and the audit can't drift.
 *
 * Why: the producers' static templates are Fair-Housing-clean by construction, but
 * they weave in DATA fields (a listing's city/address, an agent's display name).
 * That data can be scraped, typo'd, or user-controlled — so an unsanitized field is
 * an injection / Fair-Housing leak vector (e.g. a city value carrying steering
 * language flows straight into ad copy). Sanitize every interpolated field here.
 */

// Protected-class / steering language under the Fair Housing Act (42 U.S.C. §3604) + HUD
// advertising guidance. Curated to clear violations to avoid false positives on neutral copy.
export const FAIR_HOUSING_VIOLATION =
  /\b(famil(?:y|ies)|kids?|children|childless|christian|catholic|jewish|muslim|church|synagogue|mosque|safe neighborhood|good schools|no children|adults? only|perfect for|ideal for|able[- ]bodied|handicap|exclusive neighborhood|integrated|ethnic|nationality|bachelor pad|empty nesters?|mother[- ]in[- ]law)\b/i

// Prompt-injection / instruction-override markers (OWASP LLM-01) that must never ride a data field.
export const INJECTION_PATTERN =
  /\b(ignore (?:all|the|previous|prior) (?:instructions|prompts?)|disregard (?:all|the|previous)|system prompt|you are now|act as|write ['"]?)/i

export function hasFairHousingViolation(text: string): boolean {
  return FAIR_HOUSING_VIOLATION.test(text)
}

/**
 * Sanitize an untrusted field before it's woven into client-facing copy. Returns the
 * cleaned value, or `null` when the field is unsafe (contains steering language or an
 * injected directive) so the caller can fall back to a neutral default — bad input
 * yields neutral copy, never a leak.
 */
export function sanitizeClientFacingField(raw: string | null | undefined, maxLen = 60): string | null {
  if (!raw) return null
  const cleaned = String(raw).replace(/\s+/g, " ").trim().slice(0, maxLen).trim()
  if (!cleaned) return null
  if (FAIR_HOUSING_VIOLATION.test(cleaned) || INJECTION_PATTERN.test(cleaned)) return null
  return cleaned
}
