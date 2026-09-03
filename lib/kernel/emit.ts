/**
 * lib/kernel/emit.ts
 *
 * THE single canonical kernel-event emitter — does BOTH the lifecycle_events insert AND fans the
 * event into the reactor (staff notifications + canonical campaign_sequences enrollment +
 * client-portal cards + every reactor handler). Direct `.from("lifecycle_events").insert(...)`
 * writes are banned outside this file: the audit row lands, and nothing downstream ever hears it
 * (the owner's ruling: an event that reaches the audit table but never the reactor is a broken
 * cooperation between managers).
 *
 * ONE VOCABULARY (CLAUDE.md §6). Four spellings of "fire a kernel event" used to coexist and were
 * folded onto this one on 2026-09-03:
 *   · `fanOutKernelEvent` (lib/kernel/event-fanout.ts) — a thin forwarder to processKernelEvent
 *     for callers that had ALREADY inserted their own row. Retired; those callers now pass
 *     `skipInsert: true` here. Tombstone at lib/kernel/event-fanout.ts (search "TOMBSTONE").
 *   · `processKernelEvent` (lib/kernel/notification-engine.ts) — the funnel this function feeds.
 *     It stays as the reactor's INTERNAL entry (staff bell → dispatchKernelEvent); it never
 *     inserts a row, so a product module calling it directly is audit-less. New code calls
 *     emitKernelEvent; the remaining direct callers are the funnel's own kernel neighbours.
 *   · `dispatchKernelEvent` (lib/kernel/event-reactor.ts) — reactor internals; one caller
 *     (processKernelEvent). Never called from product code.
 *
 * What the merge added to this function that the others had and it lacked:
 *   · `suppressEnrollment` was declared on the input and NEVER forwarded (the sequence engine's
 *     feedback-loop guard silently did nothing through this path). Forwarded now.
 *   · `actorUserId` / `agentId` / `source` / `createdAt` — the audit columns direct inserters were
 *     writing (lifecycle_events.actor_user_id FKs users(id); agent_id is agents-class; source has a
 *     CHECK of ui|webhook|system|cron, default 'system'). Without them a converted inserter would
 *     have lost the "who" of its own audit row.
 *   · `skipInsert` + `lifecycleEventId` — the row-already-written entry point (the old
 *     fanOutKernelEvent contract). `complianceEventId` / `activityId` pass through unchanged.
 *   · `dedupeKey` now writes the live `dedupe_key` column (indexed: idx_le_dedupe) instead of a
 *     second spelling inside metadata — lib/events/event-helpers.ts and app/actions/orchestrator.ts
 *     already keyed on the column, so the two dedupe vocabularies are one.
 *
 * THE FAN-OUT GATE. Only typed KernelEvent values fan out. A free-form lifecycle string (an
 * audit-only "ai_isa_contact_email_sent", a dotted orchestrator event) is persisted and stops
 * there: processKernelEvent has NO such guard of its own — its defaultRulesForEvent would bell
 * the assigned agent for any string it is handed — so the guard the header used to CLAIM lived
 * "in the reactor" lives here, where it can be read.
 *
 * Idempotency:
 *   - `dedupeKey` (when provided) — short-window soft dedupe so a re-run within the window doesn't
 *     re-insert the same event row. The reactor's downstream side (sequence cooldown,
 *     transparency-update window, portal idempotency) handles the rest. No DB-level unique index
 *     because lifecycle_events is intentionally append-only (audit log).
 *
 * Never throws — emitters are usually inside scoring/coaching/detection paths where a fan-out
 * failure must not break the primary write. The insert's own refusal IS reported (supabase-js
 * resolves refusals, §3): `error` carries it and `inserted` is false.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { processKernelEvent } from "./notification-engine"
import { KernelEvent } from "./events"

/** lifecycle_events.source — live CHECK `lifecycle_events_source_check`. */
export type LifecycleEventSource = "ui" | "webhook" | "system" | "cron"

/** KernelEvent string values — the only events that reach the reactor. */
const VALID_KERNEL_EVENTS = new Set<string>(Object.values(KernelEvent))

export function isKernelEventValue(event: string): event is KernelEvent {
  return VALID_KERNEL_EVENTS.has(event)
}

