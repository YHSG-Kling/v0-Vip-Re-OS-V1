#!/usr/bin/env tsx
/**
 * scripts/outcome-attribution-simulator.ts  (npm run test:outcome-attribution) — pure, no DB.
 *
 * Proves the CLOSED LEARNING LOOP attribution (lib/managers/outcome-attribution.ts) that
 * powers the new "Outcomes" dimension on the Manager Trust scorecard: REAL business outcomes
 * (strategy_outcomes for the Shopping Agent; marketing_agent_weekly_outcomes for the
 * Marketing/Campaign managers) → a 0–100 decision-effectiveness score sitting alongside the
 * Anthropic rubric pass-rate. Rubric = "met the bar"; effectiveness = "won in the real world".
 */
import {
  scoreStrategyOutcomes, scoreMarketingOutcomes, effectivenessBand,
} from "../lib/managers/outcome-attribution"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

console.log("\n[outcome attribution · pure]")

// Strategy outcomes (win-weighted: accepted=1, countered=0.5, rejected/withdrawn=0)
const allAccepted = scoreStrategyOutcomes([{ outcome: "accepted" }, { outcome: "accepted" }])
check("all accepted → 100 effectiveness", allAccepted.effectiveness === 100 && allAccepted.accepted === 2)
const mixed = scoreStrategyOutcomes([{ outcome: "accepted" }, { outcome: "countered" }, { outcome: "rejected" }, { outcome: "withdrawn" }])
check("accepted+countered+rejected+withdrawn → (1+0.5)/4 = 38%", mixed.effectiveness === 38 && mixed.missed === 2)
check("unknown outcome strings are ignored", scoreStrategyOutcomes([{ outcome: "accepted" }, { outcome: "banana" }]).total === 1)
check("avg deviation averages |deviation|", scoreStrategyOutcomes([{ outcome: "accepted", deviation_from_recommendation: -2 }, { outcome: "accepted", deviation_from_recommendation: 4 }]).avgDeviation === 3)
check("empty strategy → 0 effectiveness", scoreStrategyOutcomes([]).effectiveness === 0)

// Marketing outcomes (plan quality dominant; metrics normalize 0–1 or 0–100 → 0–100)
const m1 = scoreMarketingOutcomes([{ plan_quality_score: 0.8, realized_open_rate: 0.4, realized_click_rate: 0.1 }])
check("0–1 fractions normalize to percent", m1.avgPlanQuality === 80 && m1.avgOpenRate === 40 && m1.avgClickRate === 10)
check("effectiveness = 0.6*pq + 0.25*open + 0.15*click", m1.effectiveness === Math.round(80 * 0.6 + 40 * 0.25 + 10 * 0.15))
const m2 = scoreMarketingOutcomes([{ plan_quality_score: 75 }, { plan_quality_score: 85 }])
check("0–100 values pass through; weeks counted", m2.avgPlanQuality === 80 && m2.weeks === 2)
check("no plan quality → engagement-only effectiveness", scoreMarketingOutcomes([{ realized_open_rate: 0.5, realized_click_rate: 0.5 }]).effectiveness === 50)

// Bands (min sample to claim)
check("≥70 over min sample → proven", effectivenessBand(72, 5) === "proven")
check("45–69 → developing", effectivenessBand(50, 5) === "developing")
check("<45 → underperforming", effectivenessBand(30, 5) === "underperforming")
check("small sample → no_data regardless of score", effectivenessBand(100, 2) === "no_data")

console.log("\n──────────────────────────────────────────────────")
if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
console.log(` RESULT: ${pass} passed, 0 failed`)
console.log(" ✅ OUTCOME_ATTRIBUTION_PASS — outcomes attributed to managers → effectiveness alongside rubric")
