// lib/enrichment/online-presence-store.ts
//
// THE WRITER AND THE READER OF A CONTACT'S VERSIUM REAL-ESTATE / ONLINE-BEHAVIOUR INDICATORS
// (wave 143, lane 143D — owner: "Use ALL Versium features including online behaviour").
//
// WHY THIS FILE EXISTS (CLAUDE.md §1, "writes with no reader / reads with no writer"). Wave 142 built the
// `online_presence` capability (lib/ai-isa/property-lookup-rail.ts runVersiumOnlinePresenceLeg → versium-client.ts
// appendVersiumRealEstateIndicators: "Online Presence Indicator - Real Estate", investing, tenure, home-improvement and
// online-purchasing flags). Its ONE caller, the deal investigator, hands the answer to a one-paragraph synthesis and
// DROPS it: nothing stored it, so the look-alike research (lib/kernel/lookalike-audience.ts) listed four attributes
// (online_presence_real_estate, investing_real_estate, home_improvement_interest, length_of_residence) that NO writer
// ever filled — a reader with no writer. This module is the missing half: the indicators land on the contact as a
// PROFILE BLOCK — `enrichment_profile.real_estate_indicators` — beside the other blocks the enrichment drain keeps
// (household_financials, the Versium demographic profile), with provenance per block in the ONE provenance shape
// (`enrichment_profile.field_provenance.real_estate_indicators`, wave 100C), and the SAME module reads it back.
//
// WHAT IS STORED: only the allow-listed property / behaviour facts the adapter already maps (versium-client.ts
// VersiumRealEstateIndicators — booleans, a banded tenure, ISO dates). The adapter never returns a protected
// characteristic, so none can reach this block; `realEstateIndicatorsFromProfile` re-reads it through the same allow-list
// (a hand-edited or foreign key in the stored blob is dropped, not echoed).
//
// SAFE TO WRITE: a tenant-anchored read-modify-write (id AND brokerage_id on the read and on the update), the UPDATE is
// `.select()`ed and COUNTED (an UPDATE that matches nothing also resolves — CLAUDE.md §3), every `{ error }` is read.
// Known blind spot (published): like persistFieldProvenance beside it, this is not an atomic JSON merge — a concurrent
// writer of enrichment_profile between the read and the update loses; the window is one round-trip and the next
// research pass re-asks (the block is absent again only if it was overwritten).

import type { SupabaseClient } from "@supabase/supabase-js"
import { fieldProvenanceOf, withFieldProvenance, type FieldProvenance } from "@/lib/lead-pipeline/enrichment-column-map"
import type { VersiumRealEstateIndicators } from "@/lib/external/versium-client"

/** The profile key — one spelling, read by lookalike-audience.ts and written only here. */
export const REAL_ESTATE_INDICATORS_KEY = "real_estate_indicators"

const INDICATOR_KEYS = [
  "onlinePresenceRealEstate", "investingRealEstate", "residentialPropertiesOwned", "homeOwnRent", "lengthOfResidence",
  "homeSalesTransaction", "businessOwner", "homeImprovementInterest", "onlinePurchasing", "mortgagePurchaseDate", "refinanceDate",
] as const satisfies readonly (keyof VersiumRealEstateIndicators)[]

/** PURE — the stored block: the indicators + when and from where (provenance rides field_provenance, not here). */
function realEstateIndicatorsBlock(indicators: VersiumRealEstateIndicators, capturedAt: string): Record<string, unknown> {
  const block: Record<string, unknown> = { provider: "versium", captured_at: capturedAt }
  for (const k of INDICATOR_KEYS) if (indicators[k] !== null && indicators[k] !== undefined) block[k] = indicators[k]
  return block
}

/**
 * PURE — THE READER. The indicators a profile carries, through the allow-list (null when the block is absent or empty).
 * Never throws on a malformed blob.
 */
export function realEstateIndicatorsFromProfile(profile: Record<string, unknown> | null | undefined): (VersiumRealEstateIndicators & { capturedAt: string | null }) | null {
  const raw = profile && typeof profile === "object" ? (profile as Record<string, unknown>)[REAL_ESTATE_INDICATORS_KEY] : null
  if (!raw || typeof raw !== "object") return null
  const b = raw as Record<string, unknown>
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null)
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
  const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
  const own = str(b.homeOwnRent)
  const out = {
    onlinePresenceRealEstate: bool(b.onlinePresenceRealEstate),
    investingRealEstate: bool(b.investingRealEstate),
    residentialPropertiesOwned: int(b.residentialPropertiesOwned),
    homeOwnRent: own === "owner" ? ("owner" as const) : own === "renter" ? ("renter" as const) : null,
    lengthOfResidence: str(b.lengthOfResidence),
    homeSalesTransaction: str(b.homeSalesTransaction),
    businessOwner: bool(b.businessOwner),
    homeImprovementInterest: bool(b.homeImprovementInterest),
    onlinePurchasing: bool(b.onlinePurchasing),
    mortgagePurchaseDate: str(b.mortgagePurchaseDate),
    refinanceDate: str(b.refinanceDate),
    capturedAt: str(b.captured_at),
  }
  const any = INDICATOR_KEYS.some((k) => out[k] !== null)
  return any ? out : null
}

/**
 * THE WRITER — lands the indicators on ONE contact of ONE tenant. Idempotent on its own: a contact whose profile
 * already carries a block is left alone unless `refresh` is set (the research asks only the gap). Never throws.
 */
export async function persistRealEstateIndicators(
  supabase: SupabaseClient<any, any, any>,
  target: { contactId: string; brokerageId: string },
  indicators: VersiumRealEstateIndicators,
  provenance: FieldProvenance | null,
  opts: { refresh?: boolean; now?: Date } = {},
): Promise<{ ok: boolean; wrote: boolean; error?: string }> {
  if (!target.contactId || !target.brokerageId) return { ok: false, wrote: false, error: "contactId and brokerageId are both required" }
  const { data: row, error: readError } = await supabase
    .from("contacts")
    .select("enrichment_profile")
    .eq("id", target.contactId)
    .eq("brokerage_id", target.brokerageId)
    .maybeSingle()
  if (readError) return { ok: false, wrote: false, error: readError.message }
  if (!row) return { ok: false, wrote: false, error: "contact not found in this tenant" }
  const prior = (((row as { enrichment_profile?: Record<string, unknown> | null }).enrichment_profile) ?? {}) as Record<string, unknown>
  if (!opts.refresh && realEstateIndicatorsFromProfile(prior)) return { ok: true, wrote: false }
  const at = (opts.now ?? new Date()).toISOString()
  const next = withFieldProvenance(
    { ...prior, [REAL_ESTATE_INDICATORS_KEY]: realEstateIndicatorsBlock(indicators, at) },
    fieldProvenanceOf(prior),
    provenance ? { [REAL_ESTATE_INDICATORS_KEY]: provenance } : null,
  )
  const { data: written, error: writeError } = await supabase
    .from("contacts")
    .update({ enrichment_profile: next })
    .eq("id", target.contactId)
    .eq("brokerage_id", target.brokerageId)
    .select("id")
  if (writeError) return { ok: false, wrote: false, error: writeError.message }
  if (!written || written.length === 0) return { ok: false, wrote: false, error: "indicators write matched no row" }
  return { ok: true, wrote: true }
}
