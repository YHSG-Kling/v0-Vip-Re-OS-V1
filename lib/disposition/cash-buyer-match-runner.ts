// lib/disposition/cash-buyer-match-runner.ts
//
// CASH-BUYER MATCH RUNNER — the live side of the disposition bookend. Given a subject property (a
// listing, or an off-market address), it sources nearby CASH INVESTORS from BatchData's investor-buybox
// endpoint, ranks them with the pure engine, and persists ONE cash_buyer_matches row (idempotent per
// listing) for the agent to review + stage a gated outreach. Nothing auto-sends.
//
// PROVIDER-GATED like every other BatchData caller: when BATCHDATA_MCP_URL is unset (or the tool errors)
// the runner returns an honest skip — it NEVER fabricates investor candidates. The BatchData verify
// spend is metered through the existing vendor gateway.

import type { SupabaseClient } from "@supabase/supabase-js"
import { callBatchDataMcp } from "@/lib/external/batchdata-mcp"
import {
  buildBuyBoxQuery,
  normalizeInvestorCandidate,
  rankInvestorCandidates,
  qualifiedInvestors,
  type SubjectProperty,
  type BuyBoxOptions,
  type RankedInvestor,
} from "@/lib/disposition/investor-match"

type Svc = SupabaseClient<any, any, any>

/** The BatchData MCP tool that returns ranked investors for a subject property's buy-box (first 10). */
export const INVESTOR_BUYBOX_TOOL = "investor_buybox_preview"

export interface CashBuyerMatchResult {
  ok: boolean
  reason: "matched" | "provider_unconfigured" | "provider_error" | "no_subject" | "no_candidates"
  matchId?: string
  candidateCount?: number
  qualifiedCount?: number
}

/** Pull the investor array out of whatever envelope the BatchData MCP returns (shape varies). */
function extractInvestorArray(data: any): Record<string, any>[] {
  if (Array.isArray(data)) return data
  for (const k of ["results", "records", "investors", "items", "data"]) {
    if (Array.isArray(data?.[k])) return data[k]
  }
  if (Array.isArray(data?.results?.records)) return data.results.records
  return []
}

/**
 * Match cash investors to a subject property and persist. `listingId` (when given) makes the match
 * idempotent — a re-run refreshes the same row in place. Best-effort: never throws into a caller.
 */
export async function runCashBuyerMatch(
  svc: Svc,
  params: {
    brokerageId: string
    listingId?: string | null
    subject: SubjectProperty
    options?: BuyBoxOptions
  },
): Promise<CashBuyerMatchResult> {
  const query = buildBuyBoxQuery(params.subject, params.options)
  if (!query) return { ok: false, reason: "no_subject" }

  const res = await callBatchDataMcp<any>(INVESTOR_BUYBOX_TOOL, query)
  if (res.unconfigured) return { ok: false, reason: "provider_unconfigured" }
  if (!res.ok || res.data == null) return { ok: false, reason: "provider_error" }

  // Meter the buybox lookup (preview bills for ~10 records) through the existing vendor gateway.
  try {
    const { meterVendorSpend } = await import("@/lib/vendor-governance/meter-vendor")
    await meterVendorSpend({ vendorName: "batchdata", usageType: "investor_buybox", cost: 0.05, unitCount: 10, brokerageId: params.brokerageId, systemSource: "cash_buyer_match", metadata: { listingId: params.listingId ?? null } })
  } catch { /* metering never breaks the match */ }

  const raw = extractInvestorArray(res.data)
  const ranked = rankInvestorCandidates(
    raw.map(normalizeInvestorCandidate),
    { preferClassification: params.options?.investorClassification },
  )
  const qualified = qualifiedInvestors(ranked)

  const matchId = await upsertMatch(svc, {
    brokerageId: params.brokerageId,
    listingId: params.listingId ?? null,
    subject: params.subject,
    candidates: ranked,
  })
  if (!matchId) return { ok: false, reason: "provider_error" }
  return {
    ok: true,
    reason: ranked.length === 0 ? "no_candidates" : "matched",
    matchId,
    candidateCount: ranked.length,
    qualifiedCount: qualified.length,
  }
}

async function upsertMatch(
  svc: Svc,
  m: { brokerageId: string; listingId: string | null; subject: SubjectProperty; candidates: RankedInvestor[] },
): Promise<string | null> {
  const row = {
    brokerage_id: m.brokerageId,
    listing_id: m.listingId,
    subject_street: m.subject.street,
    subject_city: m.subject.city ?? null,
    subject_state: m.subject.state ?? null,
    subject_zip: m.subject.zip ?? null,
    subject_beds: m.subject.bedrooms ?? null,
    subject_baths: m.subject.bathrooms ?? null,
    subject_sqft: m.subject.livingAreaSqft ?? null,
    subject_year_built: m.subject.yearBuilt ?? null,
    subject_property_type: m.subject.propertyTypeDetail ?? null,
    candidate_count: m.candidates.length,
    candidates: m.candidates as any,
    last_matched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  // Idempotent per listing (unique index); off-market subjects dedupe by (brokerage, street, zip).
  const { data: existing } = m.listingId
    ? await svc.from("cash_buyer_matches").select("id").eq("listing_id", m.listingId).maybeSingle()
    : await svc.from("cash_buyer_matches").select("id").eq("brokerage_id", m.brokerageId).eq("subject_street", m.subject.street).eq("subject_zip", m.subject.zip ?? "").is("listing_id", null).maybeSingle()

  if (existing) {
    await svc.from("cash_buyer_matches").update(row).eq("id", (existing as any).id)
    return (existing as any).id
  }
  const { data: created } = await svc.from("cash_buyer_matches").insert(row).select("id").maybeSingle()
  return created ? (created as any).id : null
}

/** Load a listing's cash-buyer match (or null). */
export async function getCashBuyerMatch(svc: Svc, params: { listingId: string; brokerageId: string }) {
  const { data } = await svc
    .from("cash_buyer_matches")
    .select("*")
    .eq("listing_id", params.listingId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  return data ?? null
}
