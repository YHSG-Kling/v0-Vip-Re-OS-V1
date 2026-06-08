/**
 * lib/ads/ad-manager.ts
 *
 * Wave 41 — the ADS MANAGER. A distinct manager that watches paid-ad performance
 * and PROPOSES spend actions (launch / pause / shift budget / scale a winning
 * creative) into the Command Center. Money moves only after a human approves AND
 * a hard, server-enforced spend cap clears.
 *
 * Three release-blocking controls (ai-compliance eval skill — autonomous money
 * movement):
 *   1. SCOPE: zero autonomous spend. Every spend action is proposed → a human
 *      stamps approved_by → executeAdManagerAction runs it. Nothing self-fires.
 *   2. HARD CAP: the agent can never set a daily budget above MAX_AD_DAILY_BUDGET
 *      or scale beyond MAX_SCALE_MULTIPLE — enforced at EXECUTION, not just in the
 *      proposal, so an approved-but-oversized action is still clamped/refused.
 *   3. REWARD ALIGNMENT: scale/pause decisions key ONLY on real outcomes
 *      (cost_per_lead, leads) — NEVER vanity metrics (impressions, ctr). The pure
 *      evaluator encodes this so it is auditable + unit-tested.
 */
import { createServiceClient } from "@/lib/supabase/service"

// ── Hard guardrails (server-enforced) ───────────────────────────────────────
export const MAX_AD_DAILY_BUDGET_USD = 500     // an action may never set a daily budget above this
export const MAX_SCALE_MULTIPLE      = 2        // a single scale action may at most double the budget

// ── Reward-aligned performance thresholds (REAL outcomes only) ──────────────
export const SCALE_MIN_LEADS   = 3              // a "winner" needs real lead volume…
export const SCALE_MAX_CPL_USD = 50            // …at or below this cost-per-lead
export const PAUSE_MIN_SPEND_USD = 100         // only judge a "loser" after meaningful spend…
export const PAUSE_BAD_CPL_USD   = 200         // …and either no leads or CPL at/above this

export interface CampaignPerf {
  campaignId:   string
  dailyBudget:  number
  spend:        number
  leads:        number
  costPerLead:  number | null   // null when leads === 0
  impressions:  number          // present but DELIBERATELY ignored for decisions
}

export type AdVerdict = "scale" | "pause" | "hold"
export interface AdDecision { campaignId: string; verdict: AdVerdict; reason: string; suggestedDailyBudget?: number }

/**
 * Pure: judge each live campaign by REAL outcomes only. Winners (enough leads at
 * a good cost-per-lead) → propose a bounded scale; losers (real spend with no
 * leads, or a bad cost-per-lead) → propose pause; everything else holds. Vanity
 * metrics (impressions/ctr) never drive a verdict.
 */
export function evaluateAdPerformance(rows: CampaignPerf[]): AdDecision[] {
  return rows.map((r) => {
    const isWinner = r.leads >= SCALE_MIN_LEADS && r.costPerLead != null && r.costPerLead > 0 && r.costPerLead <= SCALE_MAX_CPL_USD
    const isLoser  = r.spend >= PAUSE_MIN_SPEND_USD && (r.leads === 0 || (r.costPerLead != null && r.costPerLead >= PAUSE_BAD_CPL_USD))
    if (isWinner) {
      const suggested = clampDailyBudget(Math.round(r.dailyBudget * MAX_SCALE_MULTIPLE), r.dailyBudget)
      return { campaignId: r.campaignId, verdict: "scale", reason: `${r.leads} leads at $${r.costPerLead?.toFixed(0)}/lead — scale budget to $${suggested}/day.`, suggestedDailyBudget: suggested }
    }
    if (isLoser) {
      const why = r.leads === 0 ? `$${r.spend.toFixed(0)} spent, 0 leads` : `cost-per-lead $${r.costPerLead?.toFixed(0)} ≥ $${PAUSE_BAD_CPL_USD}`
      return { campaignId: r.campaignId, verdict: "pause", reason: `${why} — pause to stop the bleed.` }
    }
    return { campaignId: r.campaignId, verdict: "hold", reason: "performance within range — no change." }
  })
}

