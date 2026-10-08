/**
 * lib/events/lifecycle-event-core.ts — THE lifecycle_events writer that feeds the
 * orchestrator, callable with no session (lane 86F, owner follow-up).
 *
 * THE DEFECT. lib/events/event-helpers.ts::logEventAndTrigger built
 * createServerClient() — the COOKIE client — to insert the lifecycle_events row
 * and then handed it to the registered orchestrator dispatcher. Its sessionless
 * callers have no cookie:
 *   · app/api/webhooks/zapier/route.ts (DELETED wave 87, lane 87A — Zapier is outbound-only;
 *     tombstone in lib/providers/webhook-contract.ts)
 *   · app/api/webhooks/dotloop/route.ts (which also passed NO brokerage_id)
 *   · lib/esign-webhooks/finalize-packet.ts
 *   · lib/forms/esign-execution-loop.ts
 * so under RLS the insert was refused, the helper THREW, and nothing dispatched —
 * the event-bus reactions lane 86F moved onto server-only cores could not be
 * reached from the very webhooks that emit their events. Three of those callers
 * also passed a CONTACTS id as `user_id`, which lands on
 * lifecycle_events.actor_user_id — a users(id) FK — so the row was refused a
 * second way (23503) even on a client that could write it.
 *
 * THE SHAPE (template lib/transactions/dotloop-document-sync.ts): server-only,
 * the SERVICE client, a VERIFIED brokerageId handed in by the caller — the
 * webhook's signature-bound row (client_documents / buyer_broker_agreements /
 * offers / documents) — the Zapier connection record was the fourth, retired with
 * the inbound Zapier route in wave 87 — or the SESSION's brokerage (logEventAndTrigger, the session door). Never a
 * request body. Then:
 *   · the dedupe read is pinned `.eq("brokerage_id", brokerageId)`;
 *   · the actor is PROVEN — a users row in this tenant — or written as NULL (a
 *     contacts id is never an actor, §3; it rides payload.contact_id instead);
 *   · the insert is COUNTED (`.select("id")`; zero rows is a refusal, returned);
 *   · the event is DISPATCHED: the registered orchestrator dispatcher when this
 *     process has one, otherwise orchestrateEvent imported directly — a webhook
 *     route that never loaded the orchestrator no longer lands the row and stops
 *     ("processed later" had no processor);
 *   · KernelEvent-valued types fan out to the reactor (emitKernelEvent,
 *     skipInsert), exactly as before.
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"
import type { EventInput, Event } from "./types"
import { getRegisteredEventDispatcher } from "./dispatcher-registry"

export type LifecycleEventCoreInput = Omit<EventInput, "brokerage_id">

export type LifecycleEventCoreResult =
  | { ok: true; event: Event; deduped: false; dispatched: boolean; actorDropped?: string }
  | { ok: true; eventId: string; deduped: true }
  | { ok: false; error: string }

/** The entity the row is about — explicit, else derived, else the brokerage
 *  itself (entity_id / entity_type are NOT NULL on the live table). */
function entityOf(input: LifecycleEventCoreInput, brokerageId: string): { entityId: string; entityType: string } {
  const pl = (input.payload ?? {}) as Record<string, any>
  const derivedEntityId: string | null =
    pl.contact_id ?? pl.listing_id ?? pl.video_id ?? pl.transaction_id ?? pl.offer_id ?? pl.documentId ?? pl.agreementId ?? null
  const derivedEntityType: string =
    pl.contact_id ? "contact"
    : pl.listing_id ? "listing"
    : pl.video_id ? "video"
    : pl.transaction_id ? "transaction"
    : pl.offer_id ? "offer"
    : pl.documentId ? "document"
    : pl.agreementId ? "buyer_broker_agreement"
    : "brokerage"
  return {
    entityId: input.entity_id ?? derivedEntityId ?? brokerageId,
    entityType: input.entity_type ?? (derivedEntityId ? derivedEntityType : "brokerage"),
  }
}

