#!/usr/bin/env tsx
/**
 * scripts/adaptive-development-guard.ts   (npm run test:adaptive-development)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves ADAPTIVE AGENT DEVELOPMENT (wave 106, lane 106D): Education + Gamification + Performance as
 * ONE loop on the ONE competency model — the owner's eleven-key vocabulary everywhere, and the loop
 * observed weakness → education recommendation → AI coaching/simulation (assessment, compliance-first)
 * → real-world activity → actual outcome → competency update, with evidence at every step, the
 * IMPROVEMENT (never the completion) earning points, tenant isolation, and agents seeing their own only.
 *
 * PURE:   scoreCompetency's new rails, observeWeakness, composeAssessment, competencyDeltas /
 *         improvedCompetencies, planLifecycleAwards, developmentBlock — with POSITIVE CONTROLS.
 * LIVE:   runAdaptiveDevelopmentCycle driven end-to-end against the in-memory supabase (two tenants).
 * WIRING: stripped source (scripts/strip-comments.ts) — a tombstone is not a call site.
 * No live database. m720 is DML only and is asserted by shape (never pinned to applied/not-applied).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  scoreCompetency, observeWeakness, competencyDeltas, improvedCompetencies, competencyScoreMap,
  COMPETENCY_SKILLS, COMPETENCY_LABEL, COMPETENCY_GAP_TAG, COMPETENCY_GAP_SCORE, COMPETENCY_IMPROVEMENT_MIN_DELTA, SKILL_AREA_COMPETENCY,
  type CompetencyEvidence,
} from "../lib/education/skill-freshness"
import { OBJECTION_SCENARIOS, SCENARIO_CATEGORY_COMPETENCY, composeAssessment, scenarioCompetency, COMPLIANCE_FIRST_PREAMBLE } from "../lib/training/objection-scenarios"
import { KernelEvent } from "../lib/kernel/events"
import { planLifecycleAwards, POINT_VALUES, LIFECYCLE_AWARD_RULES } from "../lib/gamification/award-points"
import { awardLifecycleMilestones } from "../lib/gamification/lifecycle-awards"
import { developmentBlock } from "../lib/intelligence/agent-scorecard"
import { entityIdForKey } from "../lib/kernel/relationship-graph"
import { runAdaptiveDevelopmentCycle, DEVELOPMENT_ACTION } from "../lib/education/skill-freshness-radar"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, why?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${why ? ` — ${why}` : ""}`) } }
const code = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"))

const OWNER_ELEVEN = ["listing_presentation", "buyer_consultation", "negotiation", "pricing", "lead_conversion", "follow_up", "transaction_management", "compliance", "marketing", "recruiting", "technology"]
const RETIRED = ["objection_handling", "product_knowledge", "coursework", "lead_response", "closing", "call_quality", "compliance_ce"]

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

function vocabularyLayer() {
  console.log("\n[ONE competency vocabulary — the owner's eleven keys, one list everywhere]")
  check("COMPETENCY_SKILLS is exactly the owner's eleven (set-equal, no extras)", COMPETENCY_SKILLS.length === 11 && OWNER_ELEVEN.every((k) => (COMPETENCY_SKILLS as readonly string[]).includes(k)))
  check("the wave-103 rail spellings are NOT competencies any more (tombstoned onto the owner's keys)", RETIRED.every((k) => !(COMPETENCY_SKILLS as readonly string[]).includes(k)))
  check("every key has a label and a gap tag; every freshness area maps onto an owner key", OWNER_ELEVEN.every((k) => COMPETENCY_LABEL[k as never] && COMPETENCY_GAP_TAG[k as never]) && Object.values(SKILL_AREA_COMPETENCY).every((k) => OWNER_ELEVEN.includes(k)))
  check("the simulation library speaks the same vocabulary: every scenario category → an owner key, every scenario resolves", Object.values(SCENARIO_CATEGORY_COMPETENCY).every((k) => OWNER_ELEVEN.includes(k)) && OBJECTION_SCENARIOS.every((s) => OWNER_ELEVEN.includes(scenarioCompetency(s))))
  check("the graph admits the competency node (relationship_edges CHECK vocabulary) — the key is the identity, no competency CHECK/table of its own (m715)", (CHECK_VOCABULARIES as any).relationship_edges.to_entity_type.includes("competency") && !("competencies" in (CHECK_VOCABULARIES as any)) && !("agent_competencies" in (CHECK_VOCABULARIES as any)))
  check("one node id per key, deterministic (the ledger, the graph and the award reference agree)", entityIdForKey("competency", "negotiation") === entityIdForKey("competency", "negotiation") && new Set(OWNER_ELEVEN.map((k) => entityIdForKey("competency", k))).size === 11)
  // m711's seven live catalog tags are still emitted by the model (modules tagged by m711 keep matching).
  const m711Tags = ["objection_handling", "product_knowledge", "coursework_incomplete", "call_quality", "compliance_ce", "slow_lead_response", "low_close_rate"]
  const emitted = new Set<string>([...Object.values(COMPETENCY_GAP_TAG), "coursework_incomplete"])
  check("the catalog tags m711 stamped are all still emitted under the new keys (no module orphaned by the rename)", m711Tags.every((t) => emitted.has(t)))
}

function pureLayer() {
  console.log("\n[scoreCompetency · the four new rails + completion-is-not-competency]")
  const empty = scoreCompetency(EMPTY)
  check("no evidence → 11 skills, compliance the only scored one, 10 unproven (never a fabricated zero)", empty.skills.length === 11 && empty.unproven.length === 10 && skillOf(empty, "compliance").score != null)
  check("listing presentation: 3 appointments / 2 taken → 100 (60% = the bar); 3 / 1 → 56 is a GAP tagged listing_presentation",
    skillOf(scoreCompetency(ev({ listing: { appointments: 3, taken: 2 } })), "listing_presentation").score === 100 && skillOf(scoreCompetency(ev({ listing: { appointments: 3, taken: 1 } })), "listing_presentation").score === 56 && scoreCompetency(ev({ listing: { appointments: 3, taken: 1 } })).gapTags.includes("listing_presentation"))
  check("POSITIVE CONTROL: 2 listing appointments → below the evidence gate → unproven", skillOf(scoreCompetency(ev({ listing: { appointments: 2, taken: 2 } })), "listing_presentation").score == null)
  check("pricing: sold at 95% of list → 70; at 90% → 20 (gap); 99% → 100", skillOf(scoreCompetency(ev({ pricing: { sold: 2, avgSoldToList: 0.95 } })), "pricing").score === 70 && skillOf(scoreCompetency(ev({ pricing: { sold: 2, avgSoldToList: 0.90 } })), "pricing").score === 20 && skillOf(scoreCompetency(ev({ pricing: { sold: 1, avgSoldToList: 0.99 } })), "pricing").score === 100)
  check("marketing: 6 posts in 90 days → 50 (gap); 12 → 100", skillOf(scoreCompetency(ev({ marketing: { postsPublished: 6 } })), "marketing").score === 50 && skillOf(scoreCompetency(ev({ marketing: { postsPublished: 12 } })), "marketing").score === 100)
  check("recruiting: 2 sourced / 1 provisioned → 46 (gap); 5 / 5 → 100", skillOf(scoreCompetency(ev({ recruiting: { recruits: 2, provisioned: 1 } })), "recruiting").score === 46 && skillOf(scoreCompetency(ev({ recruiting: { recruits: 5, provisioned: 5 } })), "recruiting").score === 100)
  const quiz = [{ area: "product_knowledge" as const, lastPracticedDays: 5, lastScore: 80 }]
  check("technology = the knowledge check (80 → 80); completing 4/4 modules does NOT move it (completion is state, not competency)",
    skillOf(scoreCompetency(ev({ freshness: quiz })), "technology").score === 80 && skillOf(scoreCompetency(ev({ freshness: quiz, modules: { assigned: 4, completed: 4, avgQuizScore: 95 } })), "technology").score === 80)
  check("POSITIVE CONTROL: 4/4 modules completed with NO knowledge check → technology unproven, evidence says completion proves nothing",
    skillOf(scoreCompetency(ev({ modules: { assigned: 4, completed: 4, avgQuizScore: 95 } })), "technology").score == null && /completion alone proves nothing/.test(skillOf(scoreCompetency(ev({ modules: { assigned: 4, completed: 4, avgQuizScore: 95 } })), "technology").evidence[0]))
  check("open modules with no knowledge check keep the catalog's coursework_incomplete tag live", scoreCompetency(ev({ modules: { assigned: 4, completed: 1, avgQuizScore: null } })).gapTags.includes("coursework_incomplete"))
  check("the merged rails score under the owner's keys: drills → negotiation, coach insights → buyer_consultation, claim speed → follow_up, closings → transaction_management",
    skillOf(scoreCompetency(ev({ objection: { sessions: 4, avgScore: 82, byScenario: [] } })), "negotiation").score === 82 && skillOf(scoreCompetency(ev({ coaching: { strengths: 6, improvements: 0 } })), "buyer_consultation").score === 100
    && skillOf(scoreCompetency(ev({ outcomes: { ...EMPTY.outcomes, leadsAssigned: 10, leadsClaimed: 10, medianClaimMinutes: 12 } })), "follow_up").score === 100 && skillOf(scoreCompetency(ev({ outcomes: { ...EMPTY.outcomes, closings: 6, activeDeals: 2, avgHealthScore: 90 } })), "transaction_management").score === 94)

  console.log("\n[observeWeakness · pure — weakest with evidence, strain caps the focus]")
  const weakEv = ev({ listing: { appointments: 3, taken: 1 }, marketing: { postsPublished: 3 }, pricing: { sold: 2, avgSoldToList: 0.90 }, outcomes: { ...EMPTY.outcomes, leadsAssigned: 10, leadsClaimed: 2, medianClaimMinutes: 600 } })
  const weakP = scoreCompetency(weakEv)
  const w2 = observeWeakness(weakP)
  check("default: the TWO lowest evidenced gaps, lowest first, each carrying evidence + gap tag", w2.length === 2 && w2[0].score <= w2[1].score && w2[0].skill === "pricing" && w2.every((w) => w.evidence.length > 0 && w.gapTag === COMPETENCY_GAP_TAG[w.skill]))
  check("under strain (retention radar) → ONE focus, and the strain is named in its evidence", observeWeakness(weakP, { underStrain: true }).length === 1 && /under strain/.test(observeWeakness(weakP, { underStrain: true })[0].evidence.join(" ")))
  check("POSITIVE CONTROL: an unproven skill is never a weakness (no evidence → no observation)", observeWeakness(scoreCompetency(EMPTY)).length === 0 && !w2.some((w) => weakP.unproven.includes(w.skill)))

  console.log("\n[composeAssessment · pure — scenario + rubric, compliance FIRST, honest null]")
  const a = composeAssessment("negotiation")
  check("negotiation → the negotiation scenario with its rubric; the prompt OPENS with the compliance-first preamble (fair housing in the writing prompt)", !!a && a.scenarioKey === "low_offer_seller" && a.rubric.length === 4 && a.systemPrompt.startsWith(COMPLIANCE_FIRST_PREAMBLE) && /Fair Housing/.test(a.systemPrompt) && /score that turn 0/.test(a.systemPrompt))
  check("listing_presentation → the HARDEST listing scenario first (an assessment is a test, not a warm-up)", composeAssessment("listing_presentation")?.scenarioKey === "expired_listing")
  check("POSITIVE CONTROL: marketing has no scenario in the library → null (the loop recommends without a simulation and says so)", composeAssessment("marketing") === null && composeAssessment("recruiting") === null)

  console.log("\n[competency update · pure — deltas vs the last ledgered cycle; the improvement earns, the completion never does]")
  const before = scoreCompetency(ev({ listing: { appointments: 3, taken: 1 }, freshness: quiz }))
  const after = scoreCompetency(ev({ listing: { appointments: 5, taken: 3 }, freshness: quiz, modules: { assigned: 4, completed: 4, avgQuizScore: 95 } }))
  const deltas = competencyDeltas(competencyScoreMap(before), after)
  const improved = improvedCompetencies(deltas, after)
  check("listing presentation 56 → 100 is an improvement (delta ≥ 5, evidenced); technology (modules completed, same quiz) is NOT", improved.some((d) => d.skill === "listing_presentation" && d.before === 56 && d.after === 100) && !improved.some((d) => d.skill === "technology"))
  check("POSITIVE CONTROL: a 3-point rise is noise (below COMPETENCY_IMPROVEMENT_MIN_DELTA); a null prior never improves", improvedCompetencies([{ skill: "pricing", before: 50, after: 53, delta: 3 }, { skill: "marketing", before: null, after: 90, delta: null }], after).length === 0 && COMPETENCY_IMPROVEMENT_MIN_DELTA === 5)
  const now = new Date("2026-10-06T12:00:00Z")
  const node = entityIdForKey("competency", "listing_presentation")
  const plans = planLifecycleAwards(KernelEvent.COMPETENCY_IMPROVED, { entityId: node, now })
  check("GAMIFICATION: COMPETENCY_IMPROVED → one COMPETENCY_IMPROVED award (50) once per competency node per year", plans.length === 1 && plans[0].reason === "COMPETENCY_IMPROVED" && plans[0].points === POINT_VALUES.COMPETENCY_IMPROVED && plans[0].once.referenceId === node && !!plans[0].once.since)
  check("…and a module / course COMPLETION earns nothing in the rule table (improvement, never completion)", planLifecycleAwards(KernelEvent.TRAINING_COURSE_COMPLETED, { entityId: node, now }).length === 0 && !LIFECYCLE_AWARD_RULES.some((r) => /TRAINING|LEARNING|MODULE/.test(r.event)))
  check("POSITIVE CONTROL: the planner still awards a real lifecycle event (TRANSACTION_CLOSED)", planLifecycleAwards(KernelEvent.TRANSACTION_CLOSED, { entityId: "11111111-1111-4111-8111-111111111111", now }).length >= 1)

  console.log("\n[developmentBlock · pure — the scorecard's block from the ledger detail]")
  const blk = developmentBlock({ scores: { pricing: 20, negotiation: null, compliance: 85 }, improved: [{ skill: "compliance" }] }, "2026-10-06T00:00:00Z")
  check("weakest = lowest scored skill, overall = mean of scored, improved listed, null scores ignored", blk.weakest?.skill === "pricing" && blk.overall === 53 && blk.improvedLastCycle.join() === "compliance" && developmentBlock(null, "x").weakest === null)
}

// ── the live loop against the in-memory supabase ────────────────────────────────────────────────
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const A1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1", U1 = "01010101-0101-4010-8010-010101010101"
const B1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1", U2 = "02020202-0202-4020-8020-020202020202"
const MOD_A = "0a0a0a0a-0a0a-40a0-80a0-0a0a0a0a0a0a", MOD_P = "0b0b0b0b-0b0b-40b0-80b0-0b0b0b0b0b0b", MOD_B = "0c0c0c0c-0c0c-40c0-80c0-0c0c0c0c0c0c"
const D1 = new Date("2026-10-06T09:00:00Z"), D3 = new Date("2026-10-08T09:00:00Z")
const iso = (d: Date, minusDays = 0) => new Date(d.getTime() - minusDays * 86_400_000).toISOString()

function seed() {
  const routed = Array.from({ length: 10 }, (_, i) => ({ brokerage_id: A, agent_id: A1, claimed: i < 2, claimed_at: i < 2 ? iso(D1, 10 - 10 / 24 / 6 * 0) : null, created_at: iso(D1, 10) }))
  for (const r of routed) if (r.claimed) r.claimed_at = new Date(Date.parse(r.created_at) + 600 * 60_000).toISOString()
  const presentations = [1, 2, 3].map((i) => ({ brokerage_id: A, agent_id: A1, agent_user_id: U1, status: i === 1 ? "converted" : "presented", appointment_at: iso(D1, 20 + i), created_at: iso(D1, 22 + i) }))
  const m = memSupabase({
    objection_training_sessions: [], agent_quiz_attempts: [], learning_assignments: [], call_coaching_insights: [], transactions: [], deal_health_scores: [], tours: [], offers: [], calendar_events: [],
    assignment_log: routed, agents: [{ id: A1, user_id: U1, brokerage_id: A, license_expiry: null, ce_hours_required: null, ce_hours_completed: null, ce_cycle_end_date: null, ethics_due_date: null }, { id: B1, user_id: U2, brokerage_id: B }],
    agent_certifications: [], listing_presentations: presentations, listings: [], social_posts: [], recruits: [], agent_retention_scores: [], agent_action_ledger: [], agent_client_messages: [], relationship_edges: [], agent_points_log: [], agent_badges: [], gamification_badges: [],
    learning_modules: [
      { id: MOD_A, brokerage_id: A, status: "published", title: "Speed to lead", gap_tags: ["slow_lead_response"], display_priority: 5 },
      { id: MOD_P, brokerage_id: null, status: "published", title: "Winning the listing", gap_tags: ["listing_presentation"], display_priority: 5 },
      { id: MOD_B, brokerage_id: B, status: "published", title: "B's listing course", gap_tags: ["listing_presentation"], display_priority: 99 },
    ],
  }, { stampCreatedAt: true })
  // The live agent_action_ledger has a UNIQUE on idempotency_key (m687); the in-memory stand-in does not, so
  // the proof simulates the 23505 the ledger's claim relies on (rereadWinner then decides from the winner).
  const origFrom = m.from.bind(m)
  ;(m as any).from = (table: string) => {
    const b: any = origFrom(table)
    if (table === "agent_action_ledger") {
      const ins = b.insert.bind(b)
      b.insert = (row: any) => {
        if (row?.idempotency_key && m.tables.agent_action_ledger.some((r) => r.idempotency_key === row.idempotency_key)) {
          const dup = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }
          return { select: () => ({ single: async () => dup, maybeSingle: async () => dup }), then: (res: any) => res(dup) }
        }
        return ins(row)
      }
    }
    return b
  }
  // award_agent_points (m484) stand-in: increments nothing we read; writes the ledger row the once-check reads.
  ;(m as any).rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn !== "award_agent_points") return { data: null, error: { message: `unknown rpc ${fn}` } }
    const agent = m.tables.agents.find((a) => a.id === args.p_agent_id)
    if (!agent) return { data: null, error: { message: "no agent" } }
    const row = { id: `${m.tables.agent_points_log.length + 1}0000000-0000-4000-8000-000000000000`.slice(0, 36), agent_id: args.p_agent_id, brokerage_id: agent.brokerage_id, points: args.p_points, reason: args.p_reason, reference_type: args.p_reference_type, reference_id: args.p_reference_id, created_at: new Date().toISOString() }
    m.tables.agent_points_log.push(row)
    return { data: { brokerage_id: agent.brokerage_id, points_added: args.p_points, new_total: m.tables.agent_points_log.reduce((s, r) => s + Number(r.points), 0), log_id: row.id }, error: null }
  }
  return m
}

async function liveLayer() {
  console.log("\n[runAdaptiveDevelopmentCycle · in-memory, two tenants — the round-trip with evidence]")
  const m = seed()
  const emitted: any[] = [], proposed: any[] = []
  const seams = { emit: async (i: any) => { emitted.push(i) }, propose: async (i: any) => { proposed.push(i); m.tables.agent_client_messages.push({ brokerage_id: i.brokerageId, entity_type: "agent", entity_id: i.agentId, agent_kind: "recruiting_manager", rationale: i.rationale }); return { ok: true } } }
  const agentA = { id: A1, user_id: U1, brokerage_id: A }
  const c1 = await runAdaptiveDevelopmentCycle(m as any, agentA, { now: D1, seams })
  const ledgerA = () => m.tables.agent_action_ledger.filter((r) => r.brokerage_id === A)
  check("OBSERVE: follow_up (2/10 claimed, slow) and listing_presentation (1/3 taken) are the two weaknesses, lowest first, with evidence", c1.weakest.map((w) => w.skill).join() === "follow_up,listing_presentation" && c1.weakest.every((w) => w.evidence.length > 0) && c1.underStrain === false, JSON.stringify(c1.weakest.map((w) => [w.skill, w.score])))
  check("RECOMMEND: the catalog match per weakness writes learning_assignments (tenant A's own module + the platform module; B's module NEVER picked)",
    c1.recommended.map((r) => `${r.skill}:${r.moduleId}:${r.assigned}`).join() === `follow_up:${MOD_A}:true,listing_presentation:${MOD_P}:true` && m.tables.learning_assignments.every((a) => a.brokerage_id === A && a.agent_user_id === U1 && a.status === "open" && a.signal_source === "adaptive_development" && a.signal_metadata?.competency), JSON.stringify(c1.recommended))
  check("ASSESS: listing_presentation gets its scenario and ONE gated nudge (no stored result yet); follow_up has no scenario → honest skip", c1.assessments.length === 1 && c1.assessments[0].scenarioKey === "expired_listing" && c1.assessments[0].score === null && c1.assessments[0].nudged && proposed.length === 1 && /expired listing/i.test(proposed[0].subject), JSON.stringify(c1.assessments))
  check("UPDATE (first cycle): no prior → nothing improved, no event; has_competency planted for the skills ≥ the gap bar (compliance)", c1.improved.length === 0 && emitted.length === 0 && m.tables.relationship_edges.some((e) => e.relationship_type === "has_competency" && e.to_entity_id === entityIdForKey("competency", "compliance") && e.brokerage_id === A))
  const steps = Object.values(DEVELOPMENT_ACTION)
  check("LEDGER: every step left a withActionLedger row — recruiting_manager, subject the agent, reason LEARNED_IMPROVEMENT, executed, detail = the evidence",
    steps.every((s) => ledgerA().some((r) => r.action === s && r.actor_manager_key === "recruiting_manager" && r.subject_type === "agent" && r.subject_id === A1 && r.reason_code === "LEARNED_IMPROVEMENT" && r.status === "executed")) && ledgerA().find((r) => r.action === DEVELOPMENT_ACTION.update)?.detail?.scores?.follow_up === 28, JSON.stringify(ledgerA().map((r) => [r.action, r.status, r.reason_code])))
  check("TENANT ISOLATION: tenant B has no ledger row, no assignment, no edge, no nudge", !m.tables.agent_action_ledger.some((r) => r.brokerage_id === B) && !m.tables.learning_assignments.some((r) => r.brokerage_id === B) && !m.tables.relationship_edges.some((r) => r.brokerage_id === B) && !m.tables.agent_client_messages.some((r) => r.brokerage_id === B))
  const rowsBefore = ledgerA().length
  const c1b = await runAdaptiveDevelopmentCycle(m as any, agentA, { now: D1, seams })
  check("IDEMPOTENT: the same day again replays every step (no second ledger row, no second assignment, no second nudge)", c1b.replayed.length === 4 && ledgerA().length === rowsBefore && m.tables.learning_assignments.length === 2 && proposed.length === 1)

  // ACTIVITY + OUTCOME: the agent ran the assessment (scored 88) and took two more listings.
  // The ledger stamps created_at with the REAL clock (the live DEFAULT now()); the stored result must post-date that prior.
  const afterPrior = new Date(Date.now() + 3_600_000).toISOString()
  m.tables.objection_training_sessions.push({ brokerage_id: A, agent_user_id: U1, scenario_key: "expired_listing", total_score: 88, started_at: afterPrior, completed_at: afterPrior })
  for (const i of [4, 5]) m.tables.listing_presentations.push({ brokerage_id: A, agent_id: A1, agent_user_id: U1, status: "converted", appointment_at: iso(D3, 1), created_at: iso(D3, 2) })
  const c2 = await runAdaptiveDevelopmentCycle(m as any, agentA, { now: D3, seams })
  check("ASSESS (cycle 2): the stored simulation result IS the assessment score (88) — read for the skill the last cycle asked to assess even though the activity since lifted it out of the gaps; no new nudge", c2.assessments.some((a) => a.skill === "listing_presentation" && a.score === 88 && !a.nudged) && proposed.length === 1 && !c2.weakest.some((w) => w.skill === "listing_presentation"), JSON.stringify({ assessments: c2.assessments, weakest: c2.weakest.map((w) => w.skill) }))
  const node = entityIdForKey("competency", "listing_presentation")
  check("UPDATE (cycle 2): listing_presentation improved vs the LAST LEDGERED cycle (56 → 100, evidenced) → COMPETENCY_IMPROVED emitted on the competency node with agent_id + before/after",
    c2.improved.some((i) => i.skill === "listing_presentation" && i.before === 56 && i.after === 100) && emitted.length === 1 && emitted[0].event === KernelEvent.COMPETENCY_IMPROVED && emitted[0].entityId === node && emitted[0].brokerageId === A && emitted[0].metadata.agent_id === A1 && emitted[0].metadata.before === 56, JSON.stringify({ improved: c2.improved, emitted }))
  check("…and the ledgered update row carries the improvement as evidence; follow_up (unchanged) is not in it", ledgerA().filter((r) => r.action === DEVELOPMENT_ACTION.update).length === 2 && ledgerA().filter((r) => r.action === DEVELOPMENT_ACTION.update).pop()?.detail?.improved?.map((i: any) => i.skill).join() === "listing_presentation")
  check("GRAPH: has_competency now holds listing_presentation (score crossed the bar; confidence from the evidence gate)", m.tables.relationship_edges.some((e) => e.relationship_type === "has_competency" && e.to_entity_id === node && e.from_entity_id === U1 && e.evidence?.confidence === 0.9))

  // GAMIFICATION: the reactor's award on that event — the improvement earns 50, once per node per year.
  const aw1 = await awardLifecycleMilestones(m as any, { event: KernelEvent.COMPETENCY_IMPROVED, brokerageId: A, entityType: "competency", entityId: node, metadata: { agent_id: A1, skill: "listing_presentation" } })
  const aw2 = await awardLifecycleMilestones(m as any, { event: KernelEvent.COMPETENCY_IMPROVED, brokerageId: A, entityType: "competency", entityId: node, metadata: { agent_id: A1, skill: "listing_presentation" } })
  const pts = m.tables.agent_points_log.filter((r) => r.reason === "COMPETENCY_IMPROVED")
  check("the reactor awards COMPETENCY_IMPROVED (+50) to the agent; the same node again this year is already-awarded (one row)", pts.length === 1 && pts[0].agent_id === A1 && Number(pts[0].points) === 50 && (aw1 as any).awarded?.length === 1 && (aw2 as any).awarded?.length === 0, JSON.stringify({ aw1, aw2 }))
  check("POSITIVE CONTROL: completing the assigned modules awards nothing (no rule) — the points ledger holds only the improvement", (await awardLifecycleMilestones(m as any, { event: KernelEvent.TRAINING_COURSE_COMPLETED, brokerageId: A, entityType: "learning_module", entityId: MOD_A, metadata: { agent_id: A1 } }) as any).awarded?.length === 0 && m.tables.agent_points_log.length === 1)

  console.log("\n[fail closed + strain]")
  const m2 = seed()
  m2.tables.agent_retention_scores.push({ agent_id: A1, brokerage_id: A, composite_score: 20, signal_breakdown: null, score_date: iso(D1) })
  const refused = memSupabase({ ...m2.tables }, { refuse: { learning_assignments: "permission denied" }, stampCreatedAt: true })
  ;(refused as any).rpc = (m2 as any).rpc
  const c3 = await runAdaptiveDevelopmentCycle(refused as any, agentA, { now: D1, seams: { emit: async () => {}, propose: async () => ({ ok: true }) } })
  check("under strain → ONE focus only, the reason in the ledgered evidence", c3.underStrain === true && c3.weakest.length === 1 && /under strain/.test(c3.weakest[0].evidence.join(" ")))
  check("a refused learning_assignments read → NO assignment written (fail closed), refusal published", c3.recommended.length === 0 && c3.refusedRails.some((r) => /learning_assignments/.test(r)) && refused.writes.filter((w) => w.table === "learning_assignments").length === 0)
}

function wiringLayer() {
  console.log("\n[wiring — stripped source; survivors extended, consumers wired]")
  const model = code("lib/education/skill-freshness.ts")
  check("the vocabulary + the pure loop live ON the competency survivor (COMPETENCY_SKILLS as const, observeWeakness, competencyDeltas, improvedCompetencies)", /export const COMPETENCY_SKILLS = \[/.test(model) && /export function observeWeakness\(/.test(model) && /export function competencyDeltas\(/.test(model) && /export function improvedCompetencies\(/.test(model) && !/generateText|generateObject|fetch\(/.test(model))
  const radar = code("lib/education/skill-freshness-radar.ts")
  check("the live loop lives ON the radar survivor beside loadAgentCompetency, every step through withActionLedger, strain from the gamification strain survivor", /export async function runAdaptiveDevelopmentCycle\(/.test(radar) && /withActionLedger<T>\(\{/.test(radar) && /isAgentUnderStrain\(/.test(radar) && /export async function runAdaptiveDevelopmentAll\(/.test(radar))
  check("the four new rails are read by the ONE gatherer from their SURVIVOR tables (listing_presentations, listings, social_posts, recruits) with their errors published", /from\("listing_presentations"\)/.test(radar) && /from\("listings"\)/.test(radar) && /from\("social_posts"\)/.test(radar) && /from\("recruits"\)/.test(radar) && /rail\("listing_presentations"/.test(radar))
  check("the update step EMITS COMPETENCY_IMPROVED on the competency node and re-derives has_competency through the graph survivor", /KernelEvent\.COMPETENCY_IMPROVED/.test(radar) && /entityIdForKey\("competency", d\.skill\)/.test(radar) && /deriveCompetencyEdges\(svc, \{ brokerageId: agent\.brokerage_id/.test(radar))
  check("the recommendation writes the learning_assignments row the Academy reads (signal_source adaptive_development, status open — the CHECK vocabulary)", /from\("learning_assignments"\)\.insert\(\{/.test(radar) && /signal_source: DEVELOPMENT_SIGNAL_SOURCE/.test(radar) && (CHECK_VOCABULARIES as any).learning_assignments.status.includes("open"))
  check("the assessment reads the simulation's stored result and nudges through the ONE gated proposal rail", /from\("objection_training_sessions"\)\.select\("total_score, completed_at"\)/.test(radar) && /proposeClientMessage\(\{ brokerageId: input\.brokerageId, agentKind: "recruiting_manager"/.test(radar))
  const scenarios = code("lib/training/objection-scenarios.ts")
  const action = code("app/actions/objection-training.ts")
  check("COMPLIANCE-FIRST: the preamble is composed into BOTH simulation prompts (scoring + final evaluation), not only a post-hoc scan", /export const COMPLIANCE_FIRST_PREAMBLE/.test(scenarios) && /\$\{COMPLIANCE_FIRST_PREAMBLE\}You are scoring/.test(action) && /\$\{COMPLIANCE_FIRST_PREAMBLE\}Practice scenario/.test(action))
  const awards = code("lib/gamification/award-points.ts")
  check("GAMIFICATION: the COMPETENCY_IMPROVED rule rides the ONE rule table (per_reference_per_year, party acting) — no call-site award", /event: KernelEvent\.COMPETENCY_IMPROVED, reason: "COMPETENCY_IMPROVED", scope: "per_reference_per_year", party: "acting"/.test(awards) && !/awardAgentPoints\(/.test(radar))
  check("EVENT: COMPETENCY_IMPROVED is a KernelEvent (one enum, one spelling)", /COMPETENCY_IMPROVED\s*=\s*'competency_improved'/.test(code("lib/kernel/events.ts")))
  check("CRON: the daily onboarding-reminders cron runs the loop after the radar (autonomous, every tenant)", /runAdaptiveDevelopmentAll\(createServiceClient\(\)\)/.test(code("app/api/cron/onboarding-reminders/route.ts")))
  const scorecard = code("lib/intelligence/agent-scorecard.ts")
  check("SURFACE 1 — agent scorecard carries the `development` block from the ledger (developmentBlock), null when unreadable", /development: devReadable \? \(devByAgent\.get\(a\.id\) \?\? null\) : null/.test(scorecard) && /export function developmentBlock\(/.test(scorecard) && scorecard.includes(`.eq("action", "${DEVELOPMENT_ACTION.update}")`))
  check("SURFACE 2 — team-lead brief names each member's development focus (observeWeakness, one per member)", /observeWeakness\(p, \{ limit: 1 \}\)/.test(code("lib/intelligence/user-type-briefs/team-lead.ts")) && /focus: \$\{a\.focus\}/.test(code("lib/intelligence/user-type-briefs/team-lead.ts")))
  const academy = code("app/actions/academy-learning.ts")
  check("SURFACE 3 — the Academy recommendation: getMyLearningProgress reads the SESSION agent's own cycle (ctx.agentId + ctx.brokerageId, never a client id) and the panel renders it",
    academy.includes(`.eq("brokerage_id", ctx.brokerageId).eq("action", "${DEVELOPMENT_ACTION.update}").eq("subject_type", "agent").eq("subject_id", ctx.agentId)`) && /development=\{development\}/.test(code("app/academy/page.tsx")) && /Development focus: \{development\.focus\}/.test(readFileSync("app/academy/components/os/training-progress-panel.tsx", "utf8")))
  check("POSITIVE CONTROL: the tenant-scope finder recognises a body-supplied id shape", /\.eq\("subject_id", params\.agentId\)/.test('svc.from("x").eq("subject_id", params.agentId)'))
  check("no competency rename left a consumer on the old keys: the router + the graph read skills GENERICALLY (profile.skills / g.skill), never a retired literal", !/"(objection_handling|lead_response|closing|call_quality|compliance_ce)"/.test(code("lib/learning-router/resolve-agent-learning-context.ts")) && !/skill: "(closing|coursework|compliance_ce)"/.test(code("lib/kernel/relationship-graph.ts")))

  console.log("\n[registration + m720]")
  const pkg = readFileSync("package.json", "utf8")
  check("test:adaptive-development registered and in the guard chain after test:scrapers", /"test:adaptive-development": "tsx scripts\/adaptive-development-guard\.ts"/.test(pkg) && pkg.indexOf("npm run test:adaptive-development") > pkg.indexOf("npm run test:scrapers") && pkg.indexOf("npm run test:scrapers") > 0)
  const reg = code("lib/kernel/manager-registry.ts")
  check("MAINTENANCE_DOMAINS.adaptive_agent_development owned by recruiting_manager, co-owned by deal_coordinator + compliance_officer, named in prose",
    /adaptive_agent_development: \{ manager: "recruiting_manager", proof: "test:adaptive-development", coOwners: \["deal_coordinator", "compliance_officer"\]/.test(reg) && /deal_coordinator co-owns the outcome evidence/.test(reg) && /compliance_officer co-owns the compliance competency/.test(reg))
  const m720 = readFileSync("supabase/migrations/m720-one-competency-vocabulary-graph-nodes-and-catalog-tags.sql", "utf8")
  const sql = m720.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  const retiredIds = RETIRED.map((k) => entityIdForKey("competency", k))
  check("m720 is DML only; it EXPIRES (effective_to) the has_competency edges on every retired node id — never deletes — and leaves lead_conversion (shared key) alone",
    !/\b(create|alter|drop|delete)\s/i.test(sql) && /set effective_to = now\(\)/.test(sql) && retiredIds.every((id) => sql.includes(`'${id}'`)) && !sql.includes(`'${entityIdForKey("competency", "lead_conversion")}'`))
  check("m720 tags the catalog for the four new competencies under the m711 idempotency guard, fixtures excluded",
    ["listing_presentation", "pricing", "marketing", "recruiting"].every((t) => new RegExp(`array_append\\(gap_tags, '${t}'\\)`).test(sql) && new RegExp(`not \\(gap_tags @> array\\['${t}'\\]\\)`).test(sql)) && (sql.match(/title not like 'ZZ\\_%FIXTURE%'/g) ?? []).length === 4)
}

async function main() {
  vocabularyLayer()
  pureLayer()
  await liveLayer()
  wiringLayer()
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log("FAILED:\n  " + fails.join("\n  ")); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
