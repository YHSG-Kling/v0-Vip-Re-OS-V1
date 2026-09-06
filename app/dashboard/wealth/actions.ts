"use server"

/**
 * Wealth Opportunity — agent-facing read + action surface.
 *
 * Reads:   wealth_advisor_recommendations (filled daily by the
 *          wealth-opportunity-scan cron). Agent sees opportunities still
 *          actionable — open | presented | reviewed — and not expired.
 * Writes:  status transitions (mark-acted, dismiss, push-to-portal).
 *
 * The active set used to be status === 'new' || 'active'. Neither value is in
 * the column's CHECK vocabulary and the scan inserts no status at all, so every
 * row arrived as the column default 'open' and fell straight through to the
 * "already acted on" list — the by-type grid this page is built around never
 * rendered a single card. The vocabulary now lives in one place:
 * lib/wealth-advisor/recommendation-status.ts.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  WEALTH_ACTIVE_STATUSES,
  WEALTH_STATUS_CONVERTED,
  WEALTH_STATUS_DISMISSED,
  WEALTH_STATUS_PRESENTED,
  isWealthActive,
} from "@/lib/wealth-advisor/recommendation-status"

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
  /**
   * WHO CLOSED THIS OUT, WHEN, AND (on a dismissal) WHY.
   *
   * markWealthActed, dismissWealthOpportunity and pushWealthToPortal all stamp
   * reviewed_by_user_id + reviewed_at, and the dismissal also writes
   * dismissed_reason — and the loader selected none of the three, so the
   * "Recent history" strip could say an equity opportunity worth six figures to
   * a client had been dismissed without saying by whom or on what grounds. On a
   * shared book that is the difference between a decision and a disappearance.
   */
  reviewedAt:               string | null
  reviewedByName:           string | null
  dismissedReason:          string | null
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
    reviewedAt:               row.reviewed_at ?? null,
    // Resolved by the caller (loadWealthOpportunities) — rowToView is pure over
    // one row and has no client to look a name up with.
    reviewedByName:           row.__reviewed_by_name ?? null,
    dismissedReason:          row.dismissed_reason ?? null,
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
      reviewed_at, reviewed_by_user_id, dismissed_reason,
      contact:contact_id (first_name, last_name, email, phone)
    `)
    .eq("agent_id", agentRow.id)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order("estimated_equity", { ascending: false, nullsFirst: false })
    .limit(200)

  // reviewed_by_user_id is a users.id (written straight from auth.getUser()),
  // NOT an agents.id — the two are disjoint (CLAUDE.md §3). A failed lookup
  // leaves the name null and the history row still renders.
  const reviewerIds = [...new Set(((rows ?? []) as any[]).map((r) => r.reviewed_by_user_id).filter(Boolean) as string[])]
  const reviewerNameById = new Map<string, string>()
  if (reviewerIds.length > 0) {
    const { data: reviewers, error: reviewerErr } = await svc
      .from("users")
      .select("id, first_name, last_name, email")
      .in("id", reviewerIds)
    if (reviewerErr) console.error("[wealth] reviewer name lookup failed:", reviewerErr.message)
    for (const u of (reviewers ?? []) as any[]) {
      const label = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email
      if (label) reviewerNameById.set(u.id as string, label as string)
    }
  }

  const byType: Record<string, WealthRow[]> = {}
  const acted: WealthRow[] = []
  for (const r of (rows ?? []) as any[]) {
    const v = rowToView({
      ...r,
      __reviewed_by_name: r.reviewed_by_user_id ? reviewerNameById.get(r.reviewed_by_user_id) ?? null : null,
    })
    if (isWealthActive(v.status)) {
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
    .update({ status: WEALTH_STATUS_CONVERTED, reviewed_by_user_id: user.id, reviewed_at: new Date().toISOString() })
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
      status:               WEALTH_STATUS_DISMISSED,
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
      // Pushing to the client portal IS the 'presented' transition. Only the
      // timestamp used to move, so a pushed opportunity stayed indistinguishable
      // from an untouched one everywhere except this one column.
      status:               WEALTH_STATUS_PRESENTED,
      pushed_to_portal_at:  new Date().toISOString(),
      reviewed_by_user_id:  user.id,
      reviewed_at:          new Date().toISOString(),
    })
    .eq("id", recId)
    .eq("agent_id", agentRow.id)
    // Never resurrect a converted/dismissed/stale row back into the active list.
    .in("status", [...WEALTH_ACTIVE_STATUSES])
  if (error) return { success: false, error: error.message }
  return { success: true }
}
