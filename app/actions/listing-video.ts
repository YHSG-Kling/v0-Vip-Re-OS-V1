'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { isValidUUID } from '@/lib/validations'

// ============================================
// MAIN: GENERATE LISTING VIDEO
// ============================================
//
// MERGED ONTO THE DIRECTOR RAIL (2026-08-27, §1.1 — duplicate; the survivor is
// lib/video/video-director.ts:792 `commissionVideo`). What stood here was a
// SECOND SPELLING of photo-walkthrough commissioning that could not render:
//
//   · It hand-rolled the ai_video_projects insert WITHOUT `status`. The live
//     column default is 'planning'::text — a spelling m374's CHECK refuses —
//     so the insert failed 23514 on every call and the action died at step 2.
//     (m569 fixes the default; verified against the live DB 2026-08-27:
//     default 'planning', CHECK = the nine canonical values, 0 rows ever.)
//   · Even with the insert fixed, the staged project sat at a status no
//     renderer selects: not on the Director rail (no director_key /
//     composition_id for director-reel-render), not at a provider (no
//     provider_job_id for poll-did-videos). The m365 queue mirror never fired
//     because the project never moved.
//   · Its video_generation_queue insert ({project_id, priority, status}) wrote
//     rows NO READER could see — the only queue reader, getVideoQueue
//     (app/actions/link-to-video.ts:496), filters organization_id +
//     organization_type, which this write never set. The video's real
//     lifecycle ledger is ai_video_projects itself (getVideoProjects below;
//     the m365 trigger mirrors project status onto queue rows that ARE read).
//
// The capability — "a photo-rich listing gets a rendered walkthrough video" —
// already lives end-to-end on the Director rail: commissionVideo stages
// ai_video_projects at status='queued' with the composition + finish spec
// (compliance-gated hook via runWithComplianceRedraft, format learning, QR,
// approval_status='pending_review'), /api/cron/director-reel-render executes,
// /api/cron/composition-render-queue renders, and the m365 trigger carries
// terminal states everywhere they are mirrored. The same rail is what
// runWalkthroughPremieres (lib/video/video-plays.ts:116) commissions
// autonomously — this action is the on-demand button for the same play, and
// shares its idempotency discriminator so the two never stage twice.

