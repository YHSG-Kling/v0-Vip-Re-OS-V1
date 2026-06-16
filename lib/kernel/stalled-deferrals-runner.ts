// lib/kernel/stalled-deferrals-runner.ts
//
// Live side of OVER-DEFERRAL accountability. Reads recent deferral signals off the inter-manager
// bus, finds (manager, contact) pairs deferred-to too many times without progress, and nudges the
// deferred-to manager ("act or release") + the contact's agent. Idempotent (one nudge per stalled
// pair per window). Never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { detectStalledDeferrals, DEFAULT_STALL_THRESHOLD } from "./stalled-deferrals"
import { classifyCoordination } from "./coordination-kind"

type Svc = ReturnType<typeof createServiceClient>

export interface DeferralNudgeResult {
  deferralsScanned: number
  stalledPairs: number
  nudged: number
}

export async function runStalledDeferralNudges(
  brokerageId: string,
  client?: Svc,
  opts?: { windowDays?: number; threshold?: number },
): Promise<DeferralNudgeResult> {
  const svc = client ?? createServiceClient()
  const windowDays = opts?.windowDays ?? 7
  const threshold = opts?.threshold ?? DEFAULT_STALL_THRESHOLD
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const out: DeferralNudgeResult = { deferralsScanned: 0, stalledPairs: 0, nudged: 0 }

  const { data: signals } = await svc
    .from("manager_signals")
    .select("signal_type, to_manager, contact_id")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", since)
    .not("contact_id", "is", null)
    .limit(5000)

  const deferrals = ((signals ?? []) as any[]).filter((s) => classifyCoordination(s.signal_type) === "deferral")
  out.deferralsScanned = deferrals.length

  const stalled = detectStalledDeferrals(deferrals, { threshold })
  out.stalledPairs = stalled.length

  const { publishManagerSignal } = await import("./manager-signals")
  for (const s of stalled) {
    // Idempotent: skip if this pair was already nudged within the window.
    const { data: prior } = await svc
      .from("manager_signals")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("signal_type", "deferral_stall_nudge")
      .eq("entity_id", s.contactId)
      .eq("to_manager", s.toManager)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle()
    if (prior) continue

    const sig = await publishManagerSignal({
      brokerageId, fromManager: "campaign_orchestrator", toManager: s.toManager as any,
      signalType: "deferral_stall_nudge",
      message: `You've been deferred to ${s.count}× on this contact with no action — act now or release it so another manager can. Limbo helps no one.`,
      entityType: "contact", entityId: s.contactId, contactId: s.contactId,
      payload: { deferralCount: s.count },
    }, svc).catch(() => ({ ok: false }))

    // Also surface to the contact's responsible agent (best-effort).
    try {
      const { data: c } = await svc.from("contacts").select("agent_id, first_name, last_name").eq("id", s.contactId).maybeSingle()
      const agentId = (c as any)?.agent_id
      if (agentId) {
        const name = `${(c as any).first_name ?? ""} ${(c as any).last_name ?? ""}`.trim() || "A contact"
        await svc.from("notifications").insert({
          user_id: agentId, brokerage_id: brokerageId, type: "deferral_stall",
          title: `${name} is stuck in limbo`,
          body: `${name} has been deferred between managers ${s.count} times with no outreach. A personal touch from you may be the unlock.`,
          entity_type: "contact", entity_id: s.contactId, priority: "medium", is_read: false,
        })
      }
    } catch { /* best-effort */ }

    if ((sig as any).ok) out.nudged++
  }

  return out
}
