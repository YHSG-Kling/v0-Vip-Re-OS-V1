/**
 * DECISION REPLAY HARNESS (wave 101, lane 101B; gap map row 20) — "if the planner ran today on
 * what it saw then, would it decide the same?"
 *
 * Survivors, extended (OWNER LAW 1 — no new engine, no new table):
 *   · the decision engine: lib/ai-isa/lead-action-plan.ts planNextLeadTouch / planNextContactTouch
 *     (pure). Replay calls planFromDecisionInput, which runs THOSE functions — never a copy;
 *   · the recorded decisions: agent_action_ledger `lead.decision.*` / `contact.decision.*` rows
 *     (recordNonAction, lib/kernel/action-ledger.ts), whose detail now carries the compact planner
 *     input (detail.decision_input, written by nonActionRecordFor's callers);
 *   · the outcomes: lib/intelligence/roi-ledger.ts loadLedgerAttribution (wave 100A) — joined so a
 *     disagreement shows what the decision that WOULD HAVE CHANGED actually earned.
 *
 * Deterministic: no model call, no clock (the snapshot's `now` is the planner's now), rows sorted.
 * Tenant: every read is pinned to `brokerageId`, which the caller takes from the SESSION; a row of
 * any other tenant that reaches the pure core is REFUSED and counted, never replayed.
 */
import { planFromDecisionInput, type DecisionInputSnapshot } from "@/lib/ai-isa/lead-action-plan"
import { loadLedgerAttribution } from "@/lib/intelligence/roi-ledger"

/** The NBA decisions the ledger records (recordNonAction: `<domain>.decision.<wait|do_nothing>`). */
const DECISION_ACTIONS = ["lead.decision.wait", "lead.decision.do_nothing", "contact.decision.wait", "contact.decision.do_nothing"] as const
const REPLAY_LIMIT = 2000
const REPLAY_COLS = "id, brokerage_id, action, status, reason_code, subject_type, subject_id, created_at, causation_id, correlation_id, detail"

export interface ReplayableLedgerRow {
  id: string
  brokerage_id: string
  action: string
  status?: string | null
  reason_code?: string | null
  subject_type: string
  subject_id?: string | null
  created_at: string
  causation_id?: string | null
  correlation_id?: string | null
  detail?: Record<string, unknown> | null
}

/** What a planner answers — the two fields replay compares. */
export type ReplayPlanner = (snap: DecisionInputSnapshot) => { reasonCode: string; action: string } | null

export interface DecisionOutcome { ref: string; kind: string; model: "last_touch" | "all_touch"; cents: number }

export interface DecisionDisagreement {
  actionId: string
  subjectType: string
  subjectId: string | null
  recordedAt: string
  recordedCode: string
  recordedAction: string
  replayedCode: string
  replayedAction: string
  causationId: string | null
  correlationId: string | null
  /** Filled by the attribution join (what this decision's row was credited with). */
  outcomes: DecisionOutcome[]
}

export interface ReasonCodeReplayRow {
  recordedCode: string
  replayed: number
  agreed: number
  disagreed: number
  /** recorded code → what the current planner says instead, counted. */
  changedTo: Record<string, number>
}

export interface DecisionReplayReport {
  brokerageId: string
  /** Rows read for this tenant + window. */
  examined: number
  replayed: number
  agreements: number
  disagreements: DecisionDisagreement[]
  /** agreements / replayed; null when nothing was replayable (never a fake 100%). */
  agreementRate: number | null
  /** The denominator's other half — published, never hidden. */
  unreplayable: { noSnapshot: number; unknownVersion: number; plannerNull: number }
  /** Rows of another tenant that reached the core — refused, never replayed. */
  crossTenantRefused: number
  byReasonCode: ReasonCodeReplayRow[]
}

const currentPlanner: ReplayPlanner = (snap) => {
  const p = planFromDecisionInput(snap)
  return p ? { reasonCode: p.reasonCode, action: p.action } : null
}

/**
 * PURE — replay recorded decisions through `planner` (default: the CURRENT pure planner).
 */
