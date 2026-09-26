// lib/vendor-governance/budget-visibility.ts
// Role-scoped redaction for vendor-spend governance. PRIVACY CONTRACT:
//   • Platform staff (superadmin, support) see full detail — spend, ceiling, %,
//     and per-vendor breakdown (vendor NAMES included).
//   • Brokerage / subscriber users see ONLY a coarse status level and, when the
//     superadmin has enabled it, a "you're approaching your usage limit" warning.
//     They NEVER see dollar amounts, the budget ceiling, percentages, or any
//     vendor names. Vendors are platform-internal.
// Pure — no I/O — so the redaction is unit-tested deterministically.
//
// ─── A DEGRADED VERDICT IS NOT A CLEAN BILL OF HEALTH (wave 21) ─────────────
// `checkVendorBudget` fails OPEN by design: when the plan-tier read or the
// month-to-date ledger read is refused it returns `allowed: true` with the
// degradation flags set. This function took `VendorBudgetEval` — the narrower
// supertype — so those flags were discarded AT THE BOUNDARY BY THE SIGNATURE,
// not missing from the data: `VendorBudgetResult extends VendorBudgetEval`, and
// both production callers hand one straight in. Two consequences, and the second
// is the one that reads as reassurance:
//
//   1. PlatformBudgetView rendered `spent` / `budget` / `percent` as measured
//      fact. With `degradedTier` set, `budget` is the assumed solo_agent ceiling
//      and `percent` is computed against it — so the support console showed
//      platform staff a ceiling and a percentage that were never read, formatted
//      identically to ones that were.
//   2. `allowed: true` → `budgetLevel` → `"ok"`. A brokerage was shown a clean
//      bill of health for a verdict that measured nothing.
//
// THE PRIVACY CONTRACT ABOVE IS UNTOUCHED, AND THIS DOES NOT FIGHT IT. A
// degradation flag is not a dollar amount, a ceiling, a percentage or a vendor
// name — it says HOW WELL THE ANSWER IS KNOWN, not WHAT THE ANSWER IS. So it can
// reach BrokerageBudgetView without leaking a single number, and nothing here
// starts surfacing amounts to brokerages in order to "explain" a degradation:
// that would break the contract, not serve it.

import type { VendorBudgetEval, VendorBudgetDegradation } from "./budget-eval"

export type BudgetLevel = "ok" | "approaching" | "paused"

/**
 * HOW WELL THE VERDICT IS KNOWN. Carries no number, no ceiling and no vendor
 * name, so it is safe on BOTH sides of the privacy line.
 *
 *   measured         both halves were read. The level means what it says.
 *   assumed_ceiling  spend was measured, but the CEILING it was measured
 *                    against is a platform default — the tenant's own plan tier
 *                    was refused or its record is absent. The level is a real
 *                    comparison against a ceiling that may not be theirs.
 *   unmeasured       the spend half was never read. The verdict is fail-OPEN,
 *                    so `allowed` is true and the level is "ok" — and that "ok"
 *                    measured nothing. This is the reassuring direction, which
 *                    is the harder one to notice.
 */
export type BudgetConfidence = "measured" | "assumed_ceiling" | "unmeasured"

/**
 * Derive the confidence from the gate's degradation flags.
 *
 * Ordered worst-first on purpose. An unknown SPEND subsumes an unknown ceiling:
 * if we never learned what was spent there is nothing to compare, so naming the
 * ceiling problem instead would be the smaller of two truths reported as the
 * whole one. `degraded` (the fail-open marker) forces `unmeasured` on its own
 * rather than being assumed to imply `degradedSpend` — a verdict flagged
 * fail-open is not a measurement whatever else it carries.
 *
 * Deliberately NOT exported. Every surface gets its confidence off the view it
 * was handed, so there is exactly one place the derivation happens and no
 * caller can compute a second opinion about the same verdict.
 */
function budgetConfidence(d: VendorBudgetDegradation): BudgetConfidence {
  if (d.degradedSpend || d.degraded) return "unmeasured"
  if (d.degradedTier) return "assumed_ceiling"
  return "measured"
}

/** Coarse status from a budget evaluation (no numbers leak through this). */
export function budgetLevel(e: Pick<VendorBudgetEval, "allowed" | "softWarning">): BudgetLevel {
  if (!e.allowed) return "paused"
  if (e.softWarning) return "approaching"
  return "ok"
}

