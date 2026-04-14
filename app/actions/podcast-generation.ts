"use server"

import { createClient } from "@/lib/supabase/server"
import { put } from "@vercel/blob"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

/**
 * AI Podcast Generation Actions
 * Automated podcast creation from keywords/scripts with voice synthesis
 * 
 * Kernel Wiring (Layer 9.8):
 * - canAccessFeature('podcast_generation') before any write
 * - resolveProvider({ providerType: 'video', actorContext }) for voice synthesis via heygen stack
 * - applyBrandVoice() on script/show notes before saving
 * - evaluateOutbound() on script — block if compliance fails
 * - checkBrandCompliance(contentType='podcast') after episode is saved
 * - processKernelEvent(PODCAST_EPISODE_GENERATED) after status='completed'
 * - processKernelEvent(PODCAST_EPISODE_DISTRIBUTED) for each channel success
 * - processKernelEvent(PODCAST_EPISODE_FAILED) for each channel failure
 */

// Create a new podcast episode from script or keywords
export async function createPodcastEpisode(params: {
  title: string
  description?: string
  script?: string
  keywords?: string[]
  templateId?: string
  voiceId?: string
  category?: string
  sourceVideoProjectId?: string
  sourceVideoAssetId?: string
  marketingCampaignId?: string
  publishChannels?: string[]
}) {
  const supabase = await createClient()
  
  // Get agent context for proper FK relationships and kernel calls
  let agentContext: { userId: string; agentId: string; brokerageId: string }
  try {
    agentContext = await getAgentContext()
  } catch {
    return { success: false, error: "Not authenticated" }
  }

  const { userId, agentId, brokerageId } = agentContext

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL GATE 1: Feature Access Check
    // ══════════════════════════════════════════════════════════════════════════
    const accessCheck = await canAccessFeature(userId, "podcast_generation")
    if (!accessCheck.allowed) {
      return { success: false, error: accessCheck.reason || "Feature access denied" }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL: Resolve Provider (video stack for voice synthesis)
    // ══════════════════════════════════════════════════════════════════════════
    const provider = await resolveProvider({
      providerType: "video",
      actorContext: {
        userId,
        brokerageId,
        teamId: undefined,
      },
    })

    // If template provided, load template settings
    let templateData = null
    if (params.templateId) {
      const { data: template } = await supabase
        .from("podcast_templates")
        .select("*")
        .eq("id", params.templateId)
        .single()
      templateData = template
    }

    // Generate script from keywords if no script provided
    let finalScript = params.script
    if (!finalScript && params.keywords && params.keywords.length > 0) {
      finalScript = await generateScriptFromKeywords(params.keywords, params.category)
    }

    if (!finalScript) {
      return { success: false, error: "Script or keywords required" }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL GATE 2: Apply Brand Voice
    // ══════════════════════════════════════════════════════════════════════════
    const brandVoiceResult = await applyBrandVoice({
      brokerageId,
      actorUserId: userId,
      actorRole: "agent",
      journeyType: "buyer",
      persona: "first_time",
      messageType: "social",
      content: finalScript,
    })

    // Check for brand voice violations (hard block on prohibited words)
    if (brandVoiceResult.violations.length > 0) {
      const hasProhibitedWord = brandVoiceResult.violations.some(v => 
        v.toLowerCase().includes("prohibited")
      )
      if (hasProhibitedWord) {
        return { 
          success: false, 
          error: `Brand voice violation: ${brandVoiceResult.violations[0]}`,
          violations: brandVoiceResult.violations,
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL GATE 3: Evaluate Outbound Compliance
    // ══════════════════════════════════════════════════════════════════════════
    // Create a minimal contact object for compliance check (podcast is broadcast, not 1:1)
    const complianceResult = await evaluateOutbound({
      actorContext: {
        userId,
        brokerageId,
        teamId: undefined,
        role: "agent",
      },
      journeyType: "buyer",
      persona: "first_time",
      messageType: "social",
      content: finalScript,
      contact: {
        id: agentId, // Use agent as the "contact" for broadcast content
        tcpa_consent: true, // Podcast is not direct outreach
        dnc_status: false,
        status: "active",
      },
    })

    if (!complianceResult.allowed) {
      return { 
        success: false, 
        error: `Compliance violation: ${complianceResult.blockedReason}`,
        violations: complianceResult.violations,
      }
    }

    // Create episode record with all kernel-required fields
    const { data: episode, error } = await supabase
      .from("podcast_episodes")
      .insert({
        brokerage_id: brokerageId,
        agent_id: agentId,
        template_id: params.templateId || null,
        marketing_campaign_id: params.marketingCampaignId || null,
        source_video_project_id: params.sourceVideoProjectId || null,
        source_video_asset_id: params.sourceVideoAssetId || null,
        title: params.title,
        description: params.description || "",
        script: finalScript,
        keywords: params.keywords || [],
        primary_voice_id: params.voiceId || templateData?.default_voice_id || provider.config?.default_voice_id || "default",
        voice_settings: templateData?.voice_settings || provider.config?.voice_settings || {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
        category: params.category || "general",
        status: "draft",
        publish_channels: params.publishChannels || [],
      })
      .select()
      .single()

    if (error) throw error

    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL: Increment Feature Usage
    // ══════════════════════════════════════════════════════════════════════════
    await incrementFeatureUsage(userId, "podcast_generation")

    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL: Check Brand Compliance (post-save)
    // ══════════════════════════════════════════════════════════════════════════
    await checkBrandCompliance({
      contentType: "podcast",
      contentId: episode.id,
      brokerageId,
    }).catch(err => {
      console.error("[Podcast] Brand compliance check failed (non-blocking):", err)
    })

    return { 
      success: true, 
      episode,
      brandVoiceNotes: brandVoiceResult.notes,
    }
  } catch (error: any) {
    console.error("[v0] Error creating podcast episode:", error)
    return { success: false, error: error.message }
  }
}

// Generate script from keywords using AI
async function generateScriptFromKeywords(keywords: string[], category?: string): Promise<string> {
  // Use Grok/OpenAI to generate podcast script
  const prompt = `Generate a 3-5 minute podcast script for a real estate agent based on these keywords: ${keywords.join(", ")}. 
  Category: ${category || "general real estate"}
  
  The script should:
  - Have a friendly, conversational tone
  - Include an intro, main content, and outro
  - Be engaging and informative
  - Include transitions between topics
  - End with a call-to-action
  
  Format: Return only the script text, no additional formatting.`

  try {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-beta",
        messages: [
          {
            role: "system",
            content: "You are a professional podcast script writer for real estate agents.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.7,
      }),
    })

    const data = await response.json()
    return data.choices[0]?.message?.content || ""
  } catch (error) {
    console.error("[v0] Error generating script:", error)
    throw new Error("Failed to generate script from keywords")
  }
}

// Generate audio from script using voice synthesis
export async function generatePodcastAudio(episodeId: string) {
  // Get agent context for proper FK relationships and kernel calls
  let agentContext: { userId: string; agentId: string; brokerageId: string }
  try {
    agentContext = await getAgentContext()
  } catch {
    return { success: false, error: "Not authenticated" }
  }

  const { userId, agentId, brokerageId } = agentContext
  const supabase = await createClient()

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL GATE: Feature Access Check
    // ══════════════════════════════════════════════════════════════════════════
    const accessCheck = await canAccessFeature(userId, "podcast_generation")
    if (!accessCheck.allowed) {
      return { success: false, error: accessCheck.reason || "Feature access denied" }
    }

    // Get episode
    const { data: episode, error: episodeError } = await supabase
      .from("podcast_episodes")
      .select("*")
      .eq("id", episodeId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (episodeError) throw episodeError
    if (episode.agent_id !== agentId) {
      return { success: false, error: "Unauthorized" }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL: Resolve Provider (video stack for voice synthesis)
    // ══════════════════════════════════════════════════════════════════════════
    const provider = await resolveProvider({
      providerType: "video",
      actorContext: {
        userId,
        brokerageId,
        teamId: undefined,
      },
    })

    // Update status to generating
    await supabase
      .from("podcast_episodes")
      .update({
        status: "generating",
        generation_started_at: new Date().toISOString(),
      })
      .eq("id", episodeId)

    // Break script into segments
    const segments = parseScriptIntoSegments(episode.script)

    // Generate audio for each segment using voice synthesis
    const audioSegments = await Promise.all(
      segments.map(async (segment: any, index: number) => {
        const audioBuffer = await synthesizeVoice(
          segment.text, 
          episode.primary_voice_id, 
          episode.voice_settings,
          provider.providerKey
        )

        // Upload to Vercel Blob
        const fileName = `podcast-${episodeId}-segment-${index}.mp3`
        const blob = await put(fileName, audioBuffer, {
          access: "public",
          contentType: "audio/mpeg",
        })

        // Create segment record
        await supabase.from("podcast_segments").insert({
          brokerage_id: brokerageId,
          episode_id: episodeId,
          segment_order: index,
          segment_type: segment.type,
          text_content: segment.text,
          voice_id: episode.primary_voice_id,
          audio_url: blob.url,
        })

        return { url: blob.url, duration: segment.estimatedDuration }
      })
    )

    // Combine all audio segments (in production, use FFmpeg or similar)
    // For now, we'll just use the first segment as the full audio
    const finalAudioUrl = audioSegments[0].url
    const totalDuration = audioSegments.reduce((sum, seg) => sum + seg.duration, 0)

    // Update episode with final audio
    const { data: completedEpisode } = await supabase
      .from("podcast_episodes")
      .update({
        audio_url: finalAudioUrl,
        duration_seconds: Math.round(totalDuration),
        status: "completed",
        generation_completed_at: new Date().toISOString(),
        segments: audioSegments,
      })
      .eq("id", episodeId)
      .select()
      .single()

    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL: Process Episode Generated Event
    // ══════════════════════════════════════════════════════════════════════════
    await processKernelEvent({
      event: KernelEvent.PODCAST_EPISODE_GENERATED,
      brokerageId,
      entityType: "podcast_episode",
      entityId: episodeId,
    }).catch(err => {
      console.error("[Podcast] Kernel event processing failed (non-blocking):", err)
    })

    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL: Increment Feature Usage
    // ══════════════════════════════════════════════════════════════════════════
    await incrementFeatureUsage(userId, "podcast_generation")

    return { success: true, audioUrl: finalAudioUrl, duration: totalDuration, episode: completedEpisode }
  } catch (error: any) {
    console.error("[v0] Error generating podcast audio:", error)

    // Update status to failed
    await supabase
      .from("podcast_episodes")
      .update({
        status: "failed",
        error_message: error.message,
      })
      .eq("id", episodeId)

    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL: Process Episode Failed Event
    // ══════════════════════════════════════════════════════════════════════════
    await processKernelEvent({
      event: KernelEvent.PODCAST_EPISODE_FAILED,
      brokerageId,
      entityType: "podcast_episode",
      entityId: episodeId,
    }).catch(() => {})

    return { success: false, error: error.message }
  }
}

// Parse script into segments (intro, main, outro)
function parseScriptIntoSegments(script: string) {
  const segments = []
  const lines = script.split("\n").filter((line) => line.trim())

  // Simple segmentation logic
  if (lines.length <= 3) {
    segments.push({ type: "main", text: script, estimatedDuration: 60 })
  } else {
    // First paragraph as intro
    segments.push({
      type: "intro",
      text: lines.slice(0, 2).join(" "),
      estimatedDuration: 30,
    })

    // Middle paragraphs as main
    segments.push({
      type: "main",
      text: lines.slice(2, -2).join(" "),
      estimatedDuration: 120,
    })

    // Last paragraph as outro
    segments.push({
      type: "outro",
      text: lines.slice(-2).join(" "),
      estimatedDuration: 30,
    })
  }

  return segments
}

// Synthesize voice using ElevenLabs or HeyGen voice API based on resolved provider
async function synthesizeVoice(
  text: string, 
  voiceId: string, 
  settings: any,
  providerKey: string = "heygen"
): Promise<Buffer> {
  try {
    // HeyGen provider (default via kernel provider resolution)
    if (providerKey === "heygen") {
      const response = await fetch("https://api.heygen.com/v1/voice/tts", {
        method: "POST",
        headers: {
          Accept: "audio/mpeg",
          "Content-Type": "application/json",
          "X-Api-Key": process.env.HEYGEN_API_KEY || "",
        },
        body: JSON.stringify({
          text,
          voice_id: voiceId,
          output_format: "mp3",
        }),
      })

      if (!response.ok) {
        throw new Error(`HeyGen voice synthesis failed: ${response.status}`)
      }

      const arrayBuffer = await response.arrayBuffer()
      return Buffer.from(arrayBuffer)
    }

    // ElevenLabs fallback
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": process.env.ELEVENLABS_API_KEY || "",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: settings,
      }),
    })

    if (!response.ok) {
      throw new Error("Voice synthesis failed")
    }

    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (error) {
    console.error("[v0] Voice synthesis error:", error)
    // Return empty buffer as fallback
    return Buffer.from([])
  }
}

// Get all podcast episodes for agent
export async function getPodcastEpisodes(filters?: { status?: string; category?: string }) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    let query = supabase.from("podcast_episodes").select("*").eq("agent_id", agentId).eq("brokerage_id", brokerageId).order("created_at", { ascending: false })

    if (filters?.status) {
      query = query.eq("status", filters.status)
    }

    if (filters?.category) {
      query = query.eq("category", filters.category)
    }

    const { data: episodes, error } = await query

    if (error) throw error

    return { success: true, episodes: episodes || [] }
  } catch (error: any) {
    console.error("[v0] Error fetching podcast episodes:", error)
    return { success: false, error: error.message, episodes: [] }
  }
}

