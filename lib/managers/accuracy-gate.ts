// lib/managers/accuracy-gate.ts
//
// ACCURACY-DRIVEN AUTONOMY (owner round 36, approved rec 4) — the PREDICTIVE
// half of the earned-autonomy story. The existing ratchet grants autonomy from
// BEHAVIORAL evidence (consecutive approvals → grants; eval outcomes → posture).
// This gate adds the missing question: is the system's PREDICTIVE track record
// in that manager's domain actually good enough to act unattended?
//
// POLICY (deliberate, stated):
//   · The gate consults the domain's accuracy rail (lib/analytics/
//     prediction-accuracy — the same honest ledgers the trust panel shows) and
//     holds an AUTONOMOUS action when the rail has not earned the bar:
//     fewer than MIN observations, or a measured error above the threshold.
//     Below the bar the action STAYS SUPERVISED (routes to the approval queue)
//     with the measured reason stated — the same numbers the broker sees.
//   · It applies ONLY when the manager's effective posture is an EXPLICIT
//     'autonomous' — the decision point's standing guarantee ("absence of data
//     ⇒ allow; an unconfigured manager keeps working") is preserved. Granted
//     autonomy becomes accuracy-contingent; ungoverned/unconfigured flows are
//     untouched.
//   · It NEVER overrides a halt: the god switch and the per-tenant staff halt
//     resolve to approval_required BEFORE this gate is even consulted, and in
//     the pure decision they are checked first.
//   · It NEVER grants autonomy — it can only downgrade allow → held. A strong
//     rail changes nothing for a manager the broker keeps supervised.
//   · Rail READ failures fail OPEN with the verdict 'no_signal' (an infra
//     hiccup never silently freezes a consented, already-compliance-gated
//     send) — but a rail that READS FINE with zero graded outcomes is an
//     affirmative "not earned yet" and holds. Accuracy is earned, not assumed.
//
// Pure verdict logic is separated from I/O so the simulator proves the exact
// policy dispatch enforces.

import type { ManagerKey } from "@/lib/kernel/manager-registry"
import {
  loadRailAccuracy,
  type AccuracyRailId,
  type RailAccuracy,
  type RailMedianError,
} from "@/lib/analytics/prediction-accuracy"
import { createServiceClient } from "@/lib/supabase/service"

// ─── Policy (pure data) ──────────────────────────────────────────────────────

export type AccuracyDomain = "pricing" | "marketing_content"

export interface AccuracyGatePolicy {
  domain: AccuracyDomain
  label: string
  rail: AccuracyRailId
  /** Minimum graded observations before the rail can earn autonomy. */
  minObservations: number
  /** Bar on the rail's own median-error metric (unit must match the rail's). */
  maxMedianError?: { value: number; unit: RailMedianError["unit"]; describe: string }
  /** Bar on the rail's source-defined within-rate, where one exists. */
  minWithinRate?: { value: number; describe: string }
}

export const ACCURACY_GATE_MIN_OBSERVATIONS = 5

export const ACCURACY_GATE_POLICIES: Record<AccuracyDomain, AccuracyGatePolicy> = {
  pricing: {
    domain: "pricing",
    label: "Pricing",
    rail: "listing_price",
    minObservations: ACCURACY_GATE_MIN_OBSERVATIONS,
    maxMedianError: {
      value: 0.05,
      unit: "pct_of_sale",
      describe: "median pricing miss ≤ 5% of the eventual sale price",
    },
  },
  marketing_content: {
    domain: "marketing_content",
    label: "Marketing content",
    rail: "content_performance",
    minObservations: ACCURACY_GATE_MIN_OBSERVATIONS,
    maxMedianError: {
      value: 15,
      unit: "score_points",
      describe: "median engagement-score miss ≤ 15 points (0–100 scale)",
    },
  },
}

/** Which governed managers act in an accuracy-gated domain. Managers absent
 *  here have no mapped prediction rail — the gate is not applicable to them. */
export const MANAGER_ACCURACY_DOMAIN: Partial<Record<ManagerKey, AccuracyDomain>> = {
  listing_concierge: "pricing",
  campaign_orchestrator: "marketing_content",
}

// ─── Pure verdict ────────────────────────────────────────────────────────────

export type AccuracyGateState = "earned" | "supervised" | "no_signal" | "not_applicable"

