// lib/enrichment/provider-dedup.ts
//
// THE CROSS-PROVIDER DEDUP RULE (wave 144, lane 144E). PURE — no client, no `server-only`, so the guard imports it.
//
// OWNER (wave 144, ruling 10): "Dedup across providers: canonical record → field completeness → verified prior data →
// provenance/freshness → required gap → cheaper appropriate provider (PeopleData vs Versium) → cost gate → append; no silent
// overwrite."
//
// WHAT WAS ALREADY BUILT (the survivors this file EXTENDS, never replaces — LAW 1):
//   · field completeness / required gap — enrichment-column-map.ts versiumDemographicCategoriesNeeded (a filled Versium
//     category is never re-bought), missingHouseholdFinancials (the household rung asks only gaps), identifier-guard.ts
//     contactPointsToBuy (a contact with an e-mail buys no contact point), online-presence-store.ts (gap-only indicators);
//   · cheaper appropriate provider — property-lookup-rail.ts CONTACT_PROVIDER_ROUTES (Versium $0.05 → BatchData $0.07 →
//     PeopleData $0.25 for contact points; PeopleData stays the PERSON-PROFILE provider, Versium the household / financial /
//     online rungs) and enrichment-orchestrator.ts (PeopleData asked ONLY after a Versium miss);
//   · cost gate — budget-gate.ts checkVendorBudget through every leg's pre-flight;
//   · provenance — enrichment-column-map.ts fieldProvenanceStamp / withFieldProvenance (THE one shape).
//
// WHAT WAS MISSING (found by this lane, fixed through the two functions below):
//   1. VERIFIED PRIOR DATA was overwritten SILENTLY. Both PeopleData writers (contact-enrichment-core.ts enrichContactRecord and
//      enrichment-orchestrator.ts's contact branch) spread the provider's mapped columns straight over the row: a marital
//      status / age band / occupation a STAFF member typed (provenance source 'staff', purpose 'staff_edit') or the person
//      stated themselves (source 'contact' / purpose 'self_service' / 'conversation') was replaced by a modeled vendor value
//      with no record that anything changed. `protectStatedValues` keeps the stated value and RECORDS the provider's competing
//      value as a conflict (enrichment_profile.provider_conflicts) — the human sees both; nothing is lost and nothing is silent.
//      The same rule covers a contact POINT: a provider e-mail never replaces the e-mail the record already holds (the
//      orchestrator's PeopleData branch wrote `email: emails[0]` over the row's own address).
//   2. The orchestrator REPLACES enrichment_profile wholesale on a PeopleData pass and carried forward only the household
//      financials, the free OSINT block and the provenance — so the Versium real-estate indicators (online-presence-store.ts),
//      the online-audience identifiers (online-audience-store.ts), the deal-investigator summary and the conflict record were
//      ERASED by every re-enrichment (a write with a reader whose data a third writer deletes). `carryForwardProfileBlocks`
//      carries those blocks onto the replacement when the replacement does not itself carry them.

import { fieldProvenanceOf } from "@/lib/lead-pipeline/enrichment-column-map"

/**
 * How long a stored provider answer still ANSWERS the gap (the dedup rule's "provenance/freshness" step). OPERATIONAL windows,
 * owner-tunable — not legal rules: a person profile (job, location history) moves slower than the online identifiers the
 * vendor itself calls "historical contact points" that are re-linked over time.
 */
export const PROVIDER_FRESHNESS_DAYS = Object.freeze({
  peopledata_profile: 90,
  versium_online_presence: 180,
  versium_online_audience: 180,
})

/** PURE — is an ISO capture time within `days` of `now`? (A missing / future / malformed time is NOT fresh — re-ask.) */
export function isFresh(capturedAt: unknown, days: number, now: Date = new Date()): boolean {
  if (typeof capturedAt !== "string") return false
  const t = new Date(capturedAt).getTime()
  const age = now.getTime() - t
  return Number.isFinite(t) && age >= 0 && age <= days * 86_400_000
}

/** Provenance SOURCES that mean "a human stated this" (enrichment-column-map.ts writers: crm.ts 'staff', portal 'contact',
 *  the AI ISA's self-stated address 'ai_tool'). */
const HUMAN_STATED_SOURCES: ReadonlySet<string> = new Set(["staff", "contact", "ai_tool"])
/** Provenance PURPOSES that mean the same (one vocabulary — enrichment-column-map.ts PROVENANCE_PURPOSES). */
const HUMAN_STATED_PURPOSES: ReadonlySet<string> = new Set(["staff_edit", "self_service", "conversation"])

/** The contact columns a PROVIDER pass may write that a human may also have stated — the protected set. Contact POINTS
 *  (email) are protected regardless of provenance: a provider never replaces the address the record already holds.
 *  The MODELED credit band is deliberately ABSENT: it has one (modeled) source and no human-stated writer, and naming it here
 *  would put this file on the band's firewall path (scripts/enrichment-one-rail-guard.ts Layer 8d) for no protection gained. */
export const PROVIDER_WRITTEN_PROFILE_COLUMNS = [
  "age_range", "gender", "occupation", "education_level", "home_owner_status", "home_value_estimate",
  "marital_status", "household_income", "net_worth_range",
  "linkedin_url", "facebook_url", "twitter_url",
] as const
const CONTACT_POINT_COLUMNS = ["email"] as const

export interface ProviderConflict {
  field: string
  /** Who stated the value that was KEPT ('staff' | 'contact' | 'ai_tool' | 'record' for a contact point the row held). */
  keptSource: string
  /** The provider whose different value was NOT written. */
  offeredBy: string
  offeredValue: string
  at: string
}

const nonEmpty = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "")
const same = (a: unknown, b: unknown): boolean => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase()