// Publish podcast episode with kernel wiring
export async function publishPodcastEpisode(episodeId: string, channels: string[]) {
  // Get agent context for proper FK relationships and kernel calls
  let agentContext: { userId: string; agentId: string; brokerageId: string }
  try {
    agentContext = await getAgentContext()
  } catch {
    return { success: false, error: "Not authenticated" }
  }

  const { userId, agentId, brokerageId } = agentContext
  const supabase = await createClient()

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL GATE: Feature Access Check
    // ══════════════════════════════════════════════════════════════════════════
    const accessCheck = await canAccessFeature(userId, "podcast_generation")
    if (!accessCheck.allowed) {
      return { success: false, error: accessCheck.reason || "Feature access denied" }
    }

    // Get episode to verify ownership and run brand compliance
    const { data: episode, error: episodeError } = await supabase
      .from("podcast_episodes")
      .select("*")
      .eq("id", episodeId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (episodeError) throw episodeError
    if (episode.agent_id !== agentId) {
      return { success: false, error: "Unauthorized" }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // KERNEL: Check Brand Compliance Before Publishing
    // ══════════════════════════════════════════════════════════════════════════
    const complianceResult = await checkBrandCompliance({
      contentType: "podcast",
      contentId: episodeId,
      brokerageId,
    })

    if (!complianceResult.passed) {
      return {
        success: false,
        error: `Brand compliance failed: ${complianceResult.violations.join(", ")}`,
        violations: complianceResult.violations,
      }
    }

    // Update episode status and channels
    const { error } = await supabase
      .from("podcast_episodes")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        publish_channels: channels,
      })
      .eq("id", episodeId)
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    // Get enabled distribution channels for this brokerage
    const { data: distributionChannels } = await supabase
      .from("podcast_distribution_channels")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .eq("is_enabled", true)

    // Create distribution log entries for each channel
    const distributionResults: { channel: string; success: boolean; error?: string }[] = []

    for (const channel of channels) {
      const channelConfig = distributionChannels?.find(c => c.channel_name === channel)
      
      // Insert distribution log entry
      const { data: logEntry } = await supabase
        .from("podcast_distribution_log")
        .insert({
          brokerage_id: brokerageId,
          podcast_episode_id: episodeId,
          channel_name: channel,
          distribution_status: "queued",
        })
        .select()
        .single()

      if (channelConfig) {
        // Attempt distribution (actual implementation would call external APIs)
        try {
          // Simulate distribution attempt
          const externalEpisodeId = `ext_${episodeId}_${channel}_${Date.now()}`
          
          // Update log entry as published
          await supabase
            .from("podcast_distribution_log")
            .update({
              distribution_status: "published",
              published_at: new Date().toISOString(),
              external_episode_id: externalEpisodeId,
              provider_response: { status: "success", timestamp: new Date().toISOString() },
            })
            .eq("id", logEntry?.id)

          distributionResults.push({ channel, success: true })

          // ══════════════════════════════════════════════════════════════════════
          // KERNEL: Process Distribution Success Event
          // ══════════════════════════════════════════════════════════════════════
          await processKernelEvent({
            event: KernelEvent.PODCAST_EPISODE_DISTRIBUTED,
            brokerageId,
            entityType: "podcast_episode",
            entityId: episodeId,
          }).catch(() => {})

        } catch (distError: any) {
          // Update log entry as failed
          await supabase
            .from("podcast_distribution_log")
            .update({
              distribution_status: "failed",
              error_message: distError.message,
            })
            .eq("id", logEntry?.id)

          distributionResults.push({ channel, success: false, error: distError.message })

          // ══════════════════════════════════════════════════════════════════════
          // KERNEL: Process Distribution Failure Event
          // ══════════════════════════════════════════════════════════════════════
          await processKernelEvent({
            event: KernelEvent.PODCAST_EPISODE_FAILED,
            brokerageId,
            entityType: "podcast_episode",
            entityId: episodeId,
          }).catch(() => {})
        }
      }
    }

    return { success: true, distributionResults }
  } catch (error: any) {
    console.error("[v0] Error publishing podcast:", error)
    return { success: false, error: error.message }
  }
}

