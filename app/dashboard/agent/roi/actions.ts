"use server"

/**
 * /dashboard/agent/roi — server actions.
 *
 * Aggregates every "AI did this for you" signal into a single dollar-and-
 * hour view per agent. Pulls from data we already capture:
 *
 *   marketing_attribution_credits  → direct revenue-attribution dollars
 *                                    (any closed transaction with a
 *                                    campaign-derived contact gets credit
 *                                    rows under multiple attribution models)
 *   transactions                   → estimated_commission for closed/under-
 *                                    contract deals owned by this agent
 *   ai_isa_activities              → AI ISA outcomes (appointments set,
 *                                    qualifications, handoffs accepted)
 *   lifetime_customer_touchpoints  → SOI / past-client nurture sends
 *   feature_usage_tracking         → per-feature usage counts so we can
 *                                    convert to time-saved minutes via
 *                                    the per-feature multiplier below
 *   ai_message_drafts              → accepted drafts (reply coach wins)
 *
 * Time-saved is the meaningful number. Per-feature multipliers come from
 * realistic time estimates for the equivalent manual work — not arbitrary
 * "X minutes per AI call" guesses.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

// Per-feature time-saved multipliers (minutes saved per usage event).
// Tuned to match the manual-work equivalent for each AI flow.
const TIME_SAVED_MINUTES_PER_USE: Record<string, number> = {
  ai_isa_appointment_set:        45,   // call coordination + qualification
  ai_isa_qualification:           10,
  ai_message_draft_accepted:       4,   // reply coach
  listing_presentation_generated: 180,  // CMA + presentation deck
  marketing_image_generated:      30,
  video_generation:               60,
  video_brand_overlay:            45,   // editor work saved
  email_campaign_sent:            45,
  social_post_drafted:            15,
  newsletter_generated:           90,
  deal_health_intervention:       20,
  sphere_touchpoint_sent:           5,
  document_scan_classified:        8,
  qr_code_minted:                  2,
}

// Default per-feature feature_key → multiplier resolver.
function timeSavedFor(featureKey: string, count: number): number {
  const perUse = TIME_SAVED_MINUTES_PER_USE[featureKey] ?? 5
  return count * perUse
}

export type RoiPeriod = "7d" | "30d" | "ytd"

// ── Attribution model comparison ─────────────────────────────────────────────
// The attribution engine (lib/marketing/attribution.ts) writes FOUR models per
// (campaign × transaction) on every close — first_touch / last_touch / linear /
// time_decay — plus the attribution_weight, touchpoint_count and the
// first→last touchpoint window each weight was derived from. Every reader on
// this page pinned `linear`, and credit_dollars rendered with no derivation —
// a §2 count-without-denominator on a money figure. This block is the
// denominator: the same campaign's credit under all four models side by side,
// with the touchpoint evidence that produced each weight.

export type AttributionModelKey = "first_touch" | "last_touch" | "linear" | "time_decay"

export interface AttributionModelCampaignRow {
  campaignId:        string
  campaignName:      string | null
  /** Distinct touchpoints in the window (summed per transaction; identical
   *  across models by construction, so counted once). */
  touchpointCount:   number
  firstTouchpointAt: string | null
  lastTouchpointAt:  string | null
  /** Credit in cents per model. A model with no row for this campaign is 0 by
   *  the engine's own math (e.g. first_touch gives non-earliest campaigns 0). */
  creditCentsByModel: Record<AttributionModelKey, number>
}

export type AttributionModelComparison =
  | { ok: true; rows: AttributionModelCampaignRow[]; campaignNameLookupError: string | null }
  | { ok: false; error: string }

export interface RoiSnapshot {
  // Headline numbers
  attributedRevenueCents: number
  estimatedTimeSavedMinutes: number
  estimatedTimeSavedDollars: number   // hours × agent burn rate
  totalValueDollars: number           // revenue + time-saved value

