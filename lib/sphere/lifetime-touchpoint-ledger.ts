/**
 * lib/sphere/lifetime-touchpoint-ledger.ts — THE ONE writer of a SENT lifetime_customer_touchpoints
 * row and THE ONE emitter of LIFETIME_CUSTOMER_TOUCHPOINT_SENT (wave 104, lane 104E; closes the
 * wave-103 open item "LIFETIME_CUSTOMER_TOUCHPOINT_SENT has no emitter (award rides ANNIVERSARY_TRIGGERED)").
 *
 * SURVIVORS CONSOLIDATED HERE (OS-CONSTITUTION LAW 2 — one canonical path, never a fourth):
 *   · app/actions/lifetime-customer-touchpoints.ts — sendAnniversaryMessage / sendBirthdayMessage /
 *     sendReferralRequest each inserted their own status 'sent' row after the dispatcher accepted the
 *     send (the daily lifetime-customer-touchpoints cron and the UI both ride them);
 *   · app/actions/lifetime-customers.ts logTouchpoint — the manual "I touched this client" log, which
 *     already NAMED the kernel event in its activity echo and never emitted it — and sendMarketUpdate's
 *     in_app market_update row.
 *   Those five inserts now call recordLifetimeTouchpointSent. The SCHEDULED rows (lib/kernel/transactions.ts
 *   on close, the annual home-value report's pending_review rows) are not sends and stay where they are —
 *   this ledger records a touch that HAPPENED.
 *
 * THE EVENT: one emitKernelEvent per recorded send — entity contact, metadata.agent_id = the agents.id
 * that kept the touch (lib/gamification/lifecycle-awards.ts resolves the acting agent from it), so the
 * reactor's LIFETIME_TOUCHPOINT_KEPT award (once per contact per year) now rides the touch itself
 * instead of ANNIVERSARY_TRIGGERED (a date the calendar fired, not a touch the agent kept).
 *
 * Fail honest (CLAUDE.md §3): the insert is `.select()`ed and its error read; a refused row returns
 * { ok: false } and emits NOTHING (no evidence of a send that was not recorded). A refused emit is
 * logged, never thrown — the ledger row is the record of the send and already stands.
 *
 * Not server-only: proof-driven with an injected client (scripts/gamification-guard.ts); the emitter
 * (server-only) is lazy-imported at the call.
 */

import { KernelEvent } from "@/lib/kernel/events"

type Client = { from: (table: string) => any }

export interface RecordLifetimeTouchpointInput {
  brokerageId: string
  contactId: string
  /** agents.id (lifetime_customer_touchpoints.agent_id → agents) — never a users.id. */
  agentId: string | null
  /** lifetime_customer_touchpoints.touchpoint_type (home_anniversary | birthday | referral_request | …). */
  touchpointType: string
  /** lifetime_customer_touchpoints.channel — the live CHECK's vocabulary (email | sms | in_app | …). */
  channel: string
  engagementData?: Record<string, unknown>
  /** lifecycle_events.source — 'cron' for the daily sweep, 'ui' for a human's click. */
  source?: "ui" | "cron" | "system"
  /** users.id of the human who sent it (UI); null for the cron. */
  actorUserId?: string | null
}

export type RecordLifetimeTouchpointResult =
  | { ok: true; touchpoint: Record<string, unknown>; emitted: boolean }
  | { ok: false; error: string }

/** The metadata every LIFETIME_CUSTOMER_TOUCHPOINT_SENT carries — ONE shape for every reader.
 *  @proofSeam PURE — the proof asserts the reactor can resolve the acting agent from it. */
export function lifetimeTouchpointEventMetadata(p: { touchpointId: string; agentId: string | null; touchpointType: string; channel: string }) {
  return { touchpoint_id: p.touchpointId, agent_id: p.agentId, touchpoint_type: p.touchpointType, channel: p.channel }
}

export async function recordLifetimeTouchpointSent(client: Client, input: RecordLifetimeTouchpointInput): Promise<RecordLifetimeTouchpointResult> {
  const today = new Date().toISOString().split("T")[0]
  const { data, error } = await client
    .from("lifetime_customer_touchpoints")
    .insert({
      brokerage_id: input.brokerageId,
      contact_id: input.contactId,
      agent_id: input.agentId,
      touchpoint_type: input.touchpointType,
      channel: input.channel,
      engagement_data: input.engagementData ?? {},
      status: "sent",
      scheduled_date: today,
      sent_date: today,
    })
    .select()
    .single()
  if (error) return { ok: false, error: error.message }
  const row = (data ?? {}) as Record<string, unknown>

  let emitted = false
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    const res = await emitKernelEvent({
      event: KernelEvent.LIFETIME_CUSTOMER_TOUCHPOINT_SENT,
      brokerageId: input.brokerageId,
      entityType: "contact",
      entityId: input.contactId,
      contactId: input.contactId,
      agentId: input.agentId,
      actorUserId: input.actorUserId ?? null,
      source: input.source ?? "system",
      metadata: lifetimeTouchpointEventMetadata({ touchpointId: String(row.id ?? ""), agentId: input.agentId, touchpointType: input.touchpointType, channel: input.channel }),
      client,
    })
    emitted = !res.error
    if (res.error) console.error(`[lifetime-touchpoint-ledger] LIFETIME_CUSTOMER_TOUCHPOINT_SENT did not emit for contact ${input.contactId}: ${res.error}`)
  } catch (err) {
    console.error("[lifetime-touchpoint-ledger] emit threw (the touchpoint row already stands):", err instanceof Error ? err.message : String(err))
  }
  return { ok: true, touchpoint: row, emitted }
}