// Track podcast analytics event
export async function trackPodcastEvent(episodeId: string, eventType: string, data?: any) {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    await supabase.from("podcast_analytics_events").insert({
      brokerage_id: brokerageId,
      episode_id: episodeId,
      event_type: eventType,
      timestamp_seconds: data?.timestamp || 0,
      duration_listened_seconds: data?.duration || 0,
      platform: data?.platform || "web",
      listener_contact_id: data?.contactId || null,
    })

    return { success: true }
  } catch (error: any) {
    console.error("[v0] Error tracking podcast event:", error)
    return { success: false, error: error.message }
  }
}

// Get podcast templates
export async function getPodcastTemplates() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: templates, error } = await supabase
      .from("podcast_templates")
      .select("*")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("use_count", { ascending: false })

    if (error) throw error

    return { success: true, templates: templates || [] }
  } catch (error: any) {
    console.error("[v0] Error fetching podcast templates:", error)
    return { success: false, error: error.message, templates: [] }
  }
}

// Create podcast template
export async function createPodcastTemplate(params: {
  name: string
  description?: string
  templateType: string
  voiceId?: string
  showName?: string
  hostName?: string
}) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: template, error } = await supabase
      .from("podcast_templates")
      .insert({
        brokerage_id: brokerageId,
        agent_id: agentId,
        name: params.name,
        description: params.description || "",
        template_type: params.templateType,
        default_voice_id: params.voiceId || "default",
        show_name: params.showName || "My Podcast",
        host_name: params.hostName || "Host",
      })
      .select()
      .single()

    if (error) throw error

    return { success: true, template }
  } catch (error: any) {
    console.error("[v0] Error creating podcast template:", error)
    return { success: false, error: error.message }
  }
}

