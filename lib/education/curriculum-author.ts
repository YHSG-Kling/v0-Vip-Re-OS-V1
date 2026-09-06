// lib/education/curriculum-author.ts
//
// CURRICULUM AUTHOR (recruiting_manager) — the OS teaches itself to teach. Weekly it mines the real
// signal of the business (objection-drill scores by scenario, recurring compliance violations), asks the
// pure detector IF any topic genuinely warrants education, and for each NEW proven gap it AUTHORS a rich,
// specific micro-course with the model — grounded in the real evidence, not generic real-estate filler —
// then persists it as a GATED DRAFT on the training_courses catalog for a human to review/publish.
// Idempotent per (brokerage, topic). Best-effort; never throws into a caller.

import { z } from "zod"
import { createServiceClient } from "@/lib/supabase/service"
import { detectKnowledgeGaps, type GapSignal, type KnowledgeGap } from "@/lib/education/knowledge-gap-detector"
import { resolveMaterialFormat, channelsForFormat } from "@/lib/education/delivery-format"

type Svc = ReturnType<typeof createServiceClient>

const WEAK_DRILL_SCORE = 70

/** The rich curriculum shape the model authors (specific to the detected gap, quiz included). */
export const CurriculumSchema = z.object({
  title: z.string().describe("A specific, punchy course title naming the exact skill/topic."),
  summary: z.string().describe("2-3 sentences on why this matters and what the agent will be able to do after."),
  objectives: z.array(z.string()).min(2).max(6).describe("Concrete, observable learning objectives."),
  lessons: z.array(z.object({
    title: z.string(),
    walkthrough: z.string().describe("The FULL teaching text for this lesson — in-depth, step by step, assume the least-experienced licensee: define every term the first time it appears, walk documents/forms section by section (what each section means, how to fill it, the common mistakes), explain the WHY behind every step, and include verbatim scripts where speech is involved. Several substantial paragraphs, never a summary. Where an experienced agent would skip ahead, add a short 'If you've done this before' advanced note."),
    keyPoints: z.array(z.string()).min(2).max(6).describe("The recap after the walkthrough — specific, actionable takeaways."),
  })).min(3).max(8),
  quiz: z.array(z.object({
    question: z.string(),
    options: z.array(z.string()).min(3).max(4),
    correctIndex: z.number().int().min(0),
  })).min(2).max(5),
})
export type Curriculum = z.infer<typeof CurriculumSchema>

