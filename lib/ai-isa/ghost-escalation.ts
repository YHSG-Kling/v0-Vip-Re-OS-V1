// lib/ai-isa/ghost-escalation.ts
// ─────────────────────────────────────────────────────────────────────────────
// When the AI-ISA's AGGRESSIVE re-engagement cadence is spent on a non-responding lead
// (DEFAULT_MAX_GHOST_ATTEMPTS touches over ~3 months, no reply), the ISA does NOT give up —
// it DOWNSHIFTS to a quarterly long-horizon seasonal nurture (real-estate decisions take
// 6–18 months). At that transition it escalates ONCE to a human as an FYI — the human may
// add a personal touch (a call) the automation can't, OR archive — but the automated
// seasonal nurture keeps the relationship alive either way. Escalates to the brokerage
// broker/admins, falling through to platform staff if the brokerage has no admin. Fires
// once — the runner flags the lead reengagement_status='long_horizon'.

import type { SupabaseClient } from "@supabase/supabase-js"
import { notifyBrokerageAdmins } from "@/lib/notifications/brokerage-admins"
import { notifyPlatformStaff } from "@/lib/notifications/platform-staff"

export const GHOST_EXHAUSTED_NOTIFICATION_TYPE = "ghost_lead_exhausted"

export interface GhostEscalationResult {
  escalated: boolean
  target: "brokerage_admin" | "platform" | "none"
  notified: number
}

/**
 * WAVE 149 (lane 149C, owner ruling 7 / contract C29 — lane 148Z Still open: ghost-escalation onto the arbiter): the FYI at the
 * active → seasonal transition is no longer a reflex fired by an attempt count. The planner (this module) PROPOSES telling a
 * person; the ARBITER decides whether a person should hear about this lead now (offer a personal call) or the quiet seasonal
 * nurture should simply continue (no wait is offered: the transition is asked about once). The FYI is the fallback (an outage keeps the old behaviour).
 * The decision is ledgered (followup.decision.*). The `long_horizon` status flip is the runner's phase bookkeeping, not this decision.
 */
export async function decideGhostEscalation(
  supabase: { from: (t: string) => any },
  params: { leadId: string; brokerageId: string; attempts: number; leadTemperature?: string | null; leadScore?: number | null; hoursSinceLastActivity?: number | null; now?: Date },
  deps: { decide?: import("./followup-arbiter").ArbiterDecide; record?: boolean } = {},
): Promise<{ escalate: boolean; choice: string; rationale: string; source: "ai" | "deterministic" }> {
  const { arbitratePlannedTouch } = await import("./followup-arbiter")
  const r = await arbitratePlannedTouch(supabase, {
    brokerageId: params.brokerageId, planner: "ghost_escalation", subject: { type: "lead", id: params.leadId }, now: params.now ?? new Date(),
    options: [
      { id: "notify_human", kind: "agent_intervention", channels: ["human_task"], why: [`${params.attempts} automated follow-ups without a reply — a personal call from a person may break through`, "the quiet seasonal nurture continues either way"] },
      { id: "continue_nurture", kind: "communication", channels: [], why: ["let the quiet seasonal nurture carry the relationship; no one needs to be interrupted about this lead now"] },
    ],
    planned: "notify_human",
    // The transition is asked about ONCE (the runner flips the lead to long_horizon) — a wait would mean never, so none is offered.
    offerWait: false,
    moment: { key: "ghost_active_cadence_spent", intent: "A lead has not replied to the active follow-ups and is moving to a light seasonal nurture — decide whether a person should hear about them now." },
    relationship: { type: "lead", persona: params.leadTemperature ?? null, hasAssignedAgent: false },
    intent: typeof params.leadScore === "number" ? { score: params.leadScore, trend: params.leadTemperature ?? "unknown" } : null,
    history: { hoursSinceAnyTouch: params.hoursSinceLastActivity ?? null },
  }, deps)
  return { escalate: r.decision.kind === "agent_intervention", choice: r.choice, rationale: r.decision.rationale, source: r.decision.source }
}

export async function escalateExhaustedGhostLead(
  supabase: SupabaseClient,
  params: { leadId: string; brokerageId: string; attempts: number; firstName?: string | null },
): Promise<GhostEscalationResult> {
  const { leadId, brokerageId, attempts, firstName } = params
  if (!leadId || !brokerageId) return { escalated: false, target: "none", notified: 0 }

  const who = firstName ? firstName : "A qualifying lead"
  const body = `${who} hasn't replied after ${attempts} AI-ISA follow-ups. The ISA is NOT giving up — it's downshifting to a light quarterly nurture to stay top-of-mind for the months a move can take. A personal call from you might break through where automation can't; or archive if it's truly cold.`

  const adminCount = await notifyBrokerageAdmins(supabase, brokerageId, {
    type: GHOST_EXHAUSTED_NOTIFICATION_TYPE,
    title: "AI-ISA moved a quiet lead to long-horizon nurture — a personal call might help",
    body,
    entityType: "lead",
    entityId: leadId,
    priority: "medium",
  })
  if (adminCount > 0) return { escalated: true, target: "brokerage_admin", notified: adminCount }

  const platformCount = await notifyPlatformStaff(supabase, {
    type: GHOST_EXHAUSTED_NOTIFICATION_TYPE,
    title: "AI-ISA moved a quiet lead to long-horizon nurture; brokerage has no admin",
    body,
    entityType: "lead",
    entityId: leadId,
    priority: "medium",
  })
  return platformCount > 0
    ? { escalated: true, target: "platform", notified: platformCount }
    : { escalated: false, target: "none", notified: 0 }
}
