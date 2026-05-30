"use server"

/**
 * Wealth Opportunity — agent-facing read + action surface.
 *
 * Reads:   wealth_advisor_recommendations (filled daily by the
 *          wealth-opportunity-scan cron). Agent sees opportunities still
 *          actionable: status='new', not expired.
 * Writes:  status transitions (mark-acted, dismiss, push-to-portal).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export type OpportunityType =
  | "refinance_opportunity"
  | "cash_out_refi"
  | "heloc_for_investment"
  | "sell_and_1031_exchange"
  | "downsize_and_bank_equity"
  | "equity_milestone"

export interface WealthRow {
  id:                       string
  contactId:                string
  contactName:              string
  contactEmail:             string | null
  contactPhone:             string | null
  opportunityType:          OpportunityType | string
  currentAvmValue:          number | null
  estimatedEquity:          number | null
  equityPct:                number | null
  currentMarketRateBps:     number | null
  estimatedLockedRateBps:   number | null
  rateGapBps:               number | null
  monthlySavingsEstimate:   number | null
  oneTimeProceedsEstimate:  number | null
  aiNarrative:              string | null
  scenarios:                Record<string, unknown> | null
  signalsSupporting:        Record<string, unknown> | null
  status:                   string
  pushedToPortalAt:         string | null
  expiresAt:                string | null
  createdAt:                string
}

export interface WealthLoad {
  byType: Record<string, WealthRow[]>
  total:  number
  acted:  WealthRow[]
}

function rowToView(row: any): WealthRow {
  const contact = row.contact ?? {}
  return {
    id:                       row.id,
    contactId:                row.contact_id,
    contactName:              `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Contact",
    contactEmail:             contact.email ?? null,
    contactPhone:             contact.phone ?? null,
    opportunityType:          row.opportunity_type,
    currentAvmValue:          row.current_avm_value ?? null,
    estimatedEquity:          row.estimated_equity ?? null,
    equityPct:                row.equity_pct ?? null,
    currentMarketRateBps:     row.current_market_rate_bps ?? null,
    estimatedLockedRateBps:   row.estimated_locked_rate_bps ?? null,
    rateGapBps:               row.rate_gap_bps ?? null,
    monthlySavingsEstimate:   row.monthly_savings_estimate ?? null,
    oneTimeProceedsEstimate:  row.one_time_proceeds_estimate ?? null,
    aiNarrative:              row.ai_narrative ?? null,
    scenarios:                row.scenarios ?? null,
    signalsSupporting:        row.signals_supporting ?? null,
    status:                   row.status,
    pushedToPortalAt:         row.pushed_to_portal_at ?? null,
    expiresAt:                row.expires_at ?? null,
    createdAt:                row.created_at,
  }
}

export async function loadWealthOpportunities(): Promise<{ data: WealthLoad } | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { error: "No agent profile" }

  const nowIso = new Date().toISOString()
  // Active (not expired, not dismissed). Acted/sent stay for history.
  const { data: rows } = await svc
    .from("wealth_advisor_recommendations")
    .select(`
      id, contact_id, opportunity_type, current_avm_value, estimated_equity, equity_pct,
      current_market_rate_bps, estimated_locked_rate_bps, rate_gap_bps,
      monthly_savings_estimate, one_time_proceeds_estimate,
      ai_narrative, scenarios, signals_supporting, status,
      pushed_to_portal_at, expires_at, created_at,
      contact:contact_id (first_name, last_name, email, phone)
    `)
    .eq("agent_id", agentRow.id)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order("estimated_equity", { ascending: false, nullsFirst: false })
    .limit(200)

  const byType: Record<string, WealthRow[]> = {}
  const acted: WealthRow[] = []
  for (const r of (rows ?? []) as any[]) {
    const v = rowToView(r)
    if (v.status === "new" || v.status === "active") {
      const bucket = (byType[v.opportunityType] ??= [])
      bucket.push(v)
    } else {
      acted.push(v)
    }
  }
  const total = Object.values(byType).reduce((sum, arr) => sum + arr.length, 0)
  return { data: { byType, total, acted } }
}

export async function markWealthActed(recId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { success: false, error: "No agent profile" }

  const { error } = await svc
    .from("wealth_advisor_recommendations")
    .update({ status: "acted", reviewed_by_user_id: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", recId)
    .eq("agent_id", agentRow.id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function dismissWealthOpportunity(recId: string, reason: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { success: false, error: "No agent profile" }

  const { error } = await svc
    .from("wealth_advisor_recommendations")
    .update({
      status:               "dismissed",
      dismissed_reason:     reason || "agent_dismissed",
      reviewed_by_user_id:  user.id,
      reviewed_at:          new Date().toISOString(),
    })
    .eq("id", recId)
    .eq("agent_id", agentRow.id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function pushWealthToPortal(recId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { success: false, error: "No agent profile" }

  const { error } = await svc
    .from("wealth_advisor_recommendations")
    .update({
      pushed_to_portal_at:  new Date().toISOString(),
      reviewed_by_user_id:  user.id,
      reviewed_at:          new Date().toISOString(),
    })
    .eq("id", recId)
    .eq("agent_id", agentRow.id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}