export async function recordLifecycleEvent(
  svc: any,
  brokerageId: string,
  input: LifecycleEventCoreInput,
  /**
   * How far back the dedupe_key read looks (lane 88D). Default 24 h, unchanged for
   * every existing caller. `null` = no window: the key names ONE occurrence for good
   * — e.g. a chain-trigger event keyed on the entity that starts the chain (a signed
   * agreement re-scanned a week later is the same agreement).
   */
  opts: { dedupeWindowHours?: number | null } = {},
): Promise<LifecycleEventCoreResult> {
  if (!brokerageId) return { ok: false, error: "lifecycle event refused: no brokerageId (the tenant must come from a verified row or the session)" }
  if (!input.event_type) return { ok: false, error: "lifecycle event refused: no event_type" }

  if (input.dedupe_key) {
    const windowHours = opts.dedupeWindowHours === undefined ? 24 : opts.dedupeWindowHours
    let dupQ = svc
      .from("lifecycle_events")
      .select("id")
      .eq("dedupe_key", input.dedupe_key)
      .eq("brokerage_id", brokerageId)
    if (windowHours !== null) dupQ = dupQ.gte("created_at", new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString())
    const { data: existing, error: dupErr } = await dupQ
      .limit(1)
    // A refused dedupe read is not "no duplicate" — writing on it could double-fire.
    if (dupErr) return { ok: false, error: `lifecycle event dedupe read refused: ${dupErr.message}` }
    const hit = (existing ?? [])[0] as { id?: string } | undefined
    if (hit?.id) return { ok: true, eventId: hit.id, deduped: true }
  }

  // THE ACTOR IS PROVEN OR NULL. actor_user_id FKs users(id); a contacts id (three
  // webhook callers passed one) or a user from another tenant is dropped, reported.
  let actorUserId: string | null = null
  let actorDropped: string | undefined
  if (input.user_id) {
    const { data: u, error: uErr } = await svc
      .from("users").select("id").eq("id", input.user_id).eq("brokerage_id", brokerageId).maybeSingle()
    if (uErr) actorDropped = `actor lookup refused: ${uErr.message}`
    else if (!u) actorDropped = `${input.user_id} is not a user of brokerage ${brokerageId} — actor written as NULL`
    else actorUserId = input.user_id
  }

  const pl = (input.payload ?? {}) as Record<string, any>
  const { entityId, entityType } = entityOf(input, brokerageId)
  const { data: row, error } = await svc
    .from("lifecycle_events")
    .insert({
      brokerage_id: brokerageId,
      actor_user_id: actorUserId,
      event_type: input.event_type,
      metadata: pl, // lifecycle_events carries the payload on metadata (payload column defaults {})
      source: input.source,
      dedupe_key: input.dedupe_key ?? null,
      processed: false,
      entity_id: entityId,
      entity_type: entityType,
    })
    .select()
    .maybeSingle()
  if (error) return { ok: false, error: `lifecycle_events insert refused: ${error.message}` }
  if (!row) return { ok: false, error: "lifecycle_events insert returned no row — nothing to dispatch" }

  // Dispatch the event AS GIVEN (the persisted row's payload column is {}).
  const event = { ...(row as Event), payload: pl, user_id: actorUserId ?? undefined } as Event
  let dispatched = false
  try {
    const registered = getRegisteredEventDispatcher()
    if (registered) {
      await registered(event)
    } else {
      const { orchestrateEvent } = await import("@/lib/orchestrator/internal")
      await orchestrateEvent(event)
    }
    dispatched = true
  } catch (err) {
    console.error(`[lifecycle-event-core] dispatch of ${input.event_type} failed (row persisted):`, err)
  }

  // KernelEvent-valued types reach the reactor too (row already written → skipInsert).
  try {
    const { emitKernelEvent, isKernelEventValue } = await import("@/lib/kernel/emit")
    if (isKernelEventValue(input.event_type)) {
      await emitKernelEvent({
        event: input.event_type,
        brokerageId,
        entityType,
        entityId,
        lifecycleEventId: (row as Event).id,
        contactId: typeof pl.contact_id === "string" ? pl.contact_id : undefined,
        transactionId: typeof pl.transaction_id === "string" ? pl.transaction_id : undefined,
        listingId: typeof pl.listing_id === "string" ? pl.listing_id : undefined,
        agentUserId: actorUserId ?? undefined,
        metadata: pl,
        skipInsert: true,
      })
    }
  } catch (err) {
    console.error("[lifecycle-event-core] kernel fan-out failed (row persisted):", err)
  }

  return { ok: true, event, deduped: false, dispatched, ...(actorDropped ? { actorDropped } : {}) }
}
