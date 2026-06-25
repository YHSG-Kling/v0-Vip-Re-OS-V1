// lib/ai-isa/ghost-escalation.ts
// ─────────────────────────────────────────────────────────────────────────────
// When the AI-ISA has EXHAUSTED its automated re-engagement on a non-responding ghost
// lead (DEFAULT_MAX_GHOST_ATTEMPTS touches over ~3 months, no reply), it must STOP
// looping and hand the decision to a human — the AI-ISA manager owns the lead's
// terminal state, it doesn't message a ghost forever. This escalates to the brokerage
// broker/admins (decide: a personal call, manual nurture, or archive), falling through
// to platform staff if the brokerage has no admin. Fires once — the runner marks the
// lead reengagement_status='exhausted' so the detector never re-picks it.

import type { SupabaseClient } from "@supabase/supabase-js"
import { notifyBrokerageAdmins } from "@/lib/notifications/brokerage-admins"
import { notifyPlatformStaff } from "@/lib/notifications/platform-staff"

export const GHOST_EXHAUSTED_NOTIFICATION_TYPE = "ghost_lead_exhausted"

export interface GhostEscalationResult {
  escalated: boolean
  target: "brokerage_admin" | "platform" | "none"
  notified: number
}

export async function escalateExhaustedGhostLead(
  supabase: SupabaseClient,
  params: { leadId: string; brokerageId: string; attempts: number; firstName?: string | null },
): Promise<GhostEscalationResult> {
  const { leadId, brokerageId, attempts, firstName } = params
  if (!leadId || !brokerageId) return { escalated: false, target: "none", notified: 0 }

  const who = firstName ? firstName : "A qualifying lead"
  const body = `${who} has not responded after ${attempts} AI-ISA follow-ups — automated re-engagement is exhausted and has STOPPED. Decide the next move: a personal call, manual nurture, or archive.`

  const adminCount = await notifyBrokerageAdmins(supabase, brokerageId, {
    type: GHOST_EXHAUSTED_NOTIFICATION_TYPE,
    title: "AI-ISA exhausted follow-ups on a non-responding lead",
    body,
    entityType: "lead",
    entityId: leadId,
    priority: "medium",
  })
  if (adminCount > 0) return { escalated: true, target: "brokerage_admin", notified: adminCount }

  const platformCount = await notifyPlatformStaff(supabase, {
    type: GHOST_EXHAUSTED_NOTIFICATION_TYPE,
    title: "AI-ISA exhausted follow-ups; brokerage has no admin",
    body,
    entityType: "lead",
    entityId: leadId,
    priority: "medium",
  })
  return platformCount > 0
    ? { escalated: true, target: "platform", notified: platformCount }
    : { escalated: false, target: "none", notified: 0 }
}