/** PURE — who stated a column's current value, per its provenance stamp (null when a provider, or when nothing says). */
function humanStatedSourceOf(profile: Record<string, unknown> | null | undefined, column: string): string | null {
  const stamp = fieldProvenanceOf(profile)[column]
  if (!stamp || typeof stamp !== "object") return null
  const s = stamp as { source?: unknown; purpose?: unknown }
  if (typeof s.source === "string" && HUMAN_STATED_SOURCES.has(s.source)) return s.source
  if (typeof s.purpose === "string" && HUMAN_STATED_PURPOSES.has(s.purpose)) return typeof s.source === "string" && s.source ? s.source : s.purpose
  return null
}

/**
 * PURE — NO SILENT OVERWRITE. Given the row as it stands (`prior` — the columns + its enrichment_profile), and a PROVIDER's
 * patch, returns the patch minus every value that would replace (a) a human-stated value with a different one, or (b) a
 * contact point the row already holds with a different one — plus the conflicts, so the competing value is recorded rather
 * than lost. A gap (empty prior) is always filled; an identical value is a no-op either way; a prior PROVIDER value is
 * refreshed (the provenance stamp the writer lays down beside it says it changed, so that is not silent).
 */
export function protectStatedValues(
  prior: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
  offeredBy: string,
  now: Date = new Date(),
): { patch: Record<string, unknown>; conflicts: ProviderConflict[] } {
  const row = prior ?? {}
  const profile = (row.enrichment_profile && typeof row.enrichment_profile === "object" ? row.enrichment_profile : null) as Record<string, unknown> | null
  const out: Record<string, unknown> = { ...patch }
  const conflicts: ProviderConflict[] = []
  const at = now.toISOString()
  for (const col of CONTACT_POINT_COLUMNS) {
    if (!(col in out) || !nonEmpty(out[col]) || !nonEmpty(row[col]) || same(row[col], out[col])) continue
    conflicts.push({ field: col, keptSource: humanStatedSourceOf(profile, col) ?? "record", offeredBy, offeredValue: String(out[col]), at })
    delete out[col]
  }
  for (const col of PROVIDER_WRITTEN_PROFILE_COLUMNS) {
    if (!(col in out) || !nonEmpty(out[col]) || !nonEmpty(row[col]) || same(row[col], out[col])) continue
    const stated = humanStatedSourceOf(profile, col)
    if (!stated) continue
    conflicts.push({ field: col, keptSource: stated, offeredBy, offeredValue: typeof out[col] === "object" ? JSON.stringify(out[col]) : String(out[col]), at })
    delete out[col]
  }
  return { patch: out, conflicts }
}

/**
 * PURE — `profile` with the PRIOR provenance stamp restored for every field whose stated value was kept. Without this the
 * provider's stamp (laid down beside its offered value) would claim the kept human value — the card would say "PeopleData"
 * under a value staff typed, and the next pass would no longer see it as stated.
 */
export function keepPriorStamps(profile: Record<string, unknown>, priorProfile: Record<string, unknown> | null | undefined, fields: readonly string[]): Record<string, unknown> {
  if (fields.length === 0) return profile
  const prior = fieldProvenanceOf(priorProfile)
  const current = fieldProvenanceOf(profile)
  const next: Record<string, unknown> = { ...current }
  let changed = false
  for (const f of fields) {
    if (prior[f] && typeof prior[f] === "object") { next[f] = prior[f]; changed = true }
  }
  return changed ? { ...profile, field_provenance: next } : profile
}

/** The profile key the conflicts land under — one spelling, carried by carryForwardProfileBlocks. */
export const PROVIDER_CONFLICTS_KEY = "provider_conflicts"
const MAX_CONFLICTS = 20

/** PURE — `profile` with the new conflicts appended to the ones it already carries (newest last, bounded). */
export function withProviderConflicts(profile: Record<string, unknown>, conflicts: readonly ProviderConflict[]): Record<string, unknown> {
  if (conflicts.length === 0) return profile
  const prior = Array.isArray(profile[PROVIDER_CONFLICTS_KEY]) ? (profile[PROVIDER_CONFLICTS_KEY] as unknown[]) : []
  return { ...profile, [PROVIDER_CONFLICTS_KEY]: [...prior, ...conflicts].slice(-MAX_CONFLICTS) }
}

/**
 * The enrichment_profile BLOCKS owned by writers other than the PeopleData profile builder — each named with its writer, so a
 * wholesale profile replacement never erases another writer's data. (Household financials, the free OSINT block and
 * field_provenance have their own carry-forward in the orchestrator already — not repeated here.)
 */
export const CARRIED_PROFILE_BLOCKS: Readonly<Record<string, string>> = Object.freeze({
  real_estate_indicators: "lib/enrichment/online-presence-store.ts persistRealEstateIndicators",
  online_audience: "lib/enrichment/online-audience-store.ts persistOnlineAudienceIdentifiers",
  last_investigation_summary: "app/actions/contact-quick-actions.ts runDealInvestigatorAction",
  last_investigation_at: "app/actions/contact-quick-actions.ts runDealInvestigatorAction",
  provider_conflicts: "lib/enrichment/provider-dedup.ts withProviderConflicts",
})

/** PURE — `next` (a replacement profile) with every CARRIED_PROFILE_BLOCKS block the prior profile held and `next` lacks. */
export function carryForwardProfileBlocks(next: Record<string, any>, prior: Record<string, any> | null | undefined): Record<string, any> {
  if (!prior || typeof prior !== "object") return next
  let out = next
  for (const key of Object.keys(CARRIED_PROFILE_BLOCKS)) {
    if (prior[key] !== undefined && prior[key] !== null && (out[key] === undefined || out[key] === null)) {
      if (out === next) out = { ...next }
      out[key] = prior[key]
    }
  }
  return out
}
