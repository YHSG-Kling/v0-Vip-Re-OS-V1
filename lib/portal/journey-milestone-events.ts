/**
 * lib/portal/journey-milestone-events.ts — THE EMITTER for the client-portal
 * journey's task / stage / whole-journey completion events (lane 86F2).
 *
 * THE GAP. Lane 86F routed journey.task_completed / journey.stage_completed /
 * journey.all_tasks_done to server-only reactions (lib/portal/journey-event-
 * handlers.ts), but only the first had an emitter — and nothing in the tree ever
 * decided that a STAGE or the WHOLE journey was done, so the client's "Stage
 * Complete" and "Journey Complete!" messages could not be sent.
 *
 * THE DECISION, made where the fact becomes true. completeTask
 * (app/actions/journey-tasks.ts) is the ONLY writer of a journey completion
 * (client_portal_activity, activity_type task_completed — grep finds no other,
 * sessionless or not). After it records one, this reads back — on the service
 * client, tenant-pinned — the contact's persona (contacts.contact_persona, the
 * server's value, never the browser's) and every completion, and applies the
 * pure rule lib/portal/journey-utils.ts::detectJourneyMilestones. A re-submitted
 * task (its id already recorded before) finishes nothing, so a finished stage
 * never "finishes" again; the dedupe keys are the backstop.
 *
 * THE EMITTER. lib/events/lifecycle-event-core.ts::recordLifecycleEvent — the
 * service-client core that inserts AND dispatches. Not emitEvent (the session
 * door keyed on users.brokerage_id): the actor here is often the CLIENT in their
 * own portal, and the tenant is the one requireContactAccess already VERIFIED for
 * this contact (the `brokerageId` the caller hands in). The core proves the actor
 * is a users row of that tenant or writes NULL.
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"
import { recordLifecycleEvent } from "@/lib/events/lifecycle-event-core"
import { EVENT_TYPES } from "@/lib/events/types"
import { getPersonaJourneyStages } from "@/lib/portal/persona-config"
import { detectJourneyMilestones } from "@/lib/portal/journey-utils"

export interface JourneyCompletionInput {
  contactId: string
  actorUserId: string | null
  /** The composite `${stage.id}:${task.id}` completeTask recorded. */
  taskId: string
  taskName: string
  stageId?: string | null
  stageName?: string | null
  transactionId?: string | null
  taskType?: string | null
  formData?: Record<string, unknown> | null
}

export interface JourneyEmitOutcome {
  emitted: string[]
  errors: string[]
}

export async function emitJourneyCompletionEvents(
  svc: any,
  brokerageId: string,
  input: JourneyCompletionInput,
): Promise<JourneyEmitOutcome> {
  const out: JourneyEmitOutcome = { emitted: [], errors: [] }
  if (!brokerageId) { out.errors.push("no brokerageId — journey events are never emitted untenanted"); return out }

  const emit = async (eventType: string, payload: Record<string, unknown>, dedupeKey: string) => {
    const r = await recordLifecycleEvent(svc, brokerageId, {
      user_id: input.actorUserId ?? undefined,
      event_type: eventType,
      payload,
      source: "ui",
      dedupe_key: dedupeKey,
    })
    if (!r.ok) out.errors.push(`${eventType}: ${r.error}`)
    else if (!r.deduped) out.emitted.push(eventType)
  }

  // 1. The task itself (the agent's bell). Keyed per completion row moment.
  await emit(EVENT_TYPES.JOURNEY_TASK_COMPLETED, {
    contact_id: input.contactId,
    transaction_id: input.transactionId ?? undefined,
    task_id: input.taskId,
    task_name: input.taskName,
    stage_id: input.stageId ?? undefined,
    stage_name: input.stageName ?? undefined,
    task_type: input.taskType ?? undefined,
    form_data: input.formData ?? undefined,
  }, `journey-task-${input.contactId}-${input.taskId}-${Date.now()}`)

  // 2. Did THIS completion finish a stage / the journey? Server-side facts only.
  const { data: contact, error: cErr } = await svc
    .from("contacts").select("contact_persona").eq("id", input.contactId).eq("brokerage_id", brokerageId).maybeSingle()
  if (cErr) { out.errors.push(`contact persona read refused: ${cErr.message}`); return out }
  if (!contact) { out.errors.push(`contact ${input.contactId} is not in brokerage ${brokerageId}`); return out }

  const { data: rows, error: aErr } = await svc
    .from("client_portal_activity")
    .select("metadata")
    .eq("contact_id", input.contactId)
    .eq("brokerage_id", brokerageId)
    .eq("activity_type", "task_completed")
  // A refused read is not "nothing completed" (§3) — no milestone is claimed on it.
  if (aErr) { out.errors.push(`completion read refused: ${aErr.message}`); return out }

  const ids: string[] = []
  for (const row of rows ?? []) {
    const t = ((row as { metadata?: Record<string, unknown> }).metadata ?? {}).task_id
    if (typeof t === "string") ids.push(t)
  }
  const firstCompletion = ids.filter((t) => t === input.taskId).length === 1
  const persona = (contact.contact_persona as string | null) || "first_time_buyer"
  const stages = getPersonaJourneyStages(persona).map((s) => ({ id: s.id, name: s.name, tasks: s.tasks.map((t) => ({ id: t.id })) }))
  const m = detectJourneyMilestones(stages, new Set(ids), input.taskId, firstCompletion)

  if (m.stage) {
    await emit(EVENT_TYPES.JOURNEY_STAGE_COMPLETED, {
      contact_id: input.contactId,
      transaction_id: input.transactionId ?? undefined,
      stage_id: m.stage.id,
      stage_name: m.stage.name,
      next_stage_name: m.stage.nextName ?? undefined,
    }, `journey-stage-${input.contactId}-${m.stage.id}`)
  }
  if (m.allDone) {
    await emit(EVENT_TYPES.JOURNEY_ALL_TASKS_DONE, {
      contact_id: input.contactId,
      transaction_id: input.transactionId ?? undefined,
      persona,
    }, `journey-complete-${input.contactId}-${persona}`)
  }
  return out
}
