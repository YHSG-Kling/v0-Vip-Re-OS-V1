"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { generateAIResponse } from "@/lib/ai"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// Every function in this file used to be unauthenticated. Caller could
// generate AI video scripts attributed to any organization (burning AI
// budget), check/update/delete any video by id, and pull any user's
// video queue. Now: session is required + organization ownership is
// verified.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

// Verify the (organizationId, organizationType) refers to caller's brokerage
// (or a team within caller's brokerage). Returns ok on success.
async function verifyOrgAccess(
  organizationId: string,
  organizationType: "brokerage" | "team",
  callerBrokerageId: string,
): Promise<boolean> {
  const svc = createServiceClient()
  if (organizationType === "brokerage") {
    return organizationId === callerBrokerageId
  }
  // team — must belong to caller's brokerage
  const { data: team } = await svc
    .from("teams")
    .select("brokerage_id")
    .eq("id", organizationId)
    .maybeSingle()
  return !!team && team.brokerage_id === callerBrokerageId
}

// Helper: verify the video belongs to caller's brokerage
async function verifyVideoAccess(videoQueueId: string, callerBrokerageId: string): Promise<
  | { ok: true; video: { id: string; organization_id: string; organization_type: string; user_id: string } }
  | { ok: false }
> {
  const svc = createServiceClient()
  const { data: video } = await svc
    .from("video_generation_queue")
    .select("id, organization_id, organization_type, user_id")
    .eq("id", videoQueueId)
    .maybeSingle()
  if (!video) return { ok: false }
  const allowed = await verifyOrgAccess(
    video.organization_id as string,
    video.organization_type as "brokerage" | "team",
    callerBrokerageId,
  )
  if (!allowed) return { ok: false }
  return { ok: true, video: video as any }
}

// Generate AI script from URL
export async function generateVideoScript(params: {
  url: string
  contentCategory: string
  organizationId: string
  organizationType: "brokerage" | "team"
  userId?: string  // ignored — derived from session
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!(await verifyOrgAccess(params.organizationId, params.organizationType, auth.brokerageId))) {
    return { success: false, error: "Forbidden" }
  }

  const supabase = createServiceClient()

  try {
    // Fetch organization compliance rules
    const { data: org } = await supabase
      .from(params.organizationType === "brokerage" ? "brokerages" : "teams")
      .select("compliance_rules")
      .eq("id", params.organizationId)
      .single()

    if (!org) throw new Error("Organization not found")

    // Use AI to generate script from URL content
    const response = await generateAIResponse({
      prompt: `Create a 75-word engaging voiceover script for a ${params.contentCategory} video based on this URL: ${params.url}

Requirements:
- Professional yet conversational tone
- Follow real estate compliance: no discriminatory language
- Include required disclaimers: ${org?.compliance_rules?.required_disclaimers?.join(", ") || "Licensed Real Estate Agent"}
- Focus on benefits and features
- Make it compelling for social media

Return ONLY the script text, no formatting or labels.`,
      metadata: {
        userId: auth.userId,
        brokerageId: auth.brokerageId,
        feature: "video_script_generation",
      },
    })

    // Create video queue entry — stamp user_id + organization from session/verified params
    const { data: videoQueue, error } = await supabase
      .from("video_generation_queue")
      .insert({
        user_id: auth.userId,
        organization_id: params.organizationId,
        organization_type: params.organizationType,
        source_url: params.url,
        content_category: params.contentCategory,
        ai_generated_script: response.text,
        edited_script: response.text,
        script_status: "pending",
        compliance_approved: false,
      })
      .select()
      .single()

    if (error) throw error

    // Run compliance check
    await checkCompliance(videoQueue.id)

    revalidatePath("/content-studio")
    return { success: true, videoQueue }
  } catch (error) {
    console.error("[link-to-video] Generate video script error:", error)
    return { success: false, error: "Failed to generate script" }
  }
}

// Check script compliance — burns paid AI inference
export async function checkCompliance(videoQueueId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const supabase = createServiceClient()

  try {
    const { data: video } = await supabase
      .from("video_generation_queue")
      .select("*, brokerages(compliance_rules)")
      .eq("id", videoQueueId)
      .single()

    if (!video) throw new Error("Video not found")

    const script = video.edited_script || video.ai_generated_script
    const complianceRules = video.brokerages?.compliance_rules || {}

    // Use AI to check compliance
    const complianceResponse = await generateAIResponse({
      prompt: `Analyze this real estate video script for compliance violations:

Script: "${script}"

Check for:
1. Fair Housing Act violations (mentions of race, religion, familial status, national origin, sex, disability)
2. Discriminatory language: ${complianceRules.restricted_keywords?.join(", ")}
3. Required disclaimers present: ${complianceRules.required_disclaimers?.join(", ")}
4. Copyright/trademark concerns
5. NAR Code of Ethics adherence

Return JSON: {
  "passed": boolean,
  "flags": [{"severity": "warning"|"violation", "issue": string, "suggestion": string}],
  "score": number 0-100
}`,
      metadata: {
        userId: auth.userId,
        brokerageId: video.organization_id,
        feature: "video_script_generation",
      },
    })

    const complianceResult = JSON.parse(complianceResponse.text)

    await supabase
      .from("video_generation_queue")
      .update({
        compliance_check_passed: complianceResult.passed && complianceResult.score >= 75,
        compliance_flags: complianceResult.flags,
        script_status: complianceResult.passed ? "approved" : "needs_revision",
      })
      .eq("id", videoQueueId)

    revalidatePath("/content-studio")
    return { success: true, compliance: complianceResult }
  } catch (error) {
    console.error("[link-to-video] Check compliance error:", error)
    return { success: false, error: "Failed to check compliance" }
  }
}