export async function generateListingVideo(params: {
  transactionId?: string
  propertyId?: string
  agentId: string
  videoType?: 'full_tour' | 'social_snippet' | 'instagram_story' | 'reel' | 'drone_highlight'
  /**
   * HOOK A/B (wired 2026-09-03). true → commissionVideoExperiment stages 3
   * compliance-gated opening-hook variants sharing one experiment_id (each with
   * its own tracked QR) instead of one reel, so format-learning's
   * scoreHookOutcomes / recommendHookWinner — whose READER half the Content
   * Studio already renders — finally has a WRITER. Same Director rail, same
   * pending_review gate; nothing auto-publishes. Default false: one reel.
   */
  abTest?: boolean
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: 'Invalid agent ID' }
  }

  const supabase = await createClient()

  try {
    // 1. Get property and photos
    let property: any = null
    let photos: any[] = []

    if (params.transactionId && isValidUUID(params.transactionId)) {
      // supabase-js RESOLVES a refused query, so `const { data }` alone turns
      // "permission denied" into "Property not found" — a message naming the
      // wrong problem, on the read that also carries this video's tenant.
      const { data: transaction, error: transactionError } = await supabase
        .from('transactions')
        .select('*, listings(*)')
        .eq('id', params.transactionId)
        .single()

      if (transactionError) {
        return { success: false, error: `Could not read the transaction — ${transactionError.message}` }
      }
      property = transaction?.listings
    } else if (params.propertyId && isValidUUID(params.propertyId)) {
      const { data, error: listingError } = await supabase
        .from('listings')
        .select('*')
        .eq('id', params.propertyId)
        .single()
      if (listingError) {
        return { success: false, error: `Could not read the listing — ${listingError.message}` }
      }
      property = data
    }

    if (!property) {
      return { success: false, error: 'Property not found' }
    }

    // TENANT ANCHOR — from the LISTING this video is filed against, not from the
    // caller. ai_video_projects.listing_id FKs listings(id) and listings carries
    // brokerage_id, so the parent row IS the answer; nothing here is inferred
    // from an id space that isn't a tenant (params.agentId is an agents.id).
    //
    // This matters because ai_video_projects.brokerage_id was omitted entirely:
    // the table's own policy is permissive (`ai_video_projects_all` USING(true)),
    // but every APP reader narrows — getVideoAnalytics does
    // `.eq("brokerage_id", auth.brokerageId)`, and `NULL = <uuid>` is NULL, never
    // true. So each project this action created was written successfully and then
    // never appeared on any brokerage's video surface again.
    let videoBrokerageId = (property.brokerage_id as string | null) ?? null
    if (!videoBrokerageId) {
      // Legacy listings can carry no tenant. Fall back to the OTHER parent this
      // row already names — agents(id), whose brokerage_id is a real tenant.
      // agents.id and brokerages.id are disjoint; the column is read, never the id.
      const { data: videoAgent, error: videoAgentError } = await supabase
        .from('agents')
        .select('brokerage_id')
        .eq('id', params.agentId)
        .maybeSingle()
      if (videoAgentError) {
        return { success: false, error: `Could not resolve the agent's brokerage — ${videoAgentError.message}` }
      }
      videoBrokerageId = (videoAgent?.brokerage_id as string | null) ?? null
    }
    if (!videoBrokerageId) {
      return {
        success: false,
        error:
          'This listing and this agent both carry no brokerage, so the video project would be invisible to every brokerage video surface. Assign the listing to a brokerage first.',
      }
    }

    // Get listing photos — listing_media rows of media_type='photo'
    // (m368/m369 consolidation). The pin is load-bearing: without it a
    // disclosure PDF or a virtual-tour link would be counted toward the photo
    // minimum below and then handed to the AI as a video frame.
    const { data: listingPhotos, error: photosError } = await supabase
      .from('listing_media')
      .select('id, file_url, sort_order, is_primary, room_type, ai_quality_score')
      .eq('listing_id', property.id)
      .eq('media_type', 'photo')
      .order('sort_order')

    // A refused read resolves empty, which would surface as "Need at least N
    // photos" — a message naming the wrong problem.
    if (photosError) {
      return { success: false, error: `Could not read the listing photos — ${photosError.message}` }
    }
    photos = listingPhotos || []

    const videoType = params.videoType || 'full_tour'
    const minPhotos: Record<string, number> = {
      full_tour: 8,
      social_snippet: 5,
      instagram_story: 3,
      reel: 5,
      drone_highlight: 3,
    }

    if (photos.length < minPhotos[videoType]) {
      return { success: false, error: `Need at least ${minPhotos[videoType]} photos for ${videoType}` }
    }

    // 2. The Director needs the agent's users.id — ai_video_projects.agent_id
    //    is resolved inside commissionVideo through the canonical resolver.
    //    agents.id and users.id are DISJOINT id spaces (§3): read the column,
    //    never pass the agents.id itself.
    const { data: agentRow, error: agentUserError } = await supabase
      .from('agents')
      .select('user_id')
      .eq('id', params.agentId)
      .maybeSingle()
    if (agentUserError) {
      return { success: false, error: `Could not resolve the agent — ${agentUserError.message}` }
    }
    if (!agentRow?.user_id) {
      return { success: false, error: 'This agent has no user account, so a video cannot be commissioned for them.' }
    }

    // 3. Commission through the ONE Director rail. commissionVideo stages the
    //    ai_video_projects row at status='queued' with the composition +
    //    finish spec, drafts and compliance-GATES the hook copy, mints the
    //    outro QR, and leaves approval_status='pending_review' — then
    //    director-reel-render + composition-render-queue execute it and the
    //    m365 trigger mirrors the terminal state. Idempotency discriminator
    //    'walkthrough' is shared with runWalkthroughPremieres so the button
    //    and the autonomous play converge on ONE reel per listing.
    const situation = {
      kind: 'photo_walkthrough' as const,
      tier: 'brokerage' as const,
      targetChannel: 'instagram' as const,
      facts: { address: property.address },
    }
    const commissionOpts = {
      brokerageId: videoBrokerageId,
      agentUserId: agentRow.user_id as string,
      listingId: property.id,
      idempotencyDiscriminator: 'walkthrough',
    }

    if (params.abTest) {
      // The hook A/B arm — see the param doc. Idempotent per (listing, kind) via
      // the experiment_id the Director derives; a re-run reuses the experiment.
      const { commissionVideoExperiment } = await import('@/lib/video/video-director')
      const experiment = await commissionVideoExperiment(situation, commissionOpts, { variants: 3 })
      if (!experiment.ok) {
        return { success: false, error: experiment.reason ?? 'The hook experiment could not be commissioned' }
      }
      revalidatePath('/dashboard/marketing/videos')
      return {
        success: true,
        // Variant 0 is the curiosity scroll-stopper — the row a caller that
        // expects one id can hold; the experiment id names the whole set.
        projectId: experiment.variants?.[0]?.videoProjectId,
        experimentId: experiment.experimentId,
        variantCount: experiment.variants?.length ?? 0,
        status: experiment.status,
      }
    }

    const { commissionVideo } = await import('@/lib/video/video-director')
    const commission = await commissionVideo(situation, commissionOpts)

    if (!commission.ok) {
      return { success: false, error: commission.reason ?? 'The video could not be commissioned' }
    }

    revalidatePath('/dashboard/marketing/videos')
    return {
      success: true,
      projectId: commission.videoProjectId,
      // 'already_staged' means the walkthrough premiere (button or autonomous
      // play) exists — surfaced so the caller can say so instead of "created".
      status: commission.status,
    }
  } catch (error) {
    console.error('Generate listing video error:', error)
    return { success: false, error: 'Failed to generate video' }
  }
}