export interface AccuracyGateVerdict {
  domain: AccuracyDomain | null
  railId: AccuracyRailId | null
  railLabel: string | null
  state: AccuracyGateState
  observations: number
  /** The measured evidence (or its absence), phrased for the governance panel. */
  reason: string
}

const fmtMetric = (m: RailMedianError): string => {
  switch (m.unit) {
    case "usd": return `$${Math.round(m.value).toLocaleString("en-US")}`
    case "pct_of_sale": return `${(m.value * 100).toFixed(1)}%`
    case "days": return `${Math.round(m.value)} days`
    case "people": return `${Math.round(m.value)} people`
    case "score_points": return `${Math.round(m.value)} pts`
    case "probability_pts": return `${Math.round(m.value)} prob. pts`
  }
}

/**
 * PURE: decide whether a domain's rail has EARNED autonomous action.
 * rail === null means the rail could not be read at all → 'no_signal' (fail
 * open, stated); an available-but-thin or off-the-bar rail → 'supervised'.
 */
export function accuracyGateVerdict(policy: AccuracyGatePolicy, rail: RailAccuracy | null): AccuracyGateVerdict {
  const base = { domain: policy.domain, railId: policy.rail, railLabel: rail?.label ?? null }
  if (rail == null) {
    return {
      ...base,
      state: "no_signal",
      observations: 0,
      reason: `The ${policy.rail} accuracy rail could not be read — verdict unknown; actions are not held on an infra hiccup.`,
    }
  }
  if (!rail.available || rail.observations < policy.minObservations) {
    return {
      ...base,
      state: "supervised",
      observations: rail.observations,
      reason: `${policy.label} autonomy stays supervised — the ${policy.rail} rail has ${rail.observations} graded outcome${rail.observations === 1 ? "" : "s"}; ${policy.minObservations} are required before unattended action. Every send routes to the approval queue until the track record exists.`,
    }
  }
  if (policy.maxMedianError) {
    const m = rail.medianError
    if (!m || m.unit !== policy.maxMedianError.unit) {
      return {
        ...base,
        state: "supervised",
        observations: rail.observations,
        reason: `${policy.label} autonomy stays supervised — the ${policy.rail} rail reports no comparable median-error metric for the bar (${policy.maxMedianError.describe}).`,
      }
    }
    if (m.value > policy.maxMedianError.value) {
      return {
        ...base,
        state: "supervised",
        observations: rail.observations,
        reason: `${policy.label} autonomy stays supervised — measured median miss is ${fmtMetric(m)} over ${rail.observations} graded outcomes; the bar is ${policy.maxMedianError.describe}.`,
      }
    }
  }
  if (policy.minWithinRate) {
    const w = rail.withinRate
    if (!w || w.rate < policy.minWithinRate.value) {
      return {
        ...base,
        state: "supervised",
        observations: rail.observations,
        reason: `${policy.label} autonomy stays supervised — within-tolerance rate is ${w ? Math.round(w.rate * 100) + "%" : "unmeasured"} over ${rail.observations} graded outcomes; the bar is ${policy.minWithinRate.describe}.`,
      }
    }
  }
  return {
    ...base,
    state: "earned",
    observations: rail.observations,
    reason: `${policy.label} autonomy is accuracy-backed — ${rail.observations} graded outcomes${rail.medianError ? `, median miss ${fmtMetric(rail.medianError)}` : ""}${rail.withinRate ? `, ${Math.round(rail.withinRate.rate * 100)}% within the source tolerance` : ""}.`,
  }
}

/** PURE: verdict → the hold shape autonomyDecision consumes. Only 'supervised' holds. */
export function accuracyHold(verdict: AccuracyGateVerdict): { held: boolean; reason: string | null } {
  return verdict.state === "supervised"
    ? { held: true, reason: verdict.reason }
    : { held: false, reason: null }
}

// ─── I/O — tenant-scoped rail reads with a short cache ───────────────────────

type Svc = ReturnType<typeof createServiceClient>
const verdictCache = new Map<string, { value: AccuracyGateVerdict; expiresAt: number }>()
const VERDICT_TTL_MS = 5 * 60_000 // accuracy moves at closing speed, not send speed

const NOT_APPLICABLE: AccuracyGateVerdict = {
  domain: null,
  railId: null,
  railLabel: null,
  state: "not_applicable",
  observations: 0,
  reason: "No prediction rail maps to this manager's domain — the accuracy gate does not apply.",
}

