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
