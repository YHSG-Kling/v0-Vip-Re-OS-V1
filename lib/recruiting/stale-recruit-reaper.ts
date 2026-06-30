// ─── STALE-RECRUIT REAPER (Recruiting Manager) ───────────────────────────────
// Nothing-falls-through guard for the talent pipeline: a recruit in an active
// stage that hasn't moved past its stage SLA is escalated to the recruiter so a
// warm candidate (especially one with an offer out) never goes cold from neglect.
// Pure stage-SLA policy in stale-recruit-policy.ts.

import { createServiceClient } from "@/lib/supabase/service"
import { classifyStaleRecruit, slaDaysForStage } from "./stale-recruit-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface StaleRecruitReapResult {
  scanned: number
  escalated: number
}

export async function reapStaleRecruits(
  brokerageId: string,
  client?: Svc,
  opts?: { now?: Date; limit?: number },
): Promise<StaleRecruitReapResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: StaleRecruitReapResult = { scanned: 0, escalated: 0 }

  const { data: rows } = await svc
    .from("recruits")
    .select("id, status, updated_at, recruiter_agent_id")
    .eq("brokerage_id", brokerageId)
    .in("status", ["prospect", "contacted", "interviewing", "offer_extended"])
    .limit(opts?.limit ?? 200)

  for (const row of (rows ?? []) as Array<{ id: string; status: string | null; updated_at: string | null; recruiter_agent_id: string | null }>) {
    result.scanned++
    if (classifyStaleRecruit({ status: row.status, updatedAt: row.updated_at, now }) !== "escalate") continue

    // Idempotent: one open stale alert per recruit.
    const { data: prior } = await svc
      .from("notifications")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("type", "recruit_gone_cold")
      .eq("entity_id", row.id)
      .eq("is_read", false)
      .limit(1)
    if (prior && prior.length > 0) continue

    // resolveResponsibleAgentUserId handles entity_type 'recruit' → recruits.recruiter_agent_id → user.
    const { resolveResponsibleAgentUserId } = await import("@/lib/intelligence/mobile-approval-queue")
    const agentUserId = await resolveResponsibleAgentUserId(svc, {
      recipient_contact_id: null,
      entity_type: "recruit",
      entity_id: row.id,
    })
    if (!agentUserId) continue

    const stage = (row.status ?? "pipeline").toString().replace(/_/g, " ")
    const sla = slaDaysForStage(row.status)
    await svc.from("notifications").insert({
      user_id: agentUserId,
      brokerage_id: brokerageId,
      type: "recruit_gone_cold",
      title: "🧊 A recruit is going cold",
      body: `A candidate in "${stage}" hasn't moved in over ${sla ?? "the expected"} days. Reach out before they lose interest${(row.status ?? "").toLowerCase() === "offer_extended" ? " — there's an offer on the table" : ""}.`,
      entity_type: "recruit",
      entity_id: row.id,
      priority: (row.status ?? "").toLowerCase() === "offer_extended" ? "high" : "medium",
      is_read: false,
    })
    result.escalated++
  }

  return result
}
