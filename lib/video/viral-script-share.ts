// lib/video/viral-script-share.ts
// ─────────────────────────────────────────────────────────────────────────────
// A VIRAL VIDEO SHARES ITS SCRIPT WITH THE WHOLE BROKERAGE.
//
// THE OWNER'S RULING
//
//   "agent authored scripts should save to scripts and if it the video goes
//    viral using that script, it should be shared to the whole brokerage."
//
// m429 gave `public.scripts` the tenant and the audience column that make the
// second half sayable: an agent-authored script starts `visibility = 'private'`
// inside `brokerage_id = <their tenant>`, and promotion is the one-column update
// to `visibility = 'brokerage'`. This module is the only thing that performs it.
//
// ── WHERE IT IS CALLED FROM, AND WHY THERE ──────────────────────────────────
//
// Both existing engagement lanes, at the point they already evaluate thresholds:
//
//   · app/actions/video-generation.ts    : checkAndFirePerformanceEvents
//   · app/api/video/engagement/route.ts  : checkPerformanceThresholds
//
// Those two are where video engagement is actually processed — they already
// aggregate into video_performance_tracking and already fire
// VIDEO_HIGH_PERFORMER_DETECTED off the same numbers. Adding a third path (a
// cron, a route) would be an orphan lane racing them for the same decision.
//
// ── WHY IT TRUSTS NOTHING BUT AN id ─────────────────────────────────────────
//
// This shape was originally forced by POST /api/video/engagement, which at the
// time had NO auth gate and took `brokerageId` from the request body. That hole
// is now closed — the route is session-gated and resolves its tenant from the
// session — but the argument surface stays exactly this small on purpose: this
// function accepts a project id and NOTHING ELSE, and the view count, the
// video's tenant and the script's tenant are all re-read server-side through the
// service client. A caller cannot supply a count, cannot supply a tenant, and
// cannot name a script — recurring defect (d), resolved by making the argument
// surface too small to lie through, independently of how well any one caller is
// gated today.
//
// ── THE TWO REFUSALS THAT ARE THE POINT ─────────────────────────────────────
//
//  1. TENANT MISMATCH. `ai_video_projects.source_script_id` is a foreign key,
//     and a foreign key proves the script EXISTS — never that it belongs to the
//     same brokerage as the video. (createVideoProject already records this
//     lesson about marketing_campaign_id: "the FK only proves the campaign
//     exists, never that it is ours".) Both tenants are resolved and compared for
//     equality, and a mismatch REFUSES rather than promoting — otherwise a video
//     in brokerage A could publish a script into brokerage B.
//
//  2. THE PLATFORM CATALOGUE IS NEVER TOUCHED. A script with a NULL
//     brokerage_id is a platform-catalogue row (m406/m408/m421 convention). It
//     is already readable by every tenant, it is not any agent's work, and
//     nothing here may write it. The equality in (1) already excludes it —
//     `NULL = <uuid>` is NULL, never true — but it is also refused explicitly,
//     because relying on a NULL comparison to fail closed is how recurring
//     defect (b) gets written.
//
// ── IDEMPOTENCE ─────────────────────────────────────────────────────────────
//
// Every 'view' event past the threshold re-enters this function, so "crossing
// the threshold twice must not double anything" is the normal case, not an edge
// case. The guard is the UPDATE itself:
//
//     UPDATE scripts SET visibility='brokerage'
//      WHERE id = $1 AND visibility = 'private'
//
// One row the first time, zero rows every time after, decided atomically by the
// database rather than by a read-then-write this function could lose a race on.
// The notification and the lifecycle event are written ONLY when that update
// returned a row, so they cannot repeat either.
//
// A zero-row UPDATE is `error: null` in supabase-js (recurring defect (a)), so
// the update carries `.select("id")` and the ROW COUNT is what decides — never
// the absence of an error.

import { createServiceClient } from "@/lib/supabase/service"
import { resolveRecipientBrokerageId } from "@/lib/notifications/recipient-tenant"
import { VIRAL_VIEW_THRESHOLD } from "@/app/types/video-generation"

