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
//
// WAVE 151 (lane 151E — convergence rows 28 / 29): "THE PERSON TOLD US A DATE". A lead-desk seat records a date (a lease end, a
// planned list date, a closing, a relocation start) or a timeline bucket the person themselves stated, WITH the verbatim words that
// carried it. It is VERIFIED INTENT evidence: ONE C9 record (fp_inbound_stated, reported by self, the quote on the reference, m970
// known_deadline_* / stated_timeline) on the SAME contact through lib/intent/movement-signals.ts reassessExistingContact — the
// movement manager re-decides, the forecaster places the window on the stated date (stated dates beat inferred ranges), and the
// arbiter reassesses need and timing. Never a new Lead, never a provider call. This page is NOT on app/crm/page.tsx's module graph.

import { revalidatePath } from "next/cache"

const PERSON_OUTCOMES = ["false_positive", "declined"] as const
type PersonOutcome = (typeof PERSON_OUTCOMES)[number]

const UUID = /^[0-9a-f-]{36}$/i
/** How far ahead a stated date may lie before it is a plan the desk should re-ask about (a sanity bound, not a window). */
const STATED_DATE_MAX_DAYS_AHEAD = 730

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
    // C19 (wave 148, lane 148F — owner ruling 6): the market registry's dataset verifications (platform-wide public-data facts, no
    // tenant rows) — which datasets may lend a signal above `unknown` today, and why the others may not.
    const { listMarketDatasetVerifications, VERIFICATION_TTL_DAYS, DEFAULT_MAX_LAG_DAYS } = await import("@/lib/intent/dataset-verification")
    const [recs, fresh, datasets] = await Promise.all([
      listMovementRecordsForLeadDesk(svc as never, { brokerageId: seat.brokerageId, openOnly: opts.openOnly === true, limit: 100 }),
      movementSourceFreshness(svc as never, seat.brokerageId),
      listMarketDatasetVerifications(svc as never),
    ])
    if (recs.error) return { success: false as const, error: recs.error }
    const verifications = datasets.verifications.map((v) => ({ datasetKey: v.datasetKey, label: v.label, kind: v.kind, markets: v.geography.markets, status: v.status, confidence: v.confidence, lastVerifiedAt: v.lastVerifiedAt, lastDataAt: v.freshness.lastDataAt, licence: v.licence?.class ?? "unknown", reasons: v.reasons.slice(0, 3), ingested: v.ingested }))
    // The rule the statuses are judged by, said on the screen (never a number the page restates on its own).
    const verificationPolicy = { ttlDays: VERIFICATION_TTL_DAYS, defaultMaxLagDays: DEFAULT_MAX_LAG_DAYS }
    // 151E: what re-opens a decision for an EXISTING contact (the documented doors) and the dates a person may record.
    const { EXISTING_CONTACT_CHANGE_DOORS } = await import("@/lib/intent/movement-signals")
    const { KNOWN_DEADLINE_KINDS } = await import("@/lib/intent/moving-moments")
    const changeDoors = Object.entries(EXISTING_CONTACT_CHANGE_DOORS).map(([kind, d]) => ({ kind, sourceKey: d.sourceKey, what: d.what }))
    return { success: true as const, records: recs.records, sources: fresh.sources, freshnessNote: fresh.error, verifications, verificationNote: datasets.error, verificationPolicy, changeDoors, deadlineKinds: [...KNOWN_DEADLINE_KINDS] }
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

/**
 * WAVE 151 (151E, rows 28 / 29): a lead-desk seat records a DATE the person told us — with their words. The date must be a real day
 * that has not passed (a passed date is a note, never a deadline) inside a sanity bound; the quote is required (a stated date is
 * evidence only with its source). Tenant from the SESSION; the contact is pinned to it at the record and at the decision.
 */
export async function recordStatedDateAction(input: { contactId: string; kind: string; date: string; quote: string; side?: "buyer" | "seller" | null }) {
  try {
    if (!UUID.test(String(input?.contactId ?? ""))) return { success: false as const, error: "Invalid contact id" }
    const { KNOWN_DEADLINE_KINDS } = await import("@/lib/intent/moving-moments")
    if (!(KNOWN_DEADLINE_KINDS as readonly string[]).includes(String(input.kind))) return { success: false as const, error: `The kind of date must be one of ${KNOWN_DEADLINE_KINDS.join(", ")}` }
    const quote = String(input.quote ?? "").trim()
    if (quote.length < 5) return { success: false as const, error: "Write down the words the person used — a date without its source is not evidence." }
    const at = Date.parse(String(input.date ?? ""))
    const now = Date.now()
    if (!Number.isFinite(at)) return { success: false as const, error: "That is not a date we can read." }
    if (at < now - 86_400_000) return { success: false as const, error: "That date has already passed — record it as a note, not as a deadline." }
    if (at > now + STATED_DATE_MAX_DAYS_AHEAD * 86_400_000) return { success: false as const, error: "That date is more than two years out — confirm it with the person before recording it as a deadline." }
    const seat = await leadDeskSeat()
    if (!seat.ok) return { success: false as const, error: seat.error }
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { reassessExistingContact } = await import("@/lib/intent/movement-signals")
    const nowIso = new Date(now).toISOString()
    const r = await reassessExistingContact(createServiceClient() as never, {
      brokerageId: seat.brokerageId, contactId: input.contactId, capturedBy: "staff",
      change: { kind: "stated_date", deadline: { kind: input.kind as never, at: new Date(at).toISOString() }, quote, referenceId: `lead_desk:${seat.userId}:${nowIso}`, at: nowIso, side: input.side ?? undefined },
    })
    if (r.status === "refused") return { success: false as const, error: r.reason }
    revalidatePath("/dashboard/intelligence/movement-signals")
    return { success: true as const, status: r.status, window: r.evaluation?.status === "decided" ? (r.evaluation.decision?.action ?? null) : null, reason: r.reason }
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : "Failed to record the date" }
  }
}
