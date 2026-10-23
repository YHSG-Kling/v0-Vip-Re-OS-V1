// lib/education/seller-signal-education-context.ts
//
// THE CONSUMING HALF OF THE PROTECTED-CLASS DATA LANE.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
// The owner's stated reason for taking fair housing off the sourcing lane,
// verbatim: "we determine the kind of education in channels by the age group and
// other ways to use it without violating the rules."
//
// The SOURCING half shipped in the batchdata-seller-signals wave. It derives four
// signal kinds from protected-class inputs and writes, on
// `motivated_seller_signals.signal_details`:
//   · senior_owner       → observed.owner_age_band ∈ {flag,65to74,75plus}, observed.owner_age
//   · inherited_property → observed.probate_deed_instrument, observed.inherited
//   · recent_divorce     → observed.recently_divorced, observed.marital_status
//   · household_outgrown → observed.household_size, observed.bedroom_count, observed.surplus_people
// plus `protected_class_basis` — the classifier's REASON SENTENCE per source — on
// every row (`[]` for the 17 parcel-fact kinds).
//
// NOTHING READ ANY OF IT. lib/external/batchdata-seller-signals.ts:734 says so in
// its own header and names the gap: the education selector bands from
// `contacts.age_range`, a different vocabulary, and never looks at the signals.
// That is a writerless column in the exact place the ruling was made for
// (CLAUDE.md §1 — no duplicate exists, the capability is wanted, so BUILD the
// missing half).
//
// ── ONE AGE VOCABULARY, AND IT IS NOT THIS FILE'S ────────────────────────────
// The SURVIVOR is `AgeSegment` (18-30 / 30-50 / 50-65 / 65+) from
// lib/kernel/education.ts, because it is the vocabulary the SCORER already
// matches against `learning_modules.audience_age_segs`, the one `DELIVERY_MATRIX`
// is keyed by, and the one `CHANNEL_ORDER_BY_BAND` is keyed by. The provider's
// `owner_age_band` is a three-value senior-only observation vocabulary, not a
// superset of anything.
//
// NO SECOND BANDING FUNCTION IS ADDED HERE (CLAUDE.md §6). The crossing reuses
// the collapser that already exists for exactly this problem — the enrichment
// lane's `contacts.age_range` is ALSO a provider vocabulary, and
// `ageSegmentFromAgeRange` collapses any "<n>-<m>" / "<n>plus" string to its
// midpoint and lets `ageSegmentFromAge` alone decide every boundary. Run against
// the provider's three values it already answers correctly:
//   "65to74" → digits [65,74] → midpoint 70 → "65+"
//   "75plus" → digits [75]    → 75          → "65+"
//   "flag"   → no digits      → null        → UNMEASURED
// The last line is the load-bearing one: the provider's `seniorOwner` quickList
// is broad and carries no age, so a bare flag must NOT become a measured "65+".
// The raw `owner_age` is preferred when present, for the same reason the signal
// lane stores it — a measured number bands more precisely than a coarse band.
//
// ── PERSONAS ARE ALSO REUSED, NOT COINED ─────────────────────────────────────
// Each of the four signal kinds maps onto a member of the canonical `Persona`
// union (lib/kernel/types.ts:139) that ALREADY has a lesson supplement in
// lib/kernel/education.ts and is ALREADY scored (+60) against
// `learning_modules.audience_personas` by lib/learning-router/composer.ts.
// No new tag, no new column, no migration.
//
// ── SCOPE FENCE (do not widen the exemption) ─────────────────────────────────
// This module is the EDUCATION lane. It reads seller signals for ONE contact and
// returns an age band, persona hints and the basis sentences. It exposes no
// population, no segment and no criteria payload, and it is imported by exactly
// the education context resolver. The ads lane's refusal
// (`assertAudienceSegmentationAllowed`, lib/lead-governance/protected-class-signals.ts)
// is untouched and still fires at every audience-staging site;
// scripts/compliance-scope-simulator.ts asserts BOTH that this file never reaches
// the ads lane and that the ads lane still refuses.