// ============================================
// AI PHOTO SELECTION — DELETED (merged, 2026-08-27)
// ============================================
//
// TOMBSTONE — the private `selectPhotosForVideo` (an AI pass that picked
// photos, durations and transitions into a video_metadata.scenes manifest no
// renderer ever read) is DELETED. Survivor: lib/video/ken-burns-plan.ts:114
// `kenBurnsPlan`, invoked INSIDE remotion/PhotoWalkthroughReel.tsx:111 — the
// composition plans photo windows, pans and cross-fades deterministically from
// the listing photos the Director resolves at render time
// (lib/video/director-content.ts resolveDirectorContentProps →
// listingReelProps). The per-type spec map (photo counts / sequence styles)
// died with it: the survivor caps and paces clips itself, and no caller read
// the manifest this produced.

// ============================================
// GENERATE VIDEO NARRATION SCRIPT — DELETED (merged, 2026-08-27)
// ============================================
//
// TOMBSTONE — the private `generateVideoNarration` is DELETED. Its output was
// written to a project row nothing rendered (see the merge note on
// generateListingVideo above), so the narration was authored, paid for, and
// never heard. Survivor for the words a viewer actually gets:
// lib/video/video-director.ts:792 `commissionVideo` drafts the hook line
// through generatePersonaCopy + runWithComplianceRedraft (fair housing in the
// writing prompt, §5), and remotion/PhotoWalkthroughReel.tsx carries tour-beat
// captions (lib/video/ken-burns-plan.ts TOUR_BEATS) — "the photos ARE the
// video" (lib/video/finish-spec.ts:62). No voiceover producer exists for this
// composition (scripts/remotion-setup-guard.ts NO_LIVE_PRODUCER records that
// honestly); if one is built it must ride lib/video/script-structure's
// narrationBudget, never a hand-typed range.
//
// THE RETIRED WORD RANGES, kept unbroken for the record (the narration guard
// asserts these are gone from live code on comment-stripped source, and still
// findable RAW — a tombstone is not a call site):
//   full_tour: '150-180 words (2 min narration)',
//   social_snippet: '40-60 words (30 sec)',
//   instagram_story: '20-30 words (15 sec)',
//   reel: '50-70 words (45 sec)',
//   drone_highlight: '30-50 words (30 sec)',
// Every one was a hand-typed range beside a duration that already existed in
// the (also deleted) getDurationForType — and the full_tour ask was internally
// inconsistent (150-180 words is ~60-72s of speech, not "2 min").

