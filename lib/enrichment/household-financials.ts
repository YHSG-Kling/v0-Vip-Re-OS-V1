// lib/enrichment/household-financials.ts
//
// THE HOUSEHOLD-FINANCIAL RUNG of the one enrichment rail (lane 85C, wave 85). Owner verbatim:
// "add marital status,household income, net worth or credit on enrichment and add location for
// contact enrichment."
//
// What this module owns — and what it deliberately does NOT:
//   · The MAPPING is not here. Every value passes through lib/lead-pipeline/enrichment-column-map.ts
//     (HOUSEHOLD FINANCIALS section: householdFinancialsFromBatchData / householdFinancialsFromVersium
//     → mergeHouseholdFinancials → householdFinancialContactColumns). One vocabulary, one mapper.
//   · The PROVIDER ORDER is data, cheapest first (HOUSEHOLD_FINANCIAL_SOURCES):
//       1. BatchData `demographic` dataset — marital status / household income / net worth. ALREADY
//          BOUGHT on the seller-signal probe and the drain's property lookup; $0 marginal.
//       2. Versium financial append — the only rung selling a (modeled) CREDIT band, plus income / net
//          worth. Paid per MATCH, asked ONLY for a gap the free rung left (never for marital status,
//          which the financial output does not return).
//     PeopleData stays the demographics base (age, gender, employment, education…) — it sells none of
//     the four, so it is not a rung here.
//   · appendModeledCredit is the paid step: env-gated (VERSIUM_API_KEY), vendor-budget pre-flighted
//     (the house gate, lib/vendor-governance/budget-gate.ts), booked on the PLATFORM ledger
//     (meterVendorSpend → vendor_usage_tracking, vendor "versium") at the client's reported cost.
//   · persistHouseholdFinancialCaptures writes what the seller-signal probe already bought onto the
//     lead (enrichment_profile) or contact (first-class columns + enrichment_profile), tenant-anchored.
//
// FCRA: the credit band is a MODELED marketing estimate (MODELED_CREDIT_BASIS), stored as a band.
// Wave 86 (owner verbatim: "add because most audience or info will be used from the contact card"):
// net worth and the credit band are SHOWN on the agent-facing contact card beside household income
// and marital status, labelled "modeled estimate" (app/crm/contacts/[contactId]/components/
// enrichment-panel.tsx via app/actions/contact-enrichment.ts::getContactInsights). The credit band
// still never reaches outbound copy, an eligibility / pricing / steering decision, or a persona
// trait (FCRA / fair lending) — the modeled-credit firewall, scripts/enrichment-one-rail-guard.ts
// Layer 8d, holds that with a positive control.

import {
  householdFinancialContactColumns,
  householdFinancialsFromProfile,
  mergeHouseholdFinancials,
  missingHouseholdFinancials,
  type HouseholdFinancialField,
  type HouseholdFinancials,
} from "@/lib/lead-pipeline/enrichment-column-map"
import {
  appendVersiumFinancial,
  isVersiumConfigured,
  VERSIUM_FINANCIAL_MATCH_COST_USD,
  type VersiumFinancialResult,
  type VersiumIdentity,
} from "@/lib/external/versium-client"

/** Provider order per field, cheapest first — documentation AS DATA, asserted by
 *  scripts/enrichment-one-rail-guard.ts (Layer 8). unitCostUsd is the MARGINAL cost of asking.
 *  @proofSeam kept exported for scripts/enrichment-one-rail-guard.ts, which asserts the household-financial source costs */
export const HOUSEHOLD_FINANCIAL_SOURCES: Readonly<Record<HouseholdFinancialField, ReadonlyArray<{ provider: "batchdata" | "versium"; unitCostUsd: number; note: string }>>> = {
  marital_status: [
    { provider: "batchdata", unitCostUsd: 0, note: "demographic dataset on a lookup already bought (seller-signal probe / drain Step 6f / acquisition pull)" },
  ],
  household_income: [
    { provider: "batchdata", unitCostUsd: 0, note: "demographic dataset — demographics.income" },
    { provider: "versium", unitCostUsd: VERSIUM_FINANCIAL_MATCH_COST_USD, note: "financial append — Household Income" },
  ],
  net_worth: [
    { provider: "batchdata", unitCostUsd: 0, note: "demographic dataset — demographics.netWorth" },
    { provider: "versium", unitCostUsd: VERSIUM_FINANCIAL_MATCH_COST_USD, note: "financial append — Estimated Net Worth" },
  ],
  credit_score_range: [
    { provider: "versium", unitCostUsd: VERSIUM_FINANCIAL_MATCH_COST_USD, note: "financial append — Credit Rating (MODELED band, not a consumer report)" },
  ],
}