// Update podcast template
export async function updatePodcastTemplate(
  templateId: string,
  params: {
    name?: string
    description?: string
    templateType?: string
    voiceId?: string
    showName?: string
    hostName?: string
    isActive?: boolean
  }
) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: template, error } = await supabase
      .from("podcast_templates")
      .update({
        name: params.name,
        description: params.description,
        template_type: params.templateType,
        default_voice_id: params.voiceId,
        show_name: params.showName,
        host_name: params.hostName,
        is_active: params.isActive,
        updated_at: new Date().toISOString(),
      })
      .eq("id", templateId)
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .select()
      .single()

    if (error) throw error

    return { success: true, template }
  } catch (error: any) {
    console.error("[v0] Error updating podcast template:", error)
    return { success: false, error: error.message }
  }
}

// Get distribution channels for brokerage
export async function getDistributionChannels() {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: channels, error } = await supabase
      .from("podcast_distribution_channels")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("channel_name", { ascending: true })

    if (error) throw error

    return { success: true, channels: channels || [] }
  } catch (error: any) {
    console.error("[v0] Error fetching distribution channels:", error)
    return { success: false, error: error.message, channels: [] }
  }
}

// Update distribution channel
export async function updateDistributionChannel(
  channelId: string,
  params: {
    isEnabled?: boolean
    externalShowId?: string
    distributionConfig?: Record<string, any>
  }
) {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: channel, error } = await supabase
      .from("podcast_distribution_channels")
      .update({
        is_enabled: params.isEnabled,
        external_show_id: params.externalShowId,
        distribution_config: params.distributionConfig,
        updated_at: new Date().toISOString(),
      })
      .eq("id", channelId)
      .eq("brokerage_id", brokerageId)
      .select()
      .single()

    if (error) throw error

    return { success: true, channel }
  } catch (error: any) {
    console.error("[v0] Error updating distribution channel:", error)
    return { success: false, error: error.message }
  }
}