// Update script
export async function updateVideoScript(videoQueueId: string, editedScript: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const supabase = createServiceClient()

  try {
    const { error } = await supabase
      .from("video_generation_queue")
      .update({
        edited_script: editedScript,
        script_status: "pending",
      })
      .eq("id", videoQueueId)

    if (error) throw error

    // Re-run compliance check
    await checkCompliance(videoQueueId)

    revalidatePath("/content-studio")
    return { success: true }
  } catch (error) {
    console.error("[link-to-video] Update video script error:", error)
    return { success: false, error: "Failed to update script" }
  }
}

// Start video generation
export async function startVideoGeneration(videoQueueId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const supabase = createServiceClient()

  try {
    await supabase.from("video_generation_queue").update({ status: "generating_audio" }).eq("id", videoQueueId)
    revalidatePath("/content-studio")
    return { success: true, message: "Video generation started" }
  } catch (error) {
    console.error("[link-to-video] Start video generation error:", error)
    return { success: false, error: "Failed to start video generation" }
  }
}

export async function getVideoQueue(_userId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  try {
    // Read queue for caller's brokerage (org_id matches brokerage_id when
    // organization_type='brokerage'; we also include team-scoped rows whose
    // team belongs to caller's brokerage via a separate query).
    const { data: brokerageVideos, error } = await supabase
      .from("video_generation_queue")
      .select("*")
      .eq("organization_id", auth.brokerageId)
      .eq("organization_type", "brokerage")
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) {
      if (error.code === "PGRST205" || error.message?.includes("Could not find the table")) {
        return []
      }
      console.error("[link-to-video] Get video queue error:", error)
      return []
    }

    // Add team videos where the team belongs to caller's brokerage
    const { data: teams } = await supabase
      .from("teams")
      .select("id")
      .eq("brokerage_id", auth.brokerageId)
    const teamIds = (teams ?? []).map((t: any) => t.id)
    let teamVideos: any[] = []
    if (teamIds.length > 0) {
      const { data: tv } = await supabase
        .from("video_generation_queue")
        .select("*")
        .in("organization_id", teamIds)
        .eq("organization_type", "team")
        .order("created_at", { ascending: false })
        .limit(50)
      teamVideos = tv ?? []
    }

    return [...(brokerageVideos ?? []), ...teamVideos]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 50)
  } catch (error) {
    console.error("[link-to-video] Get video queue error:", error)
    return []
  }
}

// Get single video details
export async function getVideoDetails(videoQueueId: string) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) throw new Error("Forbidden")

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("video_generation_queue")
    .select("*, video_processing_log(*), video_social_publishes(*)")
    .eq("id", videoQueueId)
    .single()

  if (error) throw error
  return data
}

// Generate social caption — paid AI
export async function generateSocialCaption(videoQueueId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const supabase = createServiceClient()

  try {
    const { data: video } = await supabase.from("video_generation_queue").select("*").eq("id", videoQueueId).single()

    if (!video) throw new Error("Video not found")

    const captionResponse = await generateAIResponse({
      prompt: `Create an engaging social media caption for this video:

Category: ${video.content_category}
Script: ${video.edited_script || video.ai_generated_script}

Requirements:
- Attention-grabbing hook
- 3-5 relevant hashtags
- Clear call-to-action
- Compliant with real estate advertising rules
- Maximum 200 characters

Return only the caption text.`,
      metadata: {
        userId: auth.userId,
        brokerageId: auth.brokerageId,
        feature: "video_script_generation",
      },
    })

    await supabase.from("video_generation_queue").update({ social_caption: captionResponse.text }).eq("id", videoQueueId)

    revalidatePath("/content-studio")
    return { success: true, caption: captionResponse.text }
  } catch (error) {
    console.error("[link-to-video] Generate social caption error:", error)
    return { success: false, error: "Failed to generate caption" }
  }
}

// Delete video
export async function deleteVideo(videoQueueId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const access = await verifyVideoAccess(videoQueueId, auth.brokerageId)
  if (!access.ok) return { success: false, error: "Forbidden" }

  const supabase = createServiceClient()

  try {
    const { error } = await supabase.from("video_generation_queue").delete().eq("id", videoQueueId)

    if (error) throw error

    revalidatePath("/content-studio")
    return { success: true }
  } catch (error) {
    console.error("[link-to-video] Delete video error:", error)
    return { success: false, error: "Failed to delete video" }
  }
}

// Get user organizations — derives from session, not from caller param
export async function getUserOrganizations(_userId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  try {
    const { data, error } = await supabase
      .from("organization_members")
      .select("organization_id, organization_type, brokerages(id, name), teams(id, name)")
      .eq("user_id", auth.userId)

    if (error) throw error

    return (data || []).map((item) => ({
      id: item.organization_id,
      name: (item.brokerages as any)?.[0]?.name ?? (item.brokerages as any)?.name ?? (item.teams as any)?.[0]?.name ?? (item.teams as any)?.name ?? "Unknown",
      type: item.organization_type,
    }))
  } catch (error) {
    console.error("[link-to-video] Get user organizations error:", error)
    return []
  }
}
