// lib/identity/subject-identity.ts
//
// C36 — SUBJECT IDENTITY & DEDUP (wave 150, lane 150EFG). PURE — no client, no `server-only`, so the producer
// (lib/kernel/scraping.ts), the pipeline (lib/lead-pipeline/pipeline-processor.ts) and the proof
// (scripts/identity-dedup-guard.ts) import the same rules.
//
// Owner directive (150G): "Dedup/property APN/person/household/business/LLC/trust, verified ownership, source
// merge and no cross-tenant personal identity spill." Canary 5: "Two providers disagree about owner/person:
// preserve conflict, source and quality; no quiet overwrite of tenant/customer-confirmed phone; do not charge
// twice for duplicate known results."
//
// SURVIVORS (LAW 1 — extended, never replaced):
//   · PERSON identity is lib/kernel/person-identity.ts (person_identities, UNIQUE (brokerage_id, identity_key) —
//     tenant-scoped by construction, so no cross-tenant personal spill) and the raw pipeline's three-table dedup
//     (lib/kernel/scraping.ts dedupRawAgainstLeadAndContact + pipeline-processor findBestMatch). This file does not
//     re-key persons; personKeys below only names the same anchors so the producer can record them as external ids.
//   · The provider-side "no silent overwrite" rule is lib/enrichment/provider-dedup.ts protectStatedValues (contact
//     columns a human stated). mergeSourceFacts here is the SAME rule for the raw → lead/contact MERGE path, which
//     had none: pipeline-processor's post-enrichment duplicate branch wrote `phone: enriched.phone || existing.phone`
//     — the enriched value WON over a tenant-confirmed phone, silently, with the write's error unread.
//   · ENTITY markers are canonical-lead-eligibility.ts ENTITY_NAME_TOKENS (one vocabulary — CLAUDE.md §6).
//
// WHAT WAS MISSING (built here): a PROPERTY key (APN, county-scoped), HOUSEHOLD / BUSINESS / LLC-TRUST-ESTATE keys,
// and an ownership verdict — "a source-produced property does not magically prove an owner's identity".

import { ENTITY_NAME_TOKENS } from "@/lib/lead-pipeline/canonical-lead-eligibility"

type OwnerNameKind = "person" | "household" | "business" | "entity_trust_estate"

const TRUST_ESTATE_TOKENS = ["trust", "trustee", "trustees", "tr", "revocable", "irrevocable", "estate of", "et al", "etal", "llc", "l l c", "pllc", "lp", "llp"] as const

// Wave 151 (lane 151F): type-tolerant. A hydrated BatchData record carries `address` as an OBJECT ({ street, city, state,
// zip } — the documented Property Lookup shape) and lib/lead-pipeline/scraper-parsers.ts normalizeBatchDataRecord hands it
// through as `mailingAddress`; `householdKey → addressKey → norm` then THREW `s.toLowerCase is not a function`, and because
// lib/kernel/scraping.ts ingestRawSourceBatch wraps its whole record loop in one try/catch, ONE such record failed the ENTIRE
// batch with every counter at zero (found by the tenant-provider canary on the real producer). An identity-key helper must
// never throw on a non-string: anything that is not a string normalizes to "" (no key), and the batch keeps going.
function norm(s: unknown): string {
  if (typeof s !== "string") return ""
  return s.toLowerCase().replace(/[^\p{L}\p{N}&\s]/gu, " ").replace(/\s+/g, " ").trim()
}

/**
 * PURE — what kind of owner a recorded owner name is. An LLC / trust / estate is a LEGAL entity whose person behind
 * it must be found separately; "John & Jane Smith" / "Smith Family" is a HOUSEHOLD; any other ENTITY_NAME_TOKENS
 * match is a BUSINESS; else a PERSON. Null for an empty name.
 */
export function ownerNameKind(name: string | null | undefined): OwnerNameKind | null {
  const n = norm(name ?? "")
  if (!n) return null
  const padded = ` ${n} `
  if (TRUST_ESTATE_TOKENS.some((t) => padded.includes(` ${t} `))) return "entity_trust_estate"
  if (ENTITY_NAME_TOKENS.some((t) => padded.includes(` ${t} `))) return "business"
  if (/ (&|and) /.test(padded) || / family( |$)/.test(padded) || / household /.test(padded)) return "household"
  return "person"
}

/**
 * PURE — the canonical APN key. Assessor parcel numbers are printed with dashes, dots, spaces and leading zeros
 * that differ between the county site, a vendor and a deed; the parcel is the same. Scoped by county FIPS when
 * known (two counties reuse the same APN strings). Null when nothing parcel-like remains.
 */
function apnKey(apn: string | null | undefined, countyFips?: string | null): string | null {
  const a = (apn ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+(?=\d)/, "")
  if (a.length < 4) return null
  const fips = (countyFips ?? "").replace(/\D/g, "")
  return `apn:${fips.length === 5 ? fips : "?"}:${a}`
}

