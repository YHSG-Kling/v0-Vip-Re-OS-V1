// lib/buyer-search/investor-offmarket-runner.ts
//
// Live side of the INVESTOR OFF-MARKET DEAL FINDER (Shopping Agent). Given a QUALIFIED INVESTOR buyer,
// reads their buy-box (property_preferences, via the canonical loadBuyerCriteria) and matches it against
// OUR scraped OFF-MARKET / motivated-seller `leads` in the box's geography, ranks them with the pure
// engine, and persists ONE investor_deal_matches row (idempotent per contact) for the agent to review.
// Nothing auto-sends. Best-effort; never throws into a caller.

import { createServiceClient } from "@/lib/supabase/service"
import { loadBuyerCriteria } from "@/lib/buyer-search/buyer-criteria"
import {
  rankOffMarketMatches,
  qualifiedOffMarketDeals,
  boxHasGeography,
  type OffMarketProperty,
} from "@/lib/buyer-search/investor-offmarket-match"

type Svc = ReturnType<typeof createServiceClient>

export interface InvestorOffMarketResult {
  ok: boolean
  reason: "matched" | "not_investor" | "no_box" | "no_geography" | "no_inventory" | "contact_not_found"
  matchId?: string
  matchCount?: number
  qualifiedCount?: number
}

const LEAD_COLS = "id, address, city, state, zip_code, motivation_type, motivation_confidence, equity_estimate"

function toProperty(l: any): OffMarketProperty {
  return {
    leadId: l.id,
    address: l.address ?? null,
    city: l.city ?? null,
    state: l.state ?? null,
    zip: l.zip_code ?? null,
    motivationType: l.motivation_type ?? null,
    motivationConfidence: l.motivation_confidence != null ? Number(l.motivation_confidence) : null,
    equityEstimate: l.equity_estimate != null ? Number(l.equity_estimate) : null,
  }
}

/**
 * Match a qualified investor buyer to our off-market inventory and persist. Idempotent per contact.
 * Only for contact_type='investor' — regular buyers are matched to MLS inventory by the retail matchers.
 */
export async function runInvestorOffMarketMatch(
  svc: Svc,
  params: { brokerageId: string; contactId: string },
): Promise<InvestorOffMarketResult> {
  const { data: contact } = await svc
    .from("contacts")
    .select("id, contact_type, agent_id, brokerage_id")
    .eq("id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!contact) return { ok: false, reason: "contact_not_found" }
  if ((contact as any).contact_type !== "investor") return { ok: false, reason: "not_investor" }

  const box = await loadBuyerCriteria(svc, params.contactId)
  if (!box) return { ok: false, reason: "no_box" }
  if (!boxHasGeography(box)) return { ok: false, reason: "no_geography" }

  // OUR off-market inventory = motivated-seller leads in the box geography. Two targeted queries
  // (by city, by zip) merged — avoids brittle .or()/.in() string escaping and keeps each bounded.
  const cities = (box.cities ?? []).filter(Boolean)
  const zips = (box.zipCodes ?? []).filter(Boolean)
  const rows: any[] = []
  if (cities.length) {
    const { data } = await svc.from("leads").select(LEAD_COLS)
      .eq("brokerage_id", params.brokerageId).not("motivation_type", "is", null).in("city", cities).limit(150)
    rows.push(...(data ?? []))
  }
  if (zips.length) {
    const { data } = await svc.from("leads").select(LEAD_COLS)
      .eq("brokerage_id", params.brokerageId).not("motivation_type", "is", null).in("zip_code", zips).limit(150)
    rows.push(...(data ?? []))
  }
  // Dedupe merged rows by lead id before scoring.
  const byId = new Map<string, any>()
  for (const r of rows) byId.set(r.id, r)

  const ranked = rankOffMarketMatches(box, [...byId.values()].map(toProperty))
  const qualified = qualifiedOffMarketDeals(ranked)

  const matchId = await upsert(svc, {
    brokerageId: params.brokerageId,
    contactId: params.contactId,
    agentId: (contact as any).agent_id ?? null,
    candidates: ranked,
  })
  if (!matchId) return { ok: false, reason: "no_inventory" }
  return {
    ok: true,
    reason: ranked.length === 0 ? "no_inventory" : "matched",
    matchId,
    matchCount: ranked.length,
    qualifiedCount: qualified.length,
  }
}

async function upsert(
  svc: Svc,
  m: { brokerageId: string; contactId: string; agentId: string | null; candidates: any[] },
): Promise<string | null> {
  const row = {
    brokerage_id: m.brokerageId,
    contact_id: m.contactId,
    agent_id: m.agentId,
    candidate_count: m.candidates.length,
    candidates: m.candidates as any,
    last_matched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data: existing } = await svc
    .from("investor_deal_matches")
    .select("id")
    .eq("contact_id", m.contactId)
    .maybeSingle()
  if (existing) {
    await svc.from("investor_deal_matches").update(row).eq("id", (existing as any).id)
    return (existing as any).id
  }
  const { data: created } = await svc.from("investor_deal_matches").insert(row).select("id").maybeSingle()
  return created ? (created as any).id : null
}

/** Load an investor's off-market deal match (or null). */
export async function getInvestorDealMatch(svc: Svc, params: { contactId: string; brokerageId: string }) {
  const { data } = await svc
    .from("investor_deal_matches")
    .select("*")
    .eq("contact_id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  return data ?? null
}