export type ViralScriptShareResult =
  /** The script was promoted by THIS call. Exactly one call per script ever gets this. */
  | { promoted: true; scriptId: string; brokerageId: string; totalViews: number }
  /** Nothing was promoted. `reason` says why — including the ordinary "not viral yet". */
  | { promoted: false; reason: string }

/**
 * Promote the `public.scripts` row a video was rendered from to
 * brokerage-shared, if that video has crossed VIRAL_VIEW_THRESHOLD.
 *
 * Safe to call on every engagement event: below the threshold, and on every
 * event after the first crossing, it is a no-op.
 *
 * @param videoProjectId `ai_video_projects.id`. The ONLY input — everything else
 *                       is resolved from the database.
 */
export async function shareViralScriptWithBrokerage(
  videoProjectId: string,
): Promise<ViralScriptShareResult> {
  if (!videoProjectId) return { promoted: false, reason: "no video project id" }

  const svc = createServiceClient()

  // ── 1. The video, its tenant, and the script it was rendered from ─────────
  // `error` destructured throughout: supabase-js RESOLVES a refused read, so
  // `const { data }` alone reports a refusal as "no such row" and would make
  // this function report "this video has no source script" for a database that
  // simply said no.
  const { data: project, error: projectError } = await svc
    .from("ai_video_projects")
    .select("id, brokerage_id, agent_id, title, source_script_id")
    .eq("id", videoProjectId)
    .maybeSingle()

  if (projectError) {
    console.error("[viral-script-share] could not read the video project:", projectError.message)
    return { promoted: false, reason: `video project read refused: ${projectError.message}` }
  }
  if (!project) return { promoted: false, reason: "video project not found" }
  if (!project.source_script_id) {
    // The ordinary case for a video rendered from pasted text rather than from a
    // saved script. There is nothing to promote and nothing has gone wrong.
    return { promoted: false, reason: "this video was not rendered from a saved script" }
  }
  if (!project.brokerage_id) {
    // ai_video_projects.brokerage_id is NULLABLE. An untenanted project cannot
    // establish which brokerage a script would be shared WITH, so it refuses
    // rather than guessing — this is the check that stops an unstamped video
    // from publishing a script into whichever tenant asked.
    return { promoted: false, reason: "video project carries no brokerage — nothing to share it with" }
  }

  // ── 2. Is it viral? Read the count; never accept one ──────────────────────
  const { data: tracking, error: trackingError } = await svc
    .from("video_performance_tracking")
    .select("total_views")
    .eq("video_project_id", videoProjectId)
    .eq("brokerage_id", project.brokerage_id)
    .maybeSingle()

  if (trackingError) {
    console.error("[viral-script-share] could not read performance tracking:", trackingError.message)
    return { promoted: false, reason: `performance tracking read refused: ${trackingError.message}` }
  }

  const totalViews = tracking?.total_views ?? 0
  if (totalViews < VIRAL_VIEW_THRESHOLD) {
    return { promoted: false, reason: `not viral yet (${totalViews}/${VIRAL_VIEW_THRESHOLD} views)` }
  }

  // ── 3. The script, and the tenant check the FK cannot do ──────────────────
  const { data: script, error: scriptError } = await svc
    .from("scripts")
    .select("id, title, brokerage_id, visibility, created_by")
    .eq("id", project.source_script_id)
    .maybeSingle()

  if (scriptError) {
    console.error("[viral-script-share] could not read the source script:", scriptError.message)
    return { promoted: false, reason: `script read refused: ${scriptError.message}` }
  }
  if (!script) return { promoted: false, reason: "source script not found" }

  if (!script.brokerage_id) {
    return { promoted: false, reason: "source script belongs to the platform catalogue — not a tenant's to share" }
  }
  if (script.brokerage_id !== project.brokerage_id) {
    console.error(
      `[viral-script-share] REFUSED: video ${videoProjectId} (brokerage ${project.brokerage_id}) points at script ${script.id} (brokerage ${script.brokerage_id}). A foreign key proves the script exists, never that it is ours.`,
    )
    return { promoted: false, reason: "video and script belong to different brokerages" }
  }
  if (script.visibility !== "private") {
    return { promoted: false, reason: `script is already ${script.visibility}` }
  }

  // ── 4. The promotion. Atomic, one column, conditional ─────────────────────
  const { data: promoted, error: promoteError } = await svc
    .from("scripts")
    .update({ visibility: "brokerage", updated_at: new Date().toISOString() })
    .eq("id", script.id)
    .eq("visibility", "private")          // the idempotence guard, decided by the database
    .select("id")

  if (promoteError) {
    console.error("[viral-script-share] promotion refused:", promoteError.message)
    return { promoted: false, reason: `promotion refused: ${promoteError.message}` }
  }
  if (!promoted || promoted.length === 0) {
    // A zero-row UPDATE is error: null. Another event crossed the threshold
    // first and won the race; that is success for the product and a no-op here.
    return { promoted: false, reason: "already promoted by a concurrent event" }
  }

  // ── 5. Make it VISIBLE. Two audiences, one existing lane each ─────────────
  //
  // The brokerage learns about it by the script APPEARING in their library —
  // that is what the m429 read policy does the instant visibility flips — plus
  // the lifecycle_events row below, which is the tenant-scoped audit rail the
  // rest of this engagement lane already writes to. Fanning a notification out
  // to every agent in the brokerage would be a second notification lane and a
  // storm; it is deliberately not done.
  //
  // The AUTHOR is told directly, through the one notifications lane, because
  // their work has just changed hands and nothing else would tell them.
  const { error: eventError } = await svc.from("lifecycle_events").insert({
    entity_type: "script",
    entity_id: script.id,
    brokerage_id: script.brokerage_id,
    event_type: "script_shared_to_brokerage",
    actor_user_id: script.created_by ?? null,
    metadata: {
      script_title: script.title,
      video_project_id: project.id,
      video_title: project.title,
      total_views: totalViews,
      viral_view_threshold: VIRAL_VIEW_THRESHOLD,
    },
  })
  if (eventError) {
    console.error("[viral-script-share] lifecycle_events insert refused:", eventError.message)
  }

  if (script.created_by) {
    // TENANT — the RECIPIENT's `users.brokerage_id`, the one resolver
    // (lib/notifications/recipient-tenant.ts). It is NOT assumed equal to
    // script.brokerage_id: an author who has since moved brokerages would get a
    // notification stamped with a tenant the badge reader does not compute, and
    // the bell would stay dark.
    const recipientTenant = await resolveRecipientBrokerageId(svc, script.created_by)
    if (!recipientTenant.ok) {
      console.error(
        `[viral-script-share] ${recipientTenant.reason} — script_shared_to_brokerage notification NOT written`,
      )
    } else if (!recipientTenant.brokerageId) {
      console.error(
        `[viral-script-share] author ${script.created_by} has no brokerage — script_shared_to_brokerage notification NOT written rather than written where the bell cannot count it`,
      )
    } else {
      const { error: notifyError } = await svc.from("notifications").insert({
        user_id: script.created_by,
        brokerage_id: recipientTenant.brokerageId,
        type: "script_shared_to_brokerage",
        title: "Your script went viral — it is now shared with your brokerage",
        body: `"${script.title}" passed ${totalViews.toLocaleString()} views on "${project.title ?? "your video"}", so it is now available to every agent in your brokerage.`,
        entity_type: "script",
        entity_id: script.id,
      })
      if (notifyError) {
        console.error("[viral-script-share] notification insert refused:", notifyError.message)
      }
    }
  }

  console.log(
    `[viral-script-share] script ${script.id} promoted to brokerage ${script.brokerage_id} (${totalViews} views on project ${project.id})`,
  )
  return { promoted: true, scriptId: script.id, brokerageId: script.brokerage_id, totalViews }
}
