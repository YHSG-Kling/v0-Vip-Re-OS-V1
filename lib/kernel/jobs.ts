/**
 * lib/kernel/jobs.ts
 *
 * THE JOBS SURFACE — program item #2 (owner-approved 1-4): agents think in
 * JOBS, not managers ("Launch my listing kit", "Work my sphere", "Run a
 * recruiting week"). Each job is THIN ORCHESTRATION over rails that already
 * run autonomously — zero new capability, zero new egress: the same
 * idempotent producers the crons drive, invoked on demand for the moment
 * the agent wants them, with every gate they already carry intact.
 *
 * Honesty rules:
 *   · Idempotency is inherited — a job re-run cannot double-produce
 *     (every underlying runner dedupes per entity).
 *   · Every run writes an activities audit row (who ran what, results).
 *   · A job returns WHAT HAPPENED (real counts from the runners), never a
 *     fire-and-forget "started!".
 */
import { createServiceClient } from "@/lib/supabase/service"
import { bestEffort } from "@/lib/db/best-effort"

type Svc = ReturnType<typeof createServiceClient>

export type JobKey = "listing_kit" | "sphere_pass" | "recruiting_week"

export interface JobSpec {
  key: JobKey
  title: string
  /** What the agent reads on the card — plain jobs language. */
  description: string
  /** What actually runs — shown as the "AI team" line. */
  team: string
  /** Whether the job needs a listing picked first. */
  needsListing: boolean
}

export const JOB_CATALOG: JobSpec[] = [
  {
    key: "listing_kit",
    title: "Launch full listing kit",
    description:
      "Everything a new listing needs, produced now: the Ken Burns walkthrough video, the print flyer, the multi-page brochure, the Instagram carousel, and a draft paid-ad campaign — each through its normal approval gate.",
    team: "Asset Manager · Marketing Manager · Ads Manager",
    needsListing: true,
  },
  {
    key: "sphere_pass",
    title: "Work my sphere",
    description:
      "A value pass over your lifetime clients: equity + anniversary moments become gated value touches, portal cards, and videos — and stuck touchpoints get reaped back into motion.",
    team: "Sphere Manager",
    needsListing: false,
  },
  {
    key: "recruiting_week",
    title: "Run a recruiting week",
    description:
      "The talent pipeline, worked: your pitch kit refreshed if your terms changed, the switch-propensity scout's priority brief, and stale recruits nudged with stage-appropriate outreach proposals.",
    team: "Recruiting Manager",
    needsListing: false,
  },
]

export interface JobRunResult {
  ok: boolean
  job: JobKey
  /** Human-readable lines of what ACTUALLY happened (real runner counts). */
  results: string[]
  error?: string
}

/** Launch full listing kit — the per-listing producers, on demand. */
async function runListingKit(svc: Svc, brokerageId: string, agentUserId: string, listingId: string): Promise<string[]> {
  const lines: string[] = []

  // Walkthrough video via the Director (compliance-gated, idempotent per listing)
  try {
    const { data: listing } = await svc.from("listings")
      .select("id, agent_id, address, photos, lifecycle_stage").eq("id", listingId).eq("brokerage_id", brokerageId).maybeSingle()
    if (!listing) return ["Listing not found in your brokerage."]
    const { isWalkthroughEligible } = await import("@/lib/video/video-plays")
    if (isWalkthroughEligible(listing as any)) {
      const { commissionVideo } = await import("@/lib/video/video-director")
      // Same brief shape as the autonomous walkthrough play (keep-one).
      const commissioned = await commissionVideo(
        { kind: "photo_walkthrough", tier: "brokerage", targetChannel: "instagram", facts: { address: (listing as any).address } },
        { brokerageId, agentUserId, listingId, idempotencyDiscriminator: "walkthrough" },
        svc,
      )
      lines.push(commissioned.ok ? "Walkthrough video commissioned (renders shortly)." : `Walkthrough: ${commissioned.reason ?? "already produced — skipped"}.`)
    } else {
      lines.push("Walkthrough skipped — the listing needs 5+ photos in its marketing window.")
    }
  } catch (e) { lines.push(`Walkthrough: ${e instanceof Error ? e.message : "failed"}`) }

  // Print flyer + brochure + carousel — the idempotent sweep runners (this
  // listing produces; everything already produced skips by construction)
  try {
    const { runListingFlyers } = await import("@/lib/video/video-plays")
    const r = await runListingFlyers(svc)
    lines.push(r.flyers > 0 ? `Print flyer queued (${r.flyers} new).` : "Print flyer already produced — skipped.")
  } catch (e) { lines.push(`Flyer: ${e instanceof Error ? e.message : "failed"}`) }
  try {
    const { runListingBrochures } = await import("@/lib/documents/listing-brochure")
    const r = await runListingBrochures(svc)
    lines.push(r.brochures > 0 ? `Brochure produced (${r.brochures} new).` : "Brochure already produced (or needs 6+ photos) — skipped.")
  } catch (e) { lines.push(`Brochure: ${e instanceof Error ? e.message : "failed"}`) }
  try {
    const { runListingCarousels } = await import("@/lib/marketing/social-carousel")
    const r = await runListingCarousels(svc)
    lines.push(r.carousels > 0 ? `Instagram carousel queued (${r.carousels} new).` : "Carousel already produced — skipped.")
  } catch (e) { lines.push(`Carousel: ${e instanceof Error ? e.message : "failed"}`) }

  // Draft paid-ad campaign (deliverable-gated — the human approves before spend)
  try {
    const { produceListingAdCampaign } = await import("@/lib/ads/listing-ad-producer")
    const r = await produceListingAdCampaign(brokerageId, listingId, "just_listed", svc)
    lines.push(r.produced ? "Draft ad campaign staged for your approval." : `Ad campaign: ${r.reason ?? "already staged"}.`)
  } catch (e) { lines.push(`Ad campaign: ${e instanceof Error ? e.message : "failed"}`) }

  return lines
}

