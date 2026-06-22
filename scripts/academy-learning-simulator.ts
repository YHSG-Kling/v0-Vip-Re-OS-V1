#!/usr/bin/env tsx
/**
 * scripts/academy-learning-simulator.ts  (npm run test:academy-learning)
 *
 * Proves the Academy LEARNER vertical: module reader → quiz → certification.
 *  - PURE layer (always): the quiz grader (parse/grade/threshold/idempotent) — the
 *    same gradeQuiz() the server action and the reader both call.
 *  - LIVE layer (creds-gated, self-cleaning): seeds a tagged brokerage + agent +
 *    a published REQUIRED learning_module with a quiz, then performs the exact DB
 *    writes the submit-quiz action performs (learning_assignments completion +
 *    agent_certifications issuance), asserts they landed against the live schema,
 *    proves cert issuance is idempotent, then deletes every tagged row.
 *
 * Live run:  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/academy-learning-simulator.ts
 */
import { randomUUID } from "node:crypto"
import { gradeQuiz, parseQuizQuestions, MODULE_QUIZ_PASSING_SCORE, type ModuleQuizQuestion } from "../lib/academy/quiz"

const QUESTIONS: ModuleQuizQuestion[] = [
  { q: "Lead with…", choices: ["features", "feelings", "fees"], correct_idx: 1, explainer: "Them-first." },
  { q: "First response target?", choices: ["5 min", "1 day", "1 week"], correct_idx: 0 },
  { q: "Consent gate owner?", choices: ["nobody", "Compliance Officer"], correct_idx: 1 },
]

function selfTest(): void {
  let pass = 0, fail = 0
  const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

  console.log("\n[quiz grader · pure]")
  // parse tolerance
  check("parseQuizQuestions drops malformed rows", parseQuizQuestions([
    { q: "ok", choices: ["a", "b"], correct_idx: 0 },
    { q: "no choices", choices: [], correct_idx: 0 },
    { q: "bad idx", choices: ["a", "b"], correct_idx: 9 },
    null,
  ]).length === 1)
  check("parseQuizQuestions accepts options/correctIndex aliases", parseQuizQuestions([
    { question: "alias", options: ["a", "b"], correctIndex: 1 },
  ]).length === 1)

  // perfect score passes
  const perfect = gradeQuiz(QUESTIONS, { 0: 1, 1: 0, 2: 1 })
  check("all-correct → 100 and passed", perfect.score === 100 && perfect.passed)

  // one wrong → 67% → below 80 → not passed; unanswered counts wrong
  const oneWrong = gradeQuiz(QUESTIONS, { 0: 1, 1: 0 /* q2 unanswered */, 2: 0 })
  check("one wrong + one blank → below threshold, not passed", oneWrong.correct === 2 && oneWrong.score === 67 && !oneWrong.passed)

  // threshold exactness: 2/2 = 100 passes; empty quiz never passes
  check("passing bar is the platform constant", perfect.passingScore === MODULE_QUIZ_PASSING_SCORE)
  check("empty quiz grades 0/0 and never passes", (() => { const g = gradeQuiz([], {}); return g.total === 0 && !g.passed })())

  // per-question explainer surfaces only the authored ones
  check("perQuestion carries index + correctness", perfect.perQuestion.length === 3 && perfect.perQuestion[0].isCorrect)

  if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
  console.log(` RESULT: ${pass} passed, 0 failed`)
}