/** Verdict for one domain, tenant-scoped (autonomy is earned per brokerage from ITS outcomes). */
export async function loadAccuracyGateVerdict(
  brokerageId: string,
  domain: AccuracyDomain,
  client?: Svc,
): Promise<AccuracyGateVerdict> {
  const key = `${brokerageId}:${domain}`
  const hit = verdictCache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const policy = ACCURACY_GATE_POLICIES[domain]
  let rail: RailAccuracy | null = null
  try {
    const svc = client ?? createServiceClient()
    rail = await loadRailAccuracy(svc as any, policy.rail, brokerageId)
  } catch {
    rail = null // fail open → 'no_signal'
  }
  const value = accuracyGateVerdict(policy, rail)
  verdictCache.set(key, { value, expiresAt: Date.now() + VERDICT_TTL_MS })
  return value
}

/** The verdict for a MANAGER (resolves its domain; unmapped ⇒ not_applicable). */
export async function loadAccuracyGateForManager(
  brokerageId: string,
  managerKey: ManagerKey,
  client?: Svc,
): Promise<AccuracyGateVerdict> {
  const domain = MANAGER_ACCURACY_DOMAIN[managerKey]
  if (!domain) return NOT_APPLICABLE
  return loadAccuracyGateVerdict(brokerageId, domain, client)
}

/** Dispatch-shaped helper: the { held, reason } input autonomyDecision consumes.
 *  HOLD TELEMETRY (round 37): when the caller arms `telemetry.record` (dispatch
 *  does — it is the enforcement site), a held verdict is ALSO ledgered via
 *  recordAccuracyGateHold, fire-and-forget, so the hold that is enforced and
 *  the hold that is surfaced are derived from the SAME verdict — no drift. */
export async function loadAccuracyHoldForManager(
  brokerageId: string,
  managerKey: ManagerKey,
  client?: Svc,
  telemetry?: { record: boolean; systemSource?: string },
): Promise<{ held: boolean; reason: string | null }> {
  const verdict = await loadAccuracyGateForManager(brokerageId, managerKey, client)
  const hold = accuracyHold(verdict)
  if (hold.held && telemetry?.record) {
    // Fire-and-forget, fail-open — telemetry never blocks or fails the dispatch.
    void recordAccuracyGateHold({ brokerageId, managerKey, verdict, systemSource: telemetry.systemSource }, client)
  }
  return hold
}

/** Every domain's verdict — the governance-panel read. */
export async function loadAccuracyGateReport(
  brokerageId: string,
  client?: Svc,
): Promise<AccuracyGateVerdict[]> {
  const domains = Object.keys(ACCURACY_GATE_POLICIES) as AccuracyDomain[]
  return Promise.all(domains.map((d) => loadAccuracyGateVerdict(brokerageId, d, client)))
}

/** Test seam / post-write invalidation. */
export function __clearAccuracyGateCache(): void {
  verdictCache.clear()
}

// ─── HOLD TELEMETRY (round 37, owner-approved rec 3) ─────────────────────────
// Round 36 wired the gate into dispatch — holds HAPPEN but weren't surfaced.
// Every accuracy-gate hold is now ledgered on the EXISTING self_heal_events
// rail via the exact idiom the vendor-budget egress block established
// (lib/providers/dispatch.ts recordBudgetLedgerEvent): domain 'data_flow',
// outcome 'escalated' (a human is being routed in — the send waits on the
// approval queue), a subject that COLLAPSES per domain+brokerage so a burst of
// held sends folds into ONE open item in the broker's Exception Center, and
// the measured reason (the same numbers the trust panel shows) in detail.
// No new table; recording is fire-and-forget and NEVER fails a dispatch.

/** detail.flow discriminator for accuracy-hold rows on the self-heal ledger. */
export const ACCURACY_HOLD_FLOW = "accuracy_gate_hold"
/** Subject prefix — the rollup reads rows back by this, no extra state. */
export const ACCURACY_HOLD_SUBJECT_PREFIX = "accuracy_gate:"

export interface AccuracyHoldEvent {
  subject: string
  action: "none"
  outcome: "escalated"
  detail: {
    flow: typeof ACCURACY_HOLD_FLOW
    manager_key: string
    domain: AccuracyDomain | null
    rail: AccuracyRailId | null
    observations: number
    /** The measured reason — verbatim what dispatch told the caller. */
    reason: string
    system_source: string
  }
}