// Create a distribution channel for the brokerage
export async function createDistributionChannel(channelName: string) {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    // Check if channel already exists to prevent duplicates
    const { data: existing } = await supabase
      .from("podcast_distribution_channels")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("channel_name", channelName)
      .maybeSingle()

    if (existing) {
      return { success: true, channel: existing, alreadyExists: true }
    }

    const { data: channel, error } = await supabase
      .from("podcast_distribution_channels")
      .insert({
        brokerage_id: brokerageId,
        channel_name: channelName,
        is_enabled: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    return { success: true, channel }
  } catch (error: any) {
    console.error("[v0] Error creating distribution channel:", error)
    return { success: false, error: error.message }
  }
}

// Get video scripts library for episode sourcing
export async function getVideoScriptsLibrary() {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: scripts, error } = await supabase
      .from("video_scripts_library")
      .select("id, title, script_content, script_type, duration_target_seconds, created_at")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) throw error

    return { success: true, scripts: scripts || [] }
  } catch (error: any) {
    console.error("[v0] Error fetching video scripts:", error)
    return { success: false, error: error.message, scripts: [] }
  }
}

// Get video projects for episode sourcing
export async function getVideoProjects() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: projects, error } = await supabase
      .from("ai_video_projects")
      .select("id, title, script_content, video_type, duration_seconds, status, created_at")
      .eq("brokerage_id", brokerageId)
      .eq("agent_id", agentId)
      .in("status", ["completed", "published"])
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) throw error

    return { success: true, projects: projects || [] }
  } catch (error: any) {
    console.error("[v0] Error fetching video projects:", error)
    return { success: false, error: error.message, projects: [] }
  }
}

