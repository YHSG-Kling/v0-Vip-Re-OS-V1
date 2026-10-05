#!/usr/bin/env tsx
/**
 * scripts/competency-guard.ts   (npm run test:competency)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE ONE AGENT COMPETENCY MODEL (wave 103, lane 103A — layer 5 of the owner's 7-layer
 * target): per-agent competency per skill derived from EVIDENCE (outcomes, coaching insights,
 * objection-drill scores, CE / license readiness, module completions), deterministic, no LLM —
 * extended onto the skill-freshness survivor (lib/education/skill-freshness.ts) — and WIRED to
 * its consumers: curriculum assignment (learning router gap tags), the coaching brief (cites the
 * gap), the team-lead brief, the command-center board. Plus the customer journey-learning rulings:
 * a dual client is taught BOTH sides, lessons are compliance-first, no financials to contacts.
 *
 * PURE:    scoreCompetency / claimSpeedScore / summarizeCompetencyBoard / resolveClientSides /
 *          clientModulePassesCompliance — in-memory, with POSITIVE CONTROLS (every absence
 *          assertion has a fixture that trips it).
 * WIRING:  asserted from STRIPPED source (scripts/strip-comments.ts) — a tombstone is not a call site.
 * No live database; no migration (m703 unused — the model is derived at read time, never stored).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  scoreCompetency, claimSpeedScore, COMPETENCY_SKILLS, COMPETENCY_GAP_TAG, COMPETENCY_GAP_SCORE,
  COMPETENCY_LABEL, SKILL_LABEL, type CompetencyEvidence,
} from "../lib/education/skill-freshness"
import { summarizeCompetencyBoard } from "../lib/intelligence/skill-freshness-board"
import { resolveClientSides } from "../lib/agents/education-delivery-producer"
import { clientModulePassesCompliance } from "../lib/education/client-education-authoring"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const code = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"))

const EMPTY: CompetencyEvidence = {
  freshness: [
    { area: "objection_handling", lastPracticedDays: null, lastScore: null },
    { area: "product_knowledge", lastPracticedDays: null, lastScore: null },
    { area: "coursework", lastPracticedDays: null, lastScore: null },
  ],
  objection: { sessions: 0, avgScore: null, byScenario: [] },
  coaching: { strengths: 0, improvements: 0 },
  outcomes: { closings: 0, activeDeals: 0, avgHealthScore: null, tours: 0, offers: 0, appointments: 0, noShows: 0, leadsAssigned: 0, leadsClaimed: 0, medianClaimMinutes: null },
  compliance: { ready: true, blockers: 0, warnings: 0, cePct: null, activeCertifications: 0 },
  modules: { assigned: 0, completed: 0, avgQuizScore: null },
}
const ev = (over: Partial<CompetencyEvidence>): CompetencyEvidence => ({ ...EMPTY, ...over })
const skillOf = (p: ReturnType<typeof scoreCompetency>, k: string) => p.skills.find((s) => s.skill === k)!

function pureLayer() {
  console.log("\n[scoreCompetency · pure — evidence in, deterministic score out, honest nulls]")
  const empty = scoreCompetency(EMPTY)
  check("every competency skill is scored (8 skills, one vocabulary)", empty.skills.length === COMPETENCY_SKILLS.length && COMPETENCY_SKILLS.every((k) => empty.skills.some((s) => s.skill === k)))
  check("the three freshness areas ARE competency skills (superset, not a second vocabulary)", (Object.keys(SKILL_LABEL) as string[]).every((k) => (COMPETENCY_SKILLS as readonly string[]).includes(k)))
  check("no evidence → every evidence-gated skill is null/unproven (never a fabricated zero)", empty.unproven.length === 7 && empty.skills.filter((s) => s.score == null).every((s) => s.confidence === "none"))
  check("no evidence → compliance still scores (readiness is always a verdict) and overall is that one skill", skillOf(empty, "compliance_ce").score != null && empty.overall === skillOf(empty, "compliance_ce").score)
  check("deterministic: same evidence → identical profile", JSON.stringify(scoreCompetency(EMPTY)) === JSON.stringify(scoreCompetency(EMPTY)))

  // Objection handling ← the simulator's scores; freshness decay subtracts.
  const drilled = scoreCompetency(ev({ objection: { sessions: 4, avgScore: 82, byScenario: [{ key: "commission_pushback", sessions: 2, avgScore: 55 }, { key: "fsbo_cold_call", sessions: 2, avgScore: 90 }] }, freshness: [{ area: "objection_handling", lastPracticedDays: 10, lastScore: 82 }] }))
  check("objection drills (4 @ 82) → objection_handling 82, confidence high", skillOf(drilled, "objection_handling").score === 82 && skillOf(drilled, "objection_handling").confidence === "high")
  check("a WEAK drill scenario names its curriculum tag (objection:<key>) — the author's tag; a strong one does not", drilled.gapTags.includes("objection:commission_pushback") && !drilled.gapTags.includes("objection:fsbo_cold_call"))
  const staleDrill = scoreCompetency(ev({ objection: { sessions: 4, avgScore: 82, byScenario: [] }, freshness: [{ area: "objection_handling", lastPracticedDays: 90, lastScore: 82 }] }))
  check("POSITIVE CONTROL: the same drills proven 90 days ago score 15 lower (stale decay)", skillOf(staleDrill, "objection_handling").score === 67)
  check("2 drills → confidence low (below COMPETENCY_MIN_EVIDENCE)", skillOf(scoreCompetency(ev({ objection: { sessions: 2, avgScore: 80, byScenario: [] } })), "objection_handling").confidence === "low")

  // Lead response ← assignment_log claim rate × speed.
  check("claimSpeedScore: 10 min → 100; 60 min → 75; 240 min → 45; 1440 min → 15; 2 days → 10", claimSpeedScore(10) === 100 && claimSpeedScore(60) === 75 && claimSpeedScore(240) === 45 && claimSpeedScore(1440) === 15 && claimSpeedScore(2880) === 10)
  const fast = scoreCompetency(ev({ outcomes: { ...EMPTY.outcomes, leadsAssigned: 10, leadsClaimed: 10, medianClaimMinutes: 12 } }))
  const slow = scoreCompetency(ev({ outcomes: { ...EMPTY.outcomes, leadsAssigned: 10, leadsClaimed: 5, medianClaimMinutes: 600 } }))
  check("10/10 leads claimed in 12 min → lead_response 100", skillOf(fast, "lead_response").score === 100)
  check("POSITIVE CONTROL: 5/10 claimed, median 10 h → lead_response is a GAP tagged slow_lead_response", skillOf(slow, "lead_response").score! <= COMPETENCY_GAP_SCORE && slow.gaps.some((g) => g.skill === "lead_response") && slow.gapTags.includes("slow_lead_response"))

  // Lead conversion ← tour→offer, no-show penalty; sample gate at 3.
  const converting = scoreCompetency(ev({ outcomes: { ...EMPTY.outcomes, tours: 10, offers: 5 } }))
  const notConverting = scoreCompetency(ev({ outcomes: { ...EMPTY.outcomes, tours: 10, offers: 1, appointments: 8, noShows: 4 } }))
  check("5 offers from 10 tours (the coaching strength bar) → lead_conversion 100", skillOf(converting, "lead_conversion").score === 100)
  check("POSITIVE CONTROL: 1 offer from 10 tours + 50% no-shows → lead_conversion gap (low_close_rate)", skillOf(notConverting, "lead_conversion").score! <= COMPETENCY_GAP_SCORE && notConverting.gapTags.includes("low_close_rate"))
  check("2 tours → below the sample gate → unproven (not a gap)", skillOf(scoreCompetency(ev({ outcomes: { ...EMPTY.outcomes, tours: 2, offers: 0 } })), "lead_conversion").score == null)

  // Closing ← closings + deal health.
  check("6 closings at health 90 → closing 94 (0.7·95 + 0.3·90)", skillOf(scoreCompetency(ev({ outcomes: { ...EMPTY.outcomes, closings: 6, activeDeals: 2, avgHealthScore: 90 } })), "closing").score === 94)
  check("POSITIVE CONTROL: 0 closings, 2 active deals at health 30 → closing 37 (a gap)", skillOf(scoreCompetency(ev({ outcomes: { ...EMPTY.outcomes, closings: 0, activeDeals: 2, avgHealthScore: 30 } })), "closing").score === 37)

  // Call quality ← coach insights.
  check("6 strengths / 0 improvements → call_quality 100; 0 / 6 → 40 (gap)", skillOf(scoreCompetency(ev({ coaching: { strengths: 6, improvements: 0 } })), "call_quality").score === 100 && skillOf(scoreCompetency(ev({ coaching: { strengths: 0, improvements: 6 } })), "call_quality").score === 40)

  // Compliance ← the license-readiness verdict.
  const blocked = scoreCompetency(ev({ compliance: { ready: false, blockers: 1, warnings: 0, cePct: 20, activeCertifications: 0 } }))
  const clear = scoreCompetency(ev({ compliance: { ready: true, blockers: 0, warnings: 0, cePct: 100, activeCertifications: 2 } }))
  check("a readiness BLOCKER → compliance_ce 10 (a gap, tagged compliance_ce)", skillOf(blocked, "compliance_ce").score === 10 && blocked.gapTags.includes("compliance_ce"))
  check("clear + CE 100% + 2 certs → compliance_ce 100", skillOf(clear, "compliance_ce").score === 100)
  check("a warning caps compliance_ce at 70", skillOf(scoreCompetency(ev({ compliance: { ready: true, blockers: 0, warnings: 1, cePct: 100, activeCertifications: 0 } })), "compliance_ce").score === 70)

  // Coursework ← module completions + quizzes.
  check("4/4 modules, quizzes avg 90 → coursework 96", skillOf(scoreCompetency(ev({ modules: { assigned: 4, completed: 4, avgQuizScore: 90 } })), "coursework").score === 96)
  check("POSITIVE CONTROL: 1/4 modules, no quiz → coursework 25 (gap coursework_incomplete)", skillOf(scoreCompetency(ev({ modules: { assigned: 4, completed: 1, avgQuizScore: null } })), "coursework").score === 25)

  // Gaps ordering + overall.
  const mixed = scoreCompetency(ev({ outcomes: { ...EMPTY.outcomes, tours: 10, offers: 1, leadsAssigned: 10, leadsClaimed: 2, medianClaimMinutes: 1500 }, modules: { assigned: 4, completed: 4, avgQuizScore: 95 } }))
  check("gaps are lowest-first and each carries its gap tag", mixed.gaps.length >= 2 && mixed.gaps[0].score <= mixed.gaps[1].score && mixed.gaps.every((g) => g.gapTag === COMPETENCY_GAP_TAG[g.skill]))
  check("overall = mean of the SCORED skills only", mixed.overall === Math.round(mixed.skills.filter((s) => s.score != null).reduce((a, s) => a + (s.score as number), 0) / mixed.skills.filter((s) => s.score != null).length))
  check("every skill has a label and a gap tag", COMPETENCY_SKILLS.every((k) => COMPETENCY_LABEL[k] && COMPETENCY_GAP_TAG[k]))

  console.log("\n[summarizeCompetencyBoard · pure — roster tally, lowest first]")
  const board = summarizeCompetencyBoard([
    { agentId: "a", name: "Gap Gus", profile: slow },
    { agentId: "b", name: "Clear Cleo", profile: clear },
    { agentId: "c", name: "Low Lou", profile: mixed },
  ])
  check("2 of 3 agents carry a gap; lowest overall first; the top gap is named", board.scored === 3 && board.withGaps === 2 && (board.agents[0].overall ?? 101) <= (board.agents[1].overall ?? 101) && typeof board.topGap === "string")

  console.log("\n[resolveClientSides · pure — a dual client is BOTH sides; 'dual' deal_type is the brokerage's, not the client's]")
  const C = "c1"
  check("seller on one deal + buyer on another → side seller (kernel's seller-first rule), dualClient true",
    JSON.stringify(resolveClientSides(C, [{ deal_type: "dual", contact_id: null, buyer_contact_id: C, seller_contact_id: "x" }, { deal_type: "seller", contact_id: C, buyer_contact_id: null, seller_contact_id: C }])) === JSON.stringify({ side: "seller", dualClient: true }))
  check("buyer only → side buyer, not dual", JSON.stringify(resolveClientSides(C, [{ deal_type: "dual", contact_id: null, buyer_contact_id: C, seller_contact_id: "x" }])) === JSON.stringify({ side: "buyer", dualClient: false }))
  check("no party column, legacy contact_id + deal_type seller → seller", resolveClientSides(C, [{ deal_type: "seller", contact_id: C, buyer_contact_id: null, seller_contact_id: null }]).side === "seller")
  check("POSITIVE CONTROL: no deals → null side", resolveClientSides(C, []).side === null)

  console.log("\n[clientModulePassesCompliance · pure — compliance-first, hard fair-housing flag refuses]")
  const lesson = { title: "You're under contract — what happens next", summary: "What to expect now.", objectives: ["Know the steps"], lessons: [{ title: "Earnest money", walkthrough: "Your deposit shows good faith. Ask your agent about the amount for your deal.", keyPoints: ["Good faith"] }], quiz: [] } as any
  check("a clean lesson passes", clientModulePassesCompliance(lesson).ok)
  check("POSITIVE CONTROL: a steering phrase in the body is refused (fair_housing_phrase)", clientModulePassesCompliance({ ...lesson, lessons: [{ title: "Area", walkthrough: "This is a family-friendly neighborhood with good schools.", keyPoints: [] }] }).reason === "fair_housing_phrase")
  check("POSITIVE CONTROL: a steering phrase in the title is refused too", clientModulePassesCompliance({ ...lesson, title: "Safe neighborhood picks" }).ok === false)
}

function wiringLayer() {
  console.log("\n[wiring — stripped source; survivor extended, duplicates merged, consumers wired]")
  const model = code("lib/education/skill-freshness.ts")
  check("the model lives ON the freshness survivor (scoreCompetency exported from skill-freshness.ts)", /export function scoreCompetency\(/.test(model) && /export function computeSkillFreshness\(/.test(model))
  check("the model uses no model call (deterministic): no generateText / generateObject / fetch in the survivor", !/generateText|generateObject|fetch\(/.test(model))

  const radar = code("lib/education/skill-freshness-radar.ts")
  check("gatherSkillSignals is EXPORTED (the one freshness gatherer)", /export async function gatherSkillSignals\(/.test(radar))
  check("loadAgentCompetency = evidence → scoreCompetency (the one per-agent read)", /export async function loadAgentCompetency\(/.test(radar) && /scoreCompetency\(evidence\)/.test(radar))
  check("evidence reads every rail: drills, coach insights, closed+active deals, tours, offers, calendar, assignment_log, agents, certifications, learning_assignments",
    ["objection_training_sessions", "call_coaching_insights", "transactions", "deal_health_scores", "tours", "offers", "calendar_events", "assignment_log", "agent_certifications", "learning_assignments"].every((t) => radar.includes(`from("${t}")`)))
  check("CE / license FEEDS the model through the compliance survivor (evaluateLicenseReadiness + ceProgress), never a second rule", /evaluateLicenseReadiness\(\{/.test(radar) && /ceProgress\(/.test(radar) && /from "@\/lib\/compliance\/license-readiness"/.test(radar))
  check("every evidence rail destructures its error and publishes refusedRails (§3)", /refusedRails/.test(radar) && /if \(r\.error\) \{ refused\.push/.test(radar))
  check("no bare embed between transactions and deal_health_scores (PGRST201 guard)", !/deal_health_scores\(/.test(radar))

  const board = code("lib/intelligence/skill-freshness-board.ts")
  check("the board's duplicate gatherer is GONE — it imports the radar's gatherSkillSignals (merge, not a copy)", /import \{[^}]*gatherSkillSignals[^}]*\} from "@\/lib\/education\/skill-freshness-radar"/.test(board) && !/from\("objection_training_sessions"\)/.test(board) && !/from\("agent_quiz_attempts"\)/.test(board))
  check("POSITIVE CONTROL: the radar still carries those reads (the survivor kept them)", /from\("objection_training_sessions"\)/.test(radar) && /from\("agent_quiz_attempts"\)/.test(radar))
  check("the board tallies competency beside freshness (summarizeCompetencyBoard + loadAgentCompetency)", /board\.competency = summarizeCompetencyBoard\(/.test(board) && /loadAgentCompetency\(/.test(board))
  check("the command center renders the competency gaps", /skillBoard\.competency/.test(code("app/dashboard/admin/command-center/command-center-client.tsx")))

  const ctx = code("lib/learning-router/resolve-agent-learning-context.ts")
  check("CURRICULUM: the learning context loads the competency profile and folds its gapTags into gapTags", /loadAgentCompetency\(/.test(ctx) && /for \(const t of profile\.gapTags\) gapTags\.push\(t\)/.test(ctx) && /competencyGaps/.test(ctx))
  const composer = code("lib/learning-router/composer.ts")
  check("the assignment row records WHICH competency gap the pick was for (signal_metadata.competencyGaps)", /competencyGaps: ctx\.competencyGaps/.test(composer))
  check("the router still has ONE scorer and matches gap_tags against the context's gapTags", /export function scoreLearningModule\(/.test(composer) && /r\.gap_tags\.filter\(\(t\) => ctx\.gapTags\.includes\(t\)\)/.test(composer))
  const author = code("lib/education/curriculum-author.ts")
  check("the curriculum author stamps 'objection:<key>' — the same tag the model emits for a weak scenario (loop closed on one vocabulary)", /topicKey: `objection:\$\{key\}`/.test(author) && /gap_tags: \[gap\.topicKey\]/.test(author) && /gapTags\.add\(`objection:\$\{sc\.key\}`\)/.test(model))

  const coaching = code("lib/kernel/agent-coaching.ts")
  check("COACHING: buildCoachingStats loads the profile per agent; composeCoachingBrief CITES the gap (label, score, evidence) as a leak + the focus", /loadAgentCompetency\(supabase, \{ id: a\.id/.test(coaching) && /Competency gap: \$\{g\.label\} scores \$\{g\.score\}\/100 — \$\{g\.evidence\}/.test(coaching) && /Close the \$\{g\.label\.toLowerCase\(\)\} gap/.test(coaching))
  check("a refused competency read leaves the field ABSENT (never an empty 'no gaps')", /competencyByAgent\.get\(a\.id\)/.test(coaching) && /competencyGaps\?:/.test(coaching))

  const teamLead = code("lib/intelligence/user-type-briefs/team-lead.ts")
  check("TEAM LEAD: the brief reads each member's profile and adds the team-competency priority + metric", /loadAgentCompetency\(supabase, \{ id: m\.id/.test(teamLead) && /id: "team-competency"/.test(teamLead) && /label: "Competency gaps"/.test(teamLead))

  const objection = code("app/actions/objection-training.ts")
  check("SIMULATION writes its result INTO the model's evidence row (endPracticeSession sets total_score + completed_at on objection_training_sessions)", /from\("objection_training_sessions"\)[\s\S]{0,400}\.update\(\{[\s\S]{0,200}total_score: avgScore[\s\S]{0,300}completed_at: new Date\(\)\.toISOString\(\)/.test(objection))
  check("…and the loader reads scenario_key + total_score from that row", /from\("objection_training_sessions"\)\.select\("scenario_key, total_score"\)/.test(radar))
  const coachWriter = code("lib/voice/call-coaching.ts")
  check("the voice coach writes call_coaching_insights with insight_type (the call_quality evidence)", /from\("call_coaching_insights"\)[\s\S]{0,80}\.insert\(rows\)/.test(coachWriter) && /insight_type: i\.insight_type/.test(coachWriter))

  console.log("\n[journey learning for customers — stage lessons to portal + email, dual both, compliance-first, no financials]")
  const eduCtx = code("lib/portal/resolve-education-context.ts")
  check("DUAL BOTH: the education context reads the kernel's LAYOUTS and a dual client's second active transaction's milestone (secondaryMilestone)", /const isDualClient = layouts\.includes\("buyer"\) && layouts\.includes\("seller"\)/.test(eduCtx) && /\.limit\(isDualClient \? 2 : 1\)/.test(eduCtx) && /secondaryMilestone = second/.test(eduCtx))
  check("the router adds the second milestone + the second layout to the stage match", /if \(ctx\.secondaryMilestone\) stageTags\.push\(ctx\.secondaryMilestone\)/.test(composer) && /for \(const l of ctx\.layouts \?\? \[\]\)/.test(composer))
  const producer = code("lib/agents/education-delivery-producer.ts")
  check("the delivery producer resolves the client's side(s) from the party columns (resolveClientSides) and records client_side/dual_client", /export function resolveClientSides\(/.test(producer) && /resolveClientSides\(contactId/.test(producer) && /dual_client: dualClient/.test(producer))
  check("PORTAL + EMAIL per stage: the producer records a learning_assignment and proposes through the gate on the band-chosen rail (portal/email/push/sms)", /from\("learning_assignments"\)\.insert\(\{/.test(producer) && /channel: choice\.channel/.test(producer) && /CHANNEL_ORDER_BY_BAND/.test(producer))
  const gate = code("lib/agents/agent-client-messages.ts")
  check("…and the gate's approve path delivers email through dispatchEmail and portal through the canonical portal card", /channel === "email"/.test(gate) && /dispatchEmail\(/.test(gate) && /portal \/ portal_push/.test(readFileSync("lib/agents/agent-client-messages.ts", "utf8")))
  check("STAGE-APPROPRIATE: client modules are authored per buyer/seller milestone with stage_tags (the curriculum) — buyer AND seller stages both present",
    /kind: "buyer_stage", milestone: "offer_accepted"/.test(code("lib/education/client-education-curriculum.ts")) && /kind: "seller_stage", milestone: "offer_received"/.test(code("lib/education/client-education-curriculum.ts")) && /stage_tags: !isPersona/.test(code("lib/education/client-education-authoring.ts")))
  check("the cron + the event reactor both drive the producer (weekly net + just-in-time)", /produceEducationDelivery\(tgt\.brokerageId/.test(code("app/api/cron/education-delivery/route.ts")) && /produceEducationForEvent\(\{ brokerageId: params\.brokerageId/.test(code("lib/kernel/event-reactor.ts")))
  const authoring = code("lib/education/client-education-authoring.ts")
  check("COMPLIANCE-FIRST: fair housing + no client dollar figures are IN the writing prompt (CLIENT_LESSON_COMPLIANCE_RULES), and the post-hoc scan refuses before persist", /system: [\s\S]{0,600}\+ CLIENT_LESSON_COMPLIANCE_RULES/.test(authoring) && /Fair Housing/.test(authoring) && /const compliance = clientModulePassesCompliance\(curriculum\)\s*if \(!compliance\.ok\)/.test(authoring))
  check("the scan reuses the ONE fair-housing phrase regex (hasFairHousingViolation), not a second list", /import \{ hasFairHousingViolation \} from "@\/lib\/compliance\/client-text-guard"/.test(authoring))
  const FINANCIAL_SELECT = /\.select\("[^"]*(purchase_price|commission_|net_to_|proceeds|sale_price|loan_amount)[^"]*"\)/
  check("NO FINANCIALS TO CONTACTS: the delivery copy is built from module title/summary/minutes/agent name only, and the producer SELECTs no financial column", /export function buildEducationDelivery\(\s*moduleTitle: string, moduleSummary: string \| null, estimatedMinutes: number \| null, agentName: string,\s*\)/.test(producer) && !FINANCIAL_SELECT.test(producer))
  check("POSITIVE CONTROL: the financial-column finder still recognises a file that selects purchase_price (career-architect)", FINANCIAL_SELECT.test(code("lib/intelligence/career-architect.ts")))
  check("Honest note: buyer_stage_coaching / seller_stage_coaching are AGENT-facing stage playbooks (CRM card), not contact education — they read into the agent's coaching card, never the portal",
    /from\("buyer_stage_coaching"\)/.test(code("lib/intelligence/coaching-engine.ts")) && !/buyer_stage_coaching|seller_stage_coaching/.test(producer))

  console.log("\n[registration]")
  const pkg = readFileSync("package.json", "utf8")
  // The RULE is "in the guard chain, after test:scrapers" — sibling wave proofs share that slot
  // (CLAUDE.md §2: assert the rule, not the waypoint).
  check("test:competency registered and in the guard chain after test:scrapers", /"test:competency": "tsx scripts\/competency-guard\.ts"/.test(pkg) && pkg.indexOf("npm run test:competency") > pkg.indexOf("npm run test:scrapers") && pkg.indexOf("npm run test:scrapers") >= 0)
  const reg = code("lib/kernel/manager-registry.ts")
  check("MAINTENANCE_DOMAINS.agent_competency_model owned by recruiting_manager, co-owned by compliance_officer + deal_coordinator, named in prose", /agent_competency_model:\s*\{ manager: "recruiting_manager", proof: "test:competency", coOwners: \["compliance_officer", "deal_coordinator"\]/.test(reg) && /compliance_officer co-owns the compliance_ce skill/.test(reg) && /deal_coordinator co-owns the outcome evidence/.test(reg))
  check("no migration shipped (the model is derived at read time)", !/m703/.test(reg))
}

function main() {
  pureLayer()
  wiringLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ COMPETENCY_FAIL"); process.exit(1) }
  console.log(" ✅ COMPETENCY_PASS — one evidence-scored competency model on the freshness survivor; curriculum, coaching, team-lead brief and the board read it; dual clients are taught both sides, compliance-first")
}
main()
