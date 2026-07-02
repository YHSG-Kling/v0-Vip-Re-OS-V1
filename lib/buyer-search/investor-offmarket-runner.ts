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

const LEAD_COLS = "id, address, city, state, zip_code, motivation_type, motivation_confidence, equity_estimate, is_active"
const CONTACT_COLS = "id, address, city, zip_code, motivation_type, motivation_confidence, equity_estimate"

function toProperty(r: any, stage: "lead" | "contact"): OffMarketProperty {
  return {
    recordId: r.id,
    stage,
    address: r.address ?? null,
    city: r.city ?? null,
    state: r.state ?? null,   // contacts have no state column; leads do (null-safe)
    zip: r.zip_code ?? null,
    motivationType: r.motivation_type ?? null,
    motivationConfidence: r.motivation_confidence != null ? Number(r.motivation_confidence) : null,
    equityEstimate: r.equity_estimate != null ? Number(r.equity_estimate) : null,
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

  // OUR off-market inventory spans the lineage (raw → lead → contact). A motivated seller is an ACTIVE
  // lead until the AI ISA qualifies it, then it's PROMOTED to a contact (the lead is deactivated —
  // is_active=false — and the CONTACT becomes the single source of truth). So match BOTH: active
  // motivated-seller leads (not yet promoted) AND motivated-seller contacts (promoted, canonical). Two
  // targeted queries per source (by city, by zip) — avoids brittle .or()/.in() escaping; the pure
  // ranker dedupes across stages by address (preferring the contact). NON-promoted leads only, so a
  // promoted record isn't double-counted.
  const cities = (box.cities ?? []).filter(Boolean)
  const zips = (box.zipCodes ?? []).filter(Boolean)
  const props: OffMarketProperty[] = []

  const collectLeads = async (col: "city" | "zip_code", vals: string[]) => {
    const { data } = await svc.from("leads").select(LEAD_COLS)
      .eq("brokerage_id", params.brokerageId).not("motivation_type", "is", null)
      .not("is_active", "is", false)   // promoted leads (is_active=false) live on as contacts — exclude
      .in(col, vals).limit(150)
    for (const r of (data ?? [])) props.push(toProperty(r, "lead"))
  }
  const collectContacts = async (col: "city" | "zip_code", vals: string[]) => {
    const { data } = await svc.from("contacts").select(CONTACT_COLS)
      .eq("brokerage_id", params.brokerageId).not("motivation_type", "is", null)
      .in(col, vals).limit(150)
    for (const r of (data ?? [])) props.push(toProperty(r, "contact"))
  }
  if (cities.length) { await collectLeads("city", cities); await collectContacts("city", cities) }
  if (zips.length) { await collectLeads("zip_code", zips); await collectContacts("zip_code", zips) }

  const ranked = rankOffMarketMatches(box, props)   // dedupes across lead/contact stages by address
  const qualified = qualifiedOffMarketDeals(ranked)

  const matchId = await upsert(svc, {
    brokerageId: params.brokerageId,
    contactId: params.contactId,
    agentId: (contact as any).agent_id ?? null,
    candidates: ranked,
  })
  if (!matchId) return { ok: false, reason: "no_inventory" }

  // BUYER PORTAL — the investor sees their matches in their own portal (like reverse-prospecting does
  // for retail buyers). Aggregate only (count + markets), never individual seller PII — the agent shares
  // specifics. Idempotent (24h dedupe in pushPortalValueCard); only when there's something real to show.
  if (qualified.length > 0) {
    try {
      const { pushPortalValueCard } = await import("@/lib/kernel/portal-value")
      const markets = [...new Set(qualified.map((q) => q.city).filter(Boolean))].slice(0, 3).join(", ")
      await pushPortalValueCard({
        brokerageId: params.brokerageId,
        contactId: params.contactId,
        title: `${qualified.length} off-market ${qualified.length === 1 ? "opportunity" : "opportunities"} match your criteria`,
        summary: `We found ${qualified.length} off-market propert${qualified.length === 1 ? "y" : "ies"}${markets ? ` in ${markets}` : ""} that fit your investment box. Your agent will share the details and next steps.`,
        updateType: "investor_offmarket_deals",
        metadata: { audience: "buyer", qualified: qualified.length, markets, source: "investor_offmarket_match" },
      }, svc)
    } catch { /* portal push must never break the match */ }
  }
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

export interface InvestorRefreshResult { investors: number; matched: number; portalCards: number }

/**
 * AUTONOMOUS (Shopping Agent) — refresh off-market matches for EVERY qualified investor buyer in a
 * brokerage that has a buy-box. Rides a daily cron: as the platform scrapes more off-market inventory,
 * each investor's deal list stays current and their portal card refreshes, with zero agent action.
 * Idempotent per investor (upsert + 24h portal dedupe). Best-effort per investor — one failure never
 * stops the sweep.
 */
export async function refreshInvestorOffMarketMatches(
  svc: Svc,
  params: { brokerageId: string },
): Promise<InvestorRefreshResult> {
  const out: InvestorRefreshResult = { investors: 0, matched: 0, portalCards: 0 }
  // Only investor contacts that actually carry a buy-box (an investor without saved criteria can't be
  // matched — honest skip, no wasted scan).
  const { data: investors } = await svc
    .from("contacts")
    .select("id, property_preferences!inner(contact_id)")
    .eq("brokerage_id", params.brokerageId)
    .eq("contact_type", "investor")
    .limit(500)
  for (const inv of (investors ?? []) as any[]) {
    out.investors++
    try {
      const r = await runInvestorOffMarketMatch(svc, { brokerageId: params.brokerageId, contactId: inv.id })
      if (r.ok && (r.matchCount ?? 0) > 0) out.matched++
      if (r.ok && (r.qualifiedCount ?? 0) > 0) out.portalCards++
    } catch { /* best-effort — keep sweeping */ }
  }
  return out
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
