// lib/recruiting/mentor-match.ts
//
// WEIGHTED MENTOR MATCH (recruiting_manager) — the canonical, DETERMINISTIC mentor matcher that replaces
// the old LLM-freeform black-box pick (which lived in the now-retired ai-agent-onboarding monolith). A
// weighted, explainable score across the dimensions we can honestly source, so a broker sees WHY a mentor
// ranks where it does and the same inputs always produce the same ranking.
//
// Weights (spec): market/geo 35% · specialty/transaction-type 25% · personality 20% · experience-gap 10% ·
// capacity 10%. HONEST: personality is neutral (0.5) until we capture communication_style — it's a real
// placeholder, not a fabricated compatibility. Pure + unit-tested.

export interface MentorProfile {
  id: string
  name?: string | null
  locationId?: string | null
  specializations?: string[] | null
  yearsExperience?: number | null
  communicationStyle?: string | null
  /** How many mentees the mentor already has (drives the capacity dimension). */
  currentMentees?: number | null
  /** Max mentees (default 3). */
  capacity?: number | null
}

export interface MenteeProfile {
  locationId?: string | null
  specializations?: string[] | null
  yearsExperience?: number | null
  communicationStyle?: string | null
}

export const MATCH_WEIGHTS = { geo: 0.35, specialty: 0.25, personality: 0.20, experience: 0.10, capacity: 0.10 } as const
export const DEFAULT_MENTOR_CAPACITY = 3

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** Personality compatibility matrix (used only when both styles are known; else neutral 0.5). */
const COMPAT: Record<string, number> = {
  "direct|structured": 0.9, "collaborative|flexible": 0.9, "collaborative|direct": 0.6,
  "flexible|structured": 0.7, "direct|flexible": 0.5, "collaborative|structured": 0.6,
}

/** PURE: the five per-dimension sub-scores (0..1) for a mentor↔mentee pair. */
export function matchDimensions(mentor: MentorProfile, mentee: MenteeProfile): { geo: number; specialty: number; personality: number; experience: number; capacity: number } {
  // Geo: same location = strong; otherwise a low floor (a remote mentor can still help).
  const geo = mentor.locationId && mentee.locationId ? (mentor.locationId === mentee.locationId ? 1 : 0.3) : 0.3

  // Specialty overlap: share of the mentee's specializations the mentor also has.
  const mSet = new Set((mentee.specializations ?? []).map((s) => s.toLowerCase()))
  const mentorSet = new Set((mentor.specializations ?? []).map((s) => s.toLowerCase()))
  const shared = [...mSet].filter((s) => mentorSet.has(s)).length
  const specialty = mSet.size > 0 ? clamp01(shared / mSet.size) : (mentorSet.size > 0 ? 0.5 : 0.3)

  // Personality: known-both → matrix; else neutral (honest placeholder, no fabricated compatibility).
  let personality = 0.5
  if (mentor.communicationStyle && mentee.communicationStyle) {
    const key = [mentor.communicationStyle, mentee.communicationStyle].map((s) => s.toLowerCase()).sort().join("|")
    personality = COMPAT[key] ?? 0.5
  }

  // Experience gap: optimal 4-10 years senior; too close = little to teach; too far = harder to relate.
  const gap = (mentor.yearsExperience ?? 0) - (mentee.yearsExperience ?? 0)
  let experience: number
  if (gap >= 4 && gap <= 10) experience = 1
  else if (gap < 4) experience = clamp01(gap / 4)
  else experience = Math.max(0.4, 1 - (gap - 10) * 0.05)

  // Capacity: room left / total. Full mentor → 0.
  const cap = mentor.capacity ?? DEFAULT_MENTOR_CAPACITY
  const used = mentor.currentMentees ?? 0
  const capacity = cap > 0 ? clamp01((cap - used) / cap) : 0

  return { geo, specialty, personality, experience, capacity }
}

export interface MentorMatch {
  mentorId: string
  mentorName: string | null
  score: number
  breakdown: { geo: number; specialty: number; personality: number; experience: number; capacity: number }
  reason: string
}

/** PURE: the weighted composite (0..1) + a human-readable reason for a pair. */
export function scoreMentorMatch(mentor: MentorProfile, mentee: MenteeProfile): MentorMatch {
  const d = matchDimensions(mentor, mentee)
  const score = Math.round((d.geo * MATCH_WEIGHTS.geo + d.specialty * MATCH_WEIGHTS.specialty + d.personality * MATCH_WEIGHTS.personality + d.experience * MATCH_WEIGHTS.experience + d.capacity * MATCH_WEIGHTS.capacity) * 1000) / 1000
  const reasons: string[] = []
  if (d.geo >= 1) reasons.push("same market")
  if (d.specialty >= 0.5) reasons.push("shared specialties")
  if (d.experience >= 1) reasons.push("ideal experience gap")
  if (d.capacity <= 0) reasons.push("at capacity")
  const reason = reasons.length ? reasons.join(", ") : "reasonable overall fit"
  return { mentorId: mentor.id, mentorName: mentor.name ?? null, score, breakdown: d, reason }
}

/** PURE: rank all mentors for a mentee, best first (deterministic tie-break by mentor id); top-N. */
export function rankMentorMatches(mentee: MenteeProfile, mentors: MentorProfile[], limit = 3): MentorMatch[] {
  return mentors
    .map((m) => scoreMentorMatch(m, mentee))
    .sort((a, b) => b.score - a.score || a.mentorId.localeCompare(b.mentorId))
    .slice(0, limit)
}