/** The fields Versium's financial output can fill. Marital status is NOT one (basic demographic). */
const VERSIUM_FILLABLE: ReadonlySet<HouseholdFinancialField> = new Set(["household_income", "net_worth", "credit_score_range"])

/** PURE — should the paid rung be asked for this profile? Only when a field it can fill is missing. */
export function needsPaidHouseholdRung(profile: Record<string, unknown> | null | undefined): boolean {
  return missingHouseholdFinancials(profile).some((f) => VERSIUM_FILLABLE.has(f))
}

export interface AppendModeledCreditDeps {
  append?: (id: VersiumIdentity) => Promise<VersiumFinancialResult>
  checkBudget?: (p: { brokerageId: string; addCost: number }) => Promise<{ allowed: boolean }>
  meter?: (p: { vendorName: string; usageType: string; cost: number; brokerageId: string; systemSource: string; metadata?: Record<string, unknown>; attribution?: { leadId?: string | null; contactId?: string | null; rawRecordId?: string | null } }) => Promise<unknown>
}

export interface AppendModeledCreditResult {
  profile: Record<string, any>
  asked: boolean
  cost: number
  filled: HouseholdFinancialField[]
  skipped?: "complete" | "no_brokerage" | "budget" | "unconfigured" | "no_identity" | "no_match" | "error"
  error?: string
}

/**
 * The paid rung: ask Versium's financial append for the household financials a profile still lacks,
 * merge through the ONE mapper (existing values win — a fresher free BatchData read is never
 * overwritten by the paid one), book the spend. Never throws.
 */
