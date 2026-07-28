#!/usr/bin/env tsx
/**
 * scripts/fatigue-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the REACH-OUT FATIGUE GUARD shown on the contact detail surface
 * (app/components/contact/ContactFatigueGuard.tsx, fed by @/app/actions/buyer-fatigue).
 *
 * The guard's verdict — level / "safe to reach out" / reason — is computed by the
 * pure, I/O-free lib/fatigue/fatigue-display helper. This harness exercises that
 * helper directly with no Supabase, no React, no mocks: real function, real inputs,
 * real assertions. It pins down the contract the badge relies on:
 *
 *   - score thresholds agree with calculateFatigue (moderate>=25, high>=50, critical>=75)
 *   - "safe to reach out" is true ONLY at fresh / moderate (false at high / critical)
 *   - a missing score → "Not scored", safe-by-default (never block on no data)
 *   - an active alert's own message wins as the reason (most specific signal)
 *   - a junk stored risk_level falls back to the numeric thresholds (no disagreement)
 *   - score clamps to 0..100; rejected-offer / declining-engagement reasons surface
 *
 * Run:  npx tsx scripts/fatigue-simulator.ts
 */

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  buildReachoutGuard,
  deriveRiskLevel,
  type FatigueRiskLevel,
} from "../lib/fatigue/fatigue-display"

/** Source read with comments stripped — these files quote the dead literals they retired. */
const src = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
const exists = (p: string) => existsSync(join(process.cwd(), p))

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

console.log("\nFATIGUE REACH-OUT GUARD SIMULATOR\n")

// ── 1. deriveRiskLevel cut points match calculateFatigue ────────────────────
console.log("deriveRiskLevel thresholds")
const levelCases: Array<[number, FatigueRiskLevel]> = [
  [0, "fresh"],
  [24, "fresh"],
  [25, "moderate"],
  [49, "moderate"],
  [50, "high"],
  [74, "high"],
  [80, "critical"],
  [100, "critical"],
]
for (const [score, expect] of levelCases) {
  check(`score ${score} → ${expect}`, deriveRiskLevel(score) === expect, `got ${deriveRiskLevel(score)}`)
}

// ── 2. No score → safe-by-default "Not scored" ──────────────────────────────
console.log("\nno score yet")
{
  const g = buildReachoutGuard(null, null)
  check("null score → not scored", g.hasScore === false)
  check("null score → safe to reach out", g.safeToReachOut === true)
  check("null score → 'Not scored' label", g.label === "Not scored")

  const g2 = buildReachoutGuard(
    { fatigue_score: null, risk_level: null, offers_rejected: null, engagement_trend: null },
    null,
  )
  check("null fatigue_score field → not scored", g2.hasScore === false && g2.safeToReachOut === true)
}

// ── 3. safeToReachOut is true ONLY at fresh / moderate ──────────────────────
console.log("\nsafe-to-reach-out boundary")
{
  const fresh = buildReachoutGuard(
    { fatigue_score: 10, risk_level: "fresh", offers_rejected: 0, engagement_trend: "stable" },
    null,
  )
  const moderate = buildReachoutGuard(
    { fatigue_score: 40, risk_level: "moderate", offers_rejected: 0, engagement_trend: "stable" },
    null,
  )
  const high = buildReachoutGuard(
    { fatigue_score: 65, risk_level: "high", offers_rejected: 1, engagement_trend: "declining" },
    null,
  )
  const critical = buildReachoutGuard(
    { fatigue_score: 90, risk_level: "critical", offers_rejected: 3, engagement_trend: "declining" },
    null,
  )
  check("fresh → safe", fresh.safeToReachOut === true && fresh.level === "fresh")
  check("moderate → safe", moderate.safeToReachOut === true && moderate.level === "moderate")
  check("high → NOT safe", high.safeToReachOut === false && high.level === "high")
  check("critical → NOT safe", critical.safeToReachOut === false && critical.level === "critical")
  check("high label is 'Over-contacted'", high.label === "Over-contacted")
  check("critical label is 'Critical fatigue'", critical.label === "Critical fatigue")
}

// ── 4. Active alert message wins as the reason ──────────────────────────────
console.log("\nalert message precedence")
{
  const g = buildReachoutGuard(
    { fatigue_score: 72, risk_level: "high", offers_rejected: 2, engagement_trend: "declining" },
    { alert_type: "fatigue_warning", message: "Buyer fatigue score is 72/100 (warning). 2 rejected offers." },
  )
  check("alert message used verbatim as reason", g.reason === "Buyer fatigue score is 72/100 (warning). 2 rejected offers.")
  check("still flagged not-safe", g.safeToReachOut === false)

  // Empty/whitespace alert message → fall back to computed reason
  const g2 = buildReachoutGuard(
    { fatigue_score: 65, risk_level: "high", offers_rejected: 1, engagement_trend: "declining" },
    { alert_type: "fatigue_warning", message: "   " },
  )
  check("blank alert message falls back to computed reason", g2.reason.includes("Fatigue 65/100"))
  check("computed reason mentions pausing outreach", g2.reason.includes("Consider pausing outreach"))
}