  // Breakdown for the per-feature cards
  byFeature: Array<{
    featureKey:           string
    label:                string
    revenueCents:         number
    timeSavedMinutes:     number
    eventCount:           number
  }>

  // 90-day pipeline forecast
  pipeline: {
    activeTransactions:        number
    pipelineCommissionCents:   number
    upcomingSphereTouchpoints: number
    isaAppointmentsBooked:     number
  }

  // Top wins to display in the timeline
  recentWins: Array<{
    happenedAt:  string
    headline:    string
    valueCents:  number | null
    featureKey:  string
  }>

  // Meta
  period:        RoiPeriod
  periodStart:   string
  periodEnd:     string
  agentName:     string | null

  /** Same-campaign credit under all four attribution models, with the
   *  touchpoint window/count behind each weight. Additive — the headline
   *  numbers above stay linear-pinned. A refused read arrives as { ok:false },
   *  never as an empty comparison. */
  modelComparison: AttributionModelComparison
}

/**
 * Estimate the agent's hourly value from their closed-deal average. Used to
 * convert time-saved minutes into a dollar figure. Falls back to a
 * conservative real-estate-agent industry benchmark when no closed deals.
 */
async function estimateAgentHourlyBurnCents(
  svc: ReturnType<typeof createServiceClient>,
  agentRowId: string
): Promise<number> {
  const { data: closed } = await svc
    .from("transactions")
    .select("estimated_commission, commission_amount")
    .eq("agent_id", agentRowId)
    .or("status.eq.closed,close_date.lte." + new Date().toISOString().slice(0, 10))
    .limit(20)
  const sumCents = (closed ?? []).reduce((acc, t: any) => {
    const cents = Math.round(((t.commission_amount ?? t.estimated_commission ?? 0) as number) * 100)
    return acc + cents
  }, 0)
  if (sumCents === 0 || !closed?.length) {
    // Industry benchmark — median residential agent ~$60/hour effective
    return 6000
  }
  const avgCommissionCents = sumCents / closed.length
  // Real estate norm: each closed deal ≈ 40 hours of active agent time
  return Math.round(avgCommissionCents / 40)
}

function periodBounds(period: RoiPeriod): { startISO: string; endISO: string } {
  const end = new Date()
  let start: Date
  if (period === "7d") {
    start = new Date(end.getTime() - 7 * 86_400_000)
  } else if (period === "30d") {
    start = new Date(end.getTime() - 30 * 86_400_000)
  } else {
    start = new Date(end.getFullYear(), 0, 1)
  }
  return { startISO: start.toISOString(), endISO: end.toISOString() }
}

