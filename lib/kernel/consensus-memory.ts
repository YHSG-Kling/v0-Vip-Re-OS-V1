// lib/kernel/consensus-memory.ts
//
// CONSENSUS MEMORY (pure) — institutional memory across the AI team. When a manager gives a second
// opinion ("don't drop the price — buyer demand is still strong") and the OUTCOME later proves it
// right or wrong, remember it. Over time the huddle learns whose read to trust on which play: a
// manager with a strong track record on price-drop calls gets weighted heavily; a shaky one gets a
// grain of salt. This is how a real team builds trust — and a per-deal CRM has no concept of it.
// Pure (no I/O), unit-tested directly.

export interface ConsultOutcome {
  /** was the manager's second opinion proven correct by the eventual outcome? */
  correct: boolean
}

export interface ConsultAccuracy {
  calls: number
  correct: number
  accuracy: number // 0–1
}

export type ConsultConfidence = "unproven" | "reliable" | "mixed" | "unreliable"

export const DEFAULT_MIN_SAMPLE = 5

/** Track record for a (manager, play) pair. Pure. */
export function consultAccuracy(records: ConsultOutcome[]): ConsultAccuracy {
  const calls = (records ?? []).length
  const correct = (records ?? []).filter((r) => r.correct).length
  return { calls, correct, accuracy: calls > 0 ? correct / calls : 0 }
}

/** Confidence label, sample-gated so a couple of lucky calls don't crown a manager. Pure. */
export function consultConfidence(acc: ConsultAccuracy, opts?: { minSample?: number }): ConsultConfidence {
  if (acc.calls < (opts?.minSample ?? DEFAULT_MIN_SAMPLE)) return "unproven"
  if (acc.accuracy >= 0.7) return "reliable"
  if (acc.accuracy <= 0.4) return "unreliable"
  return "mixed"
}

/** How much to weight this manager's opinion on this play (0–1). Pure. */
export function consultWeight(conf: ConsultConfidence): number {
  switch (conf) {
    case "reliable": return 1.0
    case "mixed": return 0.6
    case "unproven": return 0.5 // give a new voice a fair hearing
    case "unreliable": return 0.2
  }
}

/** The ai_feedback_log source_system namespace for a play's second-opinion outcomes. Pure. */
export function consultSystem(playType: string): string {
  return `second_opinion:${(playType ?? "").trim()}`
}

export interface ConsultTrackRecord {
  consult: string
  playType: string
  calls: number
  accuracy: number
  confidence: ConsultConfidence
  weight: number
}

/** A one-line, human read of a track record for the coordination feed. Pure. */
export function describeTrackRecord(tr: ConsultTrackRecord): string {
  if (tr.calls === 0) return `no track record yet on ${tr.playType} — giving their read a fair hearing`
  return `${tr.consult}'s read on ${tr.playType} has been ${tr.confidence} (${Math.round(tr.accuracy * 100)}% over ${tr.calls}) — weight ${tr.weight.toFixed(1)}`
}
