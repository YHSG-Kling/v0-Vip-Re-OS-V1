#!/usr/bin/env tsx
/**
 * scripts/capacity-guard.ts   (npm run test:capacity) — pure, no network, no DB.
 *
 * WAVE 103 (lane 103B) — layer 6, FATIGUE / CAPACITY. Owner: "Human Intelligence … Fatigue/capacity";
 * OWNER LAWS bind (extend before replacing, ONE canonical path).
 *
 * AGENT CAPACITY IS ONE KERNEL ANSWER: `capacityFor(agent)` → { load, headroom, band, reasons }
 * (gatherer lib/lead-assignment/capacity-pick.ts, pure math lib/kernel/capacity-guardian.ts
 * computeCapacity). Its consumers never re-derive "who has room":
 *   · the assignment pick (selectAgentByCapacity — never assigns into no-headroom);
 *   · the stale-contact / contact-NBA batch (throttleTouchBatch — fewer touches when the owning
 *     agent is over);
 *   · the morning stand-up and the team-lead brief (exceptions first);
 *   · the guardian runner (the overload signal + the N-day reassignment suggestion in agent-books'
 *     validated shape, GATED on the manager bus).
 *
 *   A  pure — band matrix with positive AND negative controls; headroom; the throttle; the day count;
 *      the escalation rule; the band-aware pick
 *   B  wiring (stripped source) — one gatherer (the runner's private gatherer and the pick's private
 *      load counter are gone; `overdueTasks: 0` is gone), each consumer reads capacityFor
 *   C  contact fatigue — every outbound chokepoint (email / SMS / direct mail / video via
 *      lib/providers/dispatch.ts, phone via lib/voice/outbound-call-gates.ts, the lifetime portal
 *      cadence via app/api/cron/lifetime-customer-touchpoints) consults the over-touch engine, and
 *      the engine consults the contact scope (buyer_fatigue_scores → fatigueTemperedPolicy).
 *      Census of outbound-ledger inserters outside the dispatcher is PUBLISHED (a blind spot), not
 *      asserted
 *   D  one vocabulary — every live agent_retention_scores.tier maps to a band
 *   E  registration + ownership
 *
 * Owner: recruiting_manager (the guardian's accountable manager). Co-owners named in prose:
 * ai_isa (the stale-contact / NBA touch batch it throttles) and campaign_orchestrator (the
 * over-touch engine every contact chokepoint consults).
 */
import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { stripComments, blankStrings } from "./strip-comments"
import {
  computeCapacity, hasHeadroom, throttleTouchBatch,
  overloadDaysIn, shouldSuggestReassignment, pickLeastLoadedWithHeadroom, CAPACITY_BANDS, HIGH_LOAD, DEBT_ALARM,
  OVER_CAPACITY_ESCALATION_DAYS, AGENT_OVERLOADED_SIGNAL, AGENT_REASSIGNMENT_SUGGESTED_SIGNAL,
  type WorkloadSignals,
} from "../lib/kernel/capacity-guardian"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))
const code = (p: string) => blankStrings(src(p))
/** The body of one top-level `export … function NAME(` up to the next top-level export. */
function fnBody(stripped: string, name: string): string {
  const re = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m")
  const m = re.exec(stripped)
  if (!m) return ""
  const rest = stripped.slice(m.index + m[0].length)
  const next = rest.search(/^(?:export |async function |function )/m)
  return next === -1 ? rest : rest.slice(0, next)
}

const base = (s: Partial<WorkloadSignals> = {}): WorkloadSignals => ({ activeContacts: 10, activeLeads: 2, activeDeals: 1, staleContacts: 0, overdueTasks: 0, ...s })
const T = { maxLoad: 40 }