export async function loadAgentRoiSnapshot(period: RoiPeriod = "7d"): Promise<RoiSnapshot | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  const svc = createServiceClient()

  // Resolve agent identity
  const [{ data: profile }, { data: agentRow }] = await Promise.all([
    svc.from("users").select("first_name, last_name, brokerage_id").eq("id", user.id).maybeSingle(),
    svc.from("agents").select("id").eq("user_id", user.id).maybeSingle(),
  ])
  if (!profile?.brokerage_id) return { error: "No brokerage on profile" }
  const agentRowId = agentRow?.id ?? null
  const { startISO, endISO } = periodBounds(period)

  // ── Attributed revenue (closed deals × attribution credits) ───────────────
  // marketing_attribution_credits stores credit_dollars per (campaign, txn,
  // attribution_model). We use 'linear' so even-split campaigns count once
  // each. Scope to transactions owned by this agent.
  let attributedRevenueCents = 0
  let modelComparison: AttributionModelComparison = { ok: true, rows: [], campaignNameLookupError: null }
  if (agentRowId) {
    const { data: agentTxns } = await svc
      .from("transactions")
      .select("id")
      .eq("agent_id", agentRowId)
    const txnIds = (agentTxns ?? []).map((t: { id: string }) => t.id)
    if (txnIds.length > 0) {
      const { data: credits } = await svc
        .from("marketing_attribution_credits")
        .select("credit_dollars, created_at")
        .in("transaction_id", txnIds)
        .eq("attribution_model", "linear")
        .gte("created_at", startISO)
      attributedRevenueCents = (credits ?? []).reduce(
        (acc: number, c: any) => acc + Math.round(((c.credit_dollars ?? 0) as number) * 100),
        0
      )

      // ── All four models, same tenant scope as the headline read above ─────
      // §3: this read destructures { error } and a refusal is returned AS a
      // refusal — the panel must never render "no attribution" over a refused
      // read of a money figure.
      const { data: allModelRows, error: allModelErr } = await svc
        .from("marketing_attribution_credits")
        .select("campaign_id, transaction_id, attribution_model, credit_dollars, attribution_weight, touchpoint_count, first_touchpoint_at, last_touchpoint_at, created_at")
        .in("transaction_id", txnIds)
        .gte("created_at", startISO)
      if (allModelErr) {
        modelComparison = { ok: false, error: allModelErr.message }
      } else {
        const MODELS: AttributionModelKey[] = ["first_touch", "last_touch", "linear", "time_decay"]
        const byCampaign = new Map<string, AttributionModelCampaignRow>()
        // touchpoint_count / window are written identically on all four model
        // rows of one (campaign × transaction) — count each transaction once.
        const countedTxn = new Set<string>()
        for (const r of (allModelRows ?? []) as any[]) {
          const model = r.attribution_model as AttributionModelKey
          if (!MODELS.includes(model)) continue
          let row = byCampaign.get(r.campaign_id)
          if (!row) {
            row = {
              campaignId: r.campaign_id,
              campaignName: null,
              touchpointCount: 0,
              firstTouchpointAt: null,
              lastTouchpointAt: null,
              creditCentsByModel: { first_touch: 0, last_touch: 0, linear: 0, time_decay: 0 },
            }
            byCampaign.set(r.campaign_id, row)
          }
          row.creditCentsByModel[model] += Math.round(((r.credit_dollars ?? 0) as number) * 100)
          const pairKey = `${r.campaign_id}:${r.transaction_id}`
          if (!countedTxn.has(pairKey)) {
            countedTxn.add(pairKey)
            row.touchpointCount += Number(r.touchpoint_count ?? 0)
          }
          if (r.first_touchpoint_at && (!row.firstTouchpointAt || r.first_touchpoint_at < row.firstTouchpointAt)) {
            row.firstTouchpointAt = r.first_touchpoint_at
          }
          if (r.last_touchpoint_at && (!row.lastTouchpointAt || r.last_touchpoint_at > row.lastTouchpointAt)) {
            row.lastTouchpointAt = r.last_touchpoint_at
          }
        }

        // Campaign names — a garnish read; its refusal is reported beside the
        // rows rather than blanking them or masquerading as "unnamed".
        let campaignNameLookupError: string | null = null
        const campaignIds = Array.from(byCampaign.keys())
        if (campaignIds.length > 0) {
          const { data: campaigns, error: campErr } = await svc
            .from("marketing_campaigns")
            .select("id, campaign_name")
            .in("id", campaignIds)
          if (campErr) {
            campaignNameLookupError = campErr.message
          } else {
            for (const c of (campaigns ?? []) as Array<{ id: string; campaign_name: string | null }>) {
              const row = byCampaign.get(c.id)
              if (row) row.campaignName = c.campaign_name ?? null
            }
          }
        }

        modelComparison = {
          ok: true,
          rows: Array.from(byCampaign.values()).sort(
            (a, b) => b.creditCentsByModel.linear - a.creditCentsByModel.linear,
          ),
          campaignNameLookupError,
        }
      }
    }
  }

  // ── Feature usage → time saved ──────────────────────────────────────────
  // feature_usage_tracking persists per-feature usage_count per period. We
  // pull rows whose period_end falls inside the window.
  const { data: usage } = await svc
    .from("feature_usage_tracking")
    .select("feature_key, usage_count, period_start, period_end")
    .eq("user_id", user.id)
    .gte("period_end", startISO)
  const usageByFeature: Map<string, number> = new Map()
  for (const u of (usage ?? []) as Array<{ feature_key: string; usage_count: number }>) {
    usageByFeature.set(u.feature_key, (usageByFeature.get(u.feature_key) ?? 0) + (u.usage_count ?? 0))
  }

  // ── ISA contributions (separate count for accepted appointments) ─────────
  let isaAppointmentsBooked = 0
  if (agentRowId) {
    const { data: isaRows } = await svc
      .from("ai_isa_activities")
      .select("id, activity_type, outcome, created_at")
      .gte("created_at", startISO)
      .ilike("outcome", "%appointment%")
    isaAppointmentsBooked = (isaRows ?? []).length
    if (isaAppointmentsBooked > 0) {
      usageByFeature.set("ai_isa_appointment_set", (usageByFeature.get("ai_isa_appointment_set") ?? 0) + isaAppointmentsBooked)
    }
  }

  // ── Accepted reply-coach drafts ─────────────────────────────────────────
  if (agentRowId) {
    const { data: accepted } = await svc
      .from("ai_message_drafts")
      .select("id")
      .eq("agent_user_id", user.id)
      .eq("status", "accepted")
      .gte("acted_at", startISO)
    const acceptedCount = accepted?.length ?? 0
    if (acceptedCount > 0) {
      usageByFeature.set("ai_message_draft_accepted", (usageByFeature.get("ai_message_draft_accepted") ?? 0) + acceptedCount)
    }
  }

  // ── Sphere of influence touchpoints ─────────────────────────────────────
  // lifetime_customer_touchpoints.scheduled_date is a date column (not
  // timestamptz) — compare against YYYY-MM-DD slices.
  let sphereTouchpoints = 0
  if (agentRowId) {
    const startDate = startISO.slice(0, 10)
    const endDate   = endISO.slice(0, 10)
    const { data: spheres } = await svc
      .from("lifetime_customer_touchpoints")
      .select("id, scheduled_date")
      .eq("agent_id", agentRowId)
      .gte("scheduled_date", startDate)
      .lte("scheduled_date", endDate)
    sphereTouchpoints = spheres?.length ?? 0
    if (sphereTouchpoints > 0) {
      usageByFeature.set("sphere_touchpoint_sent", (usageByFeature.get("sphere_touchpoint_sent") ?? 0) + sphereTouchpoints)
    }
  }

  // ── Hourly burn → dollarise the time saved ──────────────────────────────
  const hourlyBurnCents = agentRowId ? await estimateAgentHourlyBurnCents(svc, agentRowId) : 6000
  const totalMinutesSaved = Array.from(usageByFeature.entries()).reduce(
    (acc, [k, count]) => acc + timeSavedFor(k, count), 0
  )
  const estimatedTimeSavedDollars = Math.round((totalMinutesSaved / 60) * (hourlyBurnCents / 100))

  // Per-feature breakdown for cards
  const FEATURE_LABELS: Record<string, string> = {
    ai_isa_appointment_set:        "AI ISA appointments booked",
    ai_message_draft_accepted:     "AI reply coach drafts you accepted",
    listing_presentation_generated:"Listing presentations auto-prepped",
    marketing_image_generated:     "AI marketing images",
    video_generation:              "AI videos rendered",
    video_brand_overlay:           "Videos branded by ffmpeg (no editor)",
    email_campaign_sent:           "Email campaigns sent",
    social_post_drafted:           "Social posts auto-drafted",
    newsletter_generated:          "Newsletters generated",
    deal_health_intervention:      "Deal-at-risk interventions",
    sphere_touchpoint_sent:        "SOI / past-client touchpoints",
    document_scan_classified:      "Documents auto-classified by scanner",
    qr_code_minted:                "QR codes auto-minted",
  }
  const byFeature = Array.from(usageByFeature.entries())
    .filter(([, count]) => count > 0)
    .map(([featureKey, count]) => ({
      featureKey,
      label:            FEATURE_LABELS[featureKey] ?? featureKey,
      revenueCents:     0,
      timeSavedMinutes: timeSavedFor(featureKey, count),
      eventCount:       count,
    }))
    .sort((a, b) => b.timeSavedMinutes - a.timeSavedMinutes)

  // ── Pipeline forecast (next 90 days) ────────────────────────────────────
  const ninetyOut = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)
  let pipelineCommissionCents = 0
  let activeTransactions = 0
  if (agentRowId) {
    const { data: openTxns } = await svc
      .from("transactions")
      .select("estimated_commission, close_date, status")
      .eq("agent_id", agentRowId)
      .neq("status", "closed")
    activeTransactions = openTxns?.length ?? 0
    pipelineCommissionCents = (openTxns ?? []).reduce(
      (acc: number, t: any) => acc + Math.round(((t.estimated_commission ?? 0) as number) * 100),
      0
    )
  }
  let upcomingSphereTouchpoints = 0
  if (agentRowId) {
    const today = new Date().toISOString().slice(0, 10)
    const { data: upcoming } = await svc
      .from("lifetime_customer_touchpoints")
      .select("id")
      .eq("agent_id", agentRowId)
      .gt("scheduled_date", today)
      .lt("scheduled_date", ninetyOut)
    upcomingSphereTouchpoints = upcoming?.length ?? 0
  }

  // ── Recent wins timeline ────────────────────────────────────────────────
  const recentWins: RoiSnapshot["recentWins"] = []
  // ISA wins
  if (agentRowId) {
    const { data: isaWins } = await svc
      .from("ai_isa_activities")
      .select("created_at, outcome, summary")
      .gte("created_at", startISO)
      .ilike("outcome", "%appointment%")
      .order("created_at", { ascending: false })
      .limit(5)
    for (const w of (isaWins ?? []) as Array<{ created_at: string; outcome: string; summary: string }>) {
      recentWins.push({
        happenedAt: w.created_at,
        headline:   `AI ISA booked an appointment — ${w.summary ?? w.outcome}`,
        valueCents: null,
        featureKey: "ai_isa_appointment_set",
      })
    }
  }
  // Closed transactions in window (the actual money landing)
  if (agentRowId) {
    const { data: closedWins } = await svc
      .from("transactions")
      .select("id, deal_name, estimated_commission, commission_amount, close_date, status")
      .eq("agent_id", agentRowId)
      .gte("close_date", startISO.slice(0, 10))
      .order("close_date", { ascending: false })
      .limit(5)
    for (const w of (closedWins ?? []) as any[]) {
      const cents = Math.round(((w.commission_amount ?? w.estimated_commission ?? 0) as number) * 100)
      recentWins.push({
        happenedAt: w.close_date ?? new Date().toISOString(),
        headline:   `Deal closed — ${w.deal_name ?? "transaction"}`,
        valueCents: cents > 0 ? cents : null,
        featureKey: "deal_close",
      })
    }
  }
  recentWins.sort((a, b) => new Date(b.happenedAt).getTime() - new Date(a.happenedAt).getTime())

  return {
    attributedRevenueCents,
    estimatedTimeSavedMinutes: totalMinutesSaved,
    estimatedTimeSavedDollars: estimatedTimeSavedDollars * 100,  // store as cents
    totalValueDollars:         attributedRevenueCents + estimatedTimeSavedDollars * 100,
    byFeature,
    pipeline: {
      activeTransactions,
      pipelineCommissionCents,
      upcomingSphereTouchpoints,
      isaAppointmentsBooked,
    },
    recentWins: recentWins.slice(0, 8),
    period,
    periodStart: startISO,
    periodEnd:   endISO,
    agentName:   [profile.first_name, profile.last_name].filter(Boolean).join(" ") || null,
    modelComparison,
  }
}
