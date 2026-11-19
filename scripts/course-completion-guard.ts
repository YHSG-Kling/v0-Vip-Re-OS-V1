#!/usr/bin/env tsx
/**
 * scripts/course-completion-guard.ts   (npm run test:course-completion)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 155 (lane 155C) — owner R1, verbatim: "course needs to complete with quiz with acceptable passing %."
 *
 * Proves the COURSE COMPLETION CONTRACT by EXECUTING the real code (all SIMULATED — in-memory client, no database):
 *   lib/academy/quiz.ts               the canonical grader + threshold / readiness / sanitizer / retry / attempt ledger
 *   lib/academy/course-completion.ts  recordCourseAttempt — the one recorder the learner action hands its service client to
 *   lib/gamification/lifecycle-awards awardLifecycleMilestones on TRAINING_COURSE_COMPLETED — the award re-reads the persisted pass
 * and, in STRIPPED source (scripts/strip-comments.ts), the wiring around them: the learner action, the reader screen, both
 * publish doors, the onboarding answer key and the onboarding certification gate. Every absence claim carries a positive control.
 * Eval spec cases implemented: REWARD-002 (viewed + failed ≠ complete, no points), REWARD-005 (a replay awards nothing).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { KernelEvent } from "../lib/kernel/events"
import {
  gradeQuiz, parseQuizQuestions, resolveCoursePassingScore, courseQuizReadiness, sanitizeQuizAnswers, quizRetryVerdict,
  readQuizAttempts, learnerQuizFeedback, MODULE_QUIZ_PASSING_SCORE, MODULE_QUIZ_ATTEMPTS_PER_DAY, type ModuleQuizQuestion,
} from "../lib/academy/quiz"
import { recordCourseAttempt } from "../lib/academy/course-completion"
import { awardLifecycleMilestones } from "../lib/gamification/lifecycle-awards"
import { POINT_VALUES, POINT_EARNING_ACTIONS } from "../lib/gamification/award-points"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const raw = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const src = (p: string) => stripComments(raw(p))
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

// ─── IN-MEMORY CLIENT (the slice recordCourseAttempt + awardLifecycleMilestones use) ──────────────────────────────────
type Row = Record<string, any>
function memoryClient(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  const t = (n: string) => (tables[n] ??= [])
  let refuse: string | null = null
  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    let patch: Row | null = null, inserted: Row[] | null = null, limitN: number | null = null
    const run = () => {
      if (refuse === table) return { data: null, error: { message: `refused ${table}` } }
      const rows = (inserted ?? t(table)).filter((r) => filters.every((f) => f(r)))
      if (patch) { for (const r of rows) Object.assign(r, patch); patch = null }
      return { data: limitN ? rows.slice(0, limitN) : rows, error: null }
    }
    const api: any = {
      select() { return api },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return api },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return api },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return api },
      gte(c: string, v: any) { filters.push((r) => String(r[c] ?? "") >= String(v)); return api },
      or(expr: string) { const terms = expr.split(",").map((s) => s.split(".")); filters.push((r) => terms.some(([c, op, v]) => (op === "is" && v === "null") ? r[c] == null : r[c] === v)); return api },
      order() { return api },
      limit(n: number) { limitN = n; return api },
      update(p: Row) { patch = { ...p }; return api },
      insert(rows: Row | Row[]) {
        if (refuse === table) { inserted = []; api.then = (res: any) => res({ data: null, error: { message: `refused ${table}` } }); return api }
        const list = (Array.isArray(rows) ? rows : [rows]).map((r, i) => ({ id: U(900 + t(table).length + i), created_at: new Date().toISOString(), ...r }))
        t(table).push(...list); inserted = list; return api
      },
      maybeSingle: async () => { const r = run(); return { data: r.error ? null : (r.data![0] ?? null), error: r.error } },
      single: async () => { const r = run(); return { data: r.error ? null : (r.data![0] ?? null), error: r.error ?? (r.data!.length ? null : { message: "no rows" }) } },
      then(res: any) { return Promise.resolve(run()).then(res) },
    }
    return api
  }
  const writer = (a: Record<string, unknown>) => {
    const agent = t("agents").find((x) => x.id === a.p_agent_id)
    if (!agent) return { data: null, error: { message: "no agents row" } }
    agent.gamification_points = (agent.gamification_points ?? 0) + Number(a.p_points)
    const log = { id: U(700 + t("agent_points_log").length), agent_id: agent.id, brokerage_id: agent.brokerage_id, points: a.p_points, reason: a.p_reason, reference_type: a.p_reference_type, reference_id: a.p_reference_id, created_at: new Date().toISOString() }
    t("agent_points_log").push(log)
    return { data: { brokerage_id: agent.brokerage_id, points_added: a.p_points, new_total: agent.gamification_points, log_id: log.id, already_awarded: false } as any, error: null }
  }
  return {
    tables, refuse: (x: string | null) => { refuse = x },
    from: (table: string) => query(table),
    rpc: async (fn: string, a: Record<string, unknown>) => {
      if (fn === "award_agent_points") return writer(a)
      if (fn === "award_agent_points_once") {
        const standing = t("agent_points_log").some((r) => r.agent_id === a.p_agent_id && r.reason === a.p_reason && (a.p_reference_id == null || r.reference_id === a.p_reference_id))
        return standing ? { data: { already_awarded: true }, error: null } : writer(a)
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } }
    },
  }
}

// ─── FIXTURES ─────────────────────────────────────────────────────────────────
const BRK = U(9), BRK_B = U(8), AGENT = U(1), USER = U(5), AGENT_B = U(3), USER_B = U(7)
const M = U(20), M_EMPTY = U(21), M_70 = U(22), M_81 = U(23), M_B = U(24), M_OPTIONAL = U(25)
const Q5: ModuleQuizQuestion[] = [0, 1, 2, 3, 4].map((i) => ({ q: `Question ${i + 1}`, choices: ["a", "b", "c", "d"], correct_idx: i % 4, explainer: `Tip for question ${i + 1}` }))
const answersWith = (correct: number) => Object.fromEntries(Q5.map((q, i) => [i, i < correct ? q.correct_idx : (q.correct_idx + 1) % 4])) as Record<number, number>
const mod = (id: string, over: Row = {}) => ({ id, brokerage_id: BRK, required: true, status: "published", title: `Course ${id.slice(-2)}`, quiz_questions: Q5, ...over })
const seed = () => ({
  agents: [{ id: AGENT, brokerage_id: BRK, user_id: USER, gamification_points: 0 }, { id: AGENT_B, brokerage_id: BRK_B, user_id: USER_B, gamification_points: 0 }],
  learning_modules: [mod(M), mod(M_EMPTY, { quiz_questions: [{ q: "half-authored", choices: ["only one"] }] }), mod(M_70, { passing_score: 60 }), mod(M_81, { passing_score: 81 }),
    mod(M_B, { brokerage_id: BRK_B }), mod(M_OPTIONAL, { required: false, quiz_questions: null })],
  // The learner OPENED and fully read the course first — markModuleViewed's row (status viewed + viewed_at).
  learning_assignments: [{ id: U(40), brokerage_id: BRK, module_id: M, agent_user_id: USER, status: "viewed", viewed_at: "2026-11-01T10:00:00Z", signal_metadata: { source_note: "kept" } }],
  gamification_badges: [],
})
const modRow = (c: ReturnType<typeof memoryClient>, id: string) => c.tables.learning_modules.find((r) => r.id === id)! as Row & { id: string }
const asg = (c: ReturnType<typeof memoryClient>, id: string, user = USER) => c.tables.learning_assignments.find((r) => r.module_id === id && r.agent_user_id === user)
const passEvent = (moduleId: string, brokerageId = BRK, agentId = AGENT, extra: Row = {}) =>
  ({ event: KernelEvent.TRAINING_COURSE_COMPLETED, brokerageId, entityType: "learning_module", entityId: moduleId, metadata: { agent_id: agentId, ...extra } })

// ─── PURE ─────────────────────────────────────────────────────────────────────
function pureLayer() {
  console.log("\n[pure · the canonical grader, the threshold, readiness, the sanitizer, the retry rule]")
  const q100 = Array.from({ length: 100 }, (_, i) => ({ q: `q${i}`, choices: ["x", "y"], correct_idx: 0 }))
  const at = (n: number) => Object.fromEntries(q100.map((_, i) => [i, i < n ? 0 : 1])) as Record<number, number>
  check(`score exactly at the canonical threshold (${MODULE_QUIZ_PASSING_SCORE}/100) passes; one point under (79/100) fails`,
    gradeQuiz(q100, at(80)).passed && gradeQuiz(q100, at(80)).score === 80 && !gradeQuiz(q100, at(79)).passed && gradeQuiz(q100, at(79)).score === 79)
  check("the threshold is the course's OWN passing_score where the row has one (onboarding_quizzes), else the canonical 80 (learning_modules has no such column)",
    resolveCoursePassingScore({ passing_score: 70 }) === 70 && resolveCoursePassingScore({}) === 80 && resolveCoursePassingScore(null) === 80 &&
      resolveCoursePassingScore({ passing_score: 0 }) === 80 && resolveCoursePassingScore({ passing_score: 150 }) === 80 && resolveCoursePassingScore({ passing_score: "85" }) === 85)
  check("a required quiz with NO valid question is not_completable (never an automatic pass); an optional reading module with no quiz is no_quiz; a valid quiz is quiz_ready",
    courseQuizReadiness(true, []) === "not_completable" && courseQuizReadiness(false, [{ q: "x", choices: ["a"] }]) === "not_completable" &&
      courseQuizReadiness(false, null) === "no_quiz" && courseQuizReadiness(true, Q5) === "quiz_ready")
  check("the grader never passes an empty quiz (0/0 → score 0, not passed)", !gradeQuiz([], {}).passed && gradeQuiz([], {}).score === 0)
  const forged = sanitizeQuizAnswers({ passed: true, score: 100, correct: [0, 1, 2], "0": 0, "1": "1", "2": 1.5, "3": -1, "9": 0, "4": 0 }, 5)
  check("a forged payload keeps only integer question → integer choice pairs: `passed`, `score`, an answer key, string / fractional / negative / out-of-range entries are dropped",
    JSON.stringify(forged) === JSON.stringify({ 0: 0, 4: 0 }))
  check("POSITIVE CONTROL: honest answers survive the sanitizer untouched", JSON.stringify(sanitizeQuizAnswers(answersWith(5), 5)) === JSON.stringify(answersWith(5)))
  const now = new Date("2026-11-19T12:00:00Z")
  const att = (h: number) => ({ n: h, at: new Date(now.getTime() - h * 3_600_000).toISOString(), score: 40, passed: false, passing_score: 80, answers: {} })
  const limited = quizRetryVerdict([att(1), att(2), att(3)], now)
  check(`the retry rule: ${MODULE_QUIZ_ATTEMPTS_PER_DAY} attempts per rolling 24 h — a 4th is refused with the time it reopens; attempts older than 24 h do not count`,
    !limited.allowed && limited.retryAt === new Date(now.getTime() - 3 * 3_600_000 + 86_400_000).toISOString() && quizRetryVerdict([att(1), att(2), att(30)], now).allowed)
  const failed = gradeQuiz(Q5, answersWith(2))
  const fb = learnerQuizFeedback(failed)
  check("a FAILED attempt shows the missed questions with their coaching, and never the correct choice (no answer-key leak before a pass)",
    fb.filter((f) => !f.isCorrect).length === 3 && fb.every((f) => f.correct === undefined) && fb.filter((f) => !f.isCorrect).every((f) => /^Tip for/.test(f.coaching ?? "")))
  const passedFb = learnerQuizFeedback(gradeQuiz(Q5, answersWith(5)))
  check("POSITIVE CONTROL: a PASSED attempt reveals the correct choices", passedFb.every((f) => typeof f.correct === "number"))
}

// ─── EXECUTED (SIMULATED) ─────────────────────────────────────────────────────
async function lifecycleLayer() {
  console.log("\n[executed · recordCourseAttempt + the TRAINING_COMPLETED award — SIMULATED]")
  const c = memoryClient(seed())
  const rec = (id: string, answers: unknown, now?: Date, user = USER, brk = BRK) => recordCourseAttempt(c, { brokerageId: brk, userId: user, module: modRow(c, id), answers, now })
  const points = () => c.tables.agents.find((a) => a.id === AGENT)!.gamification_points
  const trainingRows = () => (c.tables.agent_points_log ?? []).filter((l) => l.reason === "TRAINING_COMPLETED")

  // REWARD-002 — fully viewed + failed quiz.
  const viewedOnly = await awardLifecycleMilestones(c, passEvent(M))
  check("REWARD-002 (a): a course fully VIEWED (status viewed, no attempt) is not completed and a TRAINING_COURSE_COMPLETED event for it earns nothing",
    asg(c, M)!.status === "viewed" && viewedOnly.awarded.length === 0 && viewedOnly.refused.some((x) => /reading a course never completes it/.test(x)))
  const t0 = new Date(Date.now() - 2 * 86_400_000)
  const f1 = await rec(M, answersWith(2), t0)
  const afterFail = await awardLifecycleMilestones(c, passEvent(M))
  check("REWARD-002 (b): viewed + FAILED quiz (40%) → persisted attempt, status still viewed, completed_at null, no points, no certificate",
    f1.ok && !f1.grade.passed && !f1.completedNow && asg(c, M)!.status === "viewed" && !asg(c, M)!.completed_at && readQuizAttempts(asg(c, M)!.signal_metadata).length === 1 &&
      afterFail.awarded.length === 0 && points() === 0 && trainingRows().length === 0)
  check("the attempt ledger keeps every other key the row already carried (signal_metadata merged, never overwritten)", asg(c, M)!.signal_metadata.source_note === "kept")

  // Retake after a fail → pass exactly at the threshold → award once.
  const f2 = await rec(M, answersWith(4), new Date(t0.getTime() + 3_600_000))
  check(`a retake after the fail scoring EXACTLY ${MODULE_QUIZ_PASSING_SCORE}% (4/5) completes the course once (completedNow, status completed, attempt #2 persisted)`,
    f2.ok && f2.grade.score === 80 && f2.grade.passed && f2.completedNow && asg(c, M)!.status === "completed" && !!asg(c, M)!.completed_at &&
      readQuizAttempts(asg(c, M)!.signal_metadata).map((a) => a.n).join(",") === "1,2")
  const award = await awardLifecycleMilestones(c, passEvent(M))
  check(`the pass event earns TRAINING_COMPLETED ${POINT_VALUES.TRAINING_COMPLETED} once, keyed on the course; stored total = ledger sum`,
    award.awarded.length === 1 && award.awarded[0].reason === "TRAINING_COMPLETED" && trainingRows().length === 1 && trainingRows()[0].reference_id === M &&
      points() === POINT_VALUES.TRAINING_COMPLETED && points() === (c.tables.agent_points_log ?? []).reduce((s, l) => s + Number(l.points), 0))
  const replay = await awardLifecycleMilestones(c, passEvent(M))
  check("REWARD-005: a replayed pass event awards nothing more", replay.awarded.length === 0 && replay.alreadyAwarded === 1 && trainingRows().length === 1)
  const again = await rec(M, answersWith(0), new Date(t0.getTime() + 7_200_000))
  check("a pass cannot be edited afterwards: a later (failing) submission is refused as already passed and the completed row is untouched",
    !again.ok && again.code === "already_passed" && asg(c, M)!.status === "completed" && asg(c, M)!.quiz_score === 80 && readQuizAttempts(asg(c, M)!.signal_metadata).length === 2)
  // The once-only transition also holds against a racing twin that completed the row between the read and the write.
  const race = memoryClient(seed())
  const raceRow = race.tables.learning_assignments[0]
  const origFrom = race.from
  let flipped = false
  ;(race as any).from = (table: string) => { const q = origFrom(table); if (table === "learning_assignments" && !flipped) { const ms = q.maybeSingle; q.maybeSingle = async () => { const r = await ms(); flipped = true; raceRow.status = "completed"; return r } } return q }
  const raced = await recordCourseAttempt(race, { brokerageId: BRK, userId: USER, module: modRow(race, M), answers: answersWith(5) })
  check("the once-only transition: a twin that completed the row after our read makes our update match nothing → refused, not a second completion", !raced.ok && raced.code === "already_passed")

  // Threshold — course-specific, one point under.
  const c60 = await rec(M_70, answersWith(3))
  check("a course-specific passing_score is honored over 80: a course whose own bar is 60 completes at 3/5 (60%), which the canonical 80 would fail",
    c60.ok && c60.grade.passingScore === 60 && c60.grade.passed && c60.completedNow)
  const c81 = await rec(M_81, answersWith(4))
  check("one point under the course's bar fails: 80% against an 81% course is not completed", c81.ok && c81.grade.score === 80 && !c81.grade.passed && !c81.completedNow && asg(c, M_81)!.status === "viewed")

  // Forged pass / score.
  const forgedPayload = await rec(M_81, { passed: true, score: 100, correct: Q5.map((q) => q.correct_idx), 0: 0 }, new Date(Date.now() + 60_000))
  check("a forged payload { passed: true, score: 100, correct: [...] } with one real answer grades 20% and does not complete",
    forgedPayload.ok && forgedPayload.grade.score === 20 && !forgedPayload.grade.passed && asg(c, M_81)!.status === "viewed")
  const forgedEvent = await awardLifecycleMilestones(c, passEvent(M_81, BRK, AGENT, { score: 100, passing_score: 0, passed: true }))
  check("a forged TRAINING_COURSE_COMPLETED event (score 100 in its payload) for a course with no persisted pass earns nothing", forgedEvent.awarded.length === 0)
  // A stored row whose `passed` flag was edited in afterwards (score under the bar) is not evidence.
  const tampered = memoryClient(seed())
  Object.assign(tampered.tables.learning_assignments[0], { status: "completed", signal_metadata: { quiz_attempts: [{ n: 1, at: new Date().toISOString(), score: 40, passed: true, passing_score: 80, answers: {} }] } })
  const tamperedAward = await awardLifecycleMilestones(tampered, passEvent(M))
  check("a pass edited in afterwards (status completed + passed:true on a 40% attempt) is NOT evidence — the award re-checks the score against the bar", tamperedAward.awarded.length === 0)

  // Not completable.
  const empty = await rec(M_EMPTY, answersWith(5))
  check("a REQUIRED quiz with no valid question is not completable — refused with the author-facing reason, no row completed",
    !empty.ok && empty.code === "not_completable" && /no valid questions yet/.test(empty.error) && !asg(c, M_EMPTY))
  const optional = await rec(M_OPTIONAL, {})
  check("an optional reading module with no quiz has nothing to grade (reading it is never a completion)", !optional.ok && optional.code === "no_quiz")

  // Retry rule, executed.
  const r = memoryClient(seed())
  const base = new Date(Date.now() - 3_600_000)
  const tries = [] as Awaited<ReturnType<typeof recordCourseAttempt>>[]
  for (let i = 0; i < 4; i++) tries.push(await recordCourseAttempt(r, { brokerageId: BRK, userId: USER, module: modRow(r, M), answers: answersWith(1), now: new Date(base.getTime() + i * 60_000) }))
  const later = await recordCourseAttempt(r, { brokerageId: BRK, userId: USER, module: modRow(r, M), answers: answersWith(5), now: new Date(base.getTime() + 25 * 3_600_000) })
  check(`the retry rule, executed: ${MODULE_QUIZ_ATTEMPTS_PER_DAY} failed tries are persisted, the 4th inside 24 h is refused (retry_limited, nothing written), the next day a retake passes`,
    tries.slice(0, 3).every((x) => x.ok) && !tries[3].ok && tries[3].code === "retry_limited" && readQuizAttempts(r.tables.learning_assignments[0].signal_metadata).length === 4 /* 3 failed + the next-day pass; the refused 4th wrote nothing */ &&
      later.ok && later.completedNow)

  // Fail closed + tenancy.
  const refused = memoryClient(seed()); refused.refuse("learning_assignments")
  const rr = await recordCourseAttempt(refused, { brokerageId: BRK, userId: USER, module: modRow(refused, M), answers: answersWith(5) })
  check("an unreadable progress row fails CLOSED: the attempt is not graded (never read as 'never attempted')", !rr.ok && rr.code === "read_refused")
  const crossTenant = await awardLifecycleMilestones(c, passEvent(M, BRK_B, AGENT))
  const otherTenantCourse = memoryClient(seed())
  await recordCourseAttempt(otherTenantCourse, { brokerageId: BRK, userId: USER, module: modRow(otherTenantCourse, M_B), answers: answersWith(5) })
  const bAward = await awardLifecycleMilestones(otherTenantCourse, passEvent(M_B))
  const bAgent = await awardLifecycleMilestones(c, passEvent(M, BRK, AGENT_B))
  check("tenant A cannot credit tenant B (and back): the pass named under another tenant, another tenant's course, or another tenant's agent earns nothing",
    crossTenant.awarded.length === 0 && bAward.awarded.length === 0 && bAgent.awarded.length === 0 && trainingRows().length === 1)
}

