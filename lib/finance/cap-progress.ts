// lib/finance/cap-progress.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE CAP READING — dollars in the cap ledger → the percentage a bar draws
// and the vocabulary word `agent_earnings.cap_status` is CHECK-constrained to.
//
// WHY THIS FILE EXISTS. `agent_earnings.cap_status` and `.cap_progress_pct` were
// READ by two money surfaces and written by NOBODY (wave 13, opposite-missing
// class 1b):
//
//   app/actions/ai-agent-goals.ts:182       the AI goal-setter's prompt, which
//                                           printed "Cap status: Unknown" on
//                                           every agent, every year, and set
//                                           next year's GCI targets without it
//   app/dashboard/financials/reports/page.tsx:33   the agent's earnings report
//
// The earnings rollup that fills every other column of that row never looked at
// the cap ledger. The ledger itself — `agent_cap_tracking` (cap_amount,
// cap_paid_to_date, is_capped, anniversary window) — was already the canonical
// source for the agent financials page and the CDA portal, so nothing new is
// being invented here: the number is MOVED to where the reader looks.
//
// ONE FORMULA, not a second opinion. lib/kernel/financial.ts computed
// `(cap_paid_to_date / cap_amount) * 100` inline, which divides by zero for an
// uncapped agent and renders NaN%; it now calls this. A cap percentage computed
// two ways in two files is how the CDA and the dashboard end up disagreeing
// about whether an agent has capped — a disagreement that decides money.
//
// PURE and dependency-free so both a cron (service role) and a server action can
// share it without either importing the other's client.

/** The cap ledger row this reading is derived from — `agent_cap_tracking`. */
export interface CapLedgerRow {
  cap_amount: number | null
  cap_paid_to_date: number | null
  is_capped?: boolean | null
  anniversary_start?: string | null
  anniversary_end?: string | null
}

/**
 * The live CHECK on agent_earnings.cap_status:
 *   CHECK (cap_status = ANY (ARRAY['below_cap','at_cap','post_cap']))
 * A value outside it refuses the WHOLE upsert, taking every other earnings
 * column down with it — so the vocabulary is stated here, next to the only code
 * that produces it.
 */
export type CapStatus = "below_cap" | "at_cap" | "post_cap"

export interface CapReading {
  /** 0-100+, one decimal. NULL when there is no cap to measure against. */
  pct: number | null
  /** NULL when the agent has no cap window in force — "uncapped" is not a status. */
  status: CapStatus | null
}

/**
 * NULL IS A REAL ANSWER HERE. An agent with no ledger row, or a row with no cap
 * amount, is not "below_cap" — they are UNCAPPED, and writing `below_cap` would
 * tell the goal-setter and the earnings report that a ceiling exists which the
 * payout engine will never apply. Both readers already render a null as
 * "Unknown"/"no cap", which is the truthful statement.
 *
 * `post_cap` is DELIBERATELY NEVER RETURNED. The vocabulary admits it, but no
 * fact in the ledger distinguishes "has just reached the cap" from "is earning
 * beyond it" — `is_capped` says only that the ceiling has been met. Emitting it
 * on a guess would put an invented business state into a money column; the
 * absence is recorded here so the next reader knows it is a gap in the FACTS,
 * not an oversight in the mapping.
 */
export function readCapProgress(row: CapLedgerRow | null | undefined): CapReading {
  const amount = Number(row?.cap_amount ?? 0)
  const paid = Number(row?.cap_paid_to_date ?? 0)
  if (!row || !Number.isFinite(amount) || amount <= 0) return { pct: null, status: null }
  const safePaid = Number.isFinite(paid) ? Math.max(paid, 0) : 0
  const pct = Math.round((safePaid / amount) * 1000) / 10
  const capped = row.is_capped === true || safePaid >= amount
  return { pct, status: capped ? "at_cap" : "below_cap" }
}

/**
 * The ledger row in force TODAY — the same rule agent-360 states: the window
 * containing today is the cap the payout engine will actually apply. A row
 * outside its window is history, and scoring an agent against last year's cap is
 * the defect this picks its way around rather than taking "whatever came back".
 * Falls back to the most recently STARTED window only when no row covers today,
 * so a ledger that is merely stale still reports something a human can act on
 * — callers that must not do that can compare `anniversary_end` themselves.
 */
export function pickCapWindow<T extends CapLedgerRow>(rows: T[] | null | undefined, today = new Date()): T | null {
  const list = (rows ?? []).filter(Boolean)
  if (list.length === 0) return null
  const day = today.toISOString().slice(0, 10)
  const covering = list.find(
    (r) => (r.anniversary_start ?? "") <= day && (r.anniversary_end ?? "9999-12-31") >= day,
  )
  if (covering) return covering
  return [...list].sort((a, b) => String(b.anniversary_start ?? "").localeCompare(String(a.anniversary_start ?? "")))[0] ?? null
}
