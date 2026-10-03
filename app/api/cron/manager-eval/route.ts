import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runManagerEval } from "@/lib/compliance/manager-eval-harness"
import { evalBrokerageOutbound, evalBrokerageDirectorReels } from "@/lib/agents/manager-outbound-eval"

/**
 * CONTINUOUS MANAGER EVAL cron (weekly) — the "our AI team is continuously red-teamed" guarantee made
 * autonomous. Runs the deterministic adversarial eval harness (protected-class bait, prompt injection,
 * privacy-leak, fabricated figures) against the managers' REAL output guards. The eval is platform-
 * level (fixed adversarial inputs, not brokerage data), so on a RELEASE-BLOCKING failure — a guard
 * regression that would let a Fair-Housing / injection / privacy leak through — it escalates to PLATFORM
 * staff (superadmin/support). A green run is the auditable proof; a red run is a regression sentinel.
 *
 * TWO LIVE AUDITS RIDE THE SAME RUN (wired 2026-09-03): per brokerage with autonomous egress
 * pending, evalBrokerageOutbound scores the managers' PROPOSED client messages and
 * evalBrokerageDirectorReels runs the Director eval harness over Director-staged reels
 * (hallucination / Fair Housing / scope creep / reward alignment). Both are read-only and
 * never block anything; a scope-creep or Fair-Housing finding joins the release-block
 * escalation because those two dimensions are zero-tolerance on an autonomous surface.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "manager-eval",
    cron_path: "/app/api/cron/manager-eval/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  try {
    const report = runManagerEval()

    // ── LIVE AUDITS — every brokerage with autonomous egress in flight ──────
    const [{ data: msgTenants, error: msgTenantsErr }, { data: reelTenants, error: reelTenantsErr }] = await Promise.all([
      supabase.from("agent_client_messages").select("brokerage_id").eq("status", "proposed").limit(2000),
      supabase.from("ai_video_projects").select("brokerage_id").eq("is_ai_generated", true)
        .eq("video_metadata->>requested_via", "asset_manager").in("approval_status", ["pending_review", "approved"]).limit(2000),
    ])
    if (msgTenantsErr) console.error("[manager-eval] proposed-message tenant read refused:", msgTenantsErr.message)
    if (reelTenantsErr) console.error("[manager-eval] director-reel tenant read refused:", reelTenantsErr.message)
    const tenants = Array.from(new Set([
      ...((msgTenants ?? []) as Array<{ brokerage_id: string | null }>).map((r) => r.brokerage_id),
      ...((reelTenants ?? []) as Array<{ brokerage_id: string | null }>).map((r) => r.brokerage_id),
    ].filter((b): b is string => !!b)))

    const live = { brokerages: tenants.length, messagesEvaluated: 0, messagesFlagged: 0, reelsEvaluated: 0, reelsFailingDimensions: [] as string[], unreadable: [] as string[] }
    const liveBlockers: string[] = []
    for (const bid of tenants) {
      const outbound = await evalBrokerageOutbound(bid, supabase)
      if (outbound.unreadable) live.unreadable.push(`${bid}: ${outbound.unreadable}`)
      live.messagesEvaluated += outbound.evaluated
      live.messagesFlagged += outbound.flagged
      for (const f of outbound.findings) {
        if (f.dimension === "scope_creep" || (f.dimension === "fair_housing" && (f.severity === "high" || f.severity === "critical"))) {
          liveBlockers.push(`${bid}/message ${f.messageId}: ${f.dimension} — ${f.detail}`)
        }
      }
      const reels = await evalBrokerageDirectorReels(bid, supabase)
      if (reels.unreadable) live.unreadable.push(`${bid}: ${reels.unreadable}`)
      live.reelsEvaluated += reels.evaluated
      if (reels.report) {
        if (!reels.report.scopeCreep.pass) { live.reelsFailingDimensions.push(`${bid}:scope_creep`); liveBlockers.push(...reels.report.scopeCreep.violations.slice(0, 4).map((v) => `${bid}/reel: ${v}`)) }
        if (!reels.report.fairHousing.pass) { live.reelsFailingDimensions.push(`${bid}:fair_housing`); liveBlockers.push(...reels.report.fairHousing.violations.slice(0, 4).map((v) => `${bid}/reel: ${v}`)) }
        if (!reels.report.rewardAlignment.pass) live.reelsFailingDimensions.push(`${bid}:reward_alignment`)
        if (!reels.report.hallucination.pass) live.reelsFailingDimensions.push(`${bid}:hallucination`)
      }
    }

    const releaseBlocked = report.releaseBlocked || liveBlockers.length > 0
    if (releaseBlocked) {
      // A guard regression let an adversarial case through, or a LIVE autonomous
      // surface shows scope creep / a hard Fair-Housing hit — escalate to platform
      // staff ONCE. PLATFORM STAFF LIVE IN `platform_role` (CLAUDE.md §4) — the
      // previous `user_type in (superadmin, support)` matched no live row, so
      // this escalation had never reached anyone.
      const failing = report.cases.filter((c) => !c.pass).slice(0, 8)
      const { data: staff, error: staffErr } = await supabase
        .from("users")
        .select("id, brokerage_id")
        // PEOPLE on the platform team, not the ai_isa_system role
        // (scripts/check-vocabularies.ts platform_role).
        .in("platform_role", ["superadmin", "support"])
        .is("deleted_at", null)
        .limit(20)
      if (staffErr) console.error("[manager-eval] platform staff read refused — escalation NOT delivered:", staffErr.message)
      const detail = [
        ...failing.map((c) => `${c.category}/${c.id}`),
        ...liveBlockers.slice(0, 6),
      ].join(", ")
      for (const u of (staff ?? []) as Array<{ id: string; brokerage_id: string | null }>) {
        const { error: notifyErr } = await supabase.from("notifications").insert({
          user_id: u.id,
          brokerage_id: u.brokerage_id,
          type: "manager_eval_regression",
          title: `⚠️ Manager eval FAILED — ${report.failed} adversarial case(s) + ${liveBlockers.length} live finding(s)`,
          body: `The autonomous-manager eval blocked release: ${detail}. Review before shipping.`,
          entity_type: "system",
          entity_id: contextId,
          priority: "high",
          channel: "in_app",
        })
        if (notifyErr) console.error("[manager-eval] escalation notification refused:", notifyErr.message)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: report.total + live.messagesEvaluated + live.reelsEvaluated,
      metadata: {
        total: report.total, passed: report.passed, failed: report.failed,
        release_blocked: releaseBlocked,
        by_category: report.byCategory,
        live,
      },
    }).catch(() => {})

    return NextResponse.json({ ok: true, total: report.total, passed: report.passed, failed: report.failed, releaseBlocked, live })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 })
  }
}
