"use server"

/**
 * Lifetime Customer NPV + Income Forecast — read actions for the UI.
 *
 *   - getAgentLifetimeNpvRanked      — NPV-ranked sphere panel data
 *   - getAgentIncomeForecast         — latest forecast snapshot for hero card
 *   - getDueTouchpoints              — overdue / due-this-week list
 *   - rescanLifetimeNpvForecastAction — admin/agent on-demand rescan
 */

import { createClient } from "@/lib/supabase/server"
import { latestByContact as dedupeLedger } from "@/lib/lifetime-customer-npv/current"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"

// ─── Types ────────────────────────────────────────────────────────────────

export type NpvTier = "platinum" | "gold" | "silver" | "bronze" | "dormant"

export interface NpvRow {
  contactId:          string
  contactName:        string | null
  contactType:        string | null
  npvScore:           number
  npvDollars:         number
  tier:               NpvTier
  recommendedAction:  string | null
  recommendedCadence: string | null
  nextTouchpointDue:  string | null
  signals:            Array<{ label: string; weight?: number; dollars?: number }>
  scoreDelta:         number | null
  computedAt:         string
}

export interface AgentIncomeForecast {
  agentId:                string
  brokerageId:            string
  computedAt:             string
  weighted30:             number
  weighted60:             number
  weighted90:             number
  raw30:                  number
  raw60:                  number
  raw90:                  number
  sphereReferralExpected: number
  totalForecast90:        number
  lowBandPct:             number
  highBandPct:            number
  dealCount:              number
  activeListingCount:     number
  byStage:                Array<{ stage: string; count: number; weightedGci: number }>
  weighted90Delta:        number | null
}

// ─── NPV ranked sphere ────────────────────────────────────────────────────

export async function getAgentLifetimeNpvRanked(params: {
  agentId:  string
  limit?:   number
  /** Filter to one tier when set */
  tier?:    NpvTier
}): Promise<{ success: boolean; error?: string; rows?: NpvRow[] }> {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent id" }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // RLS gates by brokerage; we just need the latest snapshot per contact_id.
  // We approximate "latest per contact" by ordering DESC and de-duping in JS.
  let q = supabase
    .from("lifetime_customer_npv_scores")
    .select("contact_id, npv_score, npv_dollars, tier, recommended_action, recommended_cadence, next_touchpoint_due, signals, score_delta, computed_at")
    .eq("agent_id", params.agentId)
    .order("computed_at", { ascending: false })
    .limit(2000)
  if (params.tier) q = q.eq("tier", params.tier)

  const { data, error } = await q
  if (error) return { success: false, error: error.message }

  // Newest ledger row per contact via the ONE shared rule (this table is
  // append-only). The map below preserves this action's richer projection.
  const latestByContact = new Map<string, NpvRow>()
  for (const r of dedupeLedger((data ?? []) as Array<{
    contact_id: string; npv_score: number; npv_dollars: number; tier: NpvTier;
    recommended_action: string | null; recommended_cadence: string | null;
    next_touchpoint_due: string | null;
    signals: Array<{ label: string; weight?: number; dollars?: number }> | null;
    score_delta: number | null; computed_at: string
  }>)) {
    latestByContact.set(r.contact_id, {
      contactId:          r.contact_id,
      contactName:        null,  // hydrated below
      contactType:        null,
      npvScore:           Number(r.npv_score),
      npvDollars:         Number(r.npv_dollars ?? 0),
      tier:               r.tier,
      recommendedAction:  r.recommended_action,
      recommendedCadence: r.recommended_cadence,
      nextTouchpointDue:  r.next_touchpoint_due,
      signals:            r.signals ?? [],
      scoreDelta:         r.score_delta != null ? Number(r.score_delta) : null,
      computedAt:         r.computed_at,
    })
  }

  // Hydrate contact names + types
  const ids = Array.from(latestByContact.keys())
  if (ids.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, contact_type")
      .in("id", ids)
    for (const c of (contacts ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; contact_type: string | null }>) {
      const row = latestByContact.get(c.id)
      if (!row) continue
      row.contactName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || null
      row.contactType = c.contact_type
    }
  }

  const rows = Array.from(latestByContact.values()).sort((a, b) => b.npvScore - a.npvScore)
  return { success: true, rows: rows.slice(0, params.limit ?? 100) }
}

// ─── Income Forecast — latest snapshot ────────────────────────────────────

export async function getAgentIncomeForecast(params: {
  agentId: string
}): Promise<{ success: boolean; error?: string; data?: AgentIncomeForecast | null }> {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent id" }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data, error } = await supabase
    .from("income_forecast_snapshots")
    .select("*")
    .eq("agent_id", params.agentId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!data) return { success: true, data: null }

  const r = data as {
    agent_id: string; brokerage_id: string; computed_at: string;
    weighted_30: number; weighted_60: number; weighted_90: number;
    raw_30: number; raw_60: number; raw_90: number;
    sphere_referral_expected: number; low_band_pct: number; high_band_pct: number;
    deal_count: number; active_listing_count: number;
    by_stage: Array<{ stage: string; count: number; weightedGci: number }> | null;
    weighted_90_delta: number | null
  }
  const result: AgentIncomeForecast = {
    agentId:                r.agent_id,
    brokerageId:            r.brokerage_id,
    computedAt:             r.computed_at,
    weighted30:             Number(r.weighted_30 ?? 0),
    weighted60:             Number(r.weighted_60 ?? 0),
    weighted90:             Number(r.weighted_90 ?? 0),
    raw30:                  Number(r.raw_30 ?? 0),
    raw60:                  Number(r.raw_60 ?? 0),
    raw90:                  Number(r.raw_90 ?? 0),
    sphereReferralExpected: Number(r.sphere_referral_expected ?? 0),
    totalForecast90:        Number(r.weighted_90 ?? 0) + Number(r.sphere_referral_expected ?? 0),
    lowBandPct:             Number(r.low_band_pct ?? 25),
    highBandPct:            Number(r.high_band_pct ?? 15),
    dealCount:              Number(r.deal_count ?? 0),
    activeListingCount:     Number(r.active_listing_count ?? 0),
    byStage:                r.by_stage ?? [],
    weighted90Delta:        r.weighted_90_delta != null ? Number(r.weighted_90_delta) : null,
  }
  return { success: true, data: result }
}

// ─── On-demand rescan ─────────────────────────────────────────────────────

export async function rescanLifetimeNpvForecastAction(params: {
  brokerageId: string
  agentId?:    string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid brokerage id" }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const secret = process.env.CRON_SECRET
  if (!secret) return { success: false, error: "CRON_SECRET not configured" }
  const base = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL
  const url = base
    ? `${base.startsWith("http") ? base : `https://${base}`}/api/cron/lifetime-npv-forecast-rollup`
    : "/api/cron/lifetime-npv-forecast-rollup"

  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body:    JSON.stringify({
        brokerage_id: params.brokerageId,
        agent_id:     params.agentId ?? null,
      }),
      cache: "no-store",
    })
    const data = await r.json().catch(() => null)
    if (!r.ok) return { success: false, error: data?.error ?? `Rescan returned ${r.status}` }
    revalidatePath("/dashboard/agent")
    revalidatePath("/lifetime-customers")
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Rescan failed" }
  }
}
