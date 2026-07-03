// lib/intelligence/curriculum-board.ts
//
// THE CURRICULUM BOARD — the AI-authored courses awaiting a human's publish, surfaced in the one Command
// Center. The curriculum author detects a recurring knowledge gap and drafts a rich micro-course; this
// shows the broker what the OS wants to teach and why (the grounding evidence), so a human approves
// before it reaches agents. Read-only; best-effort.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface CurriculumDraft {
  id: string
  title: string
  category: string | null
  topicKey: string | null
  /** Why the OS authored it (the detector's rationale). */
  rationale: string | null
  lessonCount: number
  quizCount: number
}

export interface CurriculumBoard {
  pending: number
  drafts: CurriculumDraft[]
}

/** PURE: shape draft course rows into the board. */
export function summarizeCurriculumBoard(rows: any[], cap = 8): CurriculumBoard {
  const drafts: CurriculumDraft[] = rows.map((r) => {
    const c = r.curriculum ?? {}
    const ev = r.source_evidence ?? {}
    return {
      id: r.id,
      title: r.course_name ?? "Untitled course",
      category: r.category ?? null,
      topicKey: r.topic_key ?? null,
      rationale: typeof ev.rationale === "string" ? ev.rationale : null,
      lessonCount: Array.isArray(c.lessons) ? c.lessons.length : 0,
      quizCount: Array.isArray(c.quiz) ? c.quiz.length : 0,
    }
  })
  return { pending: rows.length, drafts: drafts.slice(0, cap) }
}

/** Build the board for a brokerage's pending AI-authored drafts. Best-effort → null. */
export async function generateCurriculumBoard(brokerageId: string, client?: Svc): Promise<CurriculumBoard | null> {
  const supabase = client ?? createServiceClient()
  try {
    const { data } = await supabase.from("training_courses")
      .select("id, course_name, category, topic_key, curriculum, source_evidence")
      .eq("brokerage_id", brokerageId).eq("is_ai_generated", true).eq("status", "draft")
      .order("created_at", { ascending: false }).limit(50)
    return summarizeCurriculumBoard((data ?? []) as any[])
  } catch (err) {
    console.error("[curriculum-board] failed:", err)
    return null
  }
}
