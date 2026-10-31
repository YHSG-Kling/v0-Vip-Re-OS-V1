"use server"

// app/actions/movement-signals.ts — THE LEAD DESK'S MOVEMENT-SIGNAL DOOR (wave 147, lane 147Z — closes lane 147I's U1 for
// movement_signals + movement_source_polls and lane 147B's "Still open" 4: "an agent / broker marking a movement record
// false_positive or declined needs a UI or action").
//
// Every export is a public HTTP endpoint (CLAUDE.md §4): the tenant comes from the SESSION, the seat must be on the ONE lead-desk
// roster (lib/intent/movement-signals.ts MOVEMENT_RAW_SIGNAL_VIEWERS = lib/auth/lead-visibility.ts LEAD_DESK_USER_TYPES — m892's
// RLS mirrors it), and only THEN does the service client read. A person may close a record only as `false_positive` or
// `declined` — the automatic outcomes (listed / purchased / moved / opted_out / no_change) stay the reconciler's, from what
// actually happened. The write is lib/intent/movement-signals.ts recordMovementOutcome: ledgered once per record
// (intent.movement_signal.outcome), tenant-pinned, an UPDATE that matched nothing counted as a refusal.

import { revalidatePath } from "next/cache"

const PERSON_OUTCOMES = ["false_positive", "declined"] as const
type PersonOutcome = (typeof PERSON_OUTCOMES)[number]

async function leadDeskSeat(): Promise<{ ok: true; brokerageId: string; userId: string; role: string } | { ok: false; error: string }> {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  if (!ctx.brokerageId || !ctx.userId) return { ok: false, error: "Not authenticated" }
  const { MOVEMENT_RAW_SIGNAL_VIEWERS } = await import("@/lib/intent/movement-signals")
  // Fail closed: an unresolved role is the empty string, which the roster refuses.
  if (!MOVEMENT_RAW_SIGNAL_VIEWERS.has(String(ctx.role ?? ""))) return { ok: false, error: "Movement signals are a lead-desk view (broker, admin, team lead or ISA seats)." }
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId, role: String(ctx.role) }
}

/** This tenant's movement records (newest first) and the published freshness of each no-push source. */
export async function listMovementSignalsAction(opts: { openOnly?: boolean } = {}) {
  try {
    const seat = await leadDeskSeat()
    if (!seat.ok) return { success: false as const, error: seat.error }
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { listMovementRecordsForLeadDesk, movementSourceFreshness } = await import("@/lib/intent/movement-signals")
    const [recs, fresh] = await Promise.all([
      listMovementRecordsForLeadDesk(svc as never, { brokerageId: seat.brokerageId, openOnly: opts.openOnly === true, limit: 100 }),
      movementSourceFreshness(svc as never, seat.brokerageId),
    ])
    if (recs.error) return { success: false as const, error: recs.error }
    return { success: true as const, records: recs.records, sources: fresh.sources, freshnessNote: fresh.error }
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : "Failed to load movement signals" }
  }
}

/** A lead-desk person closes ONE record: it was wrong (`false_positive`) or the person declined help (`declined`). */
export async function markMovementSignalOutcomeAction(signalId: string, outcome: string, note?: string) {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(String(signalId ?? ""))) return { success: false as const, error: "Invalid movement record id" }
    if (!(PERSON_OUTCOMES as readonly string[]).includes(outcome)) return { success: false as const, error: `A person may record only ${PERSON_OUTCOMES.join(" or ")}` }
    const seat = await leadDeskSeat()
    if (!seat.ok) return { success: false as const, error: seat.error }
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { recordMovementOutcome } = await import("@/lib/intent/movement-signals")
    const r = await recordMovementOutcome(createServiceClient() as never, {
      brokerageId: seat.brokerageId, signalId, outcome: outcome as PersonOutcome,
      evidence: { by: "lead_desk", user_type: seat.role, ...(note && note.trim() ? { note: note.trim().slice(0, 300) } : {}) },
      actor: { type: "user", userId: seat.userId },
    })
    if (r.status !== "recorded") return { success: false as const, error: r.reason }
    revalidatePath("/dashboard/intelligence/movement-signals")
    return { success: true as const, outcome }
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : "Failed to record the outcome" }
  }
}