// What a brokerage/subscriber user is allowed to see: a level + whether to show
// the warning banner. No spend, no ceiling, no percent, no vendor names.
export interface BrokerageBudgetView {
  scope: "brokerage"
  level: BudgetLevel
  /** Show the "approaching usage limit" banner — gated by the superadmin toggle. */
  showWarning: boolean
  /**
   * How well `level` is known. The ONLY thing a degraded verdict may tell a
   * brokerage, and it is enough: a surface can say "we could not check your
   * usage right now" instead of presenting a fail-open `"ok"` as a clean bill of
   * health. No amount, no ceiling, no percentage, no vendor — the privacy
   * contract is not weakened by an inch to carry it.
   */
  confidence: BudgetConfidence
  /**
   * May a brokerage surface SAY that the answer is not known? Exactly the same
   * shape as `showWarning` and for the same reason: `confidence` states the
   * fact, this states whether the superadmin's visibility toggle permits a
   * brokerage-facing budget surface at all.
   *
   * It has to be its own field. `showWarning` is `toggle && level !== "ok"`, and
   * an unmeasured verdict is fail-OPEN so its level IS "ok" — meaning a surface
   * reading `showWarning` alone cannot tell "the superadmin hid this" from "the
   * superadmin allowed it and there is nothing to report". Deriving the note
   * from `confidence` alone would therefore push a budget surface at brokerages
   * whose superadmin switched it off.
   */
  showConfidenceNote: boolean
}

// What platform staff (superadmin/support) see: everything.
//
// EXTENDS the degradation rather than re-listing `degraded` / `degradedTier` /
// `degradedSpend` as its own fields: a hand-copied set of the same three names
// is two declarations that agree today and drift the first time a fourth is
// added, which is the whole reason they were moved to one place.
export interface PlatformBudgetView extends VendorBudgetDegradation {
  scope: "platform"
  level: BudgetLevel
  allowed: boolean
  spent: number
  budget: number
  percent: number
  /** Per-vendor spend breakdown — vendor NAMES are platform-only. */
  vendors?: Array<{ vendor: string; spent: number }>
  /**
   * How well `spent` / `budget` / `percent` are known. Load-bearing HERE more
   * than anywhere: these three are rendered as measured fact, and under
   * `assumed_ceiling` the ceiling is the platform's solo_agent default with the
   * percentage computed against it. A support agent triaging "this brokerage is
   * at 98%" needs to know whether 98% of anything was read.
   */
  confidence: BudgetConfidence
  // WHICH half was not read arrives via `extends VendorBudgetDegradation` above
  // — staff-only detail, passed straight through from the gate's verdict rather
  // than re-derived, so the console cannot disagree with the gate about its own
  // degradation. The coarse `confidence` is what crosses the privacy line; these
  // do not.
}

export type BudgetView = BrokerageBudgetView | PlatformBudgetView

/**
 * Redact a budget evaluation for the requesting actor.
 *   isPlatformStaff      → full PlatformBudgetView (vendor names allowed)
 *   else (brokerage user) → BrokerageBudgetView; warning shown only when the
 *                           superadmin toggle (showBrokerageWarning) is ON.
 */
export function redactBudgetForActor(
  // Widened from `VendorBudgetEval` to carry the degradation half. Structural, so
  // every existing caller compiles unchanged: `VendorBudgetResult` already
  // satisfies it (that is why the flags were AT the call site all along, being
  // dropped by this signature), and a bare `evaluateVendorBudget` result
  // satisfies it too because every degradation field is optional.
  e: VendorBudgetEval & VendorBudgetDegradation,
  opts: {
    isPlatformStaff: boolean
    showBrokerageWarning: boolean
    vendors?: Array<{ vendor: string; spent: number }>
  },
): BudgetView {
  const level = budgetLevel(e)
  const confidence = budgetConfidence(e)
  if (opts.isPlatformStaff) {
    return {
      scope: "platform",
      level,
      allowed: e.allowed,
      spent: e.spent,
      budget: e.budget,
      percent: e.percent,
      vendors: opts.vendors,
      confidence,
      degraded: e.degraded,
      degradedTier: e.degradedTier,
      degradedSpend: e.degradedSpend,
    }
  }
  return {
    scope: "brokerage",
    level,
    // Only surface the banner when superadmin enabled it AND there's something to warn about.
    //
    // Deliberately NOT widened to fire on a degraded verdict. An unmeasured
    // verdict is fail-open, so `level` is "ok" and there is nothing to warn
    // ABOUT — inventing an "approaching your limit" banner out of a read failure
    // would be fabricating the very claim the gate could not make, in the
    // alarming direction this time. `confidence` is what says the answer is not
    // known, and the surface decides what to do with that.
    showWarning: opts.showBrokerageWarning && level !== "ok",
    confidence,
    showConfidenceNote: opts.showBrokerageWarning && confidence !== "measured",
  }
}
