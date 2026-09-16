// lib/buyer-search/investor-offmarket-runner.ts
//
// Live side of the INVESTOR OFF-MARKET DEAL FINDER (Shopping Agent). Given a QUALIFIED INVESTOR buyer,
// reads their buy-box (property_preferences, via the canonical loadBuyerCriteria) and matches it against
// OUR scraped OFF-MARKET / motivated-seller `leads` in the box's geography, ranks them with the pure
// engine, and persists ONE investor_deal_matches row (idempotent per contact) for the agent to review.
// Nothing auto-sends. Best-effort; never throws into a caller.

import { createServiceClient } from "@/lib/supabase/service"
import { loadBuyerCriteria, type BuyerCriteria } from "@/lib/buyer-search/buyer-criteria"
import {
  rankOffMarketMatches,
  qualifiedOffMarketDeals,
  boxHasGeography,
  scoreOffMarketFit,
  OFFMARKET_THRESHOLD,
  type OffMarketProperty,
} from "@/lib/buyer-search/investor-offmarket-match"
import { normalizeStreetAddress } from "@/lib/external/permit-signals"
import {
  fetchIncrementalPropertySearch,
  INVESTOR_OFFMARKET_QUICKLISTS,
  type BatchDataRecord,
} from "@/lib/external/batchdata-client"
import { meterVendorSpend } from "@/lib/vendor-governance/meter-vendor"

type Svc = ReturnType<typeof createServiceClient>

export interface InvestorOffMarketResult {
  ok: boolean
  reason: "matched" | "not_investor" | "no_box" | "no_geography" | "no_inventory" | "contact_not_found"
  matchId?: string
  matchCount?: number
  qualifiedCount?: number
}

// Lossless-promoted specs (m256): leads carry estimated_value; contacts carry home_value_estimate.
const LEAD_COLS = "id, address, city, state, zip_code, motivation_type, motivation_confidence, equity_estimate, is_active, beds, property_type, estimated_value"
const CONTACT_COLS = "id, address, city, zip_code, motivation_type, motivation_confidence, equity_estimate, beds, property_type, home_value_estimate"

function toProperty(r: any, stage: "lead" | "contact"): OffMarketProperty {
  const value = stage === "lead" ? r.estimated_value : r.home_value_estimate
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
    beds: r.beds != null ? Number(r.beds) : null,
    propertyType: r.property_type ?? null,
    estimatedValue: value != null ? Number(value) : null,
  }
}

/**
 * Match a qualified investor buyer to our off-market inventory and persist. Idempotent per contact.
 * Only for contact_persona='investor' — regular buyers are matched to MLS inventory by the retail
 * matchers. REPOINTED from contact_type (2026-08-31, owner ruling verbatim: "investor is a persona
 * and not a contact type"): the gate always MEANT "a buyer whose situation is an investment
 * purchase" — the persona m589 made storable. The tolerant contact_type read below keeps any
 * pre-m593 legacy row (zero live at repoint) matched rather than dropped.
 */
