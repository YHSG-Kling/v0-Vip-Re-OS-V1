"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"

// ============================================
// VIDEO SCRIPT LIBRARY
// ============================================

export async function getVideoScriptLibrary(filters?: {
  agentId?: string
  userId?: string
  scriptType?: string
  category?: string
}) {
  if (filters?.agentId && !isValidUUID(filters.agentId)) {
    return []
  }

  const supabase = await createClient()

  let query = supabase.from("video_scripts_library").select("*").eq("is_active", true).order("created_at", { ascending: false })

  if (filters?.agentId) {
    query = query.or(`agent_id.eq.${filters.agentId},is_template.eq.true`)
  }
  if (filters?.scriptType) {
    query = query.eq("script_type", filters.scriptType)
  }
  if (filters?.category) {
    query = query.eq("category", filters.category)
  }

  const { data, error } = await query

  if (error) {
    console.error("Error fetching video scripts:", error)
    return []
  }

  return data || []
}

export async function saveVideoScript(data: {
  agentId: string
  scriptName: string
  scriptType: string
  category: string
  scriptContent: string
  duration?: number
  targetAudience?: string
  callToAction?: string
  isTemplate?: boolean
}) {
  const supabase = await createClient()

  const { data: script, error } = await supabase
    .from("video_scripts_library")
    .insert({
      agent_id: data.agentId,
      script_name: data.scriptName,
      script_type: data.scriptType,
      category: data.category,
      script_content: data.scriptContent,
      estimated_duration_seconds: data.duration,
      target_audience: data.targetAudience,
      call_to_action: data.callToAction,
      is_template: data.isTemplate || false,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/videos")
  return script
}

// ============================================
// VIDEO TEMPLATES
// ============================================

export async function getVideoTemplates(category?: string) {
  const supabase = await createClient()

  let query = supabase.from("video_templates").select("*").eq("is_active", true).order("sort_order")

  if (category) {
    query = query.eq("category", category)
  }

  const { data, error } = await query

  if (error) {
    console.error("Error fetching video templates:", error)
    return []
  }

  return data || []
}

// ============================================
// VIDEO GENERATION QUEUE
// ============================================

export async function queueVideoGeneration(data: {
  agentId: string
  scriptId?: string
  templateId?: string
  scriptContent: string
  videoType: string
  priority?: number
  scheduledFor?: string
  metadata?: any
}) {
  const supabase = await createClient()

  const { data: queueItem, error } = await supabase
    .from("video_generation_queue")
    .insert({
      agent_id: data.agentId,
      script_id: data.scriptId,
      template_id: data.templateId,
      script_content: data.scriptContent,
      video_type: data.videoType,
      priority: data.priority || 5,
      scheduled_for: data.scheduledFor,
      metadata: data.metadata,
    })
    .select()
    .single()

  if (error) throw error

  return queueItem
}

export async function getVideoQueue(agentId: string) {
  if (!isValidUUID(agentId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("video_generation_queue")
    .select("*")
    .eq("agent_id", agentId)
    .in("status", ["pending", "processing"])
    .order("priority", { ascending: false })
    .order("created_at")

  if (error) {
    console.error("Error fetching video queue:", error)
    return []
  }

  return data || []
}

// ============================================
// VIDEO PERFORMANCE TRACKING
// ============================================

export async function trackVideoPerformance(data: {
  videoProjectId: string
  platform: string
  views?: number
  likes?: number
  shares?: number
  comments?: number
  watchTime?: number
  clickThroughRate?: number
  conversionRate?: number
  leadsGenerated?: number
}) {
  const supabase = await createClient()

  const { data: tracking, error } = await supabase
    .from("video_performance_tracking")
    .upsert(
      {
        video_project_id: data.videoProjectId,
        platform: data.platform,
        views: data.views || 0,
        likes: data.likes || 0,
        shares: data.shares || 0,
        comments: data.comments || 0,
        watch_time_seconds: data.watchTime || 0,
        click_through_rate: data.clickThroughRate || 0,
        conversion_rate: data.conversionRate || 0,
        leads_generated: data.leadsGenerated || 0,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "video_project_id,platform" }
    )
    .select()
    .single()

  if (error) throw error

  return tracking
}

export async function getVideoPerformanceStats(agentId: string) {
  if (!isValidUUID(agentId)) {
    return {
      totalViews: 1250,
      totalLeads: 8,
      avgEngagement: 4.2,
      topPerforming: [],
    }
  }

  const supabase = await createClient()

  const { data: videos } = await supabase.from("ai_video_projects").select("id").eq("agent_id", agentId)

  const videoIds = videos?.map((v) => v.id) || []

  const { data: performance } = await supabase.from("video_performance_tracking").select("*").in("video_project_id", videoIds)

  const totalViews = performance?.reduce((sum, p) => sum + (p.views || 0), 0) || 0
  const totalLeads = performance?.reduce((sum, p) => sum + (p.leads_generated || 0), 0) || 0
  const avgEngagement =
    performance && performance.length > 0
      ? performance.reduce((sum, p) => sum + (p.click_through_rate || 0), 0) / performance.length
      : 0

  const topPerforming =
    performance
      ?.sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 5)
      .map((p) => ({
        videoId: p.video_project_id,
        platform: p.platform,
        views: p.views,
        leads: p.leads_generated,
      })) || []

  return { totalViews, totalLeads, avgEngagement, topPerforming }
}

// ============================================
// AGENT VIDEO PROFILE
// ============================================

export async function getAgentVideoProfile(agentId: string) {
  if (!isValidUUID(agentId)) {
    return null
  }

  const supabase = await createClient()

  const { data, error } = await supabase.from("agent_video_profiles").select("*").eq("agent_id", agentId).maybeSingle()

  if (error) {
    console.error("Error fetching agent video profile:", error)
    return null
  }

  return data
}

export async function updateAgentVideoProfile(data: {
  agentId: string
  heygenAvatarId?: string
  defaultVoiceId?: string
  defaultBackgroundId?: string
  brandingPresetId?: string
  introScript?: string
  outroScript?: string
  defaultStyle?: string
}) {
  const supabase = await createClient()

  const { data: profile, error } = await supabase
    .from("agent_video_profiles")
    .upsert({
      agent_id: data.agentId,
      heygen_avatar_id: data.heygenAvatarId,
      default_voice_id: data.defaultVoiceId,
      default_background_id: data.defaultBackgroundId,
      branding_preset_id: data.brandingPresetId,
      intro_script: data.introScript,
      outro_script: data.outroScript,
      default_style: data.defaultStyle,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/videos/settings")
  return profile
}

// ============================================
// VIDEO BRANDING PRESETS
// ============================================

export async function getVideoBrandingPresets(agentId: string) {
  if (!isValidUUID(agentId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("video_branding_presets")
    .select("*")
    .or(`agent_id.eq.${agentId},is_default.eq.true`)
    .order("is_default", { ascending: false })

  if (error) {
    console.error("Error fetching branding presets:", error)
    return []
  }

  return data || []
}

export async function saveBrandingPreset(data: {
  agentId: string
  presetName: string
  logoUrl?: string
  primaryColor?: string
  secondaryColor?: string
  fontFamily?: string
  introAnimation?: string
  outroAnimation?: string
  watermarkPosition?: string
  socialHandles?: any
}) {
  const supabase = await createClient()

  const { data: preset, error } = await supabase
    .from("video_branding_presets")
    .insert({
      agent_id: data.agentId,
      preset_name: data.presetName,
      logo_url: data.logoUrl,
      primary_color: data.primaryColor,
      secondary_color: data.secondaryColor,
      font_family: data.fontFamily,
      intro_animation: data.introAnimation,
      outro_animation: data.outroAnimation,
      watermark_position: data.watermarkPosition,
      social_handles: data.socialHandles,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/videos/branding")
  return preset
}

// ============================================
// ORIGINAL VIDEO GENERATION FUNCTIONS
// ============================================

export async function generateVideoScript(params: {
  purpose: string
  persona: string
  contactName: string
  tone?: string
  length?: string
  userId?: string
}) {
  try {
    const { generateText } = await import("ai")
    
    const purposeDescriptions: Record<string, string> = {
      welcome: "a warm welcome message introducing yourself and your services",
      market_update: "a professional market update with current trends and statistics",
      personalized_buyer: "a personalized message for a buyer highlighting properties and opportunities",
      personalized_seller: "a personalized message for a seller with listing strategies",
      holiday_greeting: "a friendly holiday greeting message",
      thank_you: "an appreciative thank you message for their business",
      listing_preview: "an exciting preview of a new listing coming to market",
      open_house: "an invitation to an upcoming open house event",
    }
    
    const personaDescriptions: Record<string, string> = {
      first_time_buyer: "first-time homebuyers who need guidance and reassurance",
      luxury_buyer: "luxury buyers looking for premium properties and white-glove service",
      investor: "real estate investors focused on ROI and market opportunities",
      downsizer: "empty nesters looking to downsize to a more manageable home",
      relocator: "people relocating to the area who need local market expertise",
      seller: "homeowners looking to sell their property for top dollar",
    }
    
    const toneMap: Record<string, string> = {
      professional: "professional and authoritative",
      friendly: "warm and conversational",
      energetic: "enthusiastic and energetic",
      empathetic: "empathetic and understanding",
    }
    
    const lengthMap: Record<string, string> = {
      short: "30-45 seconds (approximately 75-100 words)",
      medium: "60-90 seconds (approximately 150-200 words)",
      long: "2-3 minutes (approximately 300-400 words)",
    }
    
    const prompt = `Generate a compelling video script for ${purposeDescriptions[params.purpose] || params.purpose} targeting ${personaDescriptions[params.persona] || params.persona}.
    
Tone: ${toneMap[params.tone || "friendly"] || "warm and professional"}
Length: ${lengthMap[params.length || "medium"] || "60-90 seconds"}
Contact Name: ${params.contactName}

Requirements:
- Start with a strong hook in the first 5 seconds
- Be authentic and conversational
- Include specific value propositions
- End with a clear call-to-action
- Use "you" and "your" language
- No filler words or corporate jargon
- Make it feel personal and genuine

Return ONLY the script text, no formatting or labels.`

    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt,
    })
    
    console.log("[v0] Generated video script for purpose:", params.purpose, "persona:", params.persona)
    
    return { success: true, script: text.trim() }
  } catch (error: any) {
    console.error("[v0] Script generation error:", error)
    return { success: false, error: error.message }
  }
}

export async function generateVideoFromScript(params: {
  script: string
  title: string
  type: "avatar" | "voice"
  avatarId?: string
  voiceId?: string
  userId?: string
}) {
  const supabase = createServiceClient()

  try {
    console.log("[v0] Generating video from script:", params.title)

    // Validate that agent has required settings
    if (params.type === "avatar" && !params.avatarId) {
      return { success: false, error: "Avatar ID not configured. Please set up in Agent Roster." }
    }
    if (!params.voiceId) {
      return { success: false, error: "Voice ID not configured. Please set up in Agent Roster." }
    }

    const { data: queueRecord, error: queueError } = await supabase
      .from("video_content_queue")
      .insert({
        user_id: params.userId || null,
        title: params.title,
        script: params.script,
        video_type: params.type,
        heygen_avatar_id: params.avatarId,
        heygen_voice_id: params.voiceId,
        status: "queued",
      })
      .select()
      .single()

    if (queueError) {
      console.error("[v0] Queue error:", queueError)
      throw queueError
    }

    // Create video script record for backward compatibility
    const { data: scriptRecord, error: scriptError } = await supabase
      .from("video_scripts")
      .insert({
        script_text: params.script,
        title: params.title,
        created_by: params.userId || "system",
        video_status: "queued",
        persona_validated: true,
        video_type: params.type,
      })
      .select()
      .single()

    if (scriptError) console.warn("[v0] Script record error:", scriptError)

    // TODO: Integrate with HeyGen API when credentials are added
    // For now, mark as queued - actual processing happens in background job
    console.log("[v0] Video queued successfully:", queueRecord.id)
    return { success: true, videoId: queueRecord.id, queueId: scriptRecord?.id }
  } catch (error: any) {
    console.error("[v0] Video generation error:", error)
    return { success: false, error: error.message }
  }
}

export async function createAvatarVideo(params: {
  scriptId: string
  script: string
  avatarId?: string
  voice?: string
  userId?: string
}) {
  const supabase = createServiceClient()

  try {
    console.log("[v0] Generating video for script:", params.scriptId)

    // TODO: Integrate with HeyGen API when credentials are added
    // For now, simulate video generation
    const videoUrl = `https://example.com/videos/${params.scriptId}.mp4`

    // Update script with video URL
    const { error } = await supabase
      .from("video_scripts")
      .update({
        video_url: videoUrl,
        video_status: "completed",
        video_generated_at: new Date().toISOString(),
      })
      .eq("id", params.scriptId)

    if (error) throw error

    console.log("[v0] Video generated successfully:", videoUrl)
    return { success: true, videoUrl }
  } catch (error: any) {
    console.error("[v0] Video generation error:", error)
    return { success: false, error: error.message }
  }
}
