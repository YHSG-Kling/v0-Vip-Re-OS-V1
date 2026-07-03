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

type Svc = ReturnType<typeof createServiceClient>

const WEAK_DRILL_SCORE = 70

/** The rich curriculum shape the model authors (specific to the detected gap, quiz included). */
export const CurriculumSchema = z.object({
  title: z.string().describe("A specific, punchy course title naming the exact skill/topic."),
  summary: z.string().describe("2-3 sentences on why this matters and what the agent will be able to do after."),
  objectives: z.array(z.string()).min(2).max(6).describe("Concrete, observable learning objectives."),
  lessons: z.array(z.object({
    title: z.string(),
    keyPoints: z.array(z.string()).min(2).max(6).describe("Specific, actionable teaching points — real scripts/tactics, not platitudes."),
  })).min(2).max(5),
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
  const [drills, flags] = await Promise.all([
    svc.from("objection_training_sessions").select("scenario_key, scenario_label, total_score, improvements").eq("brokerage_id", brokerageId).not("completed_at", "is", null).gte("started_at", since).limit(5000),
    svc.from("compliance_flags").select("violation_type, flagged_content").eq("brokerage_id", brokerageId).gte("created_at", since).limit(5000),
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

  return signals
}

/** Author a rich curriculum for a detected gap with the model. Throws if the model is unavailable. */
export async function authorCurriculum(gap: KnowledgeGap): Promise<Curriculum> {
  const { generateObjectRouted } = await import("@/lib/ai/models")
  const evidence = gap.evidence.length ? `\n\nReal evidence from our agents (ground the material in THESE, not generic advice):\n- ${gap.evidence.join("\n- ")}` : ""
  const { object } = await generateObjectRouted({
    feature: "curriculum_authoring",
    schema: CurriculumSchema,
    system: "You are a master real-estate sales trainer authoring a SHORT, specific micro-course for licensed agents. Be concrete: real scripts, exact phrasings, tactical steps. No generic filler, no platitudes. Everything must be directly usable on a live call or in a live deal.",
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
    // Idempotent: skip a topic we've already authored (any status).
    const { data: existing } = await svc.from("training_courses").select("id").eq("brokerage_id", params.brokerageId).eq("topic_key", gap.topicKey).limit(1).maybeSingle()
    if (existing) continue

    let curriculum: Curriculum
    try { curriculum = await authorCurriculum(gap) } catch { continue /* model unavailable — try again next run */ }

    const ok = await persistCurriculumDraft(svc, params.brokerageId, gap, curriculum)
    if (ok) out.authored++
  }
  return out
}

/** Persist an authored curriculum as a GATED DRAFT course (status 'draft', is_ai_generated). Idempotent. */
export async function persistCurriculumDraft(svc: Svc, brokerageId: string, gap: KnowledgeGap, curriculum: Curriculum): Promise<boolean> {
  const { error } = await svc.from("training_courses").insert({
    brokerage_id: brokerageId,
    course_name: curriculum.title,
    description: curriculum.summary,
    // training_courses.category is CHECK-constrained; skill gaps → 'advanced', compliance → 'compliance'.
    category: gap.source === "compliance" ? "compliance" : "advanced",
    is_ai_generated: true,
    status: "draft",
    topic_key: gap.topicKey,
    curriculum: curriculum as any,
    source_evidence: { rationale: gap.rationale, weakCount: gap.weakCount, avgScore: gap.avgScore, evidence: gap.evidence } as any,
    passing_score: 80,
    is_required: false,
    is_platform_default: false,
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