function replayLedgerDecisions(brokerageId: string, rows: readonly ReplayableLedgerRow[], planner: ReplayPlanner = currentPlanner): DecisionReplayReport {
  const report: DecisionReplayReport = {
    brokerageId, examined: 0, replayed: 0, agreements: 0, disagreements: [], agreementRate: null,
    unreplayable: { noSnapshot: 0, unknownVersion: 0, plannerNull: 0 }, crossTenantRefused: 0, byReasonCode: [],
  }
  const byCode = new Map<string, ReasonCodeReplayRow>()
  const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
  for (const r of sorted) {
    if (r.brokerage_id !== brokerageId) { report.crossTenantRefused++; continue }
    report.examined++
    const d = r.detail ?? {}
    const snap = d.decision_input as DecisionInputSnapshot | undefined
    if (!snap || typeof snap !== "object") { report.unreplayable.noSnapshot++; continue }
    if (typeof snap.v !== "number" || snap.v !== 1) { report.unreplayable.unknownVersion++; continue }
    const replay = planner(snap)
    if (!replay) { report.unreplayable.plannerNull++; continue }
    const recordedCode = String(d.plan_code ?? "UNKNOWN")
    const recordedAction = r.action.split(".").pop() ?? r.action
    report.replayed++
    const row = byCode.get(recordedCode) ?? { recordedCode, replayed: 0, agreed: 0, disagreed: 0, changedTo: {} }
    row.replayed++
    if (replay.reasonCode === recordedCode && replay.action === recordedAction) {
      report.agreements++
      row.agreed++
    } else {
      row.disagreed++
      row.changedTo[replay.reasonCode] = (row.changedTo[replay.reasonCode] ?? 0) + 1
      report.disagreements.push({
        actionId: r.id, subjectType: r.subject_type, subjectId: r.subject_id ?? null, recordedAt: r.created_at,
        recordedCode, recordedAction, replayedCode: replay.reasonCode, replayedAction: replay.action,
        causationId: r.causation_id ?? null, correlationId: r.correlation_id ?? null, outcomes: [],
      })
    }
    byCode.set(recordedCode, row)
  }
  report.agreementRate = report.replayed > 0 ? report.agreements / report.replayed : null
  report.byReasonCode = [...byCode.values()].sort((a, b) => b.disagreed - a.disagreed || b.replayed - a.replayed || a.recordedCode.localeCompare(b.recordedCode))
  return report
}

export type ReplayDecisionsResult =
  | { ok: true; report: DecisionReplayReport; ledgerAvailable: boolean; attributionError: string | null; truncated: boolean }
  | { ok: false; error: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * THE KERNEL FUNCTION. Reload the recorded decisions for one tenant + window (optionally one
 * subject), run the current planner on each, report agreements / disagreements by reason code, and
 * join 100A attribution onto the disagreements. Never throws; a refused read is SAID.
 */
export async function replayDecisions(
  input: { brokerageId: string; subject?: { type: "lead" | "contact"; id: string } | null; since: string; until?: string | null },
  opts: { client?: { from: (t: string) => any }; planner?: ReplayPlanner; attribution?: boolean } = {},
): Promise<ReplayDecisionsResult> {
  if (!input?.brokerageId || !UUID_RE.test(input.brokerageId)) return { ok: false, error: "replayDecisions requires the session's brokerageId — refusing an un-scoped replay" }
  const since = Date.parse(input.since)
  const until = input.until ? Date.parse(input.until) : Number.NaN
  if (!Number.isFinite(since)) return { ok: false, error: "Invalid `since`" }
  if (input.until && !Number.isFinite(until)) return { ok: false, error: "Invalid `until`" }
  if (input.subject && (!["lead", "contact"].includes(input.subject.type) || !UUID_RE.test(input.subject.id))) return { ok: false, error: "Invalid subject" }
  try {
    const svc = opts.client ?? (await import("@/lib/supabase/service")).createServiceClient()
    let q = svc.from("agent_action_ledger").select(REPLAY_COLS)
      .eq("brokerage_id", input.brokerageId).in("action", [...DECISION_ACTIONS])
      .gte("created_at", new Date(since).toISOString())
    if (Number.isFinite(until)) q = q.lte("created_at", new Date(until).toISOString())
    if (input.subject) q = q.eq("subject_type", input.subject.type).eq("subject_id", input.subject.id)
    const { data, error } = await q.order("created_at", { ascending: true }).limit(REPLAY_LIMIT)
    if (error) {
      const absent = error.code === "42P01" || error.code === "PGRST205" || error.code === "42703"
      if (absent) return { ok: true, report: replayLedgerDecisions(input.brokerageId, []), ledgerAvailable: false, attributionError: null, truncated: false }
      return { ok: false, error: `agent_action_ledger: ${error.message}` }
    }
    const rows = (data ?? []) as ReplayableLedgerRow[]
    const report = replayLedgerDecisions(input.brokerageId, rows, opts.planner ?? currentPlanner)

    // The 100A join — what the decisions that WOULD HAVE CHANGED earned (same tenant, same rule).
    let attributionError: string | null = null
    if (opts.attribution !== false && report.disagreements.length > 0) {
      const attr = await loadLedgerAttribution(svc, input.brokerageId, { sinceIso: new Date(since).toISOString() })
      if (!attr.ok) attributionError = attr.error
      else {
        const byAction = new Map<string, DecisionOutcome[]>()
        for (const c of attr.result.credits) {
          const list = byAction.get(c.actionId) ?? []
          list.push({ ref: c.outcomeRef, kind: c.kind, model: c.model, cents: c.cents })
          byAction.set(c.actionId, list)
        }
        for (const d of report.disagreements) d.outcomes = byAction.get(d.actionId) ?? []
      }
    }
    return { ok: true, report, ledgerAvailable: true, attributionError, truncated: rows.length >= REPLAY_LIMIT }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  }
}