// ─── A. PURE ────────────────────────────────────────────────────────────────────────────────────
console.log("\nA. pure — the one capacity answer")
{
  const avail = computeCapacity(base(), T)
  check("A1 light load → available, headroom = floor(ceiling·HIGH_LOAD) − load, no reasons",
    avail.band === "available" && avail.headroom === Math.floor(40 * HIGH_LOAD) - 13 && avail.reasons.length === 0 && avail.load === 13, JSON.stringify(avail))
  const busy = computeCapacity(base({ activeContacts: 26 }), T) // 29/40 = 0.725 ≥ MED_LOAD
  check("A2 ≥ MED_LOAD → busy, still has headroom, a reason is stated", busy.band === "busy" && hasHeadroom("busy") && busy.headroom > 0 && busy.reasons.length === 1, JSON.stringify(busy))
  const atCap = computeCapacity(base({ activeContacts: 32 }), T) // 35/40 = 0.875 ≥ HIGH_LOAD
  check("A3 ≥ HIGH_LOAD → at_capacity, headroom 0, no new work", atCap.band === "at_capacity" && atCap.headroom === 0 && !hasHeadroom("at_capacity"), JSON.stringify(atCap))
  const over = computeCapacity(base({ activeContacts: 40 }), T)
  check("A4 at/over the ceiling → over", over.band === "over" && over.headroom === 0, JSON.stringify(over))
  const debt = computeCapacity(base({ staleContacts: 5, overdueTasks: 3 }), T)
  check("A5 follow-up debt ≥ DEBT_ALARM → over regardless of headcount (the ball is dropping)", debt.band === "over" && debt.reasons.some((r) => r.includes("overdue")), JSON.stringify(debt))
  const halfDebt = computeCapacity(base({ overdueTasks: DEBT_ALARM / 2 }), T)
  check("A6 half the debt alarm → busy", halfDebt.band === "busy", JSON.stringify(halfDebt))
  const fatigued = computeCapacity(base({ fatigueTier: "critical" }), T)
  check("A7 CRITICAL agent fatigue → over even on a light load (burnout is no room)", fatigued.band === "over" && fatigued.reasons.some((r) => r.includes("fatigue critical")), JSON.stringify(fatigued))
  const atRisk = computeCapacity(base({ fatigueTier: "at_risk" }), T)
  check("A8 at_risk fatigue → at_capacity", atRisk.band === "at_capacity" && atRisk.reasons.some((r) => r.includes("fatigue at_risk")))
  const healthy = computeCapacity(base({ fatigueTier: "healthy" }), T)
  const noRow = computeCapacity(base({ fatigueTier: null }), T)
  check("A9 NEGATIVE CONTROL — healthy / engaged / watch / no row never move the band", healthy.band === "available" && noRow.band === "available"
    && computeCapacity(base({ fatigueTier: "engaged" }), T).band === "available" && computeCapacity(base({ fatigueTier: "watch" }), T).band === "available")
  const showings = computeCapacity(base({ pendingShowings: 4 }), T)
  check("A10 pending showings are a stated reason, not a load term (load definition unchanged)", showings.load === 13 && showings.reasons.some((r) => r === "4 showings ahead"))
  check("A11 the index inside the answer carries the guardian's own terms (load / capacityScore / followUpDebt / burnoutRisk — one definition)",
    over.index.load === 43 && over.index.capacityScore === 1 && over.index.burnoutRisk === "high" && debt.index.followUpDebt === 8)
  check("A12 the band is monotone in load", (["available", "busy", "at_capacity", "over"] as const).every((b, i) =>
    computeCapacity(base({ activeContacts: [10, 26, 32, 40][i] }), T).band === b))
  check("A13 ONE vocabulary — four bands, each spelled once", CAPACITY_BANDS.length === 4 && new Set(CAPACITY_BANDS).size === 4)

  // the throttle
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, agent: "X" }))
  const allowanceOf = (band: "over" | "at_capacity" | "busy" | "available") => throttleTouchBatch(eight, (i) => i.agent, () => band, 8).kept.length
  check("A14 touch allowance: over 25% (2 of 8), at_capacity 50% (4), busy / available the whole batch",
    allowanceOf("over") === 2 && allowanceOf("at_capacity") === 4 && allowanceOf("busy") === 8 && allowanceOf("available") === 8)
  const items = [
    { id: "a1", agent: "A" }, { id: "b1", agent: "B" }, { id: "a2", agent: "A" }, { id: "n1", agent: null },
    { id: "a3", agent: "A" }, { id: "b2", agent: "B" }, { id: "a4", agent: "A" }, { id: "a5", agent: "A" }, { id: "a6", agent: "A" },
  ]
  const bands: Record<string, "over" | "available"> = { A: "over", B: "available" }
  const t = throttleTouchBatch(items, (i) => i.agent, (id) => bands[id] ?? null, 8)
  check("A15 an OVER agent's book gets ⌊batch·25%⌋ = 2 touches, the rest are throttled; order preserved; unowned kept",
    t.kept.map((i) => i.id).join(",") === "a1,b1,a2,n1,b2" && t.throttled === 4, JSON.stringify(t))
  const none = throttleTouchBatch(items, (i) => i.agent, () => null, 8)
  check("A16 NEGATIVE CONTROL — a missing capacity answer (null band) throttles nothing", none.kept.length === items.length && none.throttled === 0)
  const tiny = throttleTouchBatch(items, (i) => i.agent, () => "over", 1)
  check("A17 the allowance floors at ONE touch (a book is never fully silenced by the throttle)", tiny.kept.filter((i) => i.agent === "A").length === 1 && tiny.kept.filter((i) => i.agent === "B").length === 1)

  // the day count + escalation rule
  const now = new Date("2026-10-05T12:00:00Z")
  const days = overloadDaysIn(["2026-10-05T06:50:00Z", "2026-10-04T06:50:00Z", "2026-10-04T07:00:00Z", "2026-10-03T06:50:00Z"], now)
  check("A18 overloadDaysIn counts DISTINCT days inside the window (two signals one day = one day)", days === 3, String(days))
  check("A19 a signal outside the window, in the future, or unparsable does not count",
    overloadDaysIn(["2026-10-01T06:50:00Z", "2026-10-06T06:50:00Z", "not-a-date"], now) === 0)
  check("A20 escalate at N days with a receiver; never without a receiver; never under N",
    shouldSuggestReassignment(OVER_CAPACITY_ESCALATION_DAYS, "B") && !shouldSuggestReassignment(OVER_CAPACITY_ESCALATION_DAYS, null) && !shouldSuggestReassignment(OVER_CAPACITY_ESCALATION_DAYS - 1, "B"))

  // the band-aware pick
  check("A21 the pick skips a LOW-load candidate whose band is over (fatigue / debt) in favour of headroom",
    pickLeastLoadedWithHeadroom([{ agentId: "A", load: 2, band: "over" }, { agentId: "B", load: 10, band: "busy" }], 40) === "B")
  check("A22 when every candidate is over, the least-loaded still wins (never stranded)",
    pickLeastLoadedWithHeadroom([{ agentId: "A", load: 50, band: "over" }, { agentId: "B", load: 45, band: "over" }], 40) === "B")
  check("A23 NEGATIVE CONTROL — a bare load keeps the original ceiling test", pickLeastLoadedWithHeadroom([{ agentId: "A", load: 2 }, { agentId: "B", load: 10 }], 40) === "A")
  check("A24 the bus words are spelled once", AGENT_OVERLOADED_SIGNAL === "agent_overloaded" && AGENT_REASSIGNMENT_SUGGESTED_SIGNAL === "agent_reassignment_suggested")
}

