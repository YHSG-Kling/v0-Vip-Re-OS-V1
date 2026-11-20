// lib/lead-scoring/record-behavioral-event.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE WRITER OF lead_behavioral_data — the event source the canonical
// scorer's behavioural 30% never had.
//
// lib/services/lead-management.service.ts:calculateLeadScore reads this table as
//   .from("lead_behavioral_data").select("event_type, event_data, occurred_at")
//   .eq("lead_id", <contact or lead id>)
// and folds it through lib/lead-scoring/behavioral-events.ts. Until this module,
// the ONLY writer was app/actions/ai-auto-response.ts:trackBehavioralEvent —
// gated on an agent session (supabase.auth.getUser() + getAgentContext()), which
// no portal contact and no provider webhook can ever pass. So the real
// behavioural moments (a buyer staring at a listing, favoriting it, opening an
// email, texting back) produced NO rows, and the 30% behavioural refinement ran
// on an empty log for everyone.
//
// This recorder is deliberately NOT a "use server" action and carries NO auth
// gate of its own: it runs on the service client, and every call site is
// responsible for resolving identity and tenant SERVER-SIDE before calling —
//   · trackPropertyView / saveProperty resolve the contact through
//     requireContactAccess (session/invite → contact → brokerage), never the body
//   · the SendGrid event webhook resolves the contact from the provider event's
//     recipient within the brokerage the provider message id proves
//   · the inbound SMS/email router resolves the entity from the tenant-scoped
//     phone/email match its signature-verified ingress already performs
//   · the legacy trackBehavioralEvent action stays as the agent-session-gated
//     wrapper and delegates here
// Passing a caller-supplied brokerageId/contactId straight from a request body
// into this function is a tenant hole — do not add such a call site.
//
// Live schema (measured, project hrvaqgvukzxfskkcrwbt): id · lead_id (NOT NULL)
// · event_type (NOT NULL) · event_data jsonb · page_url · referrer · device_type
// · session_id · ip_address · user_agent · occurred_at · created_at ·
// brokerage_id. `lead_id` is the entity id — the scorer queries it with a
// CONTACT id for contacts and a lead id for scraped leads; both id classes land
// in the same column by design.

import { EVENT_POINTS } from "./behavioral-events"

/** Vocabulary check — the scorer weighs these types; anything else only scores
 *  through an explicit event_data.points_awarded fallback. Exported so call
 *  sites and proofs can assert they speak the scored vocabulary. */
export function isScoredEventType(eventType: string): boolean {
  return typeof EVENT_POINTS[eventType] === "number"
}

export interface RecordBehavioralEventInput {
  /** Tenant — must be SERVER-RESOLVED by the caller (gate / provider match), never taken from a request body. */
  brokerageId: string
  /** Contact id (or scraped-lead id) — lands in lead_id, the column the scorer queries. Same rule: server-resolved. */
  contactId: string
  /** Prefer the EVENT_POINTS vocabulary in lib/lead-scoring/behavioral-events.ts. */
  eventType: string
  /** Extra context, stored in event_data. */
  eventData?: Record<string, unknown>
  /** Explicit score fallback for a type outside the vocabulary — stored as event_data.points_awarded. */
  pointsAwarded?: number
  /** Event time; defaults to now. */
  occurredAt?: string
  /** Optional real columns on the log. */
  pageUrl?: string
  sessionId?: string
}

export interface RecordBehavioralEventResult {
  recorded: boolean
  reason?: string
}

/**
 * Append one behavioural event. Never throws; a refused write is logged as
 * NOT recorded and reported to the caller — supabase-js RESOLVES a refused
 * insert rather than throwing, so the error is destructured, never swallowed.
 */
export async function recordBehavioralEvent(
  input: RecordBehavioralEventInput,
): Promise<RecordBehavioralEventResult> {
  if (!input.brokerageId || !input.contactId || !input.eventType) {
    const reason = "missing brokerageId/contactId/eventType"
    console.error(`[behavioral-recorder] event NOT recorded — ${reason}`)
    return { recorded: false, reason }
  }

  // ── VOCABULARY GATE AT INTAKE ─────────────────────────────────────────────
  //
  // `isScoredEventType` was exported "so call sites and proofs can assert they
  // speak the scored vocabulary" and no call site ever did. This is that
  // assertion, made once at the door rather than five times at the callers.
  //
  // WHY REFUSING IS THE HONEST ANSWER AND NOT DATA LOSS. `lead_behavioral_data`
  // has exactly ONE reader — lib/lead-scoring/behavioral-events.ts, through the
  // canonical scorer — and it weighs a row by `EVENT_POINTS[event_type]`, falling
  // back to `event_data.points_awarded`. A row whose type is in neither scores 0
  // forever and is invisible to every surface: a write with no reader, which is
  // the orphan class CLAUDE.md §1 forbids creating. Filing it looks like success
  // and measures as nothing.
  //
  // THE DOOR THIS ACTUALLY GUARDS: four of the five call sites hard-code a scored
  // type, but app/actions/ai-auto-response.ts:trackBehavioralEvent takes
  // `eventType: string` from its caller and is a "use server" export — a public
  // HTTP endpoint (§4). It can pass anything. A caller that genuinely means an
  // unscored type still gets through by SAYING WHAT IT IS WORTH
  // (`pointsAwarded`), which is the same escape the scorer already honours — so
  // the vocabulary is enforced without inventing a second one.
  if (!isScoredEventType(input.eventType) && typeof input.pointsAwarded !== "number") {
    const reason =
      `'${input.eventType}' is not a scored event type and no pointsAwarded was supplied — ` +
      `the row would never be read by the scorer. Use a type from EVENT_POINTS ` +
      `(lib/lead-scoring/behavioral-events.ts) or state the points explicitly.`
    console.error(`[behavioral-recorder] event NOT recorded — ${reason}`)
    return { recorded: false, reason }
  }

  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()

    const eventData: Record<string, unknown> = { ...(input.eventData ?? {}) }
    if (typeof input.pointsAwarded === "number") {
      eventData.points_awarded = input.pointsAwarded
    }

    const { error } = await svc.from("lead_behavioral_data").insert({
      lead_id: input.contactId,
      brokerage_id: input.brokerageId,
      event_type: input.eventType,
      event_data: eventData,
      page_url: input.pageUrl ?? null,
      session_id: input.sessionId ?? null,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
    })

    if (error) {
      console.error(
        `[behavioral-recorder] '${input.eventType}' NOT recorded for contact ${input.contactId}:`,
        error.message,
      )
      return { recorded: false, reason: error.message }
    }

    return { recorded: true }
  } catch (err: any) {
    console.error(`[behavioral-recorder] '${input.eventType}' NOT recorded:`, err)
    return { recorded: false, reason: err?.message ?? "unexpected failure" }
  }
}
