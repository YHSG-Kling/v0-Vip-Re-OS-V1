/**
 * lib/managers/teamwork-metrics.ts
 *
 * TEAMWORK METRICS (round 35) — how well the managers actually work TOGETHER,
 * rolled up from the ledgers the cross-management rail already writes:
 *
 *   · the REFERRAL ledger — manager_signals rows with signal_type
 *     'cross_manager_referral' (raise → consume lifecycle, timestamps included);
 *   · the DELIBERATION ledger — the payload.deliberation records persisted onto
 *     those same rows by lib/managers/deliberation.ts.
 *
 * PURE rollup (rollupTeamwork) over rows a thin loader fetches — no parallel state,
 * no new table: handed-off count, resolved count, median time-to-pickup, deliberations
 * held, dissents recorded, per period. Mounted on the QBR (composeTeamworkLines,
 * omit-when-empty) and as a compact card on the manager-trust governance surface.
 * NOT server-only (simulator-driven).
 */

import { createServiceClient } from "@/lib/supabase/service"
import { parseDeliberation } from "@/lib/managers/deliberation"

type Svc = ReturnType<typeof createServiceClient>

/** The referral-ledger row shape the rollup folds (manager_signals columns). */
export interface ReferralLedgerRow {
  status: string
  created_at: string
  consumed_at: string | null
  payload: Record<string, unknown> | null
}

export interface TeamworkMetrics {
  /** Window length the rows were loaded over (label math, not a filter). */
  periodDays: number
  /** Referrals raised onto the bus in the period. */
  handedOff: number
  /** Referrals the receiving manager consumed (acted on, incl. governed refusals). */
  resolved: number
  /** Median hours from raise to pickup over the resolved rows (null = none resolved). */
  medianPickupHours: number | null
  /** Full argued deliberations held (positions + winner + why on the ledger). */
  deliberationsHeld: number
  /** Deliberations that honestly recorded 'unavailable' (model unreachable). */
  deliberationsUnavailable: number
  /** Honest dissents recorded where a losing position had merit. */
  dissentsRecorded: number
}

/** PURE: median of a numeric list (average of the middle pair on even counts). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** PURE: fold the referral+deliberation ledger rows into the period's metrics. */
export function rollupTeamwork(rows: ReferralLedgerRow[], periodDays: number): TeamworkMetrics {
  let resolved = 0, deliberationsHeld = 0, deliberationsUnavailable = 0, dissentsRecorded = 0
  const pickupHours: number[] = []
  for (const r of rows) {
    if (r.status === "consumed") {
      resolved += 1
      if (r.consumed_at) {
        const h = (new Date(r.consumed_at).getTime() - new Date(r.created_at).getTime()) / 3_600_000
        if (Number.isFinite(h) && h >= 0) pickupHours.push(h)
      }
    }
    const d = parseDeliberation(r.payload)
    if (d) {
      if (d.status === "resolved") {
        deliberationsHeld += 1
        if (d.dissent) dissentsRecorded += 1
      } else {
        deliberationsUnavailable += 1
      }
    }
  }
  const med = median(pickupHours)
  return {
    periodDays,
    handedOff: rows.length,
    resolved,
    medianPickupHours: med === null ? null : Math.round(med * 10) / 10,
    deliberationsHeld,
    deliberationsUnavailable,
    dissentsRecorded,
  }
}

/** Speak an hour count the way a person would ("35 minutes" / "4.5 hours" / "3 days"). */
function fmtHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`
  if (h < 48) return `${Math.round(h * 10) / 10} hours`
  return `${Math.round(h / 24)} days`
}

/**
 * PURE: the QBR's teamwork section — [] when the managers had nothing cross-managed
 * in the period (omit-when-empty: a silent quarter never fabricates teamwork lines).
 */
export function composeTeamworkLines(m: TeamworkMetrics): string[] {
  if (m.handedOff === 0 && m.deliberationsHeld === 0 && m.deliberationsUnavailable === 0) return []
  const lines: string[] = []
  lines.push(
    `${m.handedOff} cross-manager referral${m.handedOff === 1 ? "" : "s"} crossed the bus — ${m.resolved} picked up and acted on` +
    (m.medianPickupHours !== null ? ` (median pickup ${fmtHours(m.medianPickupHours)})` : "") + ".",
  )
  if (m.deliberationsHeld > 0) {
    lines.push(
      `${m.deliberationsHeld} deliberation${m.deliberationsHeld === 1 ? "" : "s"} held — the involved managers each argued a grounded position and the resolution states why the winner beat the others` +
      (m.dissentsRecorded > 0
        ? `; ${m.dissentsRecorded} honest dissent${m.dissentsRecorded === 1 ? "" : "s"} on the record.`
        : "."),
    )
  }
  if (m.deliberationsUnavailable > 0) {
    lines.push(`${m.deliberationsUnavailable} deliberation${m.deliberationsUnavailable === 1 ? " was" : "s were"} honestly recorded unavailable (model unreachable) — no canned arguments were substituted.`)
  }
  return lines
}

/** Load the period's referral rows off the ONE ledger and roll them up. */
export async function loadTeamworkMetrics(
  brokerageId: string,
  opts: { days?: number; now?: Date } = {},
  client?: Svc,
): Promise<TeamworkMetrics> {
  const svc = client ?? createServiceClient()
  const days = opts.days ?? 90
  const sinceIso = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000).toISOString()
  const { data } = await svc
    .from("manager_signals")
    .select("status, created_at, consumed_at, payload")
    .eq("brokerage_id", brokerageId)
    .eq("signal_type", "cross_manager_referral")
    .gte("created_at", sinceIso)
    .limit(1000)
  return rollupTeamwork((data ?? []) as ReferralLedgerRow[], days)
}
