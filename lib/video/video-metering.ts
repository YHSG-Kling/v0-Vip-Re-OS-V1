// lib/video/video-metering.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE VIDEO FEATURE GATE — tier-METERED, not tier-refused (wave 86, lane 86B).
//
// Owner answer 4 (2026-09-27): the integrator's recommendation — "tier-METERED
// (count per tier, overage flows to billing; refuse only when a tier explicitly
// excludes video)" — and the standing rule that an autonomous video of a paying
// tier is never blocked.
//
// ALREADY EXISTED — REUSED, NOT REBUILT:
//   · the allowance: plan_limits(plan_tier, 'video_minutes') — 30 / 150 / 300 /
//     -1 live (solo / team / brokerage / multi_location);
//   · the cap reader: lib/usage/check-cap.ts checkUsageCap (tier → plan_limits →
//     usage_counters, pre-flight addQuantity, soft threshold);
//   · the writer: lib/usage/log-media-usage.ts logMediaUsage — ONE call records the
//     usage_events row (the per-creation COUNT: one row per video, feature + project
//     ref), bumps usage_counters (the allowance), and writes billing_usage
//     .video_minutes (the tenant usage bars + the overage projection). It had NO
//     video writer at all: every surface that reads video usage showed zero;
//   · the overage biller: lib/billing/ai-overage.ts runAIOverageBilling with
//     metric = VIDEO_OVERAGE_METRIC (m666 widened its ledger CHECK and set the terms).
//
// THE UNIT: a creation counts max(1, ceil(planned seconds / 60)) video minutes — a
// 30 s reel is one unit, a 3-minute explainer three. Every creation is counted
// (usage_events is one row per video) and the allowance is spent in the unit the
// tiers are sold in ("video min/mo" on the upgrade modal) and the provider cost
// scales with.
//
// THE ONLY REFUSAL: a tier whose video_minutes allowance is EXACTLY 0 — a tier that
// explicitly excludes video. Over the allowance is SERVED and becomes overage. A
// read that could not run is ALLOWED and labelled "unchecked" (never "within
// allowance"): the meter is advisory (check-cap.ts ruling) and must not take a
// paying tenant's autonomous video down, but nobody-checked is never rendered as
// checked-and-fine (CLAUDE.md §4).
//
// NOT server-only: the pure decision is proof-driven (scripts/video-stitching-
// simulator.ts § metering); the impure halves lazily import the service rails,
// the lib/billing/ai-overage.ts precedent.

export const VIDEO_METER_METRIC = "video_minutes" as const

/** Units a creation of `seconds` spends: whole minutes, at least one (PURE). */
export function videoMeterUnits(seconds: number | null | undefined): number {
  const s = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 60
  return Math.max(1, Math.ceil(s / 60))
}

export type VideoMeterVerdict =
  | "excluded"             // the tier's allowance is 0 — the ONE refusal
  | "unlimited"            // -1 / no limit row
  | "within_allowance"
  | "approaching_allowance" // past the tier's soft threshold, still inside
  | "overage"              // past the allowance — served, billed at period close
  | "unchecked"            // a read could not run — served, and said so

export interface VideoMeterDecision {
  allowed: boolean
  verdict: VideoMeterVerdict
  units: number
  /** Minutes already used this period BEFORE this creation (null when unreadable). */
  usedBefore: number | null
  /** The tier's allowance (-1 unlimited; null when unreadable). */
  limit: number | null
  reason: string
}

/**
 * PURE — the one decision. `cap` is checkUsageCap's answer for a pre-flight of
 * `units` (its `used` already INCLUDES the units being asked for).
 */
export function decideVideoMeter(cap: {
  allowed: boolean; used: number; limit: number; soft_warning: boolean; error?: string
}, units: number): VideoMeterDecision {
  if (cap.error) {
    return {
      allowed: true, verdict: "unchecked", units, usedBefore: null, limit: null,
      reason: `the video allowance could not be read (${cap.error}) — served and metered, NOT verified against the tier`,
    }
  }
  const usedBefore = Math.max(0, cap.used - units)
  if (cap.limit === 0) {
    return { allowed: false, verdict: "excluded", units, usedBefore, limit: 0, reason: "This plan does not include video. Upgrade the plan to create videos." }
  }
  if (cap.limit < 0) return { allowed: true, verdict: "unlimited", units, usedBefore, limit: -1, reason: "unlimited video on this plan" }
  if (cap.used > cap.limit) {
    return {
      allowed: true, verdict: "overage", units, usedBefore, limit: cap.limit,
      reason: `${cap.used} of ${cap.limit} included video minutes this period — the excess is billed as overage, never refused`,
    }
  }
  if (cap.soft_warning) {
    return { allowed: true, verdict: "approaching_allowance", units, usedBefore, limit: cap.limit, reason: `${cap.used} of ${cap.limit} included video minutes used this period` }
  }
  return { allowed: true, verdict: "within_allowance", units, usedBefore, limit: cap.limit, reason: `${cap.used} of ${cap.limit} included video minutes` }
}

/** Pre-flight: may this tenant create a video of `plannedSeconds`? Refuses only an excluded tier. */
export async function gateVideoCreation(input: { brokerageId: string; plannedSeconds: number | null | undefined }): Promise<VideoMeterDecision> {
  const units = videoMeterUnits(input.plannedSeconds)
  try {
    const { checkUsageCap } = await import("@/lib/usage/check-cap")
    const cap = await checkUsageCap({ brokerageId: input.brokerageId, metric: VIDEO_METER_METRIC, addQuantity: units })
    return decideVideoMeter(cap, units)
  } catch (e) {
    return decideVideoMeter({ allowed: true, used: 0, limit: -1, soft_warning: false, error: (e as Error).message }, units)
  }
}

/**
 * Record ONE video creation: the usage_events row (the count), the usage_counters
 * allowance and the billing_usage meter, through the ONE media-usage writer. Called
 * AFTER the project row exists (the creation is real). Never throws.
 */
export async function meterVideoCreation(input: {
  brokerageId: string
  /** agents.id (never users.id — the two are disjoint, CLAUDE.md §3). */
  agentId?: string | null
  /** users.id of the actor, when there is one (null for an autonomous run). */
  userId?: string | null
  plannedSeconds: number | null | undefined
  /** The door that created it: "video_project" | "video_director" | "topic_video" | … */
  feature: string
  /** ai_video_projects.id. */
  projectId?: string | null
  autonomous: boolean
  decision?: VideoMeterDecision | null
}): Promise<void> {
  try {
    const { logMediaUsage } = await import("@/lib/usage/log-media-usage")
    await logMediaUsage({
      brokerageId: input.brokerageId,
      metric: VIDEO_METER_METRIC,
      quantity: videoMeterUnits(input.plannedSeconds),
      agentId: input.agentId ?? null,
      userId: input.userId ?? null,
      sessionRef: input.projectId ?? null,
      feature: input.feature,
      metadata: {
        autonomous: input.autonomous,
        planned_seconds: input.plannedSeconds ?? null,
        verdict: input.decision?.verdict ?? null,
      },
    })
  } catch (e) {
    console.warn(`[video-metering] creation not metered (${input.feature}, project ${input.projectId ?? "?"}):`, (e as Error).message)
  }
}