import type { SupabaseClient } from "@supabase/supabase-js"
import { ageSegmentFromAge, ageSegmentFromAgeRange, type AgeSegment } from "@/lib/kernel/education"
import type { ProtectedClassBasis } from "@/lib/lead-governance/protected-class-signals"
import type { Persona } from "@/lib/kernel/types"

/**
 * The signal types this lane consumes, each with the EXISTING persona its
 * lesson supplement is already filed under.
 *
 * Spelled as the literal strings rather than importing the constants from
 * lib/external/batchdata-seller-signals.ts on purpose: that module is the
 * provider lane and imports the BatchData client transitively. This is a read of
 * a TABLE, not of a provider — the coupling that matters is to
 * `motivated_seller_signals.signal_type`, which is what the strings are. The
 * simulator pins the two lists equal so a rename cannot silently unwire this.
 */
export const SELLER_SIGNAL_EDUCATION_PERSONAS: Readonly<Record<string, Persona>> = Object.freeze({
  senior_owner:       "senior",
  inherited_property: "probate",
  recent_divorce:     "divorce",
  // A household larger than the house has bedrooms to seat is the archetypal
  // move-up. "upsize" is already in the Persona union and already a scorable
  // `audience_personas` value.
  household_outgrown: "upsize",
})

/** The signal types read here, in one place. */
export const SELLER_SIGNAL_EDUCATION_TYPES: readonly string[] =
  Object.freeze(Object.keys(SELLER_SIGNAL_EDUCATION_PERSONAS))

/** One `motivated_seller_signals` row, narrowed to what education reads. */
export interface SellerSignalRow {
  signal_type: string
  signal_details: unknown
}

export interface SellerSignalEducationContext {
  /** The age band the signals measured, or null when none of them carried an age. */
  ageSegment: AgeSegment | null
  /** WHICH observation produced the band — "owner_age" (the raw number) or
   *  "owner_age_band" (the provider's coarse band). null when unmeasured, so a
   *  band nobody measured never reads as one somebody did (CLAUDE.md §2). */
  ageSource: "owner_age" | "owner_age_band" | null
  /** Existing `Persona` values, deduped and stable-ordered. Scored against
   *  `learning_modules.audience_personas` by the one scorer. */
  personaHints: Persona[]
  /** The signal types that contributed, for the record. */
  signalTypes: string[]
  /** The classifier's reason sentences, carried VERBATIM off the stored rows.
   *  This is what makes the practice auditable: when a lesson or a rail was
   *  chosen because of protected-class-derived data, the assignment says so and
   *  says on what grounds. Deduped on source. */
  protectedClassBasis: ProtectedClassBasis[]
}

export const EMPTY_SELLER_SIGNAL_EDUCATION_CONTEXT: SellerSignalEducationContext = Object.freeze({
  ageSegment: null,
  ageSource: null,
  personaHints: [],
  signalTypes: [],
  protectedClassBasis: [],
})

function observedOf(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object") return {}
  const obs = (details as { observed?: unknown }).observed
  return obs && typeof obs === "object" ? (obs as Record<string, unknown>) : {}
}

function basisOf(details: unknown): ProtectedClassBasis[] {
  if (!details || typeof details !== "object") return []
  const raw = (details as { protected_class_basis?: unknown }).protected_class_basis
  if (!Array.isArray(raw)) return []
  const out: ProtectedClassBasis[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const source = (entry as { source?: unknown }).source
    const reason = (entry as { reason?: unknown }).reason
    if (typeof source === "string" && typeof reason === "string" && source && reason) {
      out.push({ source, reason })
    }
  }
  return out
}

/**
 * PURE. Collapse a contact's seller-signal rows into an education context.
 *
 * Order-independent by construction: the band prefers a raw `owner_age` over a
 * coarse `owner_age_band` no matter which row carried which, so two runs over
 * the same rows in either order answer the same.
 */
