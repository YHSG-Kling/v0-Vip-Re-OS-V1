/**
 * lib/ai-isa/qualification-signals.ts
 *
 * Lane 75B — split out of lib/ai-isa/customer-context-tools.ts so a second
 * file (lib/ai-isa/capability-catalogue.ts) can reuse the SAME follow-up
 * writer, agent notifier and signal publisher without an import cycle
 * (customer-context-tools.ts merges the catalogue's new tools into
 * buildCustomerFreeTools, so the catalogue cannot import customer-context-
 * tools.ts back). No behavior changed from the functions' prior home —
 * purely a relocation so both callers share ONE implementation (CLAUDE.md §6).
 */

import { createServiceClient } from "@/lib/supabase/service"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"

export interface QualificationSignalContext {
  brokerageId: string
  contactId?: string | null
  leadId?: string | null
  agentId?: string | null
}

/**
 * The SHARED write helper both the staff tool (app/api/internal/ai-chat's
 * schedule_follow_up, arbitrary contact_id) and every customer-safe follow-up
 * tool (LOCKED contact_id) call — one implementation, many call sites, never
 * a divergent insert into `activities` (CLAUDE.md §6).
 */
/** activities.activity_type carries NO database CHECK (scripts/check-
 *  vocabularies.ts) — this union is a TypeScript-level discipline only, kept
 *  in sync with what live writers actually use (app/actions/home-value.ts's
 *  listing-appointment booking already writes "listing_appointment"). */
export type FollowUpActivityType = "call" | "email" | "text" | "meeting" | "check_in" | "showing" | "listing_appointment"

export async function writeFollowUpActivity(params: {
  brokerageId: string
  agentId: string | null
  contactId: string
  activityType: FollowUpActivityType
  scheduledAt: string
  notes?: string | null
  title: string
}): Promise<{ success: true; activityId: string; scheduledAt: string } | { success: false; error: string }> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("activities")
    .insert({
      brokerage_id: params.brokerageId,
      agent_id: params.agentId,
      contact_id: params.contactId,
      activity_type: params.activityType,
      scheduled_at: params.scheduledAt,
      notes: params.notes ?? undefined,
      title: params.title,
      status: "scheduled",
    })
    .select("id, title, scheduled_at")
    .maybeSingle()
  if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
  return { success: true, activityId: data.id, scheduledAt: data.scheduled_at }
}

/**
 * scheduleFollowUp — activities.contact_id is NOT NULL (scripts/schema-
 * snapshot.ts), so a pre-conversion lead thread (leadId, no contactId yet)
 * cannot get an `activities` row; it falls back to `leads.next_followup_at`/
 * `next_followup_reason` (already writer-and-reader-live — the ISA's own
 * nurture cron reads it) rather than silently doing nothing.
 */
export async function scheduleFollowUp(
  ctx: QualificationSignalContext,
  input: { activityType: "call" | "meeting" | "showing" | "listing_appointment"; scheduledAt: string; notes: string; title: string },
): Promise<{ success: true; via: "activity" | "lead_followup"; activityId?: string } | { success: false; error: string }> {
  if (ctx.contactId) {
    const r = await writeFollowUpActivity({
      brokerageId: ctx.brokerageId,
      agentId: ctx.agentId ?? null,
      contactId: ctx.contactId,
      activityType: input.activityType,
      scheduledAt: input.scheduledAt,
      notes: input.notes,
      title: input.title,
    })
    if (!r.success) return { success: false, error: r.error }
    return { success: true, via: "activity", activityId: r.activityId }
  }
  if (ctx.leadId) {
    const svc = createServiceClient()
    const ok = await sentinelWrite(
      svc,
      svc.from("leads").update({
        next_followup_at: input.scheduledAt,
        next_followup_reason: `${input.title}${input.notes ? ` — ${input.notes}` : ""}`.slice(0, 500),
      }).eq("id", ctx.leadId).eq("brokerage_id", ctx.brokerageId),
      { table: "leads", flow: "qualification_followup", brokerageId: ctx.brokerageId },
    )
    return ok ? { success: true, via: "lead_followup" } : { success: false, error: "Lead follow-up write failed" }
  }
  return { success: false, error: "No contact or lead is linked to this conversation yet" }
}

/** Notifies the assigned agent (best-effort, never blocks the tool result). */
export async function notifyAssignedAgent(ctx: QualificationSignalContext, input: {
  type: string; title: string; body: string; entityType: "contact" | "lead"; entityId: string
}): Promise<void> {
  if (!ctx.agentId) return
  const svc = createServiceClient()
  const { data: agent } = await svc.from("agents").select("user_id").eq("id", ctx.agentId).maybeSingle()
  if (!agent?.user_id) return
  await svc.from("notifications").insert({
    user_id: agent.user_id,
    brokerage_id: ctx.brokerageId,
    type: input.type,
    title: input.title,
    body: input.body,
    priority: "medium",
    entity_type: input.entityType,
    entity_id: input.entityId,
  }).then(undefined, () => {})
}

/** Publishes a manager signal (best-effort — a failed publish never fails the
 *  tool call; the notification above + the durable write already carry the
 *  follow-up). fromManager is always "ai_isa" (every mounting surface here
 *  runs under the AI ISA's qualification job). */
export async function publishQualificationSignal(input: {
  brokerageId: string; toManager: "shopping_agent" | "listing_concierge" | "campaign_orchestrator" | "asset_manager"
  signalType: string; message: string; contactId: string | null; leadId: string | null
  payload?: Record<string, unknown>
}): Promise<void> {
  try {
    await publishManagerSignal({
      brokerageId: input.brokerageId,
      fromManager: "ai_isa",
      toManager: input.toManager,
      signalType: input.signalType,
      message: input.message,
      entityType: input.contactId ? "contact" : input.leadId ? "lead" : null,
      entityId: input.contactId ?? input.leadId ?? null,
      contactId: input.contactId ?? null,
      payload: input.payload ?? {},
    })
  } catch (e) {
    console.error(`[qualification-signals] publishQualificationSignal(${input.signalType}) failed:`, e)
  }
}