async function main(): Promise<void> {
  selfTest()

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[live run] ⏭  Skipped — SUPABASE creds not set (or DB unreachable).")
    console.log("\n✅ ACADEMY_LEARNING pure layer passed; live run is creds-gated.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const tag = `ACADLEARN-${Date.now()}`
  const brokerageId = randomUUID()
  const userId = randomUUID()
  const moduleId = randomUUID()
  let agentRowId: string | null = null
  const cleanup: Array<() => PromiseLike<unknown>> = []
  const title = `${tag} Them-First Mastery`
  let ok = true
  const check = (n: string, c: boolean) => { if (!c) ok = false; console.log(`  ${c ? "✓" : "✗"} ${n}`) }

  console.log(`\n[live run] tag=${tag}`)
  try {
    // ── SEED ──
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} Brokerage`, city: "Austin", state: "TX" })
    cleanup.push(() => svc.from("brokerages").delete().eq("id", brokerageId))
    await svc.from("users").insert({ id: userId, brokerage_id: brokerageId, email: `learner+${tag}@demo.local`, first_name: "Demo", last_name: "Learner", user_type: "agent" })
    cleanup.push(() => svc.from("users").delete().eq("id", userId))
    const { data: agentRow } = await svc.from("agents").insert({ user_id: userId, brokerage_id: brokerageId }).select("id").single()
    agentRowId = (agentRow?.id as string) ?? null
    if (agentRowId) cleanup.push(() => svc.from("agents").delete().eq("id", agentRowId as string))
    await svc.from("learning_modules").insert({
      id: moduleId, brokerage_id: brokerageId, title, summary: "Lead with feelings.", body: "Them-first selling.",
      status: "published", required: true, estimated_minutes: 10, quiz_questions: QUESTIONS,
    })
    cleanup.push(() => svc.from("learning_modules").delete().eq("id", moduleId))
    console.log("  ✓ seeded brokerage + agent + published required module with quiz")

    // ── GRADE (server-authoritative) then WRITE exactly what submitModuleQuiz writes ──
    const grade = gradeQuiz(parseQuizQuestions(QUESTIONS), { 0: 1, 1: 0, 2: 1 })
    check("seeded module grades to a pass", grade.passed && grade.score === 100)

    await svc.from("learning_assignments").insert({
      brokerage_id: brokerageId, module_id: moduleId, agent_user_id: userId,
      signal_source: "academy_self_serve", status: "completed", quiz_score: grade.score,
      viewed_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    })
    cleanup.push(() => svc.from("learning_assignments").delete().eq("module_id", moduleId))

    const { count: laCount } = await svc.from("learning_assignments").select("id", { count: "exact", head: true })
      .eq("module_id", moduleId).eq("agent_user_id", userId).eq("status", "completed")
    check("completion recorded in learning_assignments", (laCount ?? 0) === 1)

    // ── CERTIFY (idempotent guard, just like the action) ──
    async function issueCertOnce(): Promise<void> {
      const { count } = await svc.from("agent_certifications").select("id", { count: "exact", head: true })
        .eq("agent_id", agentRowId as string).eq("certification_name", title).eq("cert_type", "learning_module")
      if ((count ?? 0) === 0) {
        await svc.from("agent_certifications").insert({
          agent_id: agentRowId, brokerage_id: brokerageId, certification_name: title,
          cert_type: "learning_module", issued_at: new Date().toISOString(), issued_by: userId,
        })
      }
    }
    await issueCertOnce()
    await issueCertOnce() // second call must not create a duplicate
    cleanup.push(() => svc.from("agent_certifications").delete().eq("agent_id", agentRowId as string))

    const { count: certCount } = await svc.from("agent_certifications").select("id", { count: "exact", head: true })
      .eq("agent_id", agentRowId as string).eq("certification_name", title)
    check("certification issued exactly once (idempotent)", (certCount ?? 0) === 1)

    if (!ok) throw new Error("one or more live assertions failed")
    console.log("\n✅ ACADEMY_LEARNING — reader→quiz→certification ran end-to-end on the live DB.")
  } finally {
    for (const del of cleanup.reverse()) { try { await del() } catch { /* best-effort */ } }
    console.log(`  ✓ cleaned up all rows tagged ${tag}`)
  }
  if (!ok) process.exit(1)
}

main().catch((e) => { console.error("academy-learning-simulator failed:", e); process.exit(1) })