export async function runInvestorOffMarketMatch(
  svc: Svc,
  params: { brokerageId: string; contactId: string },
): Promise<InvestorOffMarketResult> {
  const { data: contact } = await svc
    .from("contacts")
    .select("id, contact_type, contact_persona, agent_id, brokerage_id")
    .eq("id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!contact) return { ok: false, reason: "contact_not_found" }
  // m593 IS APPLIED (2026-08-31, verified: the contact_type CHECK no longer
  // admits 'investor' and its backfill mapped any typed row to buyer + persona)
  // — so the transitional contact_type tolerant read that stood here is gone.
  // The persona IS the fact now, and a spelling the database cannot store must
  // not keep a live branch (§2: a check no input can trigger reads as coverage).
  const isInvestor = (contact as any).contact_persona === "investor"
  if (!isInvestor) return { ok: false, reason: "not_investor" }

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

  // BATCHDATA OFF-MARKET RAIL — wave 67 (owner verbatim: "with a buyer who we know is an investor
  // intent, that we are giving them off market listings to assist with their searching"). ADDITIVE
  // to the scraped-inventory match above (never a replacement): pulls BatchData's OFF-MARKET
  // quickLists (never on-market) for the box's TERRITORY geography, persists into
  // investor_offmarket_candidates (distinct table — this rail's own provenance, quicklists, equity%,
  // owner name), and delivers through the SAME portal-card path used above.
  const batchData = await pullAndPersistBatchDataOffMarketCandidates(svc, {
    brokerageId: params.brokerageId,
    contactId: params.contactId,
    box,
  })

  const totalQualified = qualified.length + batchData.qualifiedNew.length
  if (!matchId && batchData.persisted === 0) return { ok: false, reason: "no_inventory" }

  // BUYER PORTAL — the investor sees their matches in their own portal (like reverse-prospecting does
  // for retail buyers). Aggregate only (count + markets), never individual seller PII — the agent shares
  // specifics. Idempotent (24h dedupe in pushPortalValueCard); only when there's something real to show.
  // ONE push covers BOTH sources (scraped inventory + BatchData) — never two portal cards for one moment.
  if (totalQualified > 0) {
    try {
      const { pushPortalValueCard } = await import("@/lib/kernel/portal-value")
      const markets = [...new Set([
        ...qualified.map((q) => q.city),
        ...batchData.qualifiedNew.map((q) => q.city),
      ].filter(Boolean))].slice(0, 3).join(", ")
      await pushPortalValueCard({
        brokerageId: params.brokerageId,
        contactId: params.contactId,
        title: `${totalQualified} off-market ${totalQualified === 1 ? "opportunity" : "opportunities"} match your criteria`,
        summary: `We found ${totalQualified} off-market propert${totalQualified === 1 ? "y" : "ies"}${markets ? ` in ${markets}` : ""} that fit your investment box. Your agent will share the details and next steps.`,
        updateType: "investor_offmarket_deals",
        metadata: { audience: "buyer", qualified: totalQualified, markets, source: "investor_offmarket_match" },
      }, svc)
      if (batchData.qualifiedNew.length > 0) {
        await stampDelivered(svc, params.contactId, batchData.qualifiedNew.map((q) => q.addressKey), "portal_card")
      }
    } catch { /* portal push must never break the match */ }
  }
  return {
    ok: true,
    reason: ranked.length === 0 && batchData.persisted === 0 ? "no_inventory" : "matched",
    matchId: matchId ?? undefined,
    matchCount: ranked.length + batchData.persisted,
    qualifiedCount: totalQualified,
  }
}

// ── BATCHDATA OFF-MARKET RAIL (I/O) ─────────────────────────────────────────────────────
// Reverse of QUICKLIST_SLUG (module-private in batchdata-client.ts) for the six
// INVESTOR_OFFMARKET_QUICKLISTS slugs only — the internal motivation label scoreOffMarketFit's
// distress-strength table already understands (one vocabulary, §6).
const OFFMARKET_QUICKLIST_TO_MOTIVATION: Record<string, string> = {
  "absentee-owner": "absentee",
  "high-equity": "high_equity",
  "tired-landlord": "tired_landlord",
  vacant: "vacant",
  preforeclosure: "pre_foreclosure",
  inherited: "probate",
}

interface BatchDataOffMarketOutcome {
  persisted: number
  qualifiedNew: Array<{ addressKey: string; city: string | null; matchScore: number }>
}

/**
 * Territory-bound: only the BROKERAGE'S OWN active markets (lead_scraping_markets.is_active) whose
 * geography intersects the investor's box (city or zip) are pulled — never a global/off-territory
 * search. Bounded to the first 2 matching markets so a box with many saved cities doesn't fan out
 * into an unbounded API bill.
 */
async function resolveTerritoryMarketsForBox(
  svc: Svc, brokerageId: string, box: BuyerCriteria,
): Promise<Array<{ id: string; city: string; state: string; zip_codes: string[] | null }>> {
  const { data } = await svc.from("lead_scraping_markets")
    .select("id, city, state, zip_codes")
    .eq("brokerage_id", brokerageId).eq("is_active", true).limit(50)
  const markets = (data ?? []) as Array<{ id: string; city: string; state: string; zip_codes: string[] | null }>
  const cities = new Set(box.cities.map((c) => c.toLowerCase().trim()))
  const zips = new Set(box.zipCodes.map((z) => z.trim()))
  return markets
    .filter((m) => cities.has((m.city ?? "").toLowerCase().trim()) || (m.zip_codes ?? []).some((z) => zips.has(z)))
    .slice(0, 2)
}

/** PURE-ish mapper: a BatchData record from an off-market pull → the investor_offmarket_candidates row shape. */
function toOffMarketCandidateRow(
  r: BatchDataRecord, trigger: string, ctx: { brokerageId: string; contactId: string; marketId: string },
): { addressKey: string; row: Record<string, unknown>; property: OffMarketProperty } | null {
  const addressRaw = r.propertyAddress || r.address
  if (!addressRaw) return null
  const addressKey = normalizeStreetAddress(addressRaw)
  if (!addressKey) return null
  const equityPercent = r.valuation?.equityPercent ?? null
  const estimatedValue = r.estimatedValue ?? r.valuation?.estimatedValue ?? null
  const equityEstimate = r.valuation?.estimatedEquity
    ?? (estimatedValue != null && equityPercent != null ? Math.round(estimatedValue * (equityPercent / 100)) : null)
  const ownerName = [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || null
  const property: OffMarketProperty = {
    recordId: `batchdata:${addressKey}`,
    stage: "lead",
    address: addressRaw, city: r.propertyCity ?? r.city ?? null, state: r.propertyState ?? r.state ?? null,
    zip: r.propertyZip ?? r.zip ?? null,
    motivationType: OFFMARKET_QUICKLIST_TO_MOTIVATION[trigger] ?? trigger,
    motivationConfidence: 0.7, equityEstimate,
    beds: r.beds ?? null, propertyType: r.propertyType ?? null, estimatedValue,
  }
  return {
    addressKey,
    property,
    row: {
      brokerage_id: ctx.brokerageId, contact_id: ctx.contactId, market_id: ctx.marketId,
      address_key: addressKey, property_address: addressRaw,
      city: property.city, state: property.state, zip: property.zip,
      quicklists: r.quickLists ?? [trigger],
      estimated_value: estimatedValue, equity_percent: equityPercent, owner_name: ownerName,
    },
  }
}

/**
 * Pulls BatchData's OFF-MARKET quickLists (INVESTOR_OFFMARKET_QUICKLISTS — never on-market) for the
 * investor's box geography via fetchIncrementalPropertySearch (cursor/session-scoped, bounded take),
 * scores each with the SAME pure engine (scoreOffMarketFit — one vocabulary), and upserts into
 * investor_offmarket_candidates (unique on contact_id,address_key — idempotent re-runs). Best-effort:
 * a provider failure on one trigger/market never aborts the rest.
 */
async function pullAndPersistBatchDataOffMarketCandidates(
  svc: Svc, params: { brokerageId: string; contactId: string; box: BuyerCriteria },
): Promise<BatchDataOffMarketOutcome> {
  const out: BatchDataOffMarketOutcome = { persisted: 0, qualifiedNew: [] }
  if (!boxHasGeography(params.box)) return out
  const markets = await resolveTerritoryMarketsForBox(svc, params.brokerageId, params.box)
  if (markets.length === 0) return out

  const byAddress = new Map<string, { row: Record<string, unknown>; matchScore: number; city: string | null }>()
  for (const market of markets) {
    for (const quicklist of INVESTOR_OFFMARKET_QUICKLISTS) {
      let pull
      try {
        pull = await fetchIncrementalPropertySearch({
          quicklist, city: market.city, state: market.state,
          searchSession: `investor-offmarket-${market.id}-${quicklist}`, take: 20,
        })
      } catch { continue }
      if (!pull.ok) continue
      // Cost: this IS the pull's single metering point (fetchIncrementalPropertySearch computes but
      // never books its own cost — every caller in the codebase meters once per pull; this is that
      // one call, so a re-run of this same pull is never metered twice).
      await meterVendorSpend({
        vendorName: "batchdata", usageType: "investor_offmarket_search", cost: pull.cost,
        brokerageId: params.brokerageId, metadata: { market_id: market.id, quicklist, contact_id: params.contactId },
      })
      for (const record of pull.records) {
        const mapped = toOffMarketCandidateRow(record, quicklist, { brokerageId: params.brokerageId, contactId: params.contactId, marketId: market.id })
        if (!mapped) continue
        const scored = scoreOffMarketFit(params.box, mapped.property)   // geography/price-gated; null = out of box
        if (!scored) continue
        const prior = byAddress.get(mapped.addressKey)
        if (!prior || scored.matchScore > prior.matchScore) {
          byAddress.set(mapped.addressKey, { row: mapped.row, matchScore: scored.matchScore, city: mapped.property.city })
        }
      }
    }
  }
  if (byAddress.size === 0) return out

  // Which of these are ALREADY delivered (so we never re-stamp delivered_at as "new" on a re-run).
  const addressKeys = [...byAddress.keys()]
  const { data: existing } = await svc.from("investor_offmarket_candidates")
    .select("address_key, delivered_at").eq("contact_id", params.contactId).in("address_key", addressKeys)
  const alreadyDelivered = new Set(((existing ?? []) as Array<{ address_key: string; delivered_at: string | null }>)
    .filter((e) => e.delivered_at).map((e) => e.address_key))

  const upserts = addressKeys.map((k) => {
    const c = byAddress.get(k)!
    return { ...c.row, fit_score: c.matchScore, matched_at: new Date().toISOString() }
  })
  const { error } = await svc.from("investor_offmarket_candidates")
    .upsert(upserts, { onConflict: "contact_id,address_key" })
  if (error) return out

  out.persisted = upserts.length
  for (const k of addressKeys) {
    const c = byAddress.get(k)!
    if (c.matchScore >= OFFMARKET_THRESHOLD && !alreadyDelivered.has(k)) {
      out.qualifiedNew.push({ addressKey: k, city: c.city, matchScore: c.matchScore })
    }
  }
  return out
}

async function stampDelivered(svc: Svc, contactId: string, addressKeys: string[], via: string): Promise<void> {
  if (addressKeys.length === 0) return
  await svc.from("investor_offmarket_candidates")
    .update({ delivered_at: new Date().toISOString(), delivered_via: via })
    .eq("contact_id", contactId).in("address_key", addressKeys).is("delivered_at", null)
}

/**
 * Read this investor's persisted BatchData off-market candidates (highest fit first). Every column
 * written by pullAndPersistBatchDataOffMarketCandidates has a reader here + the portal panel.
 * Module-private: the ONE external caller is getInvestorDealMatch (below, same file) — that is the
 * reader surface app/actions/investor-deals.ts and the portal panel actually consume, so this stays
 * an internal helper rather than a second exported entry point for the same read (§6).
 */
async function getInvestorOffMarketCandidates(svc: Svc, params: { contactId: string; brokerageId: string }) {
  const { data } = await svc.from("investor_offmarket_candidates")
    .select("id, market_id, address_key, property_address, city, state, zip, quicklists, estimated_value, equity_percent, owner_name, fit_score, matched_at, delivered_at, delivered_via, dismissed_at")
    .eq("contact_id", params.contactId).eq("brokerage_id", params.brokerageId)
    .is("dismissed_at", null)
    .order("fit_score", { ascending: false }).limit(25)
  return (data ?? []) as Array<{
    id: string; market_id: string; address_key: string; property_address: string
    city: string | null; state: string | null; zip: string | null
    quicklists: string[]; estimated_value: number | null; equity_percent: number | null
    owner_name: string | null; fit_score: number; matched_at: string | null
    delivered_at: string | null; delivered_via: string | null; dismissed_at: string | null
  }>
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
  // matched — honest skip, no wasted scan). The filter is contact_persona — the axis the owner ruled
  // the investing lives on contact_persona (m589). The transitional OR over the
  // legacy contact_type spelling is dropped: m593 is applied and backfilled, so
  // no row can carry it — a filter arm the database cannot satisfy is dead
  // coverage wearing a live face (§2).
  const { data: investors } = await svc
    .from("contacts")
    .select("id, property_preferences!inner(contact_id)")
    .eq("brokerage_id", params.brokerageId)
    .eq("contact_persona", "investor")
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

/**
 * Load an investor's off-market deal match (or null), WITH the BatchData off-market candidates
 * riding alongside (offMarketCandidates — same reader every column of investor_offmarket_candidates
 * needs). Two sources, one read, so a caller (the portal panel) never has to know there are two
 * off-market rails under the hood.
 */
export async function getInvestorDealMatch(svc: Svc, params: { contactId: string; brokerageId: string }) {
  const { data } = await svc
    .from("investor_deal_matches")
    .select("*")
    .eq("contact_id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  const offMarketCandidates = await getInvestorOffMarketCandidates(svc, params)
  if (!data && offMarketCandidates.length === 0) return null
  return { ...(data ?? {}), offMarketCandidates }
}
