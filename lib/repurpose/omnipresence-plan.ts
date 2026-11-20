/**
 * lib/repurpose/omnipresence-plan.ts — OMNIPRESENCE IS A COORDINATED CROSS-CHANNEL EXPERIENCE, NEVER SIMULTANEOUS REPEATS
 * (wave 153, lane 153P — owner B9 "loop the bundles, omnipresence and refurbish"). PURE: no I/O.
 *
 * MEASURED AT BASE 1ef5df85: the Omni-Presence Repurposer (lib/repurpose/actions.ts executePipeline) scheduled EVERY connected
 * platform's post for `new Date()` — the same source, the same minute, on Instagram, Facebook, LinkedIn and TikTok, whose
 * audiences overlap — and a re-run of the same pipeline on the same source scheduled it all AGAIN (nothing read the lineage it
 * had just logged). The completion-side distributor (lib/repurpose/distribute.ts) drafted every platform with no schedule.
 *
 * This planner gives each platform ONE slot:
 *   · LINEAGE DEDUP — a platform that already carried this source (repurposed_content_log: source_type + source_id →
 *     platform_target, a scheduled / published social_posts output) is skipped `already_carried`: a replay never double-posts.
 *   · CROSS-CHANNEL FATIGUE — the second channel for the same source waits the tenant's OWN fatigue floor
 *     (followup_policy.guardrails.minHoursBetweenTouches — the owner-configurable spacing every planned touch already obeys; no
 *     number is invented here) after the previous slot, measured from the latest time any platform carried it.
 * Ownership: the run belongs to the pipeline's owner (the session's agent); the planner never moves a post across owners.
 */

export interface OmnipresenceCarried {
  platform: string
  /** The repurpose lineage key (`${source_type}:${source_id}`) the earlier output came from. */
  sourceKey: string
  /** When that output was scheduled / logged (ISO); null = unknown time (still counts as carried). */
  at: string | null
}

export interface OmnipresenceSlot {
  platform: string
  /** ISO time to schedule; null when skipped. */
  at: string | null
  skip: "already_carried" | null
}

export function omnipresenceSourceKey(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`
}

export function planOmnipresenceSchedule(i: { platforms: readonly string[]; sourceKey: string; carried: readonly OmnipresenceCarried[]; now: Date; gapHours: number }): OmnipresenceSlot[] {
  const gapMs = Math.max(0, i.gapHours) * 3_600_000
  const sameSource = i.carried.filter((c) => c.sourceKey === i.sourceKey)
  const carriedOn = new Set(sameSource.map((c) => c.platform))
  const lastCarriedMs = sameSource.reduce((m, c) => (c.at && Number.isFinite(Date.parse(c.at)) ? Math.max(m, Date.parse(c.at)) : m), Number.NEGATIVE_INFINITY)
  let next = Number.isFinite(lastCarriedMs) ? Math.max(i.now.getTime(), lastCarriedMs + gapMs) : i.now.getTime()
  const out: OmnipresenceSlot[] = []
  const seen = new Set<string>()
  for (const platform of i.platforms) {
    if (seen.has(platform)) continue
    seen.add(platform)
    if (carriedOn.has(platform)) { out.push({ platform, at: null, skip: "already_carried" }); continue }
    out.push({ platform, at: new Date(next).toISOString(), skip: null })
    next += gapMs
  }
  return out
}
