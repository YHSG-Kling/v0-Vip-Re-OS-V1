// lib/kernel/consult-outcome-resolver.ts
//
// CONSULT OUTCOME RESOLVER (live) — closes the consensus-memory loop. The huddle records a second
// opinion (manager_signals: second_opinion_requested) BEFORE a strategic play; when the play later
// reaches a terminal outcome (a deal closes, a listing sells, an offer is accepted — or the play
// fails), this resolves the open huddle: it records whether the consulted manager's read was proven
// right onto ai_feedback_log (via recordConsultOutcome), so the track record builds itself instead of
// staying empty. Idempotent per signal (a resolved huddle is never re-recorded). Best-effort.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { recordConsultOutcome } from "./consensus-memory-runner"

type Svc = ReturnType<typeof createServiceClient>

export interface ResolveConsultInput {
  brokerageId: string
  /** the relationship the play was about — matches the huddle's contact_id. */
  contactId?: string | null
  /** the entity the play was about (a listing/transaction) — matches the huddle's entity_id. */
  entityId?: string | null
  /** restrict to one play type (e.g. only resolve "offer_strategy"); omit to resolve all open huddles. */
  playType?: string | null
  /** did the play work out? true → the consulted manager's read is credited correct. */
  success: boolean
}

export interface ResolveConsultResult {
  resolved: number
  consults: string[]
}

/**
 * Resolve the open second-opinion huddles for an entity once the play's outcome is known. For each
 * matching, not-yet-resolved second_opinion_requested signal, record the consulted manager's verdict
 * and mark the signal resolved so it's recorded exactly once. Never throws.
 */
export async function resolveConsultOutcomes(input: ResolveConsultInput, client?: Svc): Promise<ResolveConsultResult> {
  const svc = client ?? createServiceClient()
  const out: ResolveConsultResult = { resolved: 0, consults: [] }
  if (!input.brokerageId || (!input.contactId && !input.entityId)) return out

  let q = svc.from("manager_signals")
    .select("id, to_manager, contact_id, entity_id, entity_type, payload, status, consumed_action")
    .eq("brokerage_id", input.brokerageId)
    .eq("signal_type", "second_opinion_requested")
    .neq("status", "consumed")
    .limit(50)
  // Match the play's entity — by contact and/or by entity id.
  if (input.contactId && input.entityId) {
    q = q.or(`contact_id.eq.${input.contactId},entity_id.eq.${input.entityId}`)
  } else if (input.contactId) {
    q = q.eq("contact_id", input.contactId)
  } else if (input.entityId) {
    q = q.eq("entity_id", input.entityId)
  }
  const { data: signals } = await q
  const rows = (signals ?? []) as Array<{ id: string; to_manager: string | null; contact_id: string | null; entity_id: string | null; entity_type: string | null; payload: Record<string, unknown> | null }>
  if (rows.length === 0) return out

  for (const sig of rows) {
    const playType = (sig.payload?.playType as string | undefined) ?? null
    if (!playType || !sig.to_manager) continue
    if (input.playType && input.playType !== playType) continue
    // Skip if this huddle was already recorded (idempotency belt-and-suspenders alongside status).
    if (sig.payload?.outcome_recorded) continue

    const entityType = sig.contact_id ? "contact" : undefined
    const r = await recordConsultOutcome({
      brokerageId: input.brokerageId,
      consult: sig.to_manager,
      playType,
      correct: input.success,
      entityType,
      entityId: sig.contact_id ?? sig.entity_id ?? null,
    }, svc).catch(() => ({ ok: false }))
    if (!r.ok) continue

    // Mark the huddle resolved so the verdict is recorded exactly once.
    await svc.from("manager_signals").update({
      status: "consumed",
      consumed_action: `consult outcome recorded: ${sig.to_manager}'s ${playType} read proven ${input.success ? "right" : "wrong"}`,
      consumed_at: new Date().toISOString(),
      payload: { ...(sig.payload ?? {}), outcome_recorded: true, outcome_success: input.success },
    }).eq("id", sig.id).then(() => {}, () => {})

    out.resolved++
    if (!out.consults.includes(sig.to_manager)) out.consults.push(sig.to_manager)
  }

  return out
}