// ── 5. Computed reasons surface factors ─────────────────────────────────────
console.log("\ncomputed reason content")
{
  const g = buildReachoutGuard(
    { fatigue_score: 50, risk_level: "moderate", offers_rejected: 1, engagement_trend: "declining" },
    null,
  )
  check("mentions 1 rejected offer (singular)", g.reason.includes("1 rejected offer.") && !g.reason.includes("offers"))
  check("mentions declining engagement", g.reason.includes("Engagement is declining."))
  check("watch is safe → 'OK to reach out'", g.reason.includes("OK to reach out"))

  const gMulti = buildReachoutGuard(
    { fatigue_score: 85, risk_level: "critical", offers_rejected: 3, engagement_trend: "stable" },
    null,
  )
  check("pluralizes rejected offers", gMulti.reason.includes("3 rejected offers."))
}

// ── 6. Junk stored level falls back to numeric thresholds ───────────────────
console.log("\nrobustness")
{
  const g = buildReachoutGuard(
    { fatigue_score: 88, risk_level: "totally-bogus", offers_rejected: 0, engagement_trend: null },
    null,
  )
  check("junk risk_level → derived 'critical' from score 88", g.level === "critical" && g.safeToReachOut === false)

  // Score out of range clamps
  const gHigh = buildReachoutGuard(
    { fatigue_score: 150, risk_level: null, offers_rejected: 0, engagement_trend: null },
    null,
  )
  check("score >100 clamps to 100 → critical", gHigh.level === "critical")
  check("clamped reason shows 100/100", gHigh.reason.includes("100/100"))

  const gNeg = buildReachoutGuard(
    { fatigue_score: -20, risk_level: null, offers_rejected: 0, engagement_trend: null },
    null,
  )
  check("score <0 clamps to 0 → fresh + safe", gNeg.level === "fresh" && gNeg.safeToReachOut === true)
}

// ── ONE scorer, speaking the vocabulary the DATABASE admits ─────────────────
//
// lib/fatigue/fatigue-scorer.ts was a SECOND implementation of calculateFatigue,
// writing the same two tables with its own thresholds and its own words. All
// three of its vocabularies were rejected by live CHECK constraints, proven
// against production:
//
//   buyer_fatigue_scores.risk_level     fresh moderate high critical  ✓
//                                       watch warning                 ✗ 23514
//   buyer_fatigue_scores.engagement_trend  increasing stable declining stopped
//                                       'slowing'                     ✗
//   fatigue_alerts.alert_type           fatigue_threshold_crossed …
//                                       'fatigue_warning'/'fatigue_critical' ✗
//
// So every score in the 35–79 band, every 'slowing' trend and every alert it
// raised was silently lost — while two UI surfaces filtered on watch/warning and
// showed permanently empty columns.
console.log("\nvocabulary the live CHECKs admit")
{
  check("the duplicate scorer is gone", !exists("lib/fatigue/fatigue-scorer.ts"))
  check("its duplicate action module is gone too", !exists("app/actions/fatigue.ts"))

  const FATIGUE_SOURCES = [
    "lib/fatigue/fatigue-calculator.ts",
    "lib/fatigue/fatigue-display.ts",
    "lib/fatigue/recovery-generator.ts",
    "app/actions/buyer-fatigue.ts",
    "app/api/fatigue/cron/route.ts",
    "app/dashboard/brokerage/fatigue/brokerage-fatigue-dashboard.tsx",
    "app/crm/contacts/[contactId]/components/fatigue-widget.tsx",
    "app/crm/contacts/[contactId]/components/fatigue-panel.tsx",
    "app/components/contact/ContactFatigueGuard.tsx",
  ]
  const DEAD = [
    /["']watch["']/,
    /["']warning["']/,
    /["']slowing["']/,
    /["']fatigue_warning["']/,
    /["']fatigue_critical["']/,
  ]
  for (const f of FATIGUE_SOURCES) {
    const body = src(f)
    const hit = DEAD.find((re) => re.test(body))
    check(`${f} carries no CHECK-rejected literal`, !hit, hit ? `found ${hit}` : undefined)
  }

  check("the calculator writes only the four admitted risk levels",
    /return "critical"[\s\S]{0,120}return "high"[\s\S]{0,120}return "moderate"[\s\S]{0,80}return "fresh"/.test(
      src("lib/fatigue/fatigue-calculator.ts")))
  check("the badge helper derives from the SAME cut points (75/50/25)",
    deriveRiskLevel(75) === "critical" && deriveRiskLevel(50) === "high" &&
    deriveRiskLevel(25) === "moderate" && deriveRiskLevel(24) === "fresh")
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