// ============================================
// "THEM FIRST" VALIDATION
// ============================================
//
// TOMBSTONE — the private `validateThemFirstContent` that stood here is
// DELETED. Survivor: lib/compliance-rules/rule-evaluators.ts:402
// `evaluateThemFirstFocus`.
//
// It was the third spelling of one idea (§6): the same pronoun ratio the
// compliance REPORT and the kernel GATE already computed, with a third word
// list. The `contentType` argument it accepted was never read — the survivor
// does not take one.
//
// SECOND MOVE (2026-08-27): the narration step that called the survivor from
// this file is itself deleted (merged onto commissionVideo — see above), so
// this file no longer authors any script to evaluate. The compliance gate on
// what the Director's videos actually say is runWithComplianceRedraft +
// evaluateOutbound inside lib/video/video-director.ts:792 — the same kernel
// rule array, applied to copy that is genuinely rendered.

// ============================================
// TRACK VIDEO VIEW
// ============================================

/**
 * Bump a listing video's view counter.
 *
 * DELIBERATELY UNAUTHENTICATED — a listing video is watched by prospects on
 * public/portal surfaces who have no agent session, so requiring one would
 * defeat the metric. What is enforced instead:
 *
 *  1. The project must EXIST and be genuinely watchable (`video_url` set).
 *     `public.increment` is SECURITY DEFINER with a hard (table, column)
 *     allow-list (verified live), so it bypasses RLS entirely and would
 *     otherwise happily increment any `ai_video_projects` row id — including
 *     drafts and rows in other brokerages — and its silence/failure would
 *     also confirm or deny that a given uuid exists.
 *  2. The rpc error is destructured. Previously the whole call was
 *     fire-and-forget, so a broken counter looked identical to a working one.
 *
 * KNOWN GAP, deliberately left: there is no per-viewer dedupe, so a caller in
 * a loop can still inflate `view_count` on a real, published video. Closing
 * that needs a `video_views(project_id, viewer_fingerprint, viewed_at)` ledger
 * with a unique index on (project_id, viewer_fingerprint, day) and the counter
 * derived from it — a migration plus a fingerprint source, neither of which
 * exists yet. Recorded rather than half-built.
 */
export async function trackVideoView(
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(projectId)) {
    return { success: false, error: 'Invalid project ID' }
  }

  const supabase = await createClient()

  const { data: project, error: lookupError } = await supabase
    .from('ai_video_projects')
    .select('id, video_url')
    .eq('id', projectId)
    .maybeSingle()

  // Fail closed: a refused read is not "no such video".
  if (lookupError) {
    return { success: false, error: 'Could not verify the video' }
  }
  // Same response for "absent" and "not yet rendered" so the endpoint is not
  // an existence oracle over the uuid space.
  if (!project?.video_url) {
    return { success: false, error: 'Video not available' }
  }

  const { error: incrementError } = await supabase.rpc('increment', {
    table_name: 'ai_video_projects',
    row_id: projectId,
    column_name: 'view_count',
  })

  if (incrementError) {
    console.error('trackVideoView: increment failed', incrementError)
    return { success: false, error: 'Could not record the view' }
  }

  return { success: true }
}

// ============================================
// GET VIDEO PROJECTS
// ============================================

export async function getVideoProjects(agentId: string) {
  if (!isValidUUID(agentId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('ai_video_projects')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Get video projects error:', error)
    return []
  }

  return data || []
}

// ============================================
// HELPER FUNCTIONS — DELETED (merged, 2026-08-27)
// ============================================
//
// TOMBSTONE — `mapVideoType`, `getDurationForType` and `getAspectRatio` are
// DELETED with the bespoke assembler they served (see the merge note on
// generateListingVideo above). Survivors: the Director's format selection
// (lib/video/video-director.ts selectVideoFormat / selectVideoFormatLearned)
// owns which composition a situation gets, and each composition's geometry —
// dimensions, fps, duration — is declared ONCE in
// lib/remotion/composition-geometry.ts (PhotoWalkthroughReel: 1080x1080 @30fps,
// 600 frames), never re-derived per caller. The `videoType` parameter above is
// still accepted for its callers' sake (it sets the photo minimum), but the
// format decision belongs to the Director's learning loop.
