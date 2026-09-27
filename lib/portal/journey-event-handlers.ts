/**
 * lib/portal/journey-event-handlers.ts — THE client-portal journey event
 * reactions, callable with no session (lane 86F, wave 86).
 *
 * WHAT THEY DO. When a client finishes a journey task, the agent's bell rings
 * ("Client completed: …"); when a stage or the whole journey is done, the client
 * gets a celebration message in their portal thread (client_portal_messages).
 *
 * THE DEFECT, IN THREE LAYERS.
 *   1. They lived in app/actions/journey-tasks.ts as "use server" exports on the
 *      COOKIE client. The client portal's completeTask emits
 *      journey.task_completed under the CLIENT's session, and the orchestrator's
 *      later dispatch runs with no cookie at all — neither session can write a
 *      notification for the AGENT or a message stamped as the agent, so both
 *      writes were refused under RLS (and the errors only logged).
 *   2. The orchestrator's switch had NO case for the three journey types (no
 *      EVENT_TYPES member existed), so EVENT_HANDLERS held them and nothing
 *      routed to them.
 *   3. completeTask emitted WITHOUT processImmediately, so the event was never
 *      handed to the orchestrator in the first place.
 * All three are closed in lane 86F: EVENT_TYPES gains JOURNEY_TASK_COMPLETED /
 * JOURNEY_STAGE_COMPLETED / JOURNEY_ALL_TASKS_DONE (lib/events/types.ts), the
 * switch routes them through the registry, completeTask processes its event
 * immediately, and the bodies live HERE.
 *
 * THE SHAPE (template lib/transactions/dotloop-document-sync.ts): server-only,
 * service client, the tenant is the EVENT row's brokerage_id (emitEvent stamps
 * the SESSION's brokerage, never the payload's). The contact must be in it; the
 * contact's agent (contacts.agent_id, agents-class) is crossed to its users.id
 * through agents.user_id INSIDE the tenant (§3 — resolved, never substituted).
 * Every write is counted and a refusal is returned, not logged-and-dropped.
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"

export interface JourneyEventOutcome { success: boolean; written: number; error?: string }

async function contactAnchor(
  svc: any,
  brokerageId: string,
  contactId: string | null | undefined,
): Promise<{ ok: true; agentId: string | null } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "No brokerageId — journey events are never acted on untenanted" }
  if (!contactId) return { ok: false, error: "No contact_id on the journey event" }
  const { data, error } = await svc
    .from("contacts").select("id, agent_id").eq("id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `Contact read refused: ${error.message}` }
  if (!data) return { ok: false, error: `Contact ${contactId} is not in brokerage ${brokerageId}` }
  return { ok: true, agentId: (data.agent_id as string | null) ?? null }
}

/** journey.task_completed — the agent's bell. */
export async function reactToJourneyTaskCompleted(
  svc: any,
  brokerageId: string,
  payload: Record<string, any>,
): Promise<JourneyEventOutcome> {
  const anchor = await contactAnchor(svc, brokerageId, payload?.contact_id)
  if (!anchor.ok) return { success: false, written: 0, error: anchor.error }
  if (!anchor.agentId) return { success: true, written: 0, error: "Contact has no agent — nobody to notify" }

  // agents.id → users.id, INSIDE the tenant (notifications.user_id is users-class).
  const { data: agentRow, error: agentErr } = await svc
    .from("agents").select("user_id").eq("id", anchor.agentId).eq("brokerage_id", brokerageId).maybeSingle()
  if (agentErr) return { success: false, written: 0, error: `Agent read refused: ${agentErr.message}` }
  const userId = (agentRow?.user_id as string | null) ?? null
  if (!userId) return { success: true, written: 0, error: "The contact's agent has no login in this brokerage — nobody to notify" }

  const taskName = payload?.task_name ?? "a journey task"
  const { data, error } = await svc.from("notifications").insert({
    user_id: userId,
    brokerage_id: brokerageId,
    type: "task_completed",
    title: `Client completed: ${taskName}`,
    body: `${taskName} completed${payload?.stage_name ? ` in the ${payload.stage_name} stage` : ""}.`,
    entity_type: "contact",
    entity_id: payload.contact_id,
    priority: "medium",
    channel: "in_app",
    is_read: false,
  }).select("id").maybeSingle()
  if (error || !data) return { success: false, written: 0, error: `Task-completed notification refused: ${error?.message ?? "no row returned"}` }
  return { success: true, written: 1 }
}

async function portalMessage(
  svc: any,
  brokerageId: string,
  payload: Record<string, any>,
  body: string,
  metadata: Record<string, unknown>,
): Promise<JourneyEventOutcome> {
  const anchor = await contactAnchor(svc, brokerageId, payload?.contact_id)
  if (!anchor.ok) return { success: false, written: 0, error: anchor.error }
  // client_portal_messages.agent_id / brokerage_id are NOT NULL.
  if (!anchor.agentId) return { success: true, written: 0, error: "Contact has no agent — no portal thread to post into" }
  const { data, error } = await svc.from("client_portal_messages").insert({
    contact_id: payload.contact_id,
    agent_id: anchor.agentId,
    brokerage_id: brokerageId,
    direction: "agent_to_client",
    channel: "portal",
    body,
    metadata,
    read: false,
  }).select("id").maybeSingle()
  if (error || !data) return { success: false, written: 0, error: `Portal message refused: ${error?.message ?? "no row returned"}` }
  return { success: true, written: 1 }
}

/** journey.stage_completed — the client's celebration message. */
export function reactToJourneyStageCompleted(svc: any, brokerageId: string, payload: Record<string, any>) {
  const stage = payload?.stage_name ?? "this"
  const next = payload?.next_stage_name ? ` Moving on to ${payload.next_stage_name}.` : ""
  return portalMessage(svc, brokerageId, payload,
    `Stage Complete: ${stage}\n\nCongratulations! You've completed the ${stage} stage.${next}`,
    { kind: "milestone", stage_name: payload?.stage_name ?? null })
}

/** journey.all_tasks_done — the client's journey-complete message. */
export function reactToJourneyAllTasksDone(svc: any, brokerageId: string, payload: Record<string, any>) {
  return portalMessage(svc, brokerageId, payload,
    "Journey Complete!\n\nCongratulations on completing your real estate journey! We're honored to have been part of this milestone.",
    { kind: "celebration" })
}
