// lib/kernel/warm-handoff-runner.ts
//
// Gathers the live parts of a warm handoff (portal transcript + context spine + 11-manager team
// brief + ISA background), composes the brief, persists it to contacts.metadata.warm_handoff (the
// same proven jsonb the context_spine uses — no schema risk), and routes ONE `warm_handoff`
// notification to the contact's agent. Best-effort: a missing part degrades gracefully; the agent
// still walks in with everything that IS known. Never throws into the caller (the escalation path).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { composeHandoffBrief, handoffTitle, type HandoffParts } from "./warm-handoff"

type Svc = ReturnType<typeof createServiceClient>

export interface WarmHandoffResult { ok: boolean; notificationId?: string; reason?: string }

export async function runWarmHandoff(
  contactId: string,
  opts: { triggerMessage?: string | null } = {},
  client?: Svc,
): Promise<WarmHandoffResult> {
  const svc = client ?? createServiceClient()
  try {
    const { data: contact } = await svc.from("contacts")
      .select("id, first_name, last_name, brokerage_id, agent_id, metadata, isa_handoff_brief")
      .eq("id", contactId).maybeSingle()
    if (!contact?.brokerage_id) return { ok: false, reason: "contact not found" }
    const c = contact as Record<string, any>
    const brokerageId = c.brokerage_id as string
    const contactName = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null

    // ── Portal transcript (robust to the role/content vs sender_type/message_content drift) ──
    const transcript: { who: string; text: string }[] = []
    try {
      const { data: session } = await svc.from("chat_sessions")
        .select("id").eq("contact_id", contactId).eq("source", "portal")
        .order("created_at", { ascending: false }).limit(1).maybeSingle()
      if (session?.id) {
        const { data: msgs } = await svc.from("chat_messages")
          .select("*").eq("session_id", session.id).order("created_at", { ascending: true }).limit(40)
        for (const m of (msgs ?? []) as Record<string, any>[]) {
          transcript.push({ who: m.role ?? m.sender_type ?? "unknown", text: m.content ?? m.message_content ?? "" })
        }
      }
    } catch { /* transcript best-effort */ }

    // ── Context spine (durable running memory) ──
    const spine = (c.metadata?.context_spine ?? {}) as Record<string, any>

    // ── 11-manager team brief ──
    let teamLines: { manager: string; line: string }[] = []
    try {
      const { runTeamQuery } = await import("./team-query")
      const tq = await runTeamQuery(brokerageId, contactName ?? contactId, {}, svc)
      teamLines = (tq.contributions ?? []).map((x: any) => ({ manager: x.manager, line: x.line }))
    } catch { /* team brief best-effort */ }

    const isa = c.isa_handoff_brief as Record<string, any> | null
    const isaBackground = isa
      ? (typeof isa.summary === "string" ? isa.summary
         : [isa.motivation, isa.timeline, isa.budget].filter(Boolean).join(" · ") || null)
      : null

    const parts: HandoffParts = {
      contactName,
      triggerMessage: opts.triggerMessage ?? null,
      spineSummary: typeof spine.summary === "string" ? spine.summary : null,
      preferences: Array.isArray(spine.preferences) ? spine.preferences : [],
      openNextStep: typeof spine.openNextStep === "string" ? spine.openNextStep : null,
      sentiment: typeof spine.sentiment === "string" ? spine.sentiment : null,
      teamLines,
      transcript,
      isaBackground,
    }
    const brief = composeHandoffBrief(parts)

    // Persist the brief on the contact (read-merge-write metadata) — the agent UI reads it.
    // The error is READ. The agent UI reads the brief from this metadata key and
    // nowhere else, so a refusal produced a "warm handoff" notification pointing
    // at a brief that does not exist.
    const { error: briefWriteError } = await svc.from("contacts").update({
      metadata: { ...(c.metadata ?? {}), warm_handoff: { ...brief, composedAt: new Date().toISOString() } },
    }).eq("id", contactId)
    if (briefWriteError) {
      console.error(`[warm-handoff] brief persist REFUSED for contact ${contactId}:`, briefWriteError.message)
    }

    // Route ONE notification to the contact's agent.
    let notificationId: string | undefined
    if (c.agent_id) {
      const { data: agentRow } = await svc.from("agents").select("user_id").eq("id", c.agent_id).maybeSingle()
      const agentUserId = (agentRow as any)?.user_id
      if (agentUserId) {
        const { data: notif } = await svc.from("notifications").insert({
          user_id: agentUserId, brokerage_id: brokerageId, type: "warm_handoff",
          title: handoffTitle(contactName), body: brief.suggestedFocus,
          entity_type: "contact", entity_id: contactId, priority: "high",
        }).select("id").single()
        notificationId = (notif as any)?.id
      }
    }

    return { ok: true, notificationId }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "warm handoff failed" }
  }
}