const STREET_SUFFIX: Record<string, string> = {
  street: "st", avenue: "ave", av: "ave", road: "rd", drive: "dr", lane: "ln", boulevard: "blvd", court: "ct",
  place: "pl", circle: "cir", terrace: "ter", highway: "hwy", parkway: "pkwy", trail: "trl", way: "way",
  north: "n", south: "s", east: "e", west: "w", apartment: "apt", suite: "ste", unit: "unit",
}

/** PURE — a normalized street-address key (+ ZIP5). Weaker than an APN; used only when no APN is known. */
function addressKey(address: string | null | undefined, zip?: string | null): string | null {
  const a = norm(address ?? "").replace(/#/g, " unit ")
  if (!/\d/.test(a)) return null
  const tokens = a.split(" ").filter(Boolean).map((t) => STREET_SUFFIX[t] ?? t)
  const z = (zip ?? "").replace(/\D/g, "").slice(0, 5)
  return `addr:${tokens.join(" ")}|${z.length === 5 ? z : "?"}`
}

/** PURE — the entity key for a business / LLC / trust / estate: the name without its legal-form tokens, + state. */
function entityKey(name: string | null | undefined, state?: string | null): string | null {
  const n = norm(name ?? "")
  if (!n) return null
  const core = ` ${n} `.replace(/ (llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|plc|the|of|tr|trust|trustee|trustees|revocable|irrevocable|living|family|estate) /g, " ").replace(/\s+/g, " ").trim()
  if (!core) return null
  return `entity:${core}|${(state ?? "").trim().toLowerCase() || "?"}`
}

/** PURE — a household key: the surname(s) at one mailing address. Two people at one address with one surname
 *  are one HOUSEHOLD (never one PERSON — a household key never merges two persons). */
function householdKey(lastName: string | null | undefined, mailingAddress: string | null | undefined, zip?: string | null): string | null {
  const ln = norm(lastName ?? "").split(" ").pop() ?? ""
  const addr = addressKey(mailingAddress, zip)
  if (!ln || !addr) return null
  return `hh:${ln}|${addr.slice(5)}`
}

/** PURE — the person anchors the tenant-scoped person store (lib/kernel/person-identity.ts) keys on, named here so
 *  the producer can carry them as external ids. NEVER cross-tenant: the caller prefixes its scope. */
function personKeys(p: { email?: string | null; phone?: string | null }): string[] {
  const out: string[] = []
  const e = (p.email ?? "").trim().toLowerCase()
  if (e.includes("@")) out.push(`email:${e}`)
  const d = (p.phone ?? "").replace(/\D/g, "").slice(-10)
  if (d.length === 10) out.push(`phone:${d}`)
  return out
}

/** Every identity key a subject carries (APN / address / entity / household / person), most specific first. */
export function subjectIdentityKeys(s: {
  apn?: string | null; countyFips?: string | null; propertyAddress?: string | null; zip?: string | null
  ownerName?: string | null; lastName?: string | null; mailingAddress?: string | null; state?: string | null
  email?: string | null; phone?: string | null
}): string[] {
  const keys: string[] = []
  const push = (k: string | null) => { if (k && !keys.includes(k)) keys.push(k) }
  push(apnKey(s.apn, s.countyFips))
  push(addressKey(s.propertyAddress, s.zip))
  const kind = ownerNameKind(s.ownerName)
  if (kind === "business" || kind === "entity_trust_estate") push(entityKey(s.ownerName, s.state))
  push(householdKey(s.lastName, s.mailingAddress ?? s.propertyAddress, s.zip))
  for (const k of personKeys(s)) push(k)
  return keys
}

// ── VERIFIED OWNERSHIP ───────────────────────────────────────────────────────────────────────────────────────

type OwnershipVerdict = "verified" | "unverified" | "conflict" | "entity_owner"

interface OwnershipEvidence {
  /** Who said who owns it — a public record / recorder / licensed vendor counts; a scraped page does not. */
  source: string
  rights: string
  ownerName: string | null
  mailingAddress?: string | null
}

/**
 * PURE — does the evidence VERIFY that `person` owns the property? "A source-produced property does not magically
 * prove an owner's identity": verified needs the person's surname on an AUTHORITATIVE owner record (public_record
 * or licensed_vendor) AND either a second independent authoritative source agreeing or the person's own mailing
 * address matching the owner's. Two authoritative sources naming DIFFERENT surnames is a CONFLICT (kept, never
 * resolved by picking one). An LLC / trust / estate owner is `entity_owner` — the person behind it is unproven.
 */
export function verifyOwnership(
  person: { firstName?: string | null; lastName?: string | null; mailingAddress?: string | null; zip?: string | null },
  evidence: readonly OwnershipEvidence[],
): { verdict: OwnershipVerdict; basis: string } {
  const authoritative = evidence.filter((e) => (e.rights === "public_record" || e.rights === "licensed_vendor") && (e.ownerName ?? "").trim())
  if (authoritative.length === 0) return { verdict: "unverified", basis: "no public-record or licensed owner record" }
  if (authoritative.every((e) => { const k = ownerNameKind(e.ownerName); return k === "business" || k === "entity_trust_estate" })) {
    return { verdict: "entity_owner", basis: `owner of record is an entity (${authoritative[0].ownerName}) — the person behind it is unproven` }
  }
  const ln = norm(person.lastName ?? "")
  if (!ln) return { verdict: "unverified", basis: "the person has no surname to match against the owner of record" }
  const names = (e: OwnershipEvidence) => ` ${norm(e.ownerName ?? "")} `
  const matching = authoritative.filter((e) => names(e).includes(` ${ln} `))
  const personKinds = authoritative.filter((e) => { const k = ownerNameKind(e.ownerName); return k === "person" || k === "household" })
  if (matching.length === 0) {
    return personKinds.length > 0
      ? { verdict: "conflict", basis: `owner of record (${personKinds.map((e) => `${e.source}: ${e.ownerName}`).join("; ")}) does not name ${person.lastName}` }
      : { verdict: "unverified", basis: "no owner of record names the person" }
  }
  const disagreeing = personKinds.filter((e) => !names(e).includes(` ${ln} `))
  if (disagreeing.length > 0) {
    return { verdict: "conflict", basis: `sources disagree: ${[...matching, ...disagreeing].map((e) => `${e.source}: ${e.ownerName}`).join("; ")}` }
  }
  const sources = new Set(matching.map((e) => e.source))
  const mailMatch = !!person.mailingAddress && matching.some((e) => addressKey(e.mailingAddress, person.zip) !== null && addressKey(e.mailingAddress, person.zip) === addressKey(person.mailingAddress, person.zip))
  if (sources.size >= 2) return { verdict: "verified", basis: `${sources.size} independent authoritative sources name ${person.lastName}` }
  if (mailMatch) return { verdict: "verified", basis: `owner of record names ${person.lastName} and the mailing address matches` }
  return { verdict: "unverified", basis: `one source (${[...sources][0]}) names ${person.lastName}; no second source or matching mailing address` }
}

// ── SOURCE MERGE THAT PRESERVES CONFLICTS ────────────────────────────────────────────────────────────────────

interface IdentityConflict {
  field: string
  kept: string
  keptSource: string
  offered: string
  offeredBy: string
  at: string
}

/** Fields whose CURRENT value on a lead / contact is a contact point or an identity — never replaced by a merge. */
const MERGE_PROTECTED_FIELDS = ["email", "phone", "first_name", "last_name"] as const

const filled = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "")
function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (field === "phone") return String(a ?? "").replace(/\D/g, "").slice(-10) === String(b ?? "").replace(/\D/g, "").slice(-10)
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase()
}

