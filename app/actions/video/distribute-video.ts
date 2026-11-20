"use server"

import { createClient } from "@/lib/supabase/server"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { isValidUUID } from "@/lib/validations"
import { VIDEO_FINISHED_STATUSES } from "@/lib/video/video-pipeline-reaper-policy"
import { normalizeVideoStatus, isCanonicalVideoStatus } from "@/lib/video/video-status"

export type DistributeVideoAction =
  | "post_now"
  | "schedule"
  | "draft"
  | "email_to_client"
  | "copy_link"

export interface DistributeVideoParams {
  videoProjectId: string
  brokerageId: string
  userId: string
  action: DistributeVideoAction
  /** For post_now and schedule */
  platform?: string
  socialAccountId?: string
  /** ISO datetime for schedule */
  scheduledFor?: string
  /** For email_to_client */
  contactId?: string
  emailSubject?: string
  emailBody?: string
}

export interface DistributeVideoResult {
  success: boolean
  error?: string
  socialPostId?: string
  shareableLink?: string
}

export async function distributeVideo(
  params: DistributeVideoParams
): Promise<DistributeVideoResult> {
  if (!isValidUUID(params.videoProjectId)) {
    return { success: false, error: "Invalid video project ID" }
  }

  // WAVE 155 (155R17 — CLAUDE.md §4): `brokerageId` and `userId` came from the request body and were written straight into
  // social_posts / activities / email_queue rows. The tenant and the actor are now the SESSION's (requireCallerTenant — a body
  // tenant naming another brokerage is refused), the project is read in that tenant, and the act leaves one receipt.
  const caller = await requireCallerTenant(params.brokerageId)
  if (!caller.ok) return { success: false, error: caller.error }
  params = { ...params, brokerageId: caller.brokerageId, userId: caller.userId }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction({ brokerageId: caller.brokerageId, action: "marketing.video.distribute", actor: { type: "user", userId: caller.userId }, subject: { type: "ai_video_project", id: params.videoProjectId }, riskClass: params.action === "draft" || params.action === "copy_link" ? "LOW_RISK_WRITE" : "COMMUNICATION", reasonCode: "HUMAN_REQUESTED", detail: { action: params.action, platform: params.platform ?? null } }, async (): Promise<DistributeVideoResult> => {
  const supabase = await createClient()
  // activities / social_posts / client_portal_messages agent_id all FK agents(id).
  // params.userId is a users.id — it is written to user_id in the same payloads.
  const actingAgentId = await resolveAgentId(supabase, params.userId)

  // Load project to get video_url and metadata
  const { data: project, error: loadError } = await supabase
    .from("ai_video_projects")
    .select("id, title, video_url, thumbnail_url, status, brokerage_id, agent_id, listing_id, script_content, video_type, audience_type, usage_intent, contact_id, learning_module_id, approval_status, compliance_status")
    .eq("id", params.videoProjectId)
    .eq("brokerage_id", caller.brokerageId)
    .maybeSingle()

  if (loadError || !project) {
    return { success: false, error: "Video project not found" }
  }

  // The stored value is normalised FIRST. `distributed`, `uploaded`, `ready` and
  // `preview_ready` are all retired spellings of a finished video
  // (lib/video/video-status.ts:RETIRED_VIDEO_STATUS), and this gate used to
  // enumerate one of them by hand — so a row written under any of the others was
  // refused with "wait for generation to complete" for a video that had finished,
  // and a video that had already been distributed once could never be distributed
  // again, because its own success rewrote its status out of the accepted set.
  // One normaliser replaces the hand-list.
  const rawStatus = String(project.status ?? "")
  const status = normalizeVideoStatus(rawStatus)

  // A value that survives normalisation and is still not in the vocabulary is
  // DRIFT, not progress. Saying "wait for generation to complete" about it would
  // name a condition nobody is waiting on.
  if (!isCanonicalVideoStatus(status)) {
    return {
      success: false,
      error: `This video's status is "${rawStatus}", which is not a status this system recognises, so it cannot be distributed.`,
    }
  }

  if (!(VIDEO_FINISHED_STATUSES as readonly string[]).includes(status)) {
    return {
      success: false,
      error: `This video is "${status}". Only a finished video (${VIDEO_FINISHED_STATUSES.join(" or ")}) can be distributed.`,
    }
  }

  if (!project.video_url) {
    return { success: false, error: "Video URL not available" }
  }

  switch (params.action) {
    case "post_now":
    case "schedule": {
      if (!params.socialAccountId) {
        return { success: false, error: "Social account is required for posting" }
      }
      if (!params.platform) {
        return { success: false, error: "Platform is required for posting" }
      }

      const scheduledFor =
        params.action === "schedule" && params.scheduledFor
          ? new Date(params.scheduledFor).toISOString()
          : new Date(Date.now() + 60_000).toISOString() // 1 min from now for "post now"

      // WAVE 153 (lane 153P — lane 153K carried finding): this insert wrote approval_status "approved" for a public post
      // nobody approved, for a video nobody classified as public marketing. Now: classifyPublicVideo refuses a personal /
      // client / unapproved / non-compliant video by its reason; the post is inserted PENDING; the SESSION user releases
      // it only when requirePublishApprover names them an approver — otherwise it waits on the approval surface.
      const { insertVideoSocialPostForApproval } = await import("@/lib/social/video-post-approval")
      const { data: sessionUser } = await supabase.auth.getUser()
      const gated = await insertVideoSocialPostForApproval(supabase, {
        brokerageId: project.brokerage_id ?? params.brokerageId,
        approverUserId: sessionUser?.user?.id ?? null,
        project: project as Record<string, unknown>,
        post: {
          user_id: params.userId,
          agent_id: actingAgentId,
          platform: params.platform,
          post_type: "custom",
          content: project.script_content?.slice(0, 280) ?? project.title ?? "Check out my latest video!",
          media_urls: [project.video_url],
          hashtags: [],
          scheduled_for: scheduledFor,
          social_account_id: params.socialAccountId,
          listing_id: project.listing_id ?? null,
          ai_generated: true,
          // Link back to the video project — stored in post_brief (kernel_event_id retired, m597)
          post_brief: `video_project:${project.id}`,
        },
      })
      if (!gated.ok) {
        return { success: false, error: gated.reason ?? "social post not created" }
      }
      const post = { id: gated.postId ?? undefined }

      // Log activity. The social_posts row above already checked its error and
      // returns on failure; this is the record that distribution happened.
      const { error: distributedActivityError } = await supabase.from("activities").insert({
        brokerage_id: params.brokerageId,
        agent_id: actingAgentId,
        activity_type: "video_distributed",
        title: gated.released ? `Video distributed to ${params.platform}` : `Video post awaiting approval for ${params.platform}`,
        description: gated.released ? `"${project.title}" scheduled for ${params.platform}` : `"${project.title}" — ${gated.reason}`,
        status: "completed",
        entity_type: "video_project",
      })
      if (distributedActivityError) {
        console.error("[distributeVideo] video_distributed activity REJECTED — the post is scheduled but unrecorded:", distributedActivityError.message)
      }

      return { success: true, socialPostId: post?.id }
    }

    case "draft": {
      const { data: post, error: postError } = await supabase
        .from("social_posts")
        .insert({
          brokerage_id: params.brokerageId,
          user_id: params.userId,
          agent_id: actingAgentId,
          platform: params.platform ?? "instagram",
          post_type: "custom",
          content: project.script_content?.slice(0, 280) ?? project.title ?? "",
          media_urls: [project.video_url],
          hashtags: [],
          scheduled_for: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          social_account_id: params.socialAccountId ?? "00000000-0000-0000-0000-000000000000",
          listing_id: project.listing_id ?? null,
          status: "draft",
          approval_status: "pending",
          ai_generated: true,
          post_brief: `video_project:${project.id}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select("id")
        .maybeSingle()

      if (postError) {
        return { success: false, error: postError.message }
      }

      return { success: true, socialPostId: post?.id }
    }

    case "email_to_client": {
      if (!params.contactId || !isValidUUID(params.contactId)) {
        return { success: false, error: "Contact ID is required for email distribution" }
      }

      const subject = params.emailSubject ?? `Video update: ${project.title}`
      const body =
        params.emailBody ??
        `Hi,\n\nI wanted to share this video with you:\n\n${project.video_url}\n\nPlease let me know if you have any questions!\n\nBest regards`

      // Enqueue email via email_queue
      const { error: emailError } = await supabase.from("email_queue").insert({
        brokerage_id: params.brokerageId,
        to_email: "", // will be resolved from contact
        to_name: "",
        subject,
        body,
        template: "video_share",
        metadata: {
          video_url: project.video_url,
          thumbnail_url: project.thumbnail_url ?? null,
          video_project_id: project.id,
          contact_id: params.contactId,
        },
        status: "pending",
        attempts: 0,
        created_at: new Date().toISOString(),
      })

      if (emailError) {
        return { success: false, error: emailError.message }
      }

      // Also write a client_portal_messages entry
      const { error: portalVideoMsgErr } = await supabase.from("client_portal_messages").insert({
        brokerage_id: params.brokerageId,
        agent_id: actingAgentId,
        contact_id: params.contactId,
        direction: "agent_to_client",
        body: `${subject}\n\n${body}`,
        created_at: new Date().toISOString(),
      })
      if (portalVideoMsgErr) console.error(`[distribute-video] portal copy of the video message NOT recorded: ${portalVideoMsgErr.message}`)

      return { success: true }
    }

    case "copy_link": {
      // Return the hosted video URL as the shareable link
      return { success: true, shareableLink: project.video_url }
    }

    default:
      return { success: false, error: "Unknown distribution action" }
  }
  })
}
