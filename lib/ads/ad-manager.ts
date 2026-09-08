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

// ── Launch proposer — approved-but-unlaunched campaigns get a launch proposal ─

export interface ProposeLaunchesResult { candidates: number; proposed: number }

/**
 * THE LAUNCH HALF OF THE LOOP. `executeAdManagerAction` could launch a campaign
 * for a year, but nothing PROPOSED launches except two manager signals
 * (content_winner / video_ready), so a campaign an agent had approved with an
 * approved creative sat until someone found the button. Now, per sweep:
 *   • Meta/Google: status 'approved' + ≥1 approved creative + ad account
 *     connected → propose launch_ad_campaign.
 *   • Streaming TV: a vibe_ctv 'draft' with a creative video + the brokerage's
 *     Vibe credential connected → propose launch_ad_campaign.
 *   • ChatGPT: never proposed for API launch (no API) — the lane surfaces the
 *     package in its own UI instead.
 * Idempotent: one open launch action per campaign. Money still moves only after
 * a human approves the action and the spend cap clears at execution.
 */
export async function proposeAdLaunches(
  brokerageId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<ProposeLaunchesResult> {
  const supabase = client ?? createServiceClient()
  const { data, error } = await supabase
    .from("ad_campaigns")
    .select("id, platform, status, daily_budget, targeting_config, campaign_name")
    .eq("brokerage_id", brokerageId)
    .in("status", ["approved", "draft"])
  if (error) {
    console.error("[ad-manager] launch-candidate read refused:", error.message)
    return { candidates: 0, proposed: 0 }
  }
  // A draft is a launch candidate ONLY on the streaming-TV lane (its approval
  // is the action itself); every other platform must be 'approved' first.
  const rows = ((data ?? []) as Array<{ id: string; platform: string; status: string; daily_budget: number | null; targeting_config: Record<string, unknown> | null; campaign_name: string | null }>)
    .filter((c) => c.status === "approved" || ((c.platform === "vibe_ctv" || c.platform === "chatgpt") && c.status === "draft"))
  if (rows.length === 0) return { candidates: 0, proposed: 0 }

  let vibeConnected: boolean | null = null
  let proposed = 0
  for (const c of rows) {
    if (Number(c.daily_budget ?? 0) <= 0) continue
    let ready = false
    let why = ""
    if (c.platform === "chatgpt") {
      // A ChatGPT draft launches through the OpenAI Advertiser API once its
      // copy is approved in the one queue and the Ads API key is connected.
      const { count } = await supabase.from("ad_creative_variations").select("id", { count: "exact", head: true })
        .eq("ad_campaign_id", c.id).eq("approval_status", "approved")
      if ((count ?? 0) === 0) continue
      const { isAdPlatformConnected } = await import("@/lib/ads/connection-status")
      ready = (await isAdPlatformConnected(brokerageId, "chatgpt", supabase)).connected
      why = `ChatGPT campaign "${c.campaign_name ?? c.id}" has approved copy and the OpenAI Ads key is connected — launch it at $${Number(c.daily_budget).toFixed(0)}/day.`
    } else if (c.platform === "vibe_ctv") {
      if (!c.targeting_config?.creative_video_url) continue
      if (vibeConnected === null) {
        const { isVibeConfigured } = await import("@/lib/providers/vibe")
        vibeConnected = await isVibeConfigured(brokerageId)
      }
      ready = vibeConnected === true
      why = `Streaming-TV spot "${c.campaign_name ?? c.id}" is staged with a TV-ready video and the Vibe account is connected — launch it at $${Number(c.daily_budget).toFixed(0)}/day.`
    } else {
      const { count } = await supabase.from("ad_creative_variations").select("id", { count: "exact", head: true })
        .eq("ad_campaign_id", c.id).eq("approval_status", "approved")
      if ((count ?? 0) === 0) continue
      const { isAdPlatformConnected } = await import("@/lib/ads/connection-status")
      ready = (await isAdPlatformConnected(brokerageId, c.platform, supabase)).connected
      why = `"${c.campaign_name ?? c.id}" is approved with an approved creative and the ${c.platform} ad account is connected — launch it at $${Number(c.daily_budget).toFixed(0)}/day.`
    }
    if (!ready) continue
    const { data: existing } = await supabase
      .from("ad_manager_actions").select("id")
      .eq("brokerage_id", brokerageId).eq("action_type", "launch_ad_campaign")
      .contains("action_input", { campaign_id: c.id })
      .in("status", ["proposed", "approved", "executing"])
      .maybeSingle()
    if (existing) continue
    const { error: insErr } = await supabase.from("ad_manager_actions").insert({
      brokerage_id: brokerageId, action_type: "launch_ad_campaign",
      action_input: { campaign_id: c.id, platform: c.platform, source: "launch_sweep" },
      rationale: why, status: "proposed", proposed_at: new Date().toISOString(),
    })
    if (!insErr) proposed++
  }
  return { candidates: rows.length, proposed }
}

// ── Executor — runs an approved action under the hard spend cap ─────────────

export interface AdActionResult { status: "succeeded" | "failed" | "skipped"; result: Record<string, unknown> }

/** Execute an approved ad action. Claims the row (stamps approved_by), runs the
 *  handler under the spend cap, records the outcome. Never self-fires.
 *
 *  `executed_at` is stamped on COMPLETION, not on claim — it used to be set in
 *  the same update as `status: "executing"`, which made stuck-ad-action-reaper's
 *  whole reason for existing unreachable: the reaper looks for status IN
 *  (approved, executing) AND executed_at IS NULL to catch a launch that crashed
 *  mid-handler, but a row could never be "executing" with executed_at null — the
 *  two were always written together. The guard could not see the failure it was
 *  built to catch (CLAUDE.md §2 — a guard that cannot see the code it judges is
 *  worse than no guard). Moving the stamp to the final update below makes
 *  "executing, executed_at still null" the real, catchable signature of a crash
 *  between claim and completion. */
export async function executeAdManagerAction(actionId: string, approverUserId: string): Promise<AdActionResult> {
  const svc = createServiceClient()
  const { data: claimed } = await svc.from("ad_manager_actions")
    .update({ status: "executing", approved_at: new Date().toISOString(), approved_by: approverUserId })
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
  await svc.from("ad_manager_actions").update({ status: outcome.status, result: outcome.result, executed_at: new Date().toISOString() }).eq("id", actionId)
  return outcome
}

async function runAdHandler(
  action: string, brokerageId: string, input: Record<string, unknown>, svc: ReturnType<typeof createServiceClient>,
): Promise<AdActionResult> {
  let campaignId = String(input.campaign_id ?? "")
  // A `video_ready` proposal (lib/kernel/manager-signals.ts ads_manager:video_ready)
  // carries a video_project_id and NO campaign — it used to fail here with
  // "campaign_id required" every time, so the Asset Manager → Ads Manager
  // handoff was a writer with no reader. The approved proposal now STAGES the
  // streaming-TV draft from that render (geo from the listing, autonomous
  // budget) and launches it below like any other vibe_ctv campaign.
  if (!campaignId && action === "launch_ad_campaign" && input.video_project_id) {
    const { stageCtvCampaignForVideo } = await import("@/lib/ads/ctv-campaign")
    const staged = await stageCtvCampaignForVideo({ brokerageId, videoProjectId: String(input.video_project_id), client: svc })
    if (!staged.ok || !staged.campaignId) return { status: "failed", result: { error: `could not stage a TV campaign from the video: ${staged.reason}` } }
    campaignId = staged.campaignId
    // Record the staged campaign on the action so the ledger names it.
    input.campaign_id = campaignId
  }
  // A `content_winner` proposal (ads_manager:content_winner) carries the winning
  // post and no campaign either — it failed the same way. On approval it STAGES
  // the paid campaign from the post (lib/ads/promote-post.ts): compliance-first
  // creative in the one approval queue, then the ordinary Meta launch gates.
  if (!campaignId && action === "launch_ad_campaign" && input.post_id) {
    const { stageCampaignFromSocialPost } = await import("@/lib/ads/promote-post")
    const staged = await stageCampaignFromSocialPost({ brokerageId, postId: String(input.post_id), client: svc })
    if (!staged.ok || !staged.campaignId) return { status: "failed", result: { error: `could not stage a paid campaign from the post: ${staged.reason}` } }
    campaignId = staged.campaignId
    input.campaign_id = campaignId
    if (!staged.alreadyStaged) {
      // The creative is a DRAFT until a human approves the words; say so
      // rather than fall through to "campaign is draft, must be approved".
      return { status: "skipped", result: { campaign_id: campaignId, creative_id: staged.creativeId, reason: "paid campaign staged from the winning post — approve the creative in the ad approval queue, then approve the campaign to launch" } }
    }
  }
  if (!campaignId) return { status: "failed", result: { error: "campaign_id required" } }
  const { data: c } = await svc.from("ad_campaigns").select("id, brokerage_id, status, daily_budget, platform, targeting_config").eq("id", campaignId).maybeSingle()
  const campaign = c as { id: string; brokerage_id: string; status: string; daily_budget: number | null; platform: string; targeting_config: Record<string, unknown> | null } | null
  if (!campaign) return { status: "failed", result: { error: "campaign not found" } }
  if (campaign.brokerage_id !== brokerageId) return { status: "failed", result: { error: "campaign outside brokerage" } }
  const currentDaily = Number(campaign.daily_budget ?? 0)

  switch (action) {
    case "launch_ad_campaign": {
      // ── Streaming TV (Vibe.co) ──────────────────────────────────────────
      // The creative is the rendered video on the staged row, not an
      // ad_creative_variations row; the connection is the Connection OS's
      // 'vibe' credential, not platform_credentials; and the publish is the
      // real Vibe chain. The human gate is the approval of THIS action.
      if (campaign.platform === "vibe_ctv") {
        if (!["draft", "approved"].includes(campaign.status)) return { status: "skipped", result: { reason: `campaign is ${campaign.status}, nothing to launch` } }
        if (currentDaily > MAX_AD_DAILY_BUDGET_USD) return { status: "failed", result: { error: `daily budget $${currentDaily} exceeds cap $${MAX_AD_DAILY_BUDGET_USD}` } }
        const { launchCtvCampaignOnVibe } = await import("@/lib/ads/ctv-campaign")
        const r = await launchCtvCampaignOnVibe({ campaignId, brokerageId, actorUserId: null, launchedVia: "ads_manager", client: svc })
        if (!r.dispatched) {
          // not connected / unreadable / Vibe refused: the row stays draft and
          // the manual vibe.co + Mark-as-launched path remains. Honest skip.
          return { status: "skipped", result: { campaign_id: campaignId, reason: r.reason } }
        }
        return { status: "succeeded", result: { campaign_id: campaignId, status: "live", external_campaign_id: r.vibeCampaignId, launched_via: "ads_manager" } }
      }
      // ── ChatGPT Ads (OpenAI Advertiser API) ─────────────────────────────
      // The copy is the APPROVED creative in the one queue; the connection is
      // the Ads API key (provider 'openai_ads'); the publish is the real chain
      // (geo lookup → upload → campaign → ad group → ad → activate). The human
      // gate is the approval of THIS action. Not connected → honest skip; the
      // staged package + ads.openai.com by hand remains.
      if (campaign.platform === "chatgpt") {
        if (!["draft", "approved"].includes(campaign.status)) return { status: "skipped", result: { reason: `campaign is ${campaign.status}, nothing to launch` } }
        if (currentDaily > MAX_AD_DAILY_BUDGET_USD) return { status: "failed", result: { error: `daily budget $${currentDaily} exceeds cap $${MAX_AD_DAILY_BUDGET_USD}` } }
        const { launchChatgptCampaignOnOpenai } = await import("@/lib/ads/chatgpt-campaign")
        const r = await launchChatgptCampaignOnOpenai({ campaignId, brokerageId, actorUserId: null, launchedVia: "ads_manager", client: svc })
        if (!r.dispatched) return { status: "skipped", result: { campaign_id: campaignId, reason: r.reason } }
        return { status: "succeeded", result: { campaign_id: campaignId, status: "live", external_campaign_id: r.openaiCampaignId, review_status: r.reviewStatus ?? null, launched_via: "ads_manager" } }
      }
      if (campaign.status !== "approved") return { status: "skipped", result: { reason: `campaign is ${campaign.status}, must be approved` } }
      // Must have at least one APPROVED creative before any spend.
      const { count } = await svc.from("ad_creative_variations").select("id", { count: "exact", head: true })
        .eq("ad_campaign_id", campaignId).eq("approval_status", "approved")
      if ((count ?? 0) === 0) return { status: "skipped", result: { reason: "no approved creative — cannot launch" } }
      // Provider connection required before spend (business rule #9): no fake launch
      // on a platform with no connected ad account.
      const { isAdPlatformConnected } = await import("@/lib/ads/connection-status")
      const conn = await isAdPlatformConnected(brokerageId, campaign.platform, svc)
      if (!conn.connected) return { status: "skipped", result: { reason: conn.reason ?? "ad platform not connected" } }
      // Hard cap: never launch a campaign whose daily budget exceeds the ceiling.
      if (currentDaily > MAX_AD_DAILY_BUDGET_USD) return { status: "failed", result: { error: `daily budget $${currentDaily} exceeds cap $${MAX_AD_DAILY_BUDGET_USD}` } }
      // Assemble the EXACT provider payload + validate every required param and the
      // Fair Housing rules BEFORE anything reaches the platform. Missing params or a
      // Housing violation blocks the launch with the specific reason.
      const { assembleAdFromCampaign } = await import("@/lib/ads/launch-assembler")
      const { validateAdReadiness, assembleAd } = await import("@/lib/ads/connectors/ad-payload")
      const asm = await assembleAdFromCampaign(campaignId, svc)
      if (!asm.ok || !asm.input) return { status: "skipped", result: { reason: asm.error ?? "could not assemble ad" } }
      const readiness = validateAdReadiness(asm.input)
      if (!readiness.ready) return { status: "skipped", result: { reason: "ad not ready to publish", missing: readiness.missing, violations: readiness.violations } }
      // Store the assembled provider structure; flip to 'launching'. The publisher
      // (ad-publish, async) makes the real Meta/Google create calls and flips to live.
      const assembled = assembleAd(asm.input)
      await svc.from("ad_campaigns").update({ status: "launching", targeting_config: { ...(campaign.targeting_config ?? {}), assembled_ad: assembled.meta ?? assembled.google } }).eq("id", campaignId)
      await svc.from("lifecycle_events").insert({ brokerage_id: brokerageId, entity_type: "ad_campaign", entity_id: campaignId, event_type: "ad_campaign_launched", actor_user_id: null, metadata: { via: "ads_manager" } })
      return { status: "succeeded", result: { campaign_id: campaignId, status: "launching", validated: true } }
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