/** Clamp a proposed daily budget to the hard cap and the per-action scale limit. */
export function clampDailyBudget(proposed: number, currentDaily: number): number {
  const scaleCap = Math.max(currentDaily, 0) * MAX_SCALE_MULTIPLE || MAX_AD_DAILY_BUDGET_USD
  return Math.max(1, Math.min(proposed, scaleCap, MAX_AD_DAILY_BUDGET_USD))
}

// ── Proposer — reads performance, proposes into the Command Center ──────────

export interface ProposeAdsResult { scanned: number; proposed: number }

/**
 * For a brokerage's LIVE campaigns, roll up the latest performance and propose
 * scale/pause actions (idempotent — one open action per campaign per type).
 * Pure verdict logic + a thin DB layer. Best-effort per campaign.
 */
export async function proposeAdOptimizations(
  brokerageId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<ProposeAdsResult> {
  const supabase = client ?? createServiceClient()

  const { data: campaigns } = await supabase
    .from("ad_campaigns")
    .select("id, campaign_name, daily_budget, status")
    .eq("brokerage_id", brokerageId)
    .in("status", ["live", "launching"])
  const live = (campaigns ?? []) as Array<{ id: string; campaign_name: string | null; daily_budget: number | null; status: string }>
  if (live.length === 0) return { scanned: 0, proposed: 0 }

  const perfs: CampaignPerf[] = []
  for (const c of live) {
    // Latest performance snapshot for the campaign.
    const { data: perf } = await supabase
      .from("ad_performance")
      .select("spend, impressions, leads, cost_per_lead, captured_at")
      .eq("ad_campaign_id", c.id)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    const p = perf as { spend?: number; impressions?: number; leads?: number; cost_per_lead?: number | null } | null
    if (!p) continue
    perfs.push({
      campaignId: c.id, dailyBudget: Number(c.daily_budget ?? 0), spend: Number(p.spend ?? 0),
      leads: Number(p.leads ?? 0), costPerLead: p.cost_per_lead == null ? null : Number(p.cost_per_lead),
      impressions: Number(p.impressions ?? 0),
    })
  }

  const decisions = evaluateAdPerformance(perfs)
  let proposed = 0
  for (const d of decisions) {
    if (d.verdict === "hold") continue
    const actionType = d.verdict === "scale" ? "scale_ad_creative" : "pause_ad_campaign"
    // Idempotent — skip if an open action of this type already exists for the campaign.
    const { data: existing } = await supabase
      .from("ad_manager_actions")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("action_type", actionType)
      .contains("action_input", { campaign_id: d.campaignId })
      .in("status", ["proposed", "approved", "executing"])
      .maybeSingle()
    if (existing) continue
    const input: Record<string, unknown> = { campaign_id: d.campaignId }
    if (d.verdict === "scale" && d.suggestedDailyBudget) input.new_daily_budget = d.suggestedDailyBudget
    const { error } = await supabase.from("ad_manager_actions").insert({
      brokerage_id: brokerageId, action_type: actionType, action_input: input,
      rationale: d.reason, status: "proposed",
    })
    if (!error) proposed++
  }
  return { scanned: perfs.length, proposed }
}

// ── Executor — runs an approved action under the hard spend cap ─────────────

export interface AdActionResult { status: "succeeded" | "failed" | "skipped"; result: Record<string, unknown> }

/** Execute an approved ad action. Claims the row (stamps approved_by), runs the
 *  handler under the spend cap, records the outcome. Never self-fires. */
export async function executeAdManagerAction(actionId: string, approverUserId: string): Promise<AdActionResult> {
  const svc = createServiceClient()
  const { data: claimed } = await svc.from("ad_manager_actions")
    .update({ status: "executing", approved_at: new Date().toISOString(), approved_by: approverUserId, executed_at: new Date().toISOString() })
    .eq("id", actionId)
    .in("status", ["proposed", "approved"])
    .select("brokerage_id, action_type, action_input")
    .single()
  if (!claimed) return { status: "skipped", result: { reason: "not in proposed/approved state" } }
  const row = claimed as { brokerage_id: string; action_type: string; action_input: Record<string, unknown> }

  let outcome: AdActionResult
  try {
    outcome = await runAdHandler(row.action_type, row.brokerage_id, row.action_input, svc)
  } catch (e) {
    outcome = { status: "failed", result: { error: (e as Error).message } }
  }
  await svc.from("ad_manager_actions").update({ status: outcome.status, result: outcome.result }).eq("id", actionId)
  return outcome
}

async function runAdHandler(
  action: string, brokerageId: string, input: Record<string, unknown>, svc: ReturnType<typeof createServiceClient>,
): Promise<AdActionResult> {
  const campaignId = String(input.campaign_id ?? "")
  if (!campaignId) return { status: "failed", result: { error: "campaign_id required" } }
  const { data: c } = await svc.from("ad_campaigns").select("id, brokerage_id, status, daily_budget").eq("id", campaignId).maybeSingle()
  const campaign = c as { id: string; brokerage_id: string; status: string; daily_budget: number | null } | null
  if (!campaign) return { status: "failed", result: { error: "campaign not found" } }
  if (campaign.brokerage_id !== brokerageId) return { status: "failed", result: { error: "campaign outside brokerage" } }
  const currentDaily = Number(campaign.daily_budget ?? 0)

  switch (action) {
    case "launch_ad_campaign": {
      if (campaign.status !== "approved") return { status: "skipped", result: { reason: `campaign is ${campaign.status}, must be approved` } }
      // Must have at least one APPROVED creative before any spend.
      const { count } = await svc.from("ad_creative_variations").select("id", { count: "exact", head: true })
        .eq("ad_campaign_id", campaignId).eq("approval_status", "approved")
      if ((count ?? 0) === 0) return { status: "skipped", result: { reason: "no approved creative — cannot launch" } }
      // Hard cap: never launch a campaign whose daily budget exceeds the ceiling.
      if (currentDaily > MAX_AD_DAILY_BUDGET_USD) return { status: "failed", result: { error: `daily budget $${currentDaily} exceeds cap $${MAX_AD_DAILY_BUDGET_USD}` } }
      await svc.from("ad_campaigns").update({ status: "launching" }).eq("id", campaignId)
      await svc.from("lifecycle_events").insert({ brokerage_id: brokerageId, entity_type: "ad_campaign", entity_id: campaignId, event_type: "ad_campaign_launched", actor_user_id: null, metadata: { via: "ads_manager" } })
      return { status: "succeeded", result: { campaign_id: campaignId, status: "launching" } }
    }
    case "pause_ad_campaign": {
      if (!["live", "launching"].includes(campaign.status)) return { status: "skipped", result: { reason: `campaign is ${campaign.status}, nothing to pause` } }
      await svc.from("ad_campaigns").update({ status: "paused" }).eq("id", campaignId)
      return { status: "succeeded", result: { campaign_id: campaignId, status: "paused" } }
    }
    case "shift_ad_budget":
    case "scale_ad_creative": {
      const requested = Number(input.new_daily_budget ?? 0)
      if (!(requested > 0)) return { status: "failed", result: { error: "new_daily_budget required" } }
      // HARD CAP enforced at execution — clamp to the ceiling + scale limit even if
      // the proposal (or an edited approval) asked for more.
      const applied = clampDailyBudget(requested, currentDaily)
      await svc.from("ad_campaigns").update({ daily_budget: applied }).eq("id", campaignId)
      return { status: "succeeded", result: { campaign_id: campaignId, requested_daily_budget: requested, applied_daily_budget: applied, capped: applied < requested } }
    }
    default:
      return { status: "failed", result: { error: "unknown ad action_type" } }
  }
}