/** Work my sphere — the lifetime-client value pass, on demand. */
async function runSpherePass(svc: Svc, brokerageId: string): Promise<string[]> {
  const lines: string[] = []
  try {
    const { runAnniversaryEquity } = await import("@/lib/kernel/anniversary-equity")
    const r: any = await runAnniversaryEquity(brokerageId, {})
    const proposed = (r?.reportsProposed ?? 0) + (r?.notesProposed ?? 0)
    lines.push(proposed > 0
      ? `${proposed} gated value touch${proposed === 1 ? "" : "es"} proposed from equity + anniversary moments.`
      : "No new equity or anniversary moments in the window — nothing manufactured.")
  } catch (e) { lines.push(`Equity/anniversary pass: ${e instanceof Error ? e.message : "failed"}`) }
  try {
    const { reapStuckLifetimeTouchpoints } = await import("@/lib/sphere/lifetime-touchpoint-reaper")
    const r = await reapStuckLifetimeTouchpoints(brokerageId, svc)
    const reaped = r.reaped
    lines.push(reaped > 0 ? `${reaped} stuck touchpoint${reaped === 1 ? "" : "s"} put back in motion.` : "No stuck touchpoints — the sphere cadence is current.")
  } catch (e) { lines.push(`Touchpoint reaper: ${e instanceof Error ? e.message : "failed"}`) }
  return lines
}

/** Run a recruiting week — the talent pipeline, worked now. */
async function runRecruitingWeek(svc: Svc, brokerageId: string): Promise<string[]> {
  const lines: string[] = []
  try {
    const { runRecruitingPitchKits } = await import("@/lib/recruiting/recruiting-pitch-kit")
    const r = await runRecruitingPitchKits(svc)
    lines.push(r.pitchKits > 0 ? `Pitch kit refreshed (${r.pitchKits} produced).` : "Pitch kit current — your terms haven't changed.")
  } catch (e) { lines.push(`Pitch kit: ${e instanceof Error ? e.message : "failed"}`) }
  try {
    const { runSwitchPropensityScoutAll } = await import("@/lib/recruiting/switch-propensity-scout")
    const r: any = await runSwitchPropensityScoutAll(svc)
    lines.push((r?.briefs ?? 0) > 0 ? "Switch-propensity priority brief delivered." : "Priority brief already current this week.")
  } catch (e) { lines.push(`Propensity scout: ${e instanceof Error ? e.message : "failed"}`) }
  try {
    const { sweepStaleRecruits } = await import("@/lib/agents/recruit-outreach-producer")
    const r = await sweepStaleRecruits(brokerageId, 7, svc)
    lines.push(r.proposed > 0
      ? `${r.proposed} stale recruit${r.proposed === 1 ? "" : "s"} got a gated outreach proposal.`
      : `Pipeline current — ${r.scanned} recruit${r.scanned === 1 ? "" : "s"} scanned, none stale.`)
  } catch (e) { lines.push(`Stale-recruit sweep: ${e instanceof Error ? e.message : "failed"}`) }
  return lines
}

/** Run a job. Every run is audited to activities (who, what, results). */
export async function runJob(
  svc: Svc,
  input: { job: JobKey; brokerageId: string; agentUserId: string; listingId?: string | null },
): Promise<JobRunResult> {
  const spec = JOB_CATALOG.find((j) => j.key === input.job)
  if (!spec) return { ok: false, job: input.job, results: [], error: "Unknown job" }
  if (spec.needsListing && !input.listingId) {
    return { ok: false, job: input.job, results: [], error: "Pick a listing first" }
  }
  let results: string[] = []
  try {
    if (input.job === "listing_kit") results = await runListingKit(svc, input.brokerageId, input.agentUserId, input.listingId as string)
    else if (input.job === "sphere_pass") results = await runSpherePass(svc, input.brokerageId)
    else results = await runRecruitingWeek(svc, input.brokerageId)
  } catch (e) {
    return { ok: false, job: input.job, results, error: e instanceof Error ? e.message : "Job failed" }
  }

  // Audit — the job run is a first-class, attributable event.
  await bestEffort(
    svc.from("activities").insert({
      brokerage_id: input.brokerageId,
      agent_user_id: input.agentUserId,
      listing_id: input.listingId ?? null,
      activity_type: "job_run",
      title: `Job: ${spec.title}`,
      description: results.join(" | ").slice(0, 900),
      metadata: { job: input.job, results },
    }),
    "the job has already RUN and its own failures are returned above; losing the audit echo must not report a job that did work as having failed",
  )

  return { ok: true, job: input.job, results }
}
