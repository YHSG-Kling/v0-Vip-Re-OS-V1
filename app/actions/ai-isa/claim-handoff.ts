"use server"

/**
 * app/actions/ai-isa/claim-handoff.ts
 *
 * A HUMAN AGENT CLAIMS A QUALIFIED CONTACT FROM THE AI-ISA HANDOFF QUEUE.
 *
 * This is the server half of app/dashboard/voice/isa/handoff-queue-panel.tsx.
 * The panel used to perform all three writes itself, from the BROWSER, with
 * the browser supabase client — including a direct `lifecycle_events` insert of
 * KernelEvent.AI_ISA_HANDOFF_TO_AGENT. A client component cannot reach the
 * kernel reactor (lib/kernel/emit.ts is server-only), so that row landed in the
 * audit table and never reached notification_rules / sequences / the reactor
 * handlers: the exact broken cooperation the owner's ruling names. The claim now
 * happens here, through emitKernelEvent.
 *
 * TENANCY (§4): tenant AND claimant come from the SESSION. The panel used to
 * receive both as props; nothing here trusts the request body for either. The
 * UPDATE carries the brokerage predicate and its rows are COUNTED (§3): a
 * wrong-tenant or already-gone qualification resolves with error === null and
 * zero rows, which is byte-identical to a claim that landed — so zero rows is
 * refused here, not reported as success.
 *
 * ID CLASSES (verified live, recorded on the panel): ai_isa_qualifications.
 * assigned_to_agent_id FKs users(id) DESPITE ITS NAME; lifecycle_events.
 * actor_user_id and notifications.user_id FK users(id). ctx.userId is a users.id.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"

export type ClaimHandoffResult =
  | { ok: true; contactId: string; notified: boolean; notifyError?: string }
  | { ok: false; error: string }

export async function claimHandoffAction(input: {
  qualificationId: string
}): Promise<ClaimHandoffResult> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return { ok: false, error: "Unauthorized" }
  }
  if (!input?.qualificationId) return { ok: false, error: "qualification_id_required" }

  const svc = createServiceClient()
  const now = new Date().toISOString()

  // 1. Persist: assign the qualification to the HUMAN AGENT taking the call.
  //    Tenant predicate on the write; rows counted (see header).
  const { data: claimed, error: assignErr } = await svc
    .from("ai_isa_qualifications")
    .update({ assigned_to_agent_id: ctx.userId, assigned_at: now })
    .eq("id", input.qualificationId)
    .eq("brokerage_id", ctx.brokerageId)
    .select("id, contact_id")
    .maybeSingle()

  if (assignErr) {
    // FAIL CLOSED — the claim did not happen; the row stays in the queue.
    return { ok: false, error: assignErr.message }
  }
  if (!claimed) {
    // Zero rows: not this tenant's qualification, or already gone. Worded like
    // "not found" so the pair is not an id-enumeration oracle.
    return { ok: false, error: "This handoff is not in your queue" }
  }
  const contactId = (claimed.contact_id as string | null) ?? null
  if (!contactId) {
    return { ok: false, error: "This qualification has no contact to hand off" }
  }

  // 2. THE KERNEL EVENT — audit row + reactor. `actor_user_id` FKs users(id).
  const emitted = await emitKernelEvent({
    event:       KernelEvent.AI_ISA_HANDOFF_TO_AGENT,
    brokerageId: ctx.brokerageId,
    entityType:  "contact",
    entityId:    contactId,
    contactId,
    actorUserId: ctx.userId,
    agentUserId: ctx.userId,
    source:      "ui",
    metadata: {
      qualification_id: input.qualificationId,
      handoff_type:     "manual_claim",
    },
  })
  if (emitted.error) {
    // The claim DID land; the audit row did not. Say so rather than hide it.
    console.error("[claimHandoffAction] AI_ISA_HANDOFF_TO_AGENT row refused:", emitted.error)
  }

  // 3. Notify the human who now owns the call. `notifications.user_id` FKs
  //    users(id); the badge-counts reader filters on the recipient's brokerage.
  const { error: notifyErr } = await svc.from("notifications").insert({
    brokerage_id: ctx.brokerageId,
    user_id:      ctx.userId,
    type:         "handoff_claimed",
    title:        "Handoff claimed",
    body:         "You claimed a qualified lead from the AI-ISA handoff queue.",
    entity_type:  "qualification",
    entity_id:    input.qualificationId,
    created_at:   now,
    is_read:      false,
  })

  return {
    ok: true,
    contactId,
    notified: !notifyErr,
    ...(notifyErr ? { notifyError: notifyErr.message } : {}),
  }
}
