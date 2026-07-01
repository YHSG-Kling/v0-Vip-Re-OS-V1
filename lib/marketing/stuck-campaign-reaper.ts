// ─── STUCK-CAMPAIGN REAPER (Campaign Orchestrator) ───────────────────────────
// Nothing-falls-through guard for the Campaign Orchestrator's PRIMARY table. The
// Marketing Manager already reaps stuck social posts; the Orchestrator reaps stale
// workflow runs — but marketing_campaigns itself had NO watcher, so a campaign could
// stall (scheduled-but-never-launched / live-but-distributed-nothing / draft-forever)
// with no human alerted and the whole multi-channel funnel silently hanging. This scans
// campaigns, classifies the stuck ones (pure policy), and escalates to the brokerage's
// broker/admins for review. Escalate-only — campaigns are human-owned; we never auto-fail
// or auto-pause one. Idempotent per campaign via the notifications dedup.

import { createServiceClient } from "@/lib/supabase/service"
import { classifyStuckCampaign, stuckCampaignMessage, recoveryStrategyFor } from "./stuck-campaign-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface StuckCampaignReapResult {
  scanned: number
  escalated: number
  reaped: number
}

export async function reapStuckCampaigns(
  brokerageId: string,
  client?: Svc,
  opts?: { now?: Date; limit?: number },
): Promise<StuckCampaignReapResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: StuckCampaignReapResult = { scanned: 0, escalated: 0, reaped: 0 }

  const { data: rows } = await svc
    .from("marketing_campaigns")
    .select("id, campaign_name, status, scheduled_start_at, launched_at, impressions, created_at")
    .eq("brokerage_id", brokerageId)
    .in("status", ["draft", "scheduled", "live"])
    .limit(opts?.limit ?? 300)

  const campaigns = (rows ?? []) as Array<{
    id: string; campaign_name: string | null; status: string | null
    scheduled_start_at: string | null; launched_at: string | null; impressions: number | null; created_at: string | null
  }>
  if (campaigns.length === 0) return result

  // Resolve the brokerage's broker/admins ONCE — a campaign is a brokerage-level asset.
  const { data: admins } = await svc
    .from("users")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .in("user_type", ["broker", "broker_admin", "admin", "superadmin"])
    .limit(10)
  const adminIds = ((admins ?? []) as Array<{ id: string }>).map((a) => a.id)
  if (adminIds.length === 0) {
    // No one to escalate to — still count the scan honestly.
    for (const c of campaigns) { if (classifyStuckCampaign({ status: c.status, scheduledStartAt: c.scheduled_start_at, launchedAt: c.launched_at, impressions: c.impressions, createdAt: c.created_at, now }) !== "keep") result.scanned++ }
    return result
  }

  for (const c of campaigns) {
    const verdict = classifyStuckCampaign({
      status: c.status, scheduledStartAt: c.scheduled_start_at, launchedAt: c.launched_at,
      impressions: c.impressions, createdAt: c.created_at, now,
    })
    if (verdict === "keep") continue
    result.scanned++

    // ── AUTONOMOUS RECOVERY (multi-manager, on the bus) ──────────────────────
    // A 'scheduled' campaign was already approved; its launch just never fired. RE-RUN the
    // compliance-gated publisher to COMPLETE the approved action — the agent never redoes it.
    // Only escalates to a human if the relaunch itself can't proceed (compliance/audience).
    if (recoveryStrategyFor(verdict) === "relaunch") {
      try {
        const { publishMarketingCampaignSafe } = await import("./campaign-publisher")
        const r = await publishMarketingCampaignSafe(c.id)
        if (r.ok) {
          result.reaped++
          // Announce the autonomous recovery on the manager bus — the AI team caught + relaunched
          // it, visible in the Command Center's "managers talking" feed (feed_only).
          try {
            const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
            await publishManagerSignal({
              brokerageId,
              fromManager: "campaign_orchestrator",
              toManager: "marketing_agent",
              signalType: "campaign_recovered",
              message: `Auto-relaunched a stalled campaign${c.campaign_name ? ` "${c.campaign_name}"` : ""} — reached ${r.audienceSize ?? 0} contacts (${r.complianceStatus ?? "ok"})`,
              entityType: "marketing_campaign",
              entityId: c.id,
              payload: { audience_size: r.audienceSize ?? 0, compliance_status: r.complianceStatus ?? null },
            }, svc)
          } catch { /* visibility is best-effort — the campaign already relaunched */ }
          continue
        }
        // Relaunch couldn't proceed (compliance held / audience empty) → fall through to escalate,
        // carrying the SPECIFIC reason so the human knows exactly what to fix.
        if (r.error) (c as { _recoverError?: string })._recoverError = r.error
      } catch { /* fall through to escalate */ }
    }

    // Idempotent per campaign: skip if an unread stuck-campaign alert already exists for it.
    const { data: prior } = await svc
      .from("notifications")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("type", "campaign_stuck")
      .eq("entity_id", c.id)
      .eq("is_read", false)
      .limit(1)
    if (prior && prior.length > 0) continue

    const recoverError = (c as { _recoverError?: string })._recoverError
    const msg = stuckCampaignMessage(verdict)
    const name = c.campaign_name ? `"${c.campaign_name}"` : "A campaign"
    let escalatedThis = false
    for (const uid of adminIds) {
      const { error } = await svc.from("notifications").insert({
        user_id: uid,
        brokerage_id: brokerageId,
        type: "campaign_stuck",
        title: msg.title,
        body: recoverError
          ? `${name}: your AI team tried to relaunch it but couldn't — ${recoverError} Fix that and it'll go out.`
          : `${name}: ${msg.body}`,
        entity_type: "marketing_campaign",
        entity_id: c.id,
        priority: "medium",
        is_read: false,
      })
      if (!error) escalatedThis = true
    }
    if (escalatedThis) result.escalated++
  }

  return result
}