/** Gather the real knowledge-gap signals for a brokerage (objection drills + compliance violations). */
export async function gatherGapSignals(svc: Svc, brokerageId: string, now: Date): Promise<GapSignal[]> {
  const since = new Date(now.getTime() - 180 * 86_400_000).toISOString()
  const questionSince = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const [drills, flags, questions] = await Promise.all([
    svc.from("objection_training_sessions").select("scenario_key, scenario_label, total_score, improvements").eq("brokerage_id", brokerageId).not("completed_at", "is", null).gte("started_at", since).limit(5000),
    svc.from("compliance_flags").select("violation_type, flagged_content").eq("brokerage_id", brokerageId).gte("created_at", since).limit(5000),
    // QUESTION SIGNAL — recurring questions in the assistant/tutor logs (user turns only, brokerage-scoped).
    svc.from("chat_messages").select("content, chat_sessions!inner(brokerage_id)").eq("role", "user").eq("chat_sessions.brokerage_id", brokerageId).gte("created_at", questionSince).limit(5000),
  ])

  const signals: GapSignal[] = []

  // Objection drills → per-scenario weakness.
  type Scen = { label: string; scores: number[]; total: number; evidence: string[] }
  const byScenario = new Map<string, Scen>()
  for (const d of (drills.data ?? []) as any[]) {
    if (!d.scenario_key) continue
    const e: Scen = byScenario.get(d.scenario_key) ?? { label: d.scenario_label ?? d.scenario_key, scores: [], total: 0, evidence: [] }
    e.total++
    if (typeof d.total_score === "number") e.scores.push(d.total_score)
    // improvements is text[] — flatten to a snippet for grounding evidence.
    const imp = Array.isArray(d.improvements) ? d.improvements.join("; ") : d.improvements
    if (imp && e.evidence.length < 5) e.evidence.push(String(imp).slice(0, 200))
    byScenario.set(d.scenario_key, e)
  }
  for (const [key, e] of byScenario) {
    const weak = e.scores.filter((s) => s <= WEAK_DRILL_SCORE)
    const avg = e.scores.length ? Math.round(e.scores.reduce((a, b) => a + b, 0) / e.scores.length) : null
    signals.push({ topicKey: `objection:${key}`, topicLabel: e.label, source: "objection_drill", weakCount: weak.length, totalCount: e.total, avgScore: avg, evidence: e.evidence })
  }

  // Compliance flags → per-violation-type recurrence.
  type Viol = { count: number; evidence: string[] }
  const byViolation = new Map<string, Viol>()
  for (const f of (flags.data ?? []) as any[]) {
    if (!f.violation_type) continue
    const e: Viol = byViolation.get(f.violation_type) ?? { count: 0, evidence: [] }
    e.count++
    if (f.flagged_content && e.evidence.length < 5) e.evidence.push(String(f.flagged_content).slice(0, 200))
    byViolation.set(f.violation_type, e)
  }
  for (const [type, e] of byViolation) {
    signals.push({ topicKey: `compliance:${type}`, topicLabel: type.replace(/_/g, " "), source: "compliance", weakCount: e.count, totalCount: e.count, avgScore: null, evidence: e.evidence })
  }

  // Recurring assistant/tutor questions → question gaps (classified against the fixed topic lexicon).
  try {
    const { buildQuestionSignals } = await import("@/lib/education/question-gap")
    const rawQs = ((questions.data ?? []) as Array<{ content?: string | null }>).map((q) => ({ text: q.content ?? "" }))
    signals.push(...buildQuestionSignals(rawQs))
  } catch { /* question mining is best-effort */ }

  return signals
}

/** Author a rich curriculum for a detected gap with the model. Throws if the model is unavailable. */
export async function authorCurriculum(gap: KnowledgeGap): Promise<Curriculum> {
  const { generateObjectRouted } = await import("@/lib/ai/models")
  const evidence = gap.evidence.length ? `\n\nReal evidence from our agents (ground the material in THESE, not generic advice):\n- ${gap.evidence.join("\n- ")}` : ""
  const { withScriptStandards } = await import("@/lib/ai/script-standards")
  const { object } = await generateObjectRouted({
    feature: "curriculum_authoring",
    schema: CurriculumSchema,
    system: withScriptStandards("You are a master real-estate trainer authoring an IN-DEPTH course for licensed agents of EVERY experience level — a nervous first-year licensee must be able to follow it start to finish, and a veteran must still learn something. Depth rules: define every term the first time it appears; walk any document or form SECTION BY SECTION (what it means, how to fill it, the mistakes that bite); give verbatim scripts wherever speech is involved; explain the WHY behind each step, never just the what. No summaries, no generic filler, no platitudes — if a lesson could fit on an index card, it is too shallow."),
    maxTokens: 6000,
    prompt: `Author a micro-course that closes this proven, recurring knowledge gap on our team:\n\nTopic: ${gap.topicLabel}\nWhy it matters: ${gap.rationale}${evidence}\n\nWrite tight, specific, and immediately actionable.`,
  })
  return object
}

export interface CurriculumAuthorResult { signals: number; gaps: number; authored: number }

