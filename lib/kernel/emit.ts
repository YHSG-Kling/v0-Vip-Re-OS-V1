/**
 * lib/kernel/emit.ts
 *
 * THE single canonical kernel-event emitter — does BOTH the lifecycle_events insert AND fans the
 * event into the reactor (staff notifications + marketing-trigger enrollment + canonical
 * campaign_sequences enrollment + client-portal cards). 20+ modules used to insert into
 * lifecycle_events directly and never call fanOutKernelEvent/processKernelEvent, which silently
 * suppressed every downstream channel — emit() exists so there is only ONE way to fire a kernel
 * event and no emitter can accidentally skip the fan-out again.
 *
 * Idempotency:
 *   - `dedupeKey` (when provided) — short-window soft dedupe so a re-run within the window doesn't
 *     re-insert the same event row. The reactor's downstream side (sequence cooldown,
 *     transparency-update window, portal idempotency) handles the rest. No DB-level unique index
 *     because lifecycle_events is intentionally append-only (audit log).
 *
 * Never throws — emitters are usually inside scoring/coaching/detection paths where a fan-out
 * failure must not break the primary write.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { fanOutKernelEvent } from "./event-fanout"
import { KernelEvent } from "./events"

export interface EmitKernelEventInput {
  event:        KernelEvent | string
  brokerageId:  string | null
  entityType:   string
  entityId:     string
  metadata?:    Record<string, unknown> | null
  // Optional contact-side context — when present, the reactor uses these directly instead of
  // re-resolving from the entity (saves a query and avoids resolution misses).
  contactId?:        string
  buyerContactId?:   string
  sellerContactId?:  string
  transactionId?:    string
  listingId?:        string
  agentUserId?:      string
  /** Set by sequence-engine-internal emits to break enrollment feedback loops. */
  suppressEnrollment?: boolean
  /** Optional short-window soft dedupe — same (brokerage, event, entity, dedupeKey) within N seconds
   *  is silently treated as a no-op. Use for tight loops (per-run repeats); leave undefined for
   *  ordinary one-shot emits. */
  dedupeKey?:        string
  dedupeWindowSec?:  number
}

export interface EmitKernelEventResult {
  inserted:        boolean
  lifecycleEventId: string | null
  fanOutOk:        boolean
  error:           string | null
}

/**
 * Insert a lifecycle_events row AND fan it through the reactor. This is the ONLY function
 * non-kernel modules should use to emit a kernel event — direct INSERTs are now banned (the
 * audit caught 20+ modules silently dropping notifications / sequences / portal).
 */
export async function emitKernelEvent(input: EmitKernelEventInput): Promise<EmitKernelEventResult> {
  const svc = createServiceClient()

  // Soft dedupe — short-window check via metadata.dedupe_key so tight loops can't re-fire the same
  // event. The reactor's downstream gates (transparency_updates window, sequence cooldown, portal
  // dedupe) cover the longer-term cases.
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
        .gte("created_at", since)
        .contains("metadata", { dedupe_key: input.dedupeKey })
        .limit(1)
      if (existing && existing.length > 0) {
        return { inserted: false, lifecycleEventId: existing[0].id as string, fanOutOk: true, error: null }
      }
    } catch {
      // dedupe is best-effort — fall through and insert
    }
  }

  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) }
  if (input.dedupeKey) metadata.dedupe_key = input.dedupeKey

  let lifecycleEventId: string | null = null
  try {
    const { data, error } = await svc
      .from("lifecycle_events")
      .insert({
        brokerage_id: input.brokerageId,
        entity_type:  input.entityType,
        entity_id:    input.entityId,
        event_type:   input.event as string,
        metadata,
      })
      .select("id")
      .single()
    if (error) {
      return { inserted: false, lifecycleEventId: null, fanOutOk: false, error: error.message }
    }
    lifecycleEventId = (data?.id as string) ?? null
  } catch (e) {
    return { inserted: false, lifecycleEventId: null, fanOutOk: false, error: (e as Error).message }
  }

  // Only the typed KernelEvent values reach fanOut — free-form lifecycle strings (audit-only) still
  // get persisted but don't trigger notifications/sequences/portal (the reactor itself guards this).
  let fanOutOk = true
  if (input.brokerageId) {
    try {
      await fanOutKernelEvent({
        event:            input.event as KernelEvent,
        brokerageId:      input.brokerageId,
        entityType:       input.entityType,
        entityId:         input.entityId,
        lifecycleEventId: lifecycleEventId ?? undefined,
        contactId:        input.contactId,
        buyerContactId:   input.buyerContactId,
        sellerContactId:  input.sellerContactId,
        transactionId:    input.transactionId,
        listingId:        input.listingId,
        agentUserId:      input.agentUserId,
        metadata:         metadata as Record<string, any>,
      })
    } catch (e) {
      fanOutOk = false
      console.error("[emitKernelEvent] fan-out failed:", e)
    }
  }

  return { inserted: true, lifecycleEventId, fanOutOk, error: null }
}
