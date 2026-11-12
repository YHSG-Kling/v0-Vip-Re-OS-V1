// lib/intelligence/offer-property-prefill.ts
//
// OFFER PROPERTY PREFILL (pure) — the offer form is filled BY THE AGENT. The only thing the system
// pre-fills is the PROPERTY IDENTIFICATION the agent shouldn't have to re-type — the property address
// and legal description — and ONLY when we already KNOW it (from the property/parcel record). Offer
// TERMS (price, earnest money, contingencies, dates) are NEVER auto-filled — that's the agent's job,
// and auto-asserting a term we weren't given is a fabrication the compliance gate would (rightly)
// flag. Unknown property facts are left BLANK for the agent to fill. This maps the known property
// facts onto a form's fillable fields by name; it never touches a non-property field. Pure (no I/O).

/** The canonical property-identification field labels PROPERTY_PATTERNS recognizes — for a caller
 *  with no PDF/AcroForm field list of its own (e.g. a "my forms" entry that isn't a fillable PDF) to
 *  get a useful known/unknown preview without inventing its own field vocabulary. */
export const KNOWN_PROPERTY_FIELD_LABELS = [
  "Property Address", "Legal Description", "Property County", "Property City", "Property State", "Property Zip", "APN",
] as const

// ─── THE SHAPE RULE (wave 142, lane 142C; owner: "never invented, never the street address") ──────
// The vocabulary a recorded legal description is written in (lot / block / plat / subdivision / PLSS /
// metes-and-bounds / condominium units). A STREET ADDRESS carries none of it.
const LEGAL_TOKEN_RE = /\b(LOT|LOTS|BLOCK|BLK|SUBDIVISION|SUBD|PLAT|PARCEL|METES|BOUNDS|TOWNSHIP|TWP|RANGE|RNG|SECTION|SEC|TRACT|UNIT|PHASE|CONDOMINIUM|CONDO|ADDITION|ADDN|SURVEY|ABSTRACT|BOOK|PAGE|PB|PG|ACRE|ACRES)\b\.?/i
const STREET_SUFFIX_RE = /\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|way|pl|place|ter|terrace|pkwy|parkway|hwy|highway|trl|trail)\b\.?/i
const STREET_ADDRESS_RE = /^\s*\d{1,6}[a-z]?\s+[a-z0-9 .'#-]+$/i

/**
 * PURE — a legal description from any NON-HUMAN source (the listing record, RentCast, public-record
 * research) is accepted only when it reads like a legal description and never when it reads like a
 * street address. A model summary, a postal line or a bare parcel number is refused by name. Applied by
 * lib/forms/legal-description.ts resolveLegalDescriptionForForm before any researched value is written.
 */
export function looksLikeLegalDescription(value: string | null | undefined): { ok: boolean; reason: "ok" | "empty" | "too_short" | "street_address" | "no_legal_tokens" } {
  const v = (value ?? "").trim()
  if (!v) return { ok: false, reason: "empty" }
  if (v.length < 8) return { ok: false, reason: "too_short" }
  const hasLegalTokens = LEGAL_TOKEN_RE.test(v)
  if (STREET_ADDRESS_RE.test(v) && STREET_SUFFIX_RE.test(v) && !hasLegalTokens) return { ok: false, reason: "street_address" }
  if (!hasLegalTokens) return { ok: false, reason: "no_legal_tokens" }
  return { ok: true, reason: "ok" }
}

export interface KnownPropertyFacts {
  address?: string | null
  /** legal description — only present when the property/parcel record carries it (often unknown). */
  legalDescription?: string | null
  /** who supplied legalDescription (listings/transactions.legal_description_source: agent | listing | rentcast | public_record), when known. */
  legalDescriptionSource?: string | null
  apn?: string | null
  county?: string | null
  /** property city/state/zip — only used to fill PROPERTY-prefixed fields, never a bare city/state. */
  propertyCity?: string | null
  propertyState?: string | null
  propertyZip?: string | null
}

export interface PropertyPrefillField {
  formField: string
  value: string
  source: keyof KnownPropertyFacts
}

export interface PropertyPrefillResult {
  /** property-identification fields we could fill (the fact was known). */
  filled: PropertyPrefillField[]
  /** property-identification fields we RECOGNIZED but had no known value for → left blank (agent fills). */
  unresolved: string[]
}

// Property-IDENTIFICATION patterns ONLY. A field that matches none of these is an offer term / other
// field and is NEVER touched. city/state/zip require a "property" qualifier so a buyer's bare
// city/state field is never mis-filled with the property's.
const PROPERTY_PATTERNS: Array<{ key: keyof KnownPropertyFacts; re: RegExp }> = [
  { key: "address",          re: /(property|subject|premises).*(address|street)|^property.?address$|^street.?address$/i },
  { key: "legalDescription", re: /legal.?descri|legal.?desc\b/i },
  { key: "apn",              re: /\bapn\b|parcel.?(number|no|id)|tax.?(parcel|id)/i },
  { key: "county",           re: /(property|subject).*county|^county$/i },
  { key: "propertyCity",     re: /(property|subject|premises).*city/i },
  { key: "propertyState",    re: /(property|subject|premises).*state/i },
  { key: "propertyZip",      re: /(property|subject|premises).*(zip|postal)/i },
]

function known(facts: KnownPropertyFacts, key: keyof KnownPropertyFacts): string | null {
  const v = facts[key]
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/**
 * Map known property facts onto a form's fillable fields. ONLY property-identification fields are ever
 * considered; offer-term fields are left untouched for the agent. A recognized property field with no
 * known value is returned in `unresolved` (blank, agent fills). Pure.
 */
export function buildPropertyPrefill(formFields: string[], facts: KnownPropertyFacts): PropertyPrefillResult {
  const filled: PropertyPrefillField[] = []
  const unresolved: string[] = []

  for (const formField of formFields ?? []) {
    const name = (formField ?? "").trim()
    if (!name) continue
    const match = PROPERTY_PATTERNS.find((p) => p.re.test(name))
    if (!match) continue // not a property-identification field → never touched (agent fills it)
    const value = known(facts, match.key)
    if (value) filled.push({ formField: name, value, source: match.key })
    else unresolved.push(name) // recognized property field, but unknown → leave blank
  }

  return { filled, unresolved }
}
