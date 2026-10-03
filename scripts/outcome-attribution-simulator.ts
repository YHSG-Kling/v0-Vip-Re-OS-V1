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
import { attributeOutcomesToLedger } from "../lib/intelligence/roi-ledger"
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"

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

// ── WAVE 100A — decision → action → outcome → revenue (lib/intelligence/roi-ledger.ts) ──────────
// The REAL pure rule on fixtures; the kernel query and its two surfaces are checked on stripped source.
console.log("\n[ledger attribution · decision → action → outcome → revenue]")
{
  type O = Parameters<typeof attributeOutcomesToLedger>[0][number]
  type A = Parameters<typeof attributeOutcomesToLedger>[1][number]
  const T = "tenant-a", OTHER = "tenant-b", C = "contact-1", LEAD = "lead-1", DEAL = "deal-1"
  const act = (id: string, at: string, over: Partial<A> = {}): A => ({
    id, brokerage_id: T, action: "comms.email.send", status: "executed", reason_code: "NURTURE_TOUCH",
    actor_type: "manager", actor_manager_key: "ai_isa", system_source: "ai_isa", subject_type: "contact", subject_id: C,
    created_at: at, correlation_id: null, detail: {}, ...over,
  })
  const closed: O = { ref: `closed:${DEAL}`, kind: "closed", brokerageId: T, subjectIds: [C, LEAD, DEAL], at: "2026-06-01T00:00:00Z", revenueCents: 900_000 }
  const actions: A[] = [
    act("a-lead", "2026-03-01T00:00:00Z", { subject_type: "lead", subject_id: LEAD }),
    act("d-wait", "2026-04-01T00:00:00Z", { action: "lead.decision.wait", status: "skipped", reason_code: "WAIT_COOLDOWN", subject_type: "lead", subject_id: LEAD }),
    act("a-seq", "2026-05-01T00:00:00Z", { reason_code: "CAMPAIGN_STEP", actor_type: "system", actor_manager_key: null, system_source: "sequence", detail: { sequence_id: "seq-9" }, correlation_id: "chain-1" }),
    act("a-chain", "2026-05-02T00:00:00Z", { subject_type: "listing", subject_id: "listing-x", reason_code: "BUYER_PROPERTY_MATCH", correlation_id: "chain-1" }),
    act("a-after", "2026-06-02T00:00:00Z", { reason_code: "TRANSACTION_MILESTONE" }),
    act("a-other-tenant", "2026-05-15T00:00:00Z", { brokerage_id: OTHER, reason_code: "HUMAN_REQUESTED" }),
    act("a-failed", "2026-05-20T00:00:00Z", { status: "failed", reason_code: "STAFF_ALERT" }),
    act("a-too-old", "2025-10-01T00:00:00Z", { reason_code: "LIFETIME_TOUCH" }),
  ]
  const r = attributeOutcomesToLedger([closed], actions)
  const last = r.credits.filter((c) => c.model === "last_touch")
  const all = r.credits.filter((c) => c.model === "all_touch")
  const allIds = all.map((c) => c.actionId).sort()
  check("a closed deal credits the preceding ledger ACTION (last touch = the latest executed action before the deal, 100% of GCI)", last.length === 1 && last[0].actionId === "a-chain" && last[0].cents === 900_000)
  check("a closed deal credits the preceding NBA DECISION (all-touch includes the lead-stage wait)", all.some((c) => c.actionId === "d-wait" && c.decision === true && c.cents > 0))
  check("a lead-stage action earns credit for the contact's deal (lead → contact subject)", all.some((c) => c.actionId === "a-lead"))
  check("the causation/correlation chain pulls in a row about another subject (same chain)", all.some((c) => c.actionId === "a-chain"))
  check("an action AFTER the outcome gets no credit", !r.credits.some((c) => c.actionId === "a-after"))
  check("a CROSS-TENANT action is never credited", !r.credits.some((c) => c.actionId === "a-other-tenant"))
  check("a failed action earns nothing; a row outside the 180-day window earns nothing", !r.credits.some((c) => c.actionId === "a-failed" || c.actionId === "a-too-old"))
  check("all-touch is an equal split in whole cents that sums EXACTLY to the revenue", allIds.join(",") === "a-chain,a-lead,a-seq,d-wait" && all.reduce((s, c) => s + c.cents, 0) === 900_000)
  check("one read answers 'which reason code produced revenue' (last-touch rollup)", r.byReasonCode[0]?.key === "BUYER_PROPERTY_MATCH" && r.byReasonCode[0]?.lastTouchCents === 900_000 && r.byReasonCode[0]?.lastTouchOutcomes.closed === 1)
  check("…and which manager / playbook / campaign (all-touch rollups)", r.byManager.some((x) => x.key === "ai_isa" && x.allTouchCents > 0) && r.byPlaybook.some((x) => x.key === "sequence") && r.byCampaign.some((x) => x.key === "seq-9" && x.allTouchCents === 225_000))
  // POSITIVE CONTROLS — the same rule DOES credit when the excluded condition is lifted.
  const moved = attributeOutcomesToLedger([closed], [act("a-after", "2026-05-31T00:00:00Z")])
  check("POSITIVE CONTROL: the same action one day BEFORE the deal is credited", moved.credits.some((c) => c.actionId === "a-after" && c.model === "last_touch"))
  const same = attributeOutcomesToLedger([closed], [act("a-other-tenant", "2026-05-15T00:00:00Z")])
  check("POSITIVE CONTROL: the same action in the deal's own tenant is credited", same.credits.some((c) => c.actionId === "a-other-tenant"))
  const onlyDecision = attributeOutcomesToLedger([closed], [actions[1]])
  check("last touch falls back to the NBA decision only when no action preceded", onlyDecision.credits.find((c) => c.model === "last_touch")?.actionId === "d-wait")
  const none = attributeOutcomesToLedger([{ ...closed, ref: "closed:lonely", subjectIds: ["nobody"] }], actions)
  check("an outcome nothing preceded is published as uncredited (never a silent zero)", none.uncredited.includes("closed:lonely") && none.credits.length === 0)
  const reply = attributeOutcomesToLedger([{ ref: "reply:1", kind: "reply", brokerageId: T, subjectIds: [C], at: "2026-05-03T00:00:00Z", revenueCents: 0 }], actions)
  check("a reply credits only rows inside its 30-day window (the March lead touch is out)", reply.credits.some((c) => c.actionId === "a-seq") && !reply.credits.some((c) => c.actionId === "a-lead"))

  // The kernel query + its surfaces (stripped source — a tombstone is not a call site).
  const src = (p: string) => stripComments(readFileSync(p, "utf8"))
  const roi = src("lib/intelligence/roi-ledger.ts")
  const loader = roi.slice(roi.indexOf("export async function loadLedgerAttribution"))
  const reads = [...loader.matchAll(/svc\.from\("([a-z_]+)"\)([\s\S]{0,200})/g)]
  const unpinned = reads.filter((m) => !/\.eq\("brokerage_id", brokerageId\)/.test(m[2])).map((m) => m[1])
  check(`every read in the kernel query (${reads.length}) is pinned to the caller's brokerage${unpinned.length ? ` — unpinned: ${unpinned.join(",")}` : ""}`, reads.length >= 6 && unpinned.length === 0)
  check("POSITIVE CONTROL: the pin check sees an unpinned specimen", !/\.eq\("brokerage_id", brokerageId\)/.test(`.select("id").eq("id", x)`))
  const fr = src("app/actions/flight-recorder.ts")
  check("WIRED: the flight recorder card loads the attribution for a contact / deal on the SESSION tenant", /loadLedgerAttribution\(svc, brokerageId,/.test(fr) && /const brokerageId = ctx\.brokerageId/.test(fr))
  check("WIRED: the Command Center ROI tile asks for it", /generateRoiLedger\(supabase, brokerageId, 90, \{ attribution: true \}\)/.test(src("lib/kernel/command-center.ts")))
  check("RENDERED: the ROI tile and the flight recorder show it", /ledgerAttribution/.test(src("app/dashboard/admin/command-center/command-center-client.tsx")) && /attribution\??\.credits/.test(src("app/dashboard/admin/ai-audit/page.tsx")))
  console.log("  · blind spots: reads cap at 2000 rows per table per window (a larger tenant is credited on the first 2000); revenue is GCI (commission_amount ?? estimated_commission, the marketing engine's rule), not the brokerage's commission_distributions share; replies come from communications inbound + isa_outreach_log.replied_at only (SMS/voice replies that land elsewhere are not outcomes yet); the correlation hop is ONE level")
}

console.log("\n──────────────────────────────────────────────────")
if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
console.log(` RESULT: ${pass} passed, 0 failed`)
console.log(" ✅ OUTCOME_ATTRIBUTION_PASS — outcomes attributed to managers → effectiveness alongside rubric")
