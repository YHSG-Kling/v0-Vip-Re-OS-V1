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
 * switch routes them through the registry, and the bodies live HERE. Lane 86F2
 * built the emitter for all three (lib/portal/journey-milestone-events.ts, called
 * by completeTask after it records a completion).
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
  // Ledgered portal egress (wave 98, lib/portal/portal-message-egress.ts): an AUTOMATED message,
  // at-most-once per (contact, kind, stage) — a re-processed journey event replays, never re-posts.
  const { insertPortalMessage } = await import("@/lib/portal/portal-message-egress")
  const { data, error } = await insertPortalMessage(svc, {
    contact_id: payload.contact_id,
    agent_id: anchor.agentId,
    brokerage_id: brokerageId,
    direction: "agent_to_client",
    channel: "portal",
    body,
    metadata,
    read: false,
  }, {
    actor: { type: "system" },
    reasonCode: "TRANSACTION_MILESTONE",
    reasonDetail: `journey ${String(metadata.kind ?? "message")}`,
    cycle: `journey:${String(metadata.kind ?? "message")}:${String(metadata.stage_name ?? "all")}`,
    systemSource: "journey_event_handler",
  })
  if (error || !data) return { success: false, written: 0, error: `Portal message refused: ${error?.message ?? "no row returned"}` }
  return { success: true, written: 1 }
}

/** The registered manager for the two client-message reactions (ORCHESTRATOR_EVENT_MANAGER in lib/kernel/manager-registry.ts). */
const JOURNEY_REACTION_MANAGER = "data_steward"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * WAVE 155 (lane 155R24, arbitration G03) — THE DECISION AND THE RECEIPT IN FRONT OF THE CLIENT MESSAGE. The stage and
 * journey celebrations post to a CLIENT's portal thread autonomously, and they did so with no decision of their own (the
 * egress row records the post, not whether it should happen). The lane 155R17 / 155R20 pattern: the EXISTING autonomy gate
 * (lib/managers/autonomy-gate.ts autonomyDecision) over its two halts — the platform's god switch (loadPlatformHalt) and
 * platform staff's per-tenant pause (loadTenantAutonomyHalt), both cached and fail-open by their own design — decides BEFORE
 * the post, and ONE withActionLedger receipt (`portal.journey.<kind>`, actor the registered manager, tenant the event row's,
 * subject the contact) records what happened. A HELD decision posts nothing and settles `skipped / autonomy_held` with the
 * halt's reason; the reaction reports success (a hold is not a dispatch failure) and names the hold. No idempotency key: the
 * egress below is already at-most-once per (contact, kind, stage). A refusing ledger runs the post exactly as before.
 */
async function decidedJourneyMessage(
  svc: any,
  brokerageId: string,
  payload: Record<string, any>,
  kind: "stage_completed" | "all_tasks_done",
  post: () => Promise<JourneyEventOutcome>,
): Promise<JourneyEventOutcome> {
  if (!brokerageId) return { success: false, written: 0, error: "No brokerageId — journey events are never acted on untenanted" }
  const { autonomyDecision, loadTenantAutonomyHalt } = await import("@/lib/managers/autonomy-gate")
  const { loadPlatformHalt } = await import("@/lib/platform/platform-controls")
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const decision = autonomyDecision({ managerKey: JOURNEY_REACTION_MANAGER, effective: null, platformHalt: await loadPlatformHalt(svc as never), tenantHalt: await loadTenantAutonomyHalt(brokerageId, svc as never) })
  let result: JourneyEventOutcome | null = null
  const run = async (): Promise<void> => { if (!decision.allow) return; result = await post() }
  const contactId = typeof payload?.contact_id === "string" ? payload.contact_id : null
  await withActionLedger<void>({
    brokerageId,
    action: `portal.journey.${kind}`,
    actor: { type: "manager", managerKey: JOURNEY_REACTION_MANAGER },
    subject: contactId && UUID_RE.test(contactId) ? { type: "contact", id: contactId } : { type: "contact", ref: String(contactId ?? "none") },
    riskClass: "COMMUNICATION",
    systemSource: "journey_event_handler",
    detail: { kind, stage_name: payload?.stage_name ?? null, autonomy: decision.allow ? "allow" : "held" },
  }, run, {
    settle: () => {
      const r = result as JourneyEventOutcome | null
      if (!decision.allow) return { status: "skipped", outcome: "autonomy_held", error: decision.reason }
      if (r?.success) return r.written > 0 ? { status: "executed", outcome: "message_posted" } : { status: "skipped", outcome: "nothing_to_post", error: r.error ?? null }
      return { status: "failed", outcome: "message_refused", error: r?.error ?? "the post returned no result" }
    },
    replay: (claim) => (claim.kind === "refused" ? run() : undefined),
  }, { client: svc })
  if (!decision.allow) return { success: true, written: 0, error: `held — ${decision.reason ?? "autonomy halt"}` }
  return (result as JourneyEventOutcome | null) ?? { success: false, written: 0, error: "the journey reaction did not run" }
}

/** journey.stage_completed — the client's celebration message (decided and receipted, above). */
export function reactToJourneyStageCompleted(svc: any, brokerageId: string, payload: Record<string, any>) {
  const stage = payload?.stage_name ?? "this"
  const next = payload?.next_stage_name ? ` Moving on to ${payload.next_stage_name}.` : ""
  return decidedJourneyMessage(svc, brokerageId, payload, "stage_completed", () => portalMessage(svc, brokerageId, payload,
    `Stage Complete: ${stage}\n\nCongratulations! You've completed the ${stage} stage.${next}`,
    { kind: "milestone", stage_name: payload?.stage_name ?? null }))
}

/** journey.all_tasks_done — the client's journey-complete message (decided and receipted, above). */
export function reactToJourneyAllTasksDone(svc: any, brokerageId: string, payload: Record<string, any>) {
  return decidedJourneyMessage(svc, brokerageId, payload, "all_tasks_done", () => portalMessage(svc, brokerageId, payload,
    "Journey Complete!\n\nCongratulations on completing your real estate journey! We're honored to have been part of this milestone.",
    { kind: "celebration" }))
}