/** Detect gaps for a brokerage and author a gated draft course for each NEW one. */
export async function runCurriculumAuthor(svc: Svc, params: { brokerageId: string; now?: Date; maxPerRun?: number }): Promise<CurriculumAuthorResult> {
  const out: CurriculumAuthorResult = { signals: 0, gaps: 0, authored: 0 }
  const now = params.now ?? new Date()
  const cap = params.maxPerRun ?? 3 // author at most a few per run (LLM cost + reviewer load)

  const signals = await gatherGapSignals(svc, params.brokerageId, now)
  out.signals = signals.length
  const gaps = detectKnowledgeGaps(signals)
  out.gaps = gaps.length
  if (gaps.length === 0) return out

  for (const gap of gaps.slice(0, cap)) {
    // Idempotent: skip a topic we've already authored (an AI module already carries this gap tag).
    const { data: existing } = await svc.from("learning_modules")
      .select("id").eq("brokerage_id", params.brokerageId).eq("is_ai_generated", true).contains("gap_tags", [gap.topicKey]).limit(1).maybeSingle()
    if (existing) continue

    let curriculum: Curriculum
    try { curriculum = await authorCurriculum(gap) } catch { continue /* model unavailable — try again next run */ }

    // Cross-path dedup: the chatter/gap path names topics dynamically, so a topic
    // another subsystem already covered (under a different gap_tag) would slip past
    // the per-tag guard above. Skip if a near-duplicate title already exists for an
    // overlapping audience — no duplicates across paths.
    const audience = gap.source === "compliance" ? ["agent", "broker"] : ["agent"]
    const { hasNearDuplicateModule } = await import("@/lib/education/dedup-guard")
    if (await hasNearDuplicateModule(svc, params.brokerageId, curriculum.title, audience)) continue

    const ok = await persistCurriculumDraft(svc, params.brokerageId, gap, curriculum)
    if (ok) out.authored++
  }
  return out
}

/** PURE: render an authored curriculum into a rich learning_modules body (markdown) — real content. */
export function renderModuleBody(c: Curriculum, footer: string): string {
  return [
    `# ${c.title}`,
    "",
    c.summary,
    "",
    "## What you'll be able to do",
    ...c.objectives.map((o) => `- ${o}`),
    "",
    ...c.lessons.flatMap((l) => [`## ${l.title}`, "", l.walkthrough, "", "**Key takeaways**", ...l.keyPoints.map((k) => `- ${k}`), ""]),
    footer ? `_${footer}_` : "",
  ].filter(Boolean).join("\n")
}

/** PURE: render a knowledge-gap curriculum (footer names the gap that triggered it). */
export function renderCurriculumBody(gap: KnowledgeGap, c: Curriculum): string {
  return renderModuleBody(c, `Authored by the Recruiting Manager from a real, recurring gap: ${gap.rationale}`)
}

/**
 * Persist an authored curriculum as a GATED DRAFT on the CANONICAL learning_modules catalog
 * (status 'pending_review', is_ai_generated, gap_tags carry the detected topic so the learning-router
 * can target it). The existing approve/publish action + learning-router delivery to agents AND client
 * portals then take over — no parallel system. Best-effort.
 */
export async function persistCurriculumDraft(svc: Svc, brokerageId: string, gap: KnowledgeGap, curriculum: Curriculum): Promise<boolean> {
  const { error } = await svc.from("learning_modules").insert({
    brokerage_id: brokerageId,
    title: curriculum.title,
    summary: curriculum.summary,
    body: renderCurriculumBody(gap, curriculum),
    quiz_questions: curriculum.quiz as any,
    is_ai_generated: true,
    status: "pending_review",
    gap_tags: [gap.topicKey],
    // Skill gaps train agents; compliance gaps train the whole roster incl. brokers.
    audience_roles: gap.source === "compliance" ? ["agent", "broker"] : ["agent"],
    // Format follows the material — only video-worthy topics render on the video channel.
    channels: channelsForFormat(resolveMaterialFormat({ topicKey: gap.topicKey })),
    estimated_minutes: 5,
    required: gap.source === "compliance",
  })
  return !error
}

/** Autonomous: author across every brokerage (rides the weekly recruit-outreach cron). */
export async function runCurriculumAuthorAll(svc: Svc, now?: Date): Promise<{ brokerages: number; authored: number }> {
  const out = { brokerages: 0, authored: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runCurriculumAuthor(svc, { brokerageId: b.id, now }); out.authored += r.authored } catch { /* keep going */ }
  }
  return out
}