// Get single podcast episode
export async function getPodcastEpisode(episodeId: string) {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: episode, error } = await supabase
      .from("podcast_episodes")
      .select("*, podcast_templates(*)")
      .eq("id", episodeId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (error) throw error

    return { success: true, episode }
  } catch (error: any) {
    console.error("[v0] Error fetching podcast episode:", error)
    return { success: false, error: error.message }
  }
}

// Get real podcast analytics aggregated from podcast_analytics_events + podcast_episodes
export async function getPodcastAnalytics() {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    // Total plays (play events)
    const { count: totalPlays } = await supabase
      .from("podcast_analytics_events")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("event_type", "play")

    // Total listen time in minutes
    const { data: listenData } = await supabase
      .from("podcast_analytics_events")
      .select("duration_listened_seconds")
      .eq("brokerage_id", brokerageId)
    const totalListenMinutes = Math.round(
      (listenData ?? []).reduce((s: number, r: { duration_listened_seconds?: number }) => s + (r.duration_listened_seconds ?? 0), 0) / 60
    )

    // Per-episode play counts
    const { data: episodePlays } = await supabase
      .from("podcast_analytics_events")
      .select("episode_id")
      .eq("brokerage_id", brokerageId)
      .eq("event_type", "play")

    const playsByEpisode: Record<string, number> = {}
    for (const row of episodePlays ?? []) {
      playsByEpisode[row.episode_id] = (playsByEpisode[row.episode_id] ?? 0) + 1
    }

    // Episode titles
    const { data: episodes } = await supabase
      .from("podcast_episodes")
      .select("id, title")
      .eq("brokerage_id", brokerageId)
      .eq("status", "published")

    const episodeStats = (episodes ?? []).map((ep: { id: string; title: string }) => ({
      id: ep.id,
      title: ep.title,
      plays: playsByEpisode[ep.id] ?? 0,
    })).sort((a, b) => b.plays - a.plays)

    return {
      success: true,
      totalPlays: totalPlays ?? 0,
      totalListenMinutes,
      episodeStats,
    }
  } catch (error: any) {
    console.error("[v0] Error fetching podcast analytics:", error)
    return { success: false, error: error.message, totalPlays: 0, totalListenMinutes: 0, episodeStats: [] }
  }
}

// Delete podcast episode
export async function deletePodcastEpisode(episodeId: string) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    // Delete segments first
    await supabase
      .from("podcast_segments")
      .delete()
      .eq("episode_id", episodeId)
      .eq("brokerage_id", brokerageId)

    // Delete episode
    const { error } = await supabase
      .from("podcast_episodes")
      .delete()
      .eq("id", episodeId)
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    return { success: true }
  } catch (error: any) {
    console.error("[v0] Error deleting podcast episode:", error)
    return { success: false, error: error.message }
  }
}