export async function appendModeledCredit(params: {
  profile: Record<string, any> | null | undefined
  identity: VersiumIdentity
  brokerageId: string | null | undefined
  lane: string
  /** Lane 87F — the person the paid rung is bought for (see MeterVendorInput.attribution). */
  attribution?: { leadId?: string | null; contactId?: string | null; rawRecordId?: string | null }
  deps?: AppendModeledCreditDeps
}): Promise<AppendModeledCreditResult> {
  const profile = { ...(params.profile ?? {}) }
  if (!needsPaidHouseholdRung(profile)) return { profile, asked: false, cost: 0, filled: [], skipped: "complete" }
  // Tenant-attributed spend only (§4: the tenant comes from the caller's own scope; a platform-anonymous
  // record is never charged to nobody).
  if (!params.brokerageId) return { profile, asked: false, cost: 0, filled: [], skipped: "no_brokerage" }
  if (!params.deps?.append && !isVersiumConfigured()) return { profile, asked: false, cost: 0, filled: [], skipped: "unconfigured" }
  try {
    const checkBudget = params.deps?.checkBudget
      ?? (async (p: { brokerageId: string; addCost: number }) => (await import("@/lib/vendor-governance/budget-gate")).checkVendorBudget(p))
    const budget = await checkBudget({ brokerageId: params.brokerageId, addCost: VERSIUM_FINANCIAL_MATCH_COST_USD })
    if (!budget.allowed) return { profile, asked: false, cost: 0, filled: [], skipped: "budget" }

    const append = params.deps?.append ?? appendVersiumFinancial
    const res = await append(params.identity)
    if (res.skipped) return { profile, asked: false, cost: 0, filled: [], skipped: res.skipped }

    const meter = params.deps?.meter
      ?? (async (p: Parameters<NonNullable<AppendModeledCreditDeps["meter"]>>[0]) => (await import("@/lib/vendor-governance/meter-vendor")).meterVendorSpend(p))
    if (res.cost > 0) {
      const booked = await meter({
        vendorName: "versium",
        usageType: "household_financials",
        cost: res.cost,
        brokerageId: params.brokerageId,
        systemSource: "skip_trace",
        metadata: { lane: params.lane, capability: "person.enrich_financial", matched: res.credits != null ? res.credits > 0 : !!res.data, credits: res.credits ?? null, match_level: res.matchLevel ?? null },
        attribution: params.attribution,
      })
      // Wave 96: meterVendorSpend resolves false when no row was written — spend the ledger never saw.
      if (booked === false) console.warn(`[versium] $${res.cost} household_financials NOT booked to the vendor ledger (brokerage ${params.brokerageId})`)
    }
    if (res.error) return { profile, asked: true, cost: res.cost, filled: [], skipped: "error", error: res.error }
    if (!res.data) return { profile, asked: true, cost: res.cost, filled: [], skipped: "no_match" }

    const before = householdFinancialsFromProfile(profile)
    const merged = mergeHouseholdFinancials(profile, res.data, "versium", { prefer: "existing" })
    const after = householdFinancialsFromProfile(merged)
    const filled = (Object.keys(after) as HouseholdFinancialField[]).filter((f) => !before[f])
    return { profile: merged, asked: true, cost: res.cost, filled }
  } catch (e) {
    return { profile, asked: false, cost: 0, filled: [], skipped: "error", error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── The seller-signal probe's captures → the entity ───────────────────────────

export interface HouseholdFinancialCapture {
  entity: "lead" | "contact"
  id: string
  financials: HouseholdFinancials
}

type SupabaseLike = { from: (table: string) => any }

/**
 * Persist what BatchData's `demographic` dataset returned on the seller-signal probe (bought for the
 * signals, previously discarded). Lead → enrichment_profile (leads carry no first-class financial
 * column); contact → the four first-class columns (householdFinancialContactColumns) + its
 * enrichment_profile. Every read and write is anchored on the caller's brokerage (§4) and every error
 * is READ (§3). Returns counts; never throws.
 */
export async function persistHouseholdFinancialCaptures(params: {
  supabase: SupabaseLike
  brokerageId: string
  captures: HouseholdFinancialCapture[]
}): Promise<{ written: number; errors: string[] }> {
  const out = { written: 0, errors: [] as string[] }
  const brokerageId = params.brokerageId
  if (!brokerageId) { out.errors.push("household financials: no brokerage scope — nothing written"); return out }
  for (const cap of params.captures) {
    if (Object.keys(cap.financials).length === 0) continue
    const table = cap.entity === "lead" ? "leads" : "contacts"
    const { data: row, error: readError } = await params.supabase
      .from(table)
      .select("id, enrichment_profile")
      .eq("brokerage_id", brokerageId)
      .eq("id", cap.id)
      .maybeSingle()
    if (readError) { out.errors.push(`${table} ${cap.id}: household read refused: ${readError.message}`); continue }
    if (!row) { out.errors.push(`${table} ${cap.id}: not found in this brokerage — household financials not written`); continue }
    const profile = mergeHouseholdFinancials(
      (row.enrichment_profile as Record<string, any> | null) ?? {}, cap.financials, "batchdata", { prefer: "incoming" },
    )
    const patch: Record<string, unknown> = cap.entity === "contact"
      ? { ...householdFinancialContactColumns(cap.financials), enrichment_profile: profile }
      : { enrichment_profile: profile }
    const { data: updated, error: writeError } = await params.supabase
      .from(table)
      .update(patch)
      .eq("brokerage_id", brokerageId)
      .eq("id", cap.id)
      .select("id")
    if (writeError) { out.errors.push(`${table} ${cap.id}: household write refused: ${writeError.message}`); continue }
    if (!updated || updated.length === 0) { out.errors.push(`${table} ${cap.id}: household write matched no row`); continue }
    out.written++
    // RELATIONSHIP GRAPH (wave 102, lane 102B): a marital status landing on a CONTACT is household
    // evidence — the other contacts of this tenant at the same mailing address become spouse_partner
    // (partnered status on either side) or household_member (address alone), with the confidence on
    // the edge (lib/kernel/relationship-graph.ts planHouseholdEdges). Leads carry no address columns
    // here and belong to the person layer (lane 102A). The contact columns stay the record; a lost
    // edge is reported beside the write, never thrown.
    if (cap.entity === "contact" && cap.financials.marital_status !== undefined) {
      try {
        const { deriveHouseholdEdges } = await import("@/lib/kernel/relationship-graph")
        const edges = await deriveHouseholdEdges(params.supabase, { brokerageId, contactId: cap.id })
        if (edges.errors.length > 0 && !edges.degraded) out.errors.push(...edges.errors.map((e) => `contact ${cap.id}: household edge: ${e}`))
      } catch (e) {
        out.errors.push(`contact ${cap.id}: household edge derivation failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  return out
}
