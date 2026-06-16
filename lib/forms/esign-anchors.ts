// lib/forms/esign-anchors.ts
//
// PROVIDER-AGNOSTIC E-SIGN ANCHORS — "tag once, sign on any provider." An offer packet is filled
// once (lib/forms/pdf-form-fill) and then needs SIGNATURE/INITIAL/DATE placement before it goes out
// — and the agent should confirm each area is set for the right party. Every e-sign provider
// (Dotloop, DocuSign, SkySlope, Authentisign, …) expresses placement differently, so we derive ONE
// canonical anchor set from the form's own field names, then per-provider adapters translate it.
//
// SAFETY (the whole point): an anchor is only auto-derived when a field names EXACTLY ONE party and a
// signature/initial/date type. A field that names no party, or TWO parties, is returned as AMBIGUOUS
// — never auto-assigned, so a signature can never land on the wrong party's line. Pure (no I/O).

export type SignerRole = "buyer" | "co_buyer" | "seller" | "co_seller" | "agent" | "listing_agent"
export type AnchorType = "signature" | "initial" | "date"

export interface EsignAnchor {
  role: SignerRole
  type: AnchorType
  /** canonical, stable key — e.g. "buyer_signature_1". */
  key: string
  /** the source PDF field name this anchor was derived from. */
  fieldName: string
}

export interface AmbiguousAnchor {
  fieldName: string
  type: AnchorType
  /** the roles that matched (0 = no party named, ≥2 = conflicting parties). */
  matchedRoles: SignerRole[]
  reason: string
}

export interface DerivedAnchors {
  anchors: EsignAnchor[]
  /** signature/initial/date fields we refused to auto-assign — the agent places these manually. */
  ambiguous: AmbiguousAnchor[]
}

// Order matters: the more-specific role (co_*, listing_*) must be tested before the base role.
const ROLE_PATTERNS: Array<{ role: SignerRole; re: RegExp }> = [
  { role: "co_buyer",      re: /co.?buyer|buyer.?2|second.?buyer|spouse/i },
  { role: "co_seller",     re: /co.?seller|seller.?2|second.?seller/i },
  { role: "listing_agent", re: /listing.?agent|seller.?agent/i },
  { role: "buyer",         re: /\bbuyer\b|\bpurchaser\b/i },
  { role: "seller",        re: /\bseller\b|\bgrantor\b/i },
  { role: "agent",         re: /\bagent\b|broker/i },
]

const TYPE_PATTERNS: Array<{ type: AnchorType; re: RegExp }> = [
  { type: "initial",   re: /initial/i },
  { type: "signature", re: /signature|\bsign\b|\bsignce\b/i },
  { type: "date",      re: /\bdate\b|signed.?on/i },
]

/** Which signer roles a field name references (0, 1, or more). Pure. */
function rolesForField(fieldName: string): SignerRole[] {
  const found: SignerRole[] = []
  // Test specific roles first; once co_buyer matches we must NOT also count the base "buyer".
  const matched = new Set<SignerRole>()
  for (const { role, re } of ROLE_PATTERNS) {
    if (re.test(fieldName)) {
      // Don't double-count base role when its specific variant already matched.
      if (role === "buyer" && matched.has("co_buyer")) continue
      if (role === "seller" && matched.has("co_seller")) continue
      if (role === "agent" && matched.has("listing_agent")) continue
      matched.add(role)
      found.push(role)
    }
  }
  return found
}

function typeForField(fieldName: string): AnchorType | null {
  for (const { type, re } of TYPE_PATTERNS) if (re.test(fieldName)) return type
  return null
}

/**
 * Derive the canonical e-sign anchors from a form's field names. A field is an anchor ONLY when it
 * names exactly one party AND a signature/initial/date type; otherwise it's returned as ambiguous
 * (placed manually) so a party is never guessed. Pure.
 */
export function deriveEsignAnchors(fieldNames: string[]): DerivedAnchors {
  const anchors: EsignAnchor[] = []
  const ambiguous: AmbiguousAnchor[] = []
  const counts: Record<string, number> = {}

  for (const raw of fieldNames ?? []) {
    const fieldName = (raw ?? "").trim()
    if (!fieldName) continue
    const type = typeForField(fieldName)
    if (!type) continue // not a signature/initial/date field — it's a data field, not an anchor
    const roles = rolesForField(fieldName)
    if (roles.length !== 1) {
      ambiguous.push({
        fieldName, type, matchedRoles: roles,
        reason: roles.length === 0 ? "no party named on the field — place manually" : `multiple parties named (${roles.join(", ")}) — place manually`,
      })
      continue
    }
    const role = roles[0]
    const idx = (counts[`${role}_${type}`] = (counts[`${role}_${type}`] ?? 0) + 1)
    anchors.push({ role, type, key: `${role}_${type}_${idx}`, fieldName })
  }

  return { anchors, ambiguous }
}

/** The distinct signer roles an anchor set requires (for building the provider's recipient list). Pure. */
export function rolesInAnchors(anchors: EsignAnchor[]): SignerRole[] {
  return Array.from(new Set((anchors ?? []).map((a) => a.role)))
}
