import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sweepStaleRecruits } from "@/lib/agents/recruit-outreach-producer"
import { refreshAllRecruitingRoi } from "@/lib/recruiting/recruiting-roi-writer"
import { runSwitchPropensityScoutAll } from "@/lib/recruiting/switch-propensity-scout"

/**
 * Weekly RECRUITING MANAGER sweep — keeps the talent pipeline warm. For every
 * brokerage with active recruits, propose the next stage-appropriate outreach for
 * recruits that have gone stale (no contact in 7+ days) into the client-message gate.
 * Idempotent per recruit (de-dupes a pending proposal), so re-running is safe.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "recruit-outreach",
    cron_path: "/app/api/cron/recruit-outreach/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let proposed = 0
  let scanned = 0
  let roiWritten = 0

  try {
    const { data: rows, error } = await supabase
      .from("recruits")
      .select("brokerage_id")
      .in("status", ["prospect", "contacted", "interviewing", "offer_extended"])
      .limit(1000)
    if (error) throw error

    const brokerages = Array.from(new Set(((rows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id)))
    for (const brokerageId of brokerages) {
      try {
        const r = await sweepStaleRecruits(brokerageId, 7, supabase)
        proposed += r.proposed
        scanned += r.scanned
      } catch (e: any) {
        errors.push(`${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    // AUTONOMOUS ROI refresh — safety net beyond the event-driven recompute (first-close + cost entry).
    // Covers EVERY brokerage with recruited-agent production/cost, not just those with active recruits,
    // so the recruiting_roi dashboard stays current with no agent action.
    const { data: roiRows } = await supabase.from("recruiting_analytics").select("brokerage_id").not("recruited_agent_id", "is", null).limit(2000)
    const roiBrokerages = Array.from(new Set([...brokerages, ...((roiRows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id)]))
    for (const brokerageId of roiBrokerages) {
      try {
        const r = await refreshAllRecruitingRoi(supabase, { brokerageId })
        roiWritten += r.written
      } catch (e: any) {
        errors.push(`roi ${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    // SWITCH-PROPENSITY SCOUT — weekly gated "prioritize these agents" brief per brokerage (the
    // highest-value, most-switchable talent first).
    let priorityBriefs = 0
    try {
      const scout = await runSwitchPropensityScoutAll(supabase)
      priorityBriefs = scout.briefs
    } catch (e: any) { errors.push(`scout: ${e?.message ?? String(e)}`) }

    // VENDOR RECRUITMENT SCOUT — the marketplace-growth mirror: a weekly gated "invite these vendors"
    // brief for the off-platform vendors the brokerage already relies on (grow the marketplace toward
    // the vendors it already depends on).
    let vendorBriefs = 0
    try {
      const { runVendorRecruitmentScoutAll } = await import("@/lib/recruiting/vendor-recruitment-scout")
      const vscout = await runVendorRecruitmentScoutAll(supabase)
      vendorBriefs = vscout.briefs
    } catch (e: any) { errors.push(`vendor-scout: ${e?.message ?? String(e)}`) }

    // CURRICULUM AUTHOR — the OS teaches itself to teach: detect recurring knowledge gaps from real
    // signal (objection drills + compliance flags) and author gated draft micro-courses for the new ones.
    let curriculaAuthored = 0
    try {
      const { runCurriculumAuthorAll } = await import("@/lib/education/curriculum-author")
      const authored = await runCurriculumAuthorAll(supabase)
      curriculaAuthored = authored.authored
    } catch (e: any) { errors.push(`curriculum-author: ${e?.message ?? String(e)}`) }

    // TIER ONBOARDING CURRICULUM — the OS trains new subscribers out of the gate: author the tier- and
    // role-appropriate onboarding path (idempotent safety net for the SUBSCRIPTION_CREATED emit).
    let onboardingAuthored = 0
    try {
      const { runOnboardingCurriculumAll } = await import("@/lib/education/onboarding-curriculum")
      const ob = await runOnboardingCurriculumAll(supabase)
      onboardingAuthored = ob.authored
    } catch (e: any) { errors.push(`onboarding-curriculum: ${e?.message ?? String(e)}`) }

    // CONTENT FRESHNESS — flag AI-authored lessons that have aged out (>180d) for a gated refresh so
    // stale law/market facts never mislead; the human re-authors through the existing review queue.
    let staleModules = 0
    try {
      const { runContentFreshnessAll } = await import("@/lib/education/content-freshness")
      const fr = await runContentFreshnessAll(supabase)
      staleModules = fr.stale
    } catch (e: any) { errors.push(`content-freshness: ${e?.message ?? String(e)}`) }

    // CAREER TIER — auto-upgrade agents who earned the next tier + nudge those ≥80% toward it (the
    // progression ladder that answers the "no path forward" attrition driver).
    let tierUpgrades = 0, tierNudges = 0
    try {
      const { runCareerTierEvaluationAll } = await import("@/lib/recruiting/career-tier")
      const ct = await runCareerTierEvaluationAll(supabase)
      tierUpgrades = ct.upgraded; tierNudges = ct.nudges
    } catch (e: any) { errors.push(`career-tier: ${e?.message ?? String(e)}`) }

    // LEADERBOARD — snapshot weekly/monthly/all-time point rankings from the single ledger (fixes the
    // never-populated leaderboard drift).
    let leaderboardRows = 0
    try {
      const { runLeaderboardSnapshotAll } = await import("@/lib/recruiting/leaderboard")
      const lb = await runLeaderboardSnapshotAll(supabase)
      leaderboardRows = lb.rows
    } catch (e: any) { errors.push(`leaderboard: ${e?.message ?? String(e)}`) }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: proposed,
      metadata: { proposed, scanned, roiWritten, priorityBriefs, vendorBriefs, curriculaAuthored, onboardingAuthored, staleModules, tierUpgrades, tierNudges, leaderboardRows, brokerages: brokerages.length, errors },
    }).catch(() => {})
    return NextResponse.json({ ok: true, proposed, scanned, roiWritten, priorityBriefs, vendorBriefs, curriculaAuthored, onboardingAuthored, staleModules, tierUpgrades, tierNudges, leaderboardRows, brokerages: brokerages.length, errors })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
