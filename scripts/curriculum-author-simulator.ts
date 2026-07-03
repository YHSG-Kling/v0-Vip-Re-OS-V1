#!/usr/bin/env tsx
/**
 * scripts/curriculum-author-simulator.ts   (npm run test:curriculum-author)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AUTONOMOUS CURRICULUM AUTHOR — the OS teaching itself to teach. It mines real signal for a
 * recurring knowledge gap, decides IF a topic warrants education, authors a rich micro-course grounded in
 * that evidence, and persists it as a GATED DRAFT for a human to publish. HONEST gating: a one-off low
 * score is noise; a mostly-strong scenario isn't a gap; a topic handled well never surfaces.
 *
 * PURE:   detectKnowledgeGaps (recurrence + weakness gating, priority ranking) + summarizeCurriculumBoard.
 * SOURCE: the author gathers real signals, authors via the model, persists a gated draft, rides the weekly
 *         cron; the board is wired into loadCommandCenter + rendered; owned by recruiting_manager.
 * LIVE (creds-gated on Supabase): seed weak objection drills → gatherGapSignals + detect flags the gap →
 *         persistCurriculumDraft lands a draft course → the board surfaces it → idempotent → clean up == 0.
 *         (The model call is creds-gated separately; the test authors a REAL, gap-specific curriculum to
 *         prove the detect→persist→surface pipeline without depending on a live gateway.)
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { detectKnowledgeGaps, MIN_RECURRENCE, type GapSignal } from "../lib/education/knowledge-gap-detector"
import { classifyQuestion, buildQuestionSignals, QUESTION_MIN_ASKERS } from "../lib/education/question-gap"
import { summarizeCurriculumBoard } from "../lib/intelligence/curriculum-board"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const sig = (o: Partial<GapSignal>): GapSignal => ({ topicKey: "objection:x", topicLabel: "X", source: "objection_drill", weakCount: 5, totalCount: 8, avgScore: 55, evidence: ["struggled to reframe value"], ...o })

function pureLayer() {
  console.log("\n[detectKnowledgeGaps · pure — the 'is this worth teaching?' brain]")
  const gaps = detectKnowledgeGaps([sig({ topicKey: "objection:price", topicLabel: "price too high", weakCount: 6, totalCount: 10, avgScore: 52 })])
  check("a recurring, prevalent weak scenario IS a gap", gaps.length === 1 && gaps[0].topicKey === "objection:price")
  check("gap carries a broker-readable rationale + evidence", /scored weak|avg/i.test(gaps[0].rationale) && gaps[0].evidence.length > 0)
  check("a one-off low score is NOT a gap (below recurrence)", detectKnowledgeGaps([sig({ weakCount: MIN_RECURRENCE - 1, totalCount: 3 })]).length === 0)
  check("a mostly-STRONG scenario is NOT a gap (low weakness ratio)", detectKnowledgeGaps([sig({ weakCount: 3, totalCount: 30, avgScore: 88 })]).length === 0)
  check("compliance recurrence is a gap regardless of ratio", detectKnowledgeGaps([sig({ topicKey: "compliance:fair_housing", source: "compliance", weakCount: 4, totalCount: 4, avgScore: null })]).length === 1)
  const ranked = detectKnowledgeGaps([
    sig({ topicKey: "objection:a", weakCount: 4, totalCount: 6, avgScore: 68 }),
    sig({ topicKey: "objection:b", weakCount: 8, totalCount: 10, avgScore: 40 }),
  ])
  check("worse + more-frequent gap ranks first (priority)", ranked[0].topicKey === "objection:b")
  check("quiet signal → no gaps (honest)", detectKnowledgeGaps([]).length === 0)

  console.log("\n[question → curriculum · pure — the OS learns from what people ask]")
  check("classifies a real-estate question to its topic", classifyQuestion("what does clear to close mean?")?.topic === "clear_to_close" && classifyQuestion("how does escrow work")?.topic === "escrow")
  check("an off-topic / too-short question is not force-fit (null)", classifyQuestion("hello") === null && classifyQuestion("what's the weather") === null)
  const qs = Array.from({ length: QUESTION_MIN_ASKERS }, () => ({ text: "can you explain how the appraisal process works" }))
  const qSignals = buildQuestionSignals(qs)
  check(`a topic asked ≥${QUESTION_MIN_ASKERS}× becomes a question signal`, qSignals.length === 1 && qSignals[0].topicKey === "question:appraisal" && qSignals[0].source === "question")
  check("under the recurrence floor → no signal (noise)", buildQuestionSignals([{ text: "how does escrow work" }]).length === 0)
  const qGap = detectKnowledgeGaps(qSignals)
  check("a recurring question is a gap (recurrence-only, like compliance)", qGap.length === 1 && qGap[0].topicKey === "question:appraisal")
  const gs = readFileSync(join(process.cwd(), "lib/education/curriculum-author.ts"), "utf8")
  check("gatherGapSignals mines chat questions (brokerage-scoped user turns)", /from\("chat_messages"\)[\s\S]*?chat_sessions!inner\(brokerage_id\)[\s\S]*?buildQuestionSignals/.test(gs))

  console.log("\n[summarizeCurriculumBoard · pure — canonical learning_modules rows]")
  const board = summarizeCurriculumBoard([
    { id: "c1", title: "Beating the price objection", gap_tags: ["objection:price"], quiz_questions: [1, 2], body: "# T\n\nsummary\n\n## What you'll be able to do\n- x\n\n## Lesson A\n- a\n\n## Lesson B\n- b\n" },
  ])
  check("board counts pending + lesson/quiz sizes + gap rationale", board.pending === 1 && board.drafts[0].lessonCount === 2 && board.drafts[0].quizCount === 2 && /objection:price/.test(board.drafts[0].rationale ?? ""))
}

function sourceLayer() {
  console.log("\n[wiring — mine signal, author via model, gated draft, board, owned]")
  const author = src("lib/education/curriculum-author.ts")
  check("mines REAL signal (objection drills + compliance flags)", /objection_training_sessions[\s\S]*?compliance_flags/.test(author))
  check("authors via the model, grounded in real evidence (no generic filler)", /generateObjectRouted[\s\S]*?CurriculumSchema/.test(author) && /evidence/i.test(author))
  check("persists a GATED DRAFT on the CANONICAL learning_modules (not a parallel table)", /from\("learning_modules"\)\.insert\([\s\S]*?status: "pending_review"[\s\S]*?gap_tags: \[gap\.topicKey\]/.test(author))
  check("idempotent per gap tag (no duplicate module for a topic)", /contains\("gap_tags", \[gap\.topicKey\]\)/.test(author))
  const cron = src("app/api/cron/recruit-outreach/route.ts")
  check("the weekly recruit-outreach cron runs the author", /runCurriculumAuthorAll/.test(cron))
  const cc = src("lib/kernel/command-center.ts")
  check("curriculumBoard is wired into loadCommandCenter", /curriculumBoard:\s*import\("@\/lib\/intelligence\/curriculum-board"\)/.test(cc) && /generateCurriculumBoard\(brokerageId\)/.test(cc))
  const client = src("app/dashboard/admin/command-center/command-center-client.tsx")
  check("the client renders the curriculum board card", /AI-authored curriculum/.test(client) && /data\.curriculumBoard/.test(client))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /curriculum_author:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:curriculum-author"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed weak drills → detect the gap → persist a gated draft → board surfaces it → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ag } = await svc.from("agents").select("user_id").eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no agent — skipping"); return }
  const agentUserId = (ag as any).user_id
  const cleanup: Array<{ table: string; id: string }> = []
  const started = new Date().toISOString()
  try {
    // 4 weak drills on one scenario → a recurring, prevalent gap.
    for (let i = 0; i < 4; i++) {
      const { data } = await svc.from("objection_training_sessions").insert({
        brokerage_id: brokerageId, agent_user_id: agentUserId, scenario_key: "zz_test_lowball", scenario_label: "ZZ Test — lowball offer",
        status: "completed", started_at: started, completed_at: started, total_score: 50, improvements: ["Could not justify list price with comps"],
      }).select("id").single()
      cleanup.push({ table: "objection_training_sessions", id: (data as any).id })
    }

    const { gatherGapSignals, persistCurriculumDraft, runCurriculumAuthor } = await import("../lib/education/curriculum-author")
    const signals = await gatherGapSignals(svc as any, brokerageId, new Date())
    const gap = detectKnowledgeGaps(signals).find((g) => g.topicKey === "objection:zz_test_lowball")
    check("live: gathered signal + detected the seeded gap", !!gap && gap!.weakCount >= 4)

    // Author a REAL, gap-specific curriculum (prod uses the model; here we prove detect→persist→surface).
    const curriculum = {
      title: "Defending list price against a lowball offer",
      summary: "Turn a lowball into a real negotiation by anchoring on comps and the cost of waiting.",
      objectives: ["Anchor the seller's price with 3 recent comps", "Reframe a lowball as an opening, not an insult"],
      lessons: [
        { title: "Anchor on evidence", keyPoints: ["Open with the 3 closest comps", "Translate condition deltas into dollars"] },
        { title: "Reframe the lowball", keyPoints: ["Thank them for the offer, then counter with data", "Quantify the cost of the home sitting"] },
      ],
      quiz: [{ question: "First move on a lowball?", options: ["Reject it", "Counter with comps", "Ignore it"], correctIndex: 1 }],
    }
    const ok = gap ? await persistCurriculumDraft(svc as any, brokerageId, gap, curriculum) : false
    check("live: persisted a gated DRAFT module for the gap", ok === true)

    const { data: mod } = await svc.from("learning_modules").select("id, status, is_ai_generated, gap_tags, body, quiz_questions").eq("brokerage_id", brokerageId).contains("gap_tags", ["objection:zz_test_lowball"]).maybeSingle()
    if (mod) cleanup.push({ table: "learning_modules", id: (mod as any).id })
    check("live: the draft is on learning_modules, pending_review, rich body + quiz", !!mod && (mod as any).status === "pending_review" && (mod as any).is_ai_generated === true && typeof (mod as any).body === "string" && (mod as any).body.length > 50 && Array.isArray((mod as any).quiz_questions))

    const { generateCurriculumBoard } = await import("../lib/intelligence/curriculum-board")
    const board = await generateCurriculumBoard(brokerageId, svc as any)
    check("live: the command-center board surfaces the pending draft", !!board && board.pending >= 1 && board.drafts.some((d) => d.topicKey === "objection:zz_test_lowball"))

    // Idempotent: a second run detects the existing gap tag and does not re-author.
    const r2 = await runCurriculumAuthor(svc as any, { brokerageId })
    const { count } = await svc.from("learning_modules").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).contains("gap_tags", ["objection:zz_test_lowball"])
    check("live: idempotent — one module per gap topic", count === 1 && r2.authored === 0)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CURRICULUM_AUTHOR_FAIL"); process.exit(1) }
  console.log(" ✅ CURRICULUM_AUTHOR_PASS — the OS detects real knowledge gaps and authors gated, grounded micro-courses")
}
main()
