// lib/education/knowledge-gap-detector.ts
//
// KNOWLEDGE-GAP DETECTOR — the intelligence behind autonomous curriculum authoring. The OS watches the
// real signal of the business (objection-drill scores by scenario, recurring compliance violations) and
// decides IF a topic actually warrants education — not general material, but a proven, recurring gap. A
// single low score is noise; the same weakness across the roster, again and again, is a curriculum. This
// is pure + honest: a gap must clear a recurrence threshold AND a weakness ratio to qualify, so the
// author never manufactures a course nobody needs, and a topic the team already handles well never
// surfaces.

export type GapSource = "objection_drill" | "compliance" | "question"

export interface GapSignal {
  /** Stable slug, e.g. "objection:price_too_high" or "compliance:fair_housing_language". */
  topicKey: string
  /** Human topic, e.g. "The 'your price is too high' objection". */
  topicLabel: string
  source: GapSource
  /** Instances that demonstrate weakness (low drill score / a violation). */
  weakCount: number
  /** Total instances observed for this topic (drills run; for compliance, = weakCount). */
  totalCount: number
  /** Mean score 0-100 for drill topics; null for compliance. */
  avgScore: number | null
  /** Real, de-identified evidence snippets (improvement notes / flagged phrasings) to ground authoring. */
  evidence: string[]
}

export interface KnowledgeGap {
  topicKey: string
  topicLabel: string
  source: GapSource
  weakCount: number
  avgScore: number | null
  /** 0..1 — share of instances that were weak (compliance = 1). */
  weaknessRatio: number
  /** Higher = more worth teaching (weak volume × how weak). */
  priority: number
  /** Why the OS decided this warrants a curriculum (broker-readable). */
  rationale: string
  evidence: string[]
}

/** A topic needs at least this many weak instances to count as a recurring gap (not a one-off). */
export const MIN_RECURRENCE = 3
/** For scored topics, the roster must be weak on at least this share before it's a gap. */
export const MIN_WEAKNESS_RATIO = 0.4
/** A drill score at or below this is "weak". */
export const WEAK_DRILL_SCORE = 70

/**
 * PURE: decide which topics genuinely warrant a curriculum. Honest gating: enough recurrence AND (for
 * scored topics) enough weakness. Returns the worthy gaps, highest-priority first.
 */
export function detectKnowledgeGaps(signals: GapSignal[], opts: { minRecurrence?: number; minWeaknessRatio?: number } = {}): KnowledgeGap[] {
  const minRec = opts.minRecurrence ?? MIN_RECURRENCE
  const minRatio = opts.minWeaknessRatio ?? MIN_WEAKNESS_RATIO
  const gaps: KnowledgeGap[] = []

  for (const s of signals) {
    if (s.weakCount < minRec) continue // not recurring enough — noise, not a gap
    // Scored topics (drills) carry an avgScore; recurrence-only sources (compliance, questions) do not.
    const scored = s.avgScore != null
    const weaknessRatio = scored ? (s.totalCount > 0 ? s.weakCount / s.totalCount : 0) : 1
    // Scored topics must also show the weakness is prevalent (a mostly-strong scenario isn't a gap).
    if (scored && weaknessRatio < minRatio) continue

    // Priority: weak volume scaled by how weak (a 40-avg gap outranks a 68-avg gap of equal volume).
    const weaknessDepth = s.avgScore != null ? (100 - s.avgScore) / 100 : 0.7
    const priority = Math.round(s.weakCount * (0.5 + weaknessDepth) * 100) / 100

    const rationale = s.source === "compliance"
      ? `${s.weakCount} recurring ${s.topicLabel} compliance flags — the roster keeps getting this wrong.`
      : s.source === "question"
      ? `${s.weakCount} people asked about ${s.topicLabel} recently — a recurring question worth a proper lesson.`
      : `${s.weakCount}/${s.totalCount} drills on ${s.topicLabel} scored weak (avg ${Math.round(s.avgScore ?? 0)}/100) — a real, repeated gap.`

    gaps.push({
      topicKey: s.topicKey, topicLabel: s.topicLabel, source: s.source,
      weakCount: s.weakCount, avgScore: s.avgScore, weaknessRatio: Math.round(weaknessRatio * 100) / 100,
      priority, rationale, evidence: s.evidence.slice(0, 5),
    })
  }

  return gaps.sort((a, b) => b.priority - a.priority || a.topicKey.localeCompare(b.topicKey))
}
