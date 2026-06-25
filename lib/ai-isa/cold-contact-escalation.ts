// lib/ai-isa/cold-contact-escalation.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE COLD-CONTACT CHECKPOINT — the contact-side mirror of the ghost-lead escalation.
// When the AI ISA has auto-re-engaged a converted buyer/seller COLD_CONTACT_TOUCHES times
// with NO reply, the relationship is cold: the automation keeps nurturing (de-confliction
// caps the cadence), but the OWNING AGENT is told ONCE so a human can make the personal call
// the AI can't. Routes to the contact's agent (the human who owns the relationship), NOT the
// broker — it's an operational nudge, not an escalation up the chain. Fires once per cold
// period (deduped on a recent notification). Never throws.

import type { SupabaseClient } from "@supabase/supabase-js"

export const COLD_CONTACT_NOTIFICATION_TYPE = "contact_gone_cold"
/** One cold-contact nudge per contact per this window (don't re-nag the agent each run). */
const COLD_DEDUP_DAYS = 30

export interface ColdContactEscalationResult {
  escalated: boolean
  reason: "notified" | "deduped" | "no_agent_user" | "missing_input"
}

/**
 * escalateColdContact — notify the contact's OWNING AGENT that an auto-nurtured contact has
 * gone cold after `touches` unanswered touches; recommend a personal call. Deduped per
 * contact within COLD_DEDUP_DAYS. Resolves the agent's users.id from contacts.agent_id.
 */
export async function escalateColdContact(
  supabase: SupabaseClient,
  params: { contactId: string; brokerageId: string; agentId: string | null; touches: number; firstName?: string | null },
): Promise<ColdContactEscalationResult> {
  const { contactId, brokerageId, agentId, touches, firstName } = params
  if (!contactId || !brokerageId || !agentId) return { escalated: false, reason: "missing_input" }

  // Resolve the owning agent's user (agents.id → users.id) — the human to nudge.
  const { data: agent } = await supabase.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  const agentUserId = (agent as { user_id: string | null } | null)?.user_id ?? null
  if (!agentUserId) return { escalated: false, reason: "no_agent_user" }

  // Dedup — one nudge per contact within the window.
  const since = new Date(Date.now() - COLD_DEDUP_DAYS * 86_400_000).toISOString()
  const { data: prior } = await supabase.from("notifications").select("id")
    .eq("brokerage_id", brokerageId).eq("type", COLD_CONTACT_NOTIFICATION_TYPE)
    .eq("entity_id", contactId).gte("created_at", since).limit(1).maybeSingle()
  if (prior) return { escalated: false, reason: "deduped" }

  const who = firstName ? firstName : "A contact"
  const { error } = await supabase.from("notifications").insert({
    user_id: agentUserId, brokerage_id: brokerageId, type: COLD_CONTACT_NOTIFICATION_TYPE,
    title: "A contact has gone quiet — a personal call might help",
    body: `${who} hasn't replied after ${touches} AI follow-ups. The automation will keep a light touch going, but a quick personal call from you often re-opens the door where automation can't.`,
    entity_type: "contact", entity_id: contactId, priority: "medium", is_read: false,
  })
  return error ? { escalated: false, reason: "missing_input" } : { escalated: true, reason: "notified" }
}