/** PURE: verdict → the exact ledger event shape (simulator-proven). */
export function buildAccuracyHoldEvent(args: {
  brokerageId: string
  managerKey: ManagerKey
  verdict: AccuracyGateVerdict
  systemSource?: string
}): AccuracyHoldEvent {
  return {
    subject: `${ACCURACY_HOLD_SUBJECT_PREFIX}${args.verdict.domain ?? args.managerKey}:${args.brokerageId}`,
    action: "none",
    outcome: "escalated",
    detail: {
      flow: ACCURACY_HOLD_FLOW,
      manager_key: args.managerKey,
      domain: args.verdict.domain,
      rail: args.verdict.railId,
      observations: args.verdict.observations,
      reason: args.verdict.reason,
      system_source: args.systemSource ?? "dispatch",
    },
  }
}

/** Best-effort append of one hold to the self-heal ledger. FAIL-OPEN: telemetry
 *  never blocks, delays, or fails the dispatch whose hold it records. */
export async function recordAccuracyGateHold(
  args: { brokerageId: string; managerKey: ManagerKey; verdict: AccuracyGateVerdict; systemSource?: string },
  client?: Svc,
): Promise<void> {
  try {
    const evt = buildAccuracyHoldEvent(args)
    const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
    const svc = client ?? createServiceClient()
    await recordSelfHeal(svc, {
      brokerageId: args.brokerageId,
      domain: "data_flow",
      subject: evt.subject,
      action: evt.action,
      outcome: evt.outcome,
      detail: evt.detail,
    })
  } catch { /* the dispatch result is the record of truth */ }
}

// ─── Hold rollup — the manager-trust read (holds per manager/domain per period) ──

export interface AccuracyHoldRollupRow {
  managerKey: string
  domain: string
  holds: number
  /** The most recent measured reason — the numbers behind the throttle. */
  lastReason: string
  lastAt: string
}

export interface AccuracyHoldRollup {
  windowDays: number
  totalHolds: number
  rows: AccuracyHoldRollupRow[]
}

/** PURE: fold ledger rows into the rollup. Rows whose detail.flow is not the
 *  accuracy-hold discriminator are ignored (the subject prefix is shared-rail
 *  courtesy, the flow key is the contract). */
export function foldAccuracyHolds(
  rows: Array<{ detail: Record<string, unknown> | null; created_at: string }>,
  windowDays: number,
): AccuracyHoldRollup {
  const byKey = new Map<string, AccuracyHoldRollupRow>()
  let total = 0
  for (const r of rows) {
    const d = (r.detail ?? {}) as Record<string, unknown>
    if (d.flow !== ACCURACY_HOLD_FLOW) continue
    total += 1
    const managerKey = String(d.manager_key ?? "unknown")
    const domain = String(d.domain ?? "unknown")
    const key = `${managerKey}|${domain}`
    const cur = byKey.get(key)
    if (!cur) {
      byKey.set(key, {
        managerKey,
        domain,
        holds: 1,
        lastReason: String(d.reason ?? ""),
        lastAt: r.created_at,
      })
    } else {
      cur.holds += 1
      if (r.created_at > cur.lastAt) {
        cur.lastAt = r.created_at
        cur.lastReason = String(d.reason ?? cur.lastReason)
      }
    }
  }
  return {
    windowDays,
    totalHolds: total,
    rows: [...byKey.values()].sort((a, b) => b.holds - a.holds || b.lastAt.localeCompare(a.lastAt)),
  }
}

/** Trailing-window rollup from the self-heal ledger. Returns null when the
 *  ledger could not be read — the panel says "unavailable", never fakes zero. */
export async function loadAccuracyHoldRollup(
  brokerageId: string,
  windowDays = 30,
  client?: Svc,
): Promise<AccuracyHoldRollup | null> {
  try {
    const svc = client ?? createServiceClient()
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
    const { data, error } = await svc
      .from("self_heal_events")
      .select("detail, created_at")
      .eq("brokerage_id", brokerageId)
      .eq("domain", "data_flow")
      .like("subject", `${ACCURACY_HOLD_SUBJECT_PREFIX}%`)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2000)
    if (error) return null
    return foldAccuracyHolds(
      ((data ?? []) as Array<{ detail: Record<string, unknown> | null; created_at: string }>),
      windowDays,
    )
  } catch {
    return null
  }
}