/**
 * PURE — merge an incoming source's values onto the record we already hold. The held value WINS for every
 * protected field (a confirmed phone / email / name is the tenant's or the customer's, and a provider or a scraped
 * duplicate never replaces it); a gap is filled; an identical value corroborates; a DIFFERENT value is returned as
 * a conflict with both sources, so the human sees both and nothing is lost or silent. Non-protected fields follow
 * the same gap-fill rule (`overwritable` lists any the caller deliberately lets the newer source refresh).
 */
export function mergeSourceFacts(
  held: Record<string, unknown>,
  incoming: Record<string, unknown>,
  opts: { heldSource: string; incomingSource: string; overwritable?: readonly string[]; now?: Date },
): { patch: Record<string, unknown>; conflicts: IdentityConflict[]; corroborated: string[] } {
  const at = (opts.now ?? new Date()).toISOString()
  const patch: Record<string, unknown> = {}
  const conflicts: IdentityConflict[] = []
  const corroborated: string[] = []
  for (const [field, offered] of Object.entries(incoming)) {
    if (!filled(offered)) continue
    const current = held[field]
    if (!filled(current)) { patch[field] = offered; continue }
    if (sameValue(field, current, offered)) { corroborated.push(field); continue }
    if (opts.overwritable?.includes(field) && !(MERGE_PROTECTED_FIELDS as readonly string[]).includes(field)) { patch[field] = offered; continue }
    conflicts.push({ field, kept: String(current), keptSource: opts.heldSource, offered: String(offered), offeredBy: opts.incomingSource, at })
  }
  return { patch, conflicts, corroborated }
}

// NO DOUBLE CHARGE FOR A KNOWN RESULT is NOT rebuilt here — the survivors already hold it: a person the tenant already
// has is caught by pipeline-processor.ts findBestMatch('pre_enrichment') BEFORE enrichWithPeopleData spends (the row
// is parked duplicate_pre_enrich), a provider answer is reused while fresh (lib/enrichment/provider-dedup.ts isFresh /
// PROVIDER_FRESHNESS_DAYS), and a replayed observation never becomes a second raw row (C35 idempotency key, m961).