export interface EmitKernelEventInput {
  event:        KernelEvent | string
  brokerageId:  string | null
  entityType:   string
  entityId:     string
  metadata?:    Record<string, unknown> | null
  // ── Audit-row identity (the columns direct inserters used to write) ──────────────────────
  /** users.id of the human/actor who caused the event → lifecycle_events.actor_user_id (FK users). */
  actorUserId?:  string | null
  /** agents.id → lifecycle_events.agent_id (agents-class column; NOT a users.id). */
  agentId?:      string | null
  /** lifecycle_events.source; defaults to the column default ('system'). */
  source?:       LifecycleEventSource
  /** Explicit row timestamp (e.g. the archivedAt the outcome already carries); defaults to now(). */
  createdAt?:    string
  // ── Optional contact-side context — when present, the reactor uses these directly instead of
  //    re-resolving from the entity (saves a query and avoids resolution misses). ───────────────
  contactId?:        string
  buyerContactId?:   string
  sellerContactId?:  string
  transactionId?:    string
  listingId?:        string
  /** users.id of the acting agent for portal attribution; defaults to actorUserId. */
  agentUserId?:      string
  /** Set by sequence-engine-internal emits to break enrollment feedback loops. */
  suppressEnrollment?: boolean
  /** Optional short-window soft dedupe — same (event, entity, dedupeKey) within N seconds is
   *  silently treated as a no-op. Use for tight loops (per-run repeats); leave undefined for
   *  ordinary one-shot emits. Written to the `dedupe_key` column. */
  dedupeKey?:        string
  dedupeWindowSec?:  number
  // ── Row-already-written entry point (the retired fanOutKernelEvent contract) ─────────────────
  /** The caller has ALREADY inserted its lifecycle_events row (a kernel command that writes the
   *  row inside a Promise.all, a wrapper that owns its own insert). Skip the insert and only fan
   *  out. Pass `lifecycleEventId` when you have it so the reactor can cross-link. */
  skipInsert?:       boolean
  lifecycleEventId?: string
  complianceEventId?: string
  activityId?:        string
}

export interface EmitKernelEventResult {
  inserted:        boolean
  lifecycleEventId: string | null
  fanOutOk:        boolean
  error:           string | null
}

/**
 * Insert a lifecycle_events row AND fan it through the reactor. This is the ONLY function
 * non-kernel modules should use to emit a kernel event — direct INSERTs are banned (the
 * 2026-09-03 sweep found 40+ modules silently dropping notifications / sequences / portal).
 */
export async function emitKernelEvent(input: EmitKernelEventInput): Promise<EmitKernelEventResult> {
  const svc = createServiceClient()
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) }

  let lifecycleEventId: string | null = input.lifecycleEventId ?? null
  let inserted = false

  if (!input.skipInsert) {
    // Soft dedupe — short-window check on the dedupe_key column so tight loops can't re-fire the
    // same event. The reactor's downstream gates (transparency_updates window, sequence cooldown,
    // portal dedupe) cover the longer-term cases.
    if (input.dedupeKey) {
      const windowSec = Math.max(1, Math.min(3600, input.dedupeWindowSec ?? 60))
      const since = new Date(Date.now() - windowSec * 1000).toISOString()
      try {
        const { data: existing } = await svc
          .from("lifecycle_events")
          .select("id")
          .eq("event_type", input.event as string)
          .eq("entity_type", input.entityType)
          .eq("entity_id", input.entityId)
          .eq("dedupe_key", input.dedupeKey)
          .gte("created_at", since)
          .limit(1)
        if (existing && existing.length > 0) {
          return { inserted: false, lifecycleEventId: existing[0].id as string, fanOutOk: true, error: null }
        }
      } catch {
        // dedupe is best-effort — fall through and insert
      }
    }

    // Only the columns the caller supplied are written, so the database defaults (created_at
    // now(), source 'system', payload '{}') apply exactly as they did for the direct inserters.
    const row: Record<string, unknown> = {
      brokerage_id: input.brokerageId,
      entity_type:  input.entityType,
      entity_id:    input.entityId,
      event_type:   input.event as string,
      metadata,
    }
    if (input.actorUserId !== undefined) row.actor_user_id = input.actorUserId
    if (input.agentId     !== undefined) row.agent_id      = input.agentId
    if (input.source      !== undefined) row.source        = input.source
    if (input.createdAt   !== undefined) row.created_at    = input.createdAt
    if (input.dedupeKey   !== undefined) row.dedupe_key    = input.dedupeKey

    try {
      const { data, error } = await svc
        .from("lifecycle_events")
        .insert(row)
        .select("id")
        .single()
      if (error) {
        return { inserted: false, lifecycleEventId: null, fanOutOk: false, error: error.message }
      }
      lifecycleEventId = (data?.id as string) ?? null
      inserted = true
    } catch (e) {
      return { inserted: false, lifecycleEventId: null, fanOutOk: false, error: (e as Error).message }
    }
  }

  // THE GATE — see the header. Free-form lifecycle strings are audit-only; typed KernelEvents
  // reach staff notifications, sequence enrollment, portal cards and every reactor handler.
  let fanOutOk = true
  if (input.brokerageId && isKernelEventValue(input.event as string)) {
    try {
      await processKernelEvent({
        event:             input.event as KernelEvent,
        brokerageId:       input.brokerageId,
        entityType:        input.entityType,
        entityId:          input.entityId,
        lifecycleEventId:  lifecycleEventId ?? undefined,
        complianceEventId: input.complianceEventId,
        activityId:        input.activityId,
        contactId:         input.contactId,
        buyerContactId:    input.buyerContactId,
        sellerContactId:   input.sellerContactId,
        transactionId:     input.transactionId,
        listingId:         input.listingId,
        agentUserId:       input.agentUserId ?? input.actorUserId ?? undefined,
        metadata,
        suppressEnrollment: input.suppressEnrollment,
      })
    } catch (e) {
      fanOutOk = false
      console.error("[emitKernelEvent] fan-out failed:", e)
    }
  }

  return { inserted, lifecycleEventId, fanOutOk, error: null }
}
