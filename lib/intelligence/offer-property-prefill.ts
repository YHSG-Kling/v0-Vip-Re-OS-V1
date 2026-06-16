// lib/intelligence/offer-property-prefill.ts
//
// OFFER PROPERTY PREFILL (pure) — the offer form is filled BY THE AGENT. The only thing the system
// pre-fills is the PROPERTY IDENTIFICATION the agent shouldn't have to re-type — the property address
// and legal description — and ONLY when we already KNOW it (from the property/parcel record). Offer
// TERMS (price, earnest money, contingencies, dates) are NEVER auto-filled — that's the agent's job,
// and auto-asserting a term we weren't given is a fabrication the compliance gate would (rightly)
// flag. Unknown property facts are left BLANK for the agent to fill. This maps the known property
// facts onto a form's fillable fields by name; it never touches a non-property field. Pure (no I/O).

export interface KnownPropertyFacts {
  address?: string | null
  /** legal description — only present when the property/parcel record carries it (often unknown). */
  legalDescription?: string | null
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
