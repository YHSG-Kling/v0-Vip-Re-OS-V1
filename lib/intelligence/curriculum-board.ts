// lib/intelligence/curriculum-board.ts
//
// THE CURRICULUM BOARD — the AI-authored learning modules awaiting a human's publish, surfaced in the one
// Command Center. The curriculum author detects a recurring knowledge gap and drafts a rich module on the
// canonical learning_modules catalog (status 'pending_review'); this shows the broker what the OS wants to
// teach and why (the gap tag), so a human approves before the learning-router delivers it to agents and
// client portals. Read-only; best-effort.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface CurriculumDraft {
  id: string
  title: string
  category: string | null
  topicKey: string | null
  /** Why the OS authored it (the gap tag it was grounded in). */
  rationale: string | null
  lessonCount: number
  quizCount: number
}

export interface CurriculumBoard {
  pending: number
  drafts: CurriculumDraft[]
}

/** PURE: shape pending AI learning-module rows into the board. */
export function summarizeCurriculumBoard(rows: any[], cap = 8): CurriculumBoard {
  const drafts: CurriculumDraft[] = rows.map((r) => {
    const gapTags: string[] = Array.isArray(r.gap_tags) ? r.gap_tags : []
    const quiz = Array.isArray(r.quiz_questions) ? r.quiz_questions : []
    // Count the lesson headings in the rendered body ("## " sections excluding the objectives block).
    const lessonCount = typeof r.body === "string" ? Math.max(0, (r.body.match(/^## /gm)?.length ?? 0) - 1) : 0
    return {
      id: r.id,
      title: r.title ?? "Untitled module",
      category: gapTags[0]?.split(":")[0] ?? null,
      topicKey: gapTags[0] ?? null,
      rationale: gapTags.length ? `Authored from the "${gapTags.join(", ")}" knowledge gap` : null,
      lessonCount,
      quizCount: quiz.length,
    }
  })
  return { pending: rows.length, drafts: drafts.slice(0, cap) }
}

/** Build the board for a brokerage's pending AI-authored modules. Best-effort → null. */
export async function generateCurriculumBoard(brokerageId: string, client?: Svc): Promise<CurriculumBoard | null> {
  const supabase = client ?? createServiceClient()
  try {
    const { data } = await supabase.from("learning_modules")
      .select("id, title, gap_tags, quiz_questions, body")
      .eq("brokerage_id", brokerageId).eq("is_ai_generated", true).eq("status", "pending_review")
      .order("created_at", { ascending: false }).limit(50)
    return summarizeCurriculumBoard((data ?? []) as any[])
  } catch (err) {
    console.error("[curriculum-board] failed:", err)
    return null
  }
}