// ─── B. WIRING ──────────────────────────────────────────────────────────────────────────────────
console.log("\nB. wiring — one gatherer, every consumer reads it (stripped source)")
{
  const pick = code("lib/lead-assignment/capacity-pick.ts")
  check("B1 capacity-pick exports capacityFor AND gatherWorkloadSignals (the one gatherer)", /export async function capacityFor\(/.test(pick) && /^async function gatherWorkloadSignals\(/m.test(pick))
  const gather = fnBody(src("lib/lead-assignment/capacity-pick.ts"), "gatherWorkloadSignals")
  for (const t of ["contacts", "leads", "transactions", "tasks", "showings", "agent_retention_scores"]) {
    check(`B2 the gatherer reads ${t}`, new RegExp(`\\.from\\("${t}"\\)`).test(gather))
  }
  check("B3 every gatherer read is tenant-pinned", (gather.match(/\.from\("/g) ?? []).length === (gather.match(/\.eq\("brokerage_id", brokerageId\)/g) ?? []).length, `${(gather.match(/\.from\("/g) ?? []).length} reads vs ${(gather.match(/\.eq\("brokerage_id", brokerageId\)/g) ?? []).length} tenant pins`)
  check("B4 the private load counter is gone (merged onto the gatherer)", !/function agentWorkingLoad\(/.test(pick))
  check("B4 POSITIVE CONTROL — the finder sees the old counter in a fixture", /function agentWorkingLoad\(/.test('async function agentWorkingLoad(supabase) {}'))
  check("B5 selectAgentByCapacity reads capacityFor and passes the band to the pick", /capacityFor\(supabase, brokerageId, id/.test(fnBody(src("lib/lead-assignment/capacity-pick.ts"), "selectAgentByCapacity")) && /band: cap\.band/.test(pick))

  const runner = src("lib/kernel/capacity-guardian-runner.ts")
  check("B6 the runner's private gatherer is gone; it reads capacityFor", !/async function gatherSignals\(/.test(runner) && /capacityFor\(svc, brokerageId, a\.id/.test(runner))
  check("B7 `overdueTasks: 0` (the hardcoded debt term) is gone", !/overdueTasks:\s*0\b/.test(runner))
  check("B7 POSITIVE CONTROL", /overdueTasks:\s*0\b/.test("return { overdueTasks: 0, activeDeals }"))
  check("B8 escalation: prior overload days counted, receiver picked by capacity, shape validated by agent-books, suggestion published GATED",
    /overloadDaysIn\(/.test(runner) && /selectAgentByCapacity\(svc, brokerageId, receivers, maxLoad\)/.test(runner)
    && /validateBookTransferRequest\(\{ fromAgentId: a\.id, toAgentId: receiverId as string, scope: "temporary"/.test(runner)
    && /signalType:\s*AGENT_REASSIGNMENT_SUGGESTED_SIGNAL/.test(runner) && /if \(!opts\.dryRun\)/.test(runner))
  check("B9 the runner never calls reassignAgentBooks itself (a suggestion, not a move)", !/reassignAgentBooks\(/.test(runner))

  const cron = src("app/api/cron/stale-contact-monitor/route.ts")
  const rankAt = cron.indexOf("rankContactsForTouch(planned)")
  const throttleAt = cron.indexOf("throttleTouchBatch(rankedForTouch")
  const loopAt = cron.indexOf("for (const contact of staleContacts)")
  check("B10 stale-contact / NBA batch: throttled by the owning agent's band AFTER ranking and BEFORE engaging",
    rankAt > 0 && throttleAt > rankAt && loopAt > throttleAt && /capacityFor\(supabase, brokerageId, agentId/.test(cron) && /throttledForCapacity/.test(cron))

  const standup = src("lib/kernel/morning-standup.ts")
  const rank = fnBody(standup, "rankStandup")
  check("B11 morning stand-up: the capacity exception ranks right after fires (before approvals)",
    rank.indexOf("kind: \"capacity\"") > rank.indexOf("kind: \"fire\"") && rank.indexOf("kind: \"capacity\"") < rank.indexOf("kind: \"approval\"") && /hasHeadroom\(cap\.band\)/.test(rank))
  check("B12 runMorningStandup reads capacityFor for the stand-up agent (agents.id)", /capacityFor\(supabase, brokerageId, standupAgentId/.test(standup))

  const brief = src("lib/intelligence/user-type-briefs/team-lead.ts")
  const capAt = brief.indexOf("team-capacity-exceptions")
  const handoffAt = brief.indexOf("team-isa-handoffs")
  check("B13 team-lead brief: capacity exceptions + open reassignment suggestions lead the priorities (exceptions first)",
    capAt > 0 && handoffAt > capAt && /capacityFor\(supabase, params\.brokerageId, agentId/.test(brief) && /AGENT_REASSIGNMENT_SUGGESTED_SIGNAL/.test(brief) && /\.eq\("status", "open"\)/.test(brief))

  const route = src("app/api/cron/capacity-guardian/route.ts")
  check("B14 the cron route suppresses by the ONE signal word and reports reassignments", /AGENT_OVERLOADED_SIGNAL/.test(route) && /reassignments_suggested/.test(route))
  check("B15 the cron is scheduled (reachability, CLAUDE.md §1)", /\/api\/cron\/capacity-guardian/.test(src("lib/kernel/cron-dispatch.ts")) && /\/api\/cron\/stale-contact-monitor/.test(src("lib/kernel/cron-dispatch.ts")))
}

// ─── C. CONTACT FATIGUE AT EVERY OUTBOUND CHOKEPOINT ───────────────────────────────────────────
console.log("\nC. contact fatigue — every outbound chokepoint consults the contact scope")
{
  const dispatch = src("lib/providers/dispatch.ts")
  for (const fn of ["dispatchEmail", "dispatchSms", "dispatchDirectMail", "dispatchVideo"]) {
    const body = fnBody(dispatch, fn)
    check(`C1 ${fn} runs deconflictGate (the over-touch engine) before sending`, body.length > 0 && /deconflictGate\(\{/.test(body), body.length === 0 ? "function not found" : "no gate in body")
  }
  check("C1 POSITIVE CONTROL — a dispatcher body without the gate is flagged", !/deconflictGate\(\{/.test("export async function dispatchX(p) { return send(p) }"))
  const gate = fnBody(dispatch, "deconflictGate") || dispatch.slice(dispatch.indexOf("async function deconflictGate("), dispatch.indexOf("async function deconflictGate(") + 800)
  check("C2 deconflictGate calls evaluateDeconflict and refuses on a suppression", /evaluateDeconflict\(args\)/.test(gate) && /if \(d\.allowed\) return null/.test(gate))
  const phone = src("lib/voice/outbound-call-gates.ts")
  check("C3 phone: the pre-dial gate stack consults evaluateDeconflict", /evaluateDeconflict\(\{/.test(phone) && /OUTBOUND_CALL_GATES/.test(phone))
  const lifetime = src("app/api/cron/lifetime-customer-touchpoints/route.ts")
  check("C4 portal cadence (lifetime touches): consults evaluateDeconflict per contact per channel", /evaluateDeconflict\(\{ brokerageId, contactId, channel, systemSource \}\)/.test(lifetime))
  const engine = src("lib/kernel/deconflict/index.ts")
  check("C5 the engine consults the CONTACT scope: buyer_fatigue_scores.risk_level → fatigueTemperedPolicy (error read, base policy on refusal)",
    /\.from\("buyer_fatigue_scores"\)\.select\("risk_level"\)/.test(engine) && /fatigueTemperedPolicy\(policy, fatigueRisk\)/.test(engine) && /fatigueErr/.test(engine))

  // PUBLISHED, NOT ASSERTED — outbound-ledger inserters outside the dispatcher (the blind spot).
  const ledgers = ["email_sends", "isa_outreach_log", "direct_mail_recipients", "marketing_campaign_touchpoints"]
  const out = execSync(`grep -rlE 'from\\("(${ledgers.join("|")})"\\)\\s*\\.insert' lib app --include=*.ts --include=*.tsx || true`, { encoding: "utf8" })
  const files = out.split("\n").filter(Boolean).filter((f) => f !== "lib/providers/dispatch.ts")
  console.log(`  ℹ census: ${files.length} file(s) insert an outbound ledger row outside lib/providers/dispatch.ts (raw grep, comments included — a blind spot, not a finding):`)
  for (const f of files) console.log(`     - ${f}`)
  console.log("  ℹ NOT consulted by design: transactional portal confirmations (showing-lifecycle, self-book, event-fanout) — confirmations are not pressure; 'portal' is not a DeconflictChannel and deconflict_suppression_log.channel's CHECK admits no such word.")
}

// ─── D. ONE VOCABULARY ──────────────────────────────────────────────────────────────────────────
console.log("\nD. one vocabulary — every live fatigue tier maps to a band")
{
  const tiers = (CHECK_VOCABULARIES as Record<string, Record<string, string[]>>).agent_retention_scores?.tier ?? []
  check("D1 the live CHECK on agent_retention_scores.tier is in the cache", tiers.length > 0)
  const bands = tiers.map((t) => computeCapacity(base({ fatigueTier: t as WorkloadSignals["fatigueTier"] }), T).band)
  check("D2 every live tier yields a band; critical → over, at_risk → at_capacity, the rest leave a light load available",
    bands.every((b) => (CAPACITY_BANDS as readonly string[]).includes(b))
    && tiers.every((t, i) => (t === "critical" ? bands[i] === "over" : t === "at_risk" ? bands[i] === "at_capacity" : bands[i] === "available")), JSON.stringify(Object.fromEntries(tiers.map((t, i) => [t, bands[i]]))))
}

// ─── E. REGISTRATION ────────────────────────────────────────────────────────────────────────────
console.log("\nE. registration + ownership")
{
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
  check("E1 package.json test:capacity → this guard", pkg.scripts["test:capacity"] === "tsx scripts/capacity-guard.ts")
  check("E2 the guard chain runs it", /npm run test:capacity(\s|&|$)/.test(pkg.scripts.guard))
  const reg = src("lib/kernel/manager-registry.ts")
  check("E3 MAINTENANCE_DOMAINS owns it (recruiting_manager; co-owners ai_isa + campaign_orchestrator)",
    /agent_capacity_one_answer:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:capacity",\s*coOwners:\s*\["ai_isa",\s*"campaign_orchestrator"\]/.test(reg))
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ Capacity — one kernel answer, every consumer wired, every contact chokepoint consulting fatigue.")
console.log(" CAPACITY_PASS")
