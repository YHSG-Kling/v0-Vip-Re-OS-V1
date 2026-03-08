"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { generateText } from "ai"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// Generate AI script from URL
export async function generateVideoScript(params: {
  url: string
  contentCategory: string
  organizationId: string
  organizationType: "brokerage" | "team"
  userId?: string // Accept optional userId parameter
}) {
  const supabase = createServiceClient()

  const userId = params.userId || "system"

  try {
    // Fetch organization compliance rules
    const { data: org } = await supabase
      .from(params.organizationType === "brokerage" ? "brokerages" : "teams")
      .select("compliance_rules")
      .eq("id", params.organizationId)
      .single()

    if (!org) throw new Error("Organization not found")

    // Use AI to generate script from URL content
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Create a 75-word engaging voiceover script for a ${params.contentCategory} video based on this URL: ${params.url}

Requirements:
- Professional yet conversational tone
- Follow real estate compliance: no discriminatory language
- Include required disclaimers: ${org?.compliance_rules?.required_disclaimers?.join(", ") || "Licensed Real Estate Agent"}
- Focus on benefits and features
- Make it compelling for social media

Return ONLY the script text, no formatting or labels.`,
    })

    // Create video queue entry
    const { data: videoQueue, error } = await supabase
      .from("video_generation_queue")
      .insert({
        user_id: userId, // Use userId parameter instead of supabase auth
        organization_id: params.organizationId,
        organization_type: params.organizationType,
        source_url: params.url,
        content_category: params.contentCategory,
        ai_generated_script: text,
        edited_script: text,
        script_status: "pending",
      })
      .select()
      .single()

    if (error) throw error

    // Run compliance check
    await checkCompliance(videoQueue.id)

    revalidatePath("/content-studio")
    return { success: true, videoQueue }
  } catch (error) {
    console.error("Generate video script error:", error)
    return { success: false, error: "Failed to generate script" }
  }
}

// Check script compliance
export async function checkCompliance(videoQueueId: string) {
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
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
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
    })

    const complianceResult = JSON.parse(text)

    // Update video with compliance results
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
    console.error("Check compliance error:", error)
    return { success: false, error: "Failed to check compliance" }
  }
}

// Update script
export async function updateVideoScript(videoQueueId: string, editedScript: string) {
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
    console.error("Update video script error:", error)
    return { success: false, error: "Failed to update script" }
  }
}

// Start video generation
export async function startVideoGeneration(videoQueueId: string) {
  const supabase = createServiceClient()

  try {
    // Update status
    await supabase.from("video_generation_queue").update({ status: "generating_audio" }).eq("id", videoQueueId)

    // Trigger background processing (would call Edge Function or webhook)
    // For now, just update status
    revalidatePath("/content-studio")
    return { success: true, message: "Video generation started" }
  } catch (error) {
    console.error("Start video generation error:", error)
    return { success: false, error: "Failed to start video generation" }
  }
}

export async function getVideoQueue(userId?: string) {
  const supabase = createServiceClient()

  try {
    let query = supabase.from("video_generation_queue").select("*").order("created_at", { ascending: false }).limit(50)

    if (userId && userId !== "system") {
      query = query.eq("user_id", userId)
    }

    const { data, error } = await query

    if (error) {
      if (error.code === "PGRST205" || error.message?.includes("Could not find the table")) {
        console.log("[v0] video_generation_queue table not found. Run migration script 260-fix-content-studio-tables.sql")
        return []
      }
      console.error("Get video queue error:", error)
      return []
    }
    return data || []
  } catch (error) {
    console.error("Get video queue error:", error)
    return []
  }
}

// Get single video details
export async function getVideoDetails(videoQueueId: string) {
  const supabase = createServiceClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) throw new Error("Not authenticated")

  const { data, error } = await supabase
    .from("video_generation_queue")
    .select("*, video_processing_log(*), video_social_publishes(*)")
    .eq("id", videoQueueId)
    .single()

  if (error) throw error
  return data
}

// Generate social caption
export async function generateSocialCaption(videoQueueId: string) {
  const supabase = createServiceClient()

  try {
    const { data: video } = await supabase.from("video_generation_queue").select("*").eq("id", videoQueueId).single()

    if (!video) throw new Error("Video not found")

    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
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
    })

    await supabase.from("video_generation_queue").update({ social_caption: text }).eq("id", videoQueueId)

    revalidatePath("/content-studio")
    return { success: true, caption: text }
  } catch (error) {
    console.error("Generate social caption error:", error)
    return { success: false, error: "Failed to generate caption" }
  }
}

// Delete video
export async function deleteVideo(videoQueueId: string) {
  const supabase = createServiceClient()

  try {
    const { error } = await supabase.from("video_generation_queue").delete().eq("id", videoQueueId)

    if (error) throw error

    revalidatePath("/content-studio")
    return { success: true }
  } catch (error) {
    console.error("Delete video error:", error)
    return { success: false, error: "Failed to delete video" }
  }
}

// Get user organizations
export async function getUserOrganizations(userId?: string) {
  const supabase = createServiceClient()

  try {
    if (!userId || userId === "system") {
      return [{ id: "default-org", name: "Default Organization", type: "brokerage" }]
    }

    const { data, error } = await supabase
      .from("organization_members")
      .select("organization_id, organization_type, brokerages(id, name), teams(id, name)")
      .eq("user_id", userId)

    if (error) throw error

    return (data || []).map((item) => ({
      id: item.organization_id,
      name: item.brokerages?.name || item.teams?.name || "Unknown",
      type: item.organization_type,
    }))
  } catch (error) {
    console.error("Get user organizations error:", error)
    return [{ id: "default-org", name: "Default Organization", type: "brokerage" }]
  }
}
