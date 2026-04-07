"use server"

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"

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

  const supabase = await createClient()

  // Load project to get video_url and metadata
  const { data: project, error: loadError } = await supabase
    .from("ai_video_projects")
    .select("id, title, video_url, thumbnail_url, status, brokerage_id, agent_id, listing_id, script_content, video_type")
    .eq("id", params.videoProjectId)
    .maybeSingle()

  if (loadError || !project) {
    return { success: false, error: "Video project not found" }
  }

  const readyStatuses = ["ready", "completed", "preview_ready", "published"]
  if (!readyStatuses.includes(project.status)) {
    return { success: false, error: "Video is not ready for distribution. Please wait for generation to complete." }
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

      const { data: post, error: postError } = await supabase
        .from("social_posts")
        .insert({
          brokerage_id: params.brokerageId,
          user_id: params.userId,
          agent_id: params.userId,
          platform: params.platform,
          post_type: "video",
          content: project.script_content?.slice(0, 280) ?? project.title ?? "Check out my latest video!",
          media_urls: [project.video_url],
          hashtags: [],
          scheduled_for: scheduledFor,
          social_account_id: params.socialAccountId,
          listing_id: project.listing_id ?? null,
          status: params.action === "post_now" ? "scheduled" : "scheduled",
          approval_status: "approved",
          ai_generated: true,
          // Link back to the video project via kernel_event_id proxy — stored in post_brief
          post_brief: `video_project:${project.id}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select("id")
        .maybeSingle()

      if (postError) {
        return { success: false, error: postError.message }
      }

      // Log activity
      await supabase.from("activities").insert({
        brokerage_id: params.brokerageId,
        agent_id: params.userId,
        activity_type: "video_distributed",
        title: `Video distributed to ${params.platform}`,
        description: `"${project.title}" scheduled for ${params.platform}`,
        status: "completed",
        entity_type: "video_project",
      })

      return { success: true, socialPostId: post?.id }
    }

    case "draft": {
      const { data: post, error: postError } = await supabase
        .from("social_posts")
        .insert({
          brokerage_id: params.brokerageId,
          user_id: params.userId,
          agent_id: params.userId,
          platform: params.platform ?? "instagram",
          post_type: "video",
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
      await supabase.from("client_portal_messages").insert({
        brokerage_id: params.brokerageId,
        agent_id: params.userId,
        contact_id: params.contactId,
        direction: "outbound",
        body: `${subject}\n\n${body}`,
        created_at: new Date().toISOString(),
      })

      return { success: true }
    }

    case "copy_link": {
      // Return the hosted video URL as the shareable link
      return { success: true, shareableLink: project.video_url }
    }

    default:
      return { success: false, error: "Unknown distribution action" }
  }
}
