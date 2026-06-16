// lib/intelligence/health-lifecycle-runner.ts
//
// Live side of HEALTH-TRIGGERED LIFECYCLE PLAYS — find the agent's/brokerage's relationships that
// have decayed to at-risk/dormant and hand the matched manager the right re-engagement play via the
// inter-manager bus (so it shows on the coordination feed and the manager's inbox acts on it).
// Idempotent per (contact, play) within the window. Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { getHealthPrioritizedContacts } from "./health-prioritizer-runner"
import { lifecyclePlayForHealth } from "./health-lifecycle-play"
import { winbackVideoPlan } from "./winback-video"

type Svc = ReturnType<typeof createServiceClient>

export interface HealthLifecycleResult {
  scanned: number
  playsHandedOff: number
  winbackVideosStaged: number
}

export async function runHealthLifecyclePlays(brokerageId: string, client?: Svc, opts?: { limit?: number }): Promise<HealthLifecycleResult> {
  const svc = client ?? createServiceClient()
  const out: HealthLifecycleResult = { scanned: 0, playsHandedOff: 0, winbackVideosStaged: 0 }

  const ranked = await getHealthPrioritizedContacts(svc, brokerageId, { limit: opts?.limit ?? 300 })
  const decaying = ranked.filter((r) => r.priority >= 3) // at_risk or dormant
  if (decaying.length === 0) return out

  // Need contact_type + agent to match the play to who they are and to attribute a win-back video.
  const ids = decaying.map((d) => d.contactId)
  const { data: contacts } = await svc.from("contacts").select("id, contact_type, agent_id").in("id", ids)
  const byId = new Map<string, { type: string | null; agentId: string | null }>(((contacts ?? []) as any[]).map((c) => [c.id, { type: c.contact_type ?? null, agentId: c.agent_id ?? null }]))
  const typeById = new Map<string, string | null>([...byId.entries()].map(([k, v]) => [k, v.type]))

  // Resolve a valid sender users.id: the contact's agent (agents.user_id) or the brokerage system user.
  let brokerageSender: string | null = null
  const senderFor = async (agentId: string | null): Promise<string | null> => {
    if (agentId) {
      const { data: a } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
      if ((a as any)?.user_id) return (a as any).user_id
    }
    if (brokerageSender === null) {
      const { data: bk } = await svc.from("brokerages").select("ai_isa_system_user_id").eq("id", brokerageId).maybeSingle()
      brokerageSender = (bk as any)?.ai_isa_system_user_id ?? ""
    }
    return brokerageSender || null
  }

  const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")

  for (const d of decaying) {
    out.scanned++
    const plan = lifecyclePlayForHealth(d.band, typeById.get(d.contactId) ?? null)
    if (!plan.play || !plan.manager) continue

    // Idempotent: don't re-hand the same play for the same contact within the window.
    const { data: prior } = await svc
      .from("manager_signals")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("signal_type", "health_lifecycle_play")
      .eq("contact_id", d.contactId)
      .gte("created_at", since)
      .ilike("message", `%${plan.play}%`)
      .limit(1)
      .maybeSingle()
    if (prior) continue

    const sig = await publishManagerSignal({
      brokerageId, fromManager: "sphere_of_influence", toManager: plan.manager as any,
      signalType: "health_lifecycle_play",
      message: `${plan.reason} (health ${d.band}, ${d.score}/100). Run the ${plan.play} play${plan.urgency === "now" ? " — urgent" : ""}.`,
      entityType: "contact", entityId: d.contactId, contactId: d.contactId,
      payload: { play: plan.play, band: d.band, score: d.score, urgency: plan.urgency },
    }, svc).catch(() => ({ ok: false }))
    if ((sig as any).ok) out.playsHandedOff++

    // MULTIMODAL WIN-BACK — a DORMANT relationship gets a personal Video Director win-back
    // (highest-emotion re-engagement). commissionVideo is idempotent per (entity, kind), so this is
    // safe to call each run; Asset Manager → Video Director stages it for approval.
    const wb = winbackVideoPlan(typeById.get(d.contactId) ?? null, d.band)
    if (wb.commission && wb.kind) {
      try {
        const sender = await senderFor(byId.get(d.contactId)?.agentId ?? null)
        if (sender) {
          const { commissionVideo } = await import("@/lib/video/video-director")
          const r = await commissionVideo(
            { kind: wb.kind as any, tier: "solo_agent", targetChannel: "email", facts: { contact_id: d.contactId } } as any,
            { brokerageId, agentUserId: sender, contactId: d.contactId },
            svc,
          )
          if ((r as any).ok) out.winbackVideosStaged++
        }
      } catch { /* best-effort — the manager play still went out */ }
    }
  }

  return out
}