export function deriveEducationContextFromSignals(
  rows: readonly SellerSignalRow[],
): SellerSignalEducationContext {
  let fromRawAge: AgeSegment | null = null
  let fromBand: AgeSegment | null = null
  const personaHints: Persona[] = []
  const signalTypes: string[] = []
  const basisBySource = new Map<string, ProtectedClassBasis>()

  for (const row of rows) {
    const persona = SELLER_SIGNAL_EDUCATION_PERSONAS[row.signal_type]
    if (!persona) continue
    if (!signalTypes.includes(row.signal_type)) signalTypes.push(row.signal_type)
    if (!personaHints.includes(persona)) personaHints.push(persona)
    for (const b of basisOf(row.signal_details)) {
      if (!basisBySource.has(b.source)) basisBySource.set(b.source, b)
    }

    if (row.signal_type === "senior_owner") {
      const observed = observedOf(row.signal_details)
      const rawAge = observed.owner_age
      if (typeof rawAge === "number") {
        fromRawAge = ageSegmentFromAge(rawAge) ?? fromRawAge
      }
      const band = observed.owner_age_band
      if (typeof band === "string") {
        // The SAME collapser the enrichment vocabulary goes through. "flag"
        // carries no digits and therefore stays unmeasured — deliberately.
        fromBand = ageSegmentFromAgeRange(band) ?? fromBand
      }
    }
  }

  const ageSegment = fromRawAge ?? fromBand
  return {
    ageSegment,
    ageSource: ageSegment === null ? null : fromRawAge ? "owner_age" : "owner_age_band",
    personaHints,
    signalTypes,
    protectedClassBasis: [...basisBySource.values()],
  }
}

/**
 * Read one CONTACT's seller signals and derive the education context.
 *
 * ID CLASS, STATED: `motivated_seller_signals.contact_id` has a FOREIGN KEY onto
 * `contacts(id)` — the PRIMARY KEY, verified live against project
 * hrvaqgvukzxfskkcrwbt on 2026-08-22 — NOT onto the secondary unique
 * `contacts.contact_id`. The same `contacts.id` is what the learning router uses
 * as its customer `actorId` and what `learning_assignments.contact_id` carries,
 * so one id class runs the whole path (CLAUDE.md §3). Picking the other column
 * here would produce a query that always returns nothing and an education lane
 * that silently never routes by age.
 *
 * FAILS SOFT, and this is a deliberate departure from §4's fail-closed default.
 * A gate that cannot run must refuse; this is not a gate. It is an ENRICHMENT of
 * a selection that has a sensible answer without it, and refusing to educate
 * somebody because we could not read their age band would be strictly worse than
 * the status quo. An unreadable table, a refusal, a contact with no signals and a
 * contact whose signals carry no age all return the same EMPTY context, and the
 * caller then routes on the unbanded default (the client's own portal, which
 * needs no consent and assumes nothing).
 */
export async function readSellerSignalEducationContext(
  supabase: SupabaseClient,
  contactId: string,
): Promise<SellerSignalEducationContext> {
  if (!contactId) return EMPTY_SELLER_SIGNAL_EDUCATION_CONTEXT
  // supabase-js RESOLVES refusals (CLAUDE.md §3): `error` is destructured and
  // read, because an unread refusal would present as "this contact has no
  // signals", which is a different fact.
  const { data, error } = await supabase
    .from("motivated_seller_signals")
    .select("signal_type, signal_details")
    .eq("contact_id", contactId)
    .in("signal_type", SELLER_SIGNAL_EDUCATION_TYPES as string[])
    .order("detected_at", { ascending: false })
    .limit(50)
  if (error) return EMPTY_SELLER_SIGNAL_EDUCATION_CONTEXT
  return deriveEducationContextFromSignals((data ?? []) as SellerSignalRow[])
}
