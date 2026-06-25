// lib/lead-assignment/unassigned-escalation.ts
// ─────────────────────────────────────────────────────────────────────────────
// The TOP rungs of the assignment cascade. resolveAgentForContact already cascades
// agent → rules → team → team-lead → brokerage load-balance, but when it finds NO
// eligible agent it returns null and the qualified, CONSENTED lead used to sit
// ownerless and invisible (no contact created) until the stale detector noticed 7+
// days later — and if the brokerage still has no active agent, it just loops.
//
// This closes that dead-end: when the AI ISA qualifies a lead but assignment can't
// place it, ESCALATE to the people who can fix it — the brokerage broker/admins
// (activate an agent / fix the assignment rules). If the brokerage has no broker/admin
// either (a provisioning gap), fall through to PLATFORM staff. Deduped to one alert
// per lead per day. A hot, qualified lead is never silently ownerless again.

import type { SupabaseClient } from "@supabase/supabase-js"
import { notifyBrokerageAdmins } from "@/lib/notifications/brokerage-admins"
import { notifyPlatformStaff } from "@/lib/notifications/platform-staff"

export const UNASSIGNED_LEAD_NOTIFICATION_TYPE = "qualified_lead_unassigned"

export interface UnassignedEscalationResult {
  escalated: boolean
  target: "brokerage_admin" | "platform" | "none"
  notified: number
  reason?: string
}

/**
 * escalateUnassignedQualifiedLead — surface a qualified lead that assignment couldn't
 * place. Broker/admins first; platform staff if the brokerage has none. Deduped on a
 * recent notification for this lead. Best-effort, never throws into the ISA flow.
 */
export async function escalateUnassignedQualifiedLead(
  supabase: SupabaseClient,
  params: { leadId: string; brokerageId: string; reason?: string | null; score?: number | null; nowMs?: number },
): Promise<UnassignedEscalationResult> {
  const { leadId, brokerageId, reason, score } = params
  if (!leadId || !brokerageId) return { escalated: false, target: "none", notified: 0, reason: "missing lead/brokerage" }
  try {
    // Dedup: one escalation per lead per day.
    const nowMs = params.nowMs ?? Date.now()
    const since = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString()
    const { data: recent } = await supabase
      .from("notifications")
      .select("id")
      .eq("type", UNASSIGNED_LEAD_NOTIFICATION_TYPE)
      .eq("entity_id", leadId)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle()
    if (recent) return { escalated: false, target: "none", notified: 0, reason: "already escalated today" }

    const scoreNote = typeof score === "number" ? ` (qualification score ${Math.round(score)})` : ""
    const title = "A qualified lead has no agent to receive it"
    const body = `An AI-ISA-qualified, consented lead${scoreNote} couldn't be assigned — no eligible active agent${reason ? ` (${reason})` : ""}. Activate an agent or adjust the assignment rules so this lead is worked before it goes cold.`

    const adminCount = await notifyBrokerageAdmins(supabase, brokerageId, {
      type: UNASSIGNED_LEAD_NOTIFICATION_TYPE,
      title,
      body,
      entityType: "lead",
      entityId: leadId,
      priority: "high",
    })
    if (adminCount > 0) return { escalated: true, target: "brokerage_admin", notified: adminCount }

    // No broker/admin in the brokerage either — a provisioning gap the platform owns.
    const platformCount = await notifyPlatformStaff(supabase, {
      type: UNASSIGNED_LEAD_NOTIFICATION_TYPE,
      title: `Brokerage has no admin to receive a qualified lead`,
      body: `${body} The brokerage has no broker/admin user — platform provisioning attention needed.`,
      entityType: "lead",
      entityId: leadId,
      priority: "high",
    })
    return platformCount > 0
      ? { escalated: true, target: "platform", notified: platformCount }
      : { escalated: false, target: "none", notified: 0, reason: "no broker/admin or platform staff to notify" }
  } catch (e) {
    return { escalated: false, target: "none", notified: 0, reason: `escalation error: ${(e as Error).message}` }
  }
}