// ─── WIRING (stripped source) ─────────────────────────────────────────────────
function wiringLayer() {
  console.log("\n[wiring · the learner action, the screen, the publish doors, onboarding — stripped source]")
  const act = src("app/actions/academy-learning.ts")
  const submit = (act.match(/export async function submitModuleQuiz[\s\S]*?\n\}(?=\n|$)/) ?? [""])[0]
  const reader = (act.match(/export async function getModuleForLearner[\s\S]*?\n\}(?=\n|$)/) ?? [""])[0]
  check("submitModuleQuiz: session identity, the course scope gate, then THE recorder; certificate, competency edge and event only on completedNow",
    /getAgentContext\(\)/.test(submit) && /moduleInLearnerScope\(svc, ctx, mod\)/.test(submit) && /recordCourseAttempt\(svc,/.test(submit) &&
      /if \(completedNow\) \{[\s\S]*deriveEducationCompletedEdge[\s\S]*agent_certifications[\s\S]*KernelEvent\.TRAINING_COURSE_COMPLETED/.test(submit) && !/gradeQuiz\(/.test(submit))
  check("the action never trusts a client score or pass: no `answers.passed` / `answers.score` read, and the event carries the SERVER grade",
    !/answers\.(passed|score)/.test(submit) && /score: grade\.score, passing_score: grade\.passingScore/.test(submit))
  check("the certificate is a CHECK-valid cert_type (the base value 'learning_module' was refused by agent_certifications_cert_type_check)",
    /const CERT_TYPE = "specialty"/.test(act) && (CHECK_VOCABULARIES as any).agent_certifications.cert_type.includes("specialty"))
  check("NEGATIVE CONTROL (red at base): 'learning_module' is NOT an agent_certifications.cert_type — every base certificate insert was refused",
    !(CHECK_VOCABULARIES as any).agent_certifications.cert_type.includes("learning_module"))
  check("getModuleForLearner sends questions + choices only (no correct_idx, no explainer before an attempt), the resolved threshold and the readiness",
    /questions: questions\.map\(\(\{ q, choices \}\) => \(\{ q, choices \}\)\)/.test(reader) && /passingScore: resolveCoursePassingScore\(/.test(reader) && /readiness: courseQuizReadiness\(/.test(reader) &&
      /moduleInLearnerScope\(svc, ctx, mod\)/.test(reader))
  check("POSITIVE CONTROL: the leak finder would see an explainer sent before an attempt", !/questions\.map\(\(\{ q, choices \}\) => \(\{ q, choices \}\)\)/.test("questions.map(({ q, choices, explainer }) => ({ q, choices, explainer }))"))
  const scope = (act.match(/async function moduleInLearnerScope[\s\S]*?\n\}(?=\n|$)/) ?? [""])[0]
  check("course scope: tenant first, then a team-authored module only for that team (rowInTeamScope, wave 154) — a team that cannot be resolved fails closed",
    /mod\.brokerage_id && mod\.brokerage_id !== ctx\.brokerageId\) return false/.test(scope) && /rowInTeamScope\(mod\.team_id, team\.teamId\)/.test(scope) && /return false\s*\}\s*\}$/.test(scope.trim()))
  const ui = src("app/academy/module/[id]/module-reader-client.tsx")
  check("the reader screen shows coaching from the GRADED result (never pre-loaded), the not-completable notice, and says reading does not complete the course",
    /result\?\.perQuestion\.find\(\(p\) => p\.index === idx\)\?\.coaching/.test(ui) && !/question\.explainer/.test(ui) && /mod\.readiness === "not_completable"/.test(ui) && /Reading the lesson doesn&apos;t complete it/.test(ui))
  for (const [file, fn] of [["app/actions/learning-modules.ts", "publishLearningModuleAction"], ["app/actions/learning-modules-approvals.ts", "approveLearningModuleAction"]] as const) {
    const body = (src(file).match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n\\}(?=\\n|$)`)) ?? [""])[0]
    check(`${fn}: a required quiz with no valid question is refused publication with COURSE_NOT_COMPLETABLE_MESSAGE (the author is told)`,
      /courseQuizReadiness\([\s\S]*?=== "not_completable"\) \{\s*return \{ ok: false, error: COURSE_NOT_COMPLETABLE_MESSAGE \}/.test(body))
  }
  const onb = src("app/actions/onboarding/onboarding-quiz-actions.ts")
  check("the onboarding quiz endpoint strips the answer key before it reaches the browser (red at base: fetchQuiz returned getQuizForStep's questions raw)",
    /questions: quiz\.questions\.map\(\(q\) => withoutAnswerKey\(q\)\)/.test(onb) && /correctAnswer: _a/.test(onb) && !/export (async )?function withoutAnswerKey/.test(onb))
  const cert = src("lib/onboarding/certification-engine.ts")
  const gate = (cert.match(/async function requireAttachedQuizzesPassed[\s\S]*?\n\}(?=\n|$)/) ?? [""])[0]
  check("onboarding certificates: an attached quiz must hold a STORED attempt whose score meets the quiz's own bar (score re-checked, not the passed flag); no valid question = cannot complete; a refused read is a missing requirement",
    /from\('agent_quiz_attempts'\)[\s\S]*?\.gte\('score', bar\)/.test(gate) && /resolveCoursePassingScore\(quiz\)/.test(gate) && /has no valid questions yet/.test(gate) &&
      /could not be checked/.test(gate) && !/\.eq\('passed', true\)/.test(gate) &&
      (cert.match(/await requireAttachedQuizzesPassed\(supabase, agentId,/g) ?? []).length === 2)
  check("TRAINING_COMPLETED is advertised only because it is now a verified reactor award (R1), with its existing value",
    POINT_EARNING_ACTIONS.some((a) => a.reason === "TRAINING_COMPLETED") && POINT_VALUES.TRAINING_COMPLETED === 25)
  check("POSITIVE CONTROL: the comment stripper is in use — a tombstone naming recordCourseAttempt is not a call site",
    !/recordCourseAttempt\(svc,/.test(stripComments("// recordCourseAttempt(svc, …) — a tombstone\nexport const x = 1")))
  const parsed = parseQuizQuestions([{ question: "legacy", options: ["a", "b"], correct: 1 }, { q: "bad", choices: ["a", "b"], correct_idx: 5 }])
  check("the parser still accepts the legacy {question, options, correct} spelling and drops an out-of-range key (the grader's input is unchanged)", parsed.length === 1 && parsed[0].correct_idx === 1)
}

async function main() {
  pureLayer()
  await lifecycleLayer()
  wiringLayer()
  console.log(`\n RESULT: ${pass} passed, ${fail} failed (all SIMULATED)`)
  if (fail > 0) { console.log(" ❌ COURSE_COMPLETION_FAIL\n" + fails.map((f) => `   - ${f}`).join("\n")); process.exit(1) }
  console.log(" ✅ COURSE_COMPLETION_OK")
}
main().catch((e) => { console.error(e); process.exit(1) })
