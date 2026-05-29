"use server"

import { createClient } from "@/lib/supabase/server"
import { put } from "@vercel/blob"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { gatewayChat } from "@/lib/ai/gateway-chat"
import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"
import { syndicateEpisode, type SyndicateEpisodeResult } from "@/lib/podcast/transistor-client"
import { generateTextRouted } from "@/lib/ai/models"
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
    const ctx = await getAgentContext()
    if (!ctx.agentId) return { success: false, error: "Missing agent context" }
    if (!ctx.brokerageId) return { success: false, error: "Missing agent context" }
    agentContext = {
      userId: ctx.userId,
      agentId: ctx.agentId,
      brokerageId: ctx.brokerageId,
    }
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

    // Resolve agent's ElevenLabs cloned voice (canonical for podcast audio).
    // The voice clone lives in agent_voice_profiles keyed by agents.id (agentId) —
    // it is a customer-facing brand asset. (users has no elevenlabs_voice_id.)
    const { data: voiceProfile } = await supabase
      .from("agent_voice_profiles")
      .select("elevenlabs_voice_id")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle()
    const agentVoiceId = voiceProfile?.elevenlabs_voice_id ?? null

    // Generate script from keywords if no script provided
    let finalScript = params.script
    if (!finalScript && params.keywords && params.keywords.length > 0) {
      finalScript = await generateScriptFromKeywords(params.keywords, params.category, userId)
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
        first_name: "",
        last_name: "",
        contact_type: "buyer" as const,
        tcpa_consent: true, // Podcast is not direct outreach
        isa_reengage_allowed: true,
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
        // podcast_episodes.agent_id FKs to users (content/business action), not agents.
        agent_id: userId,
        template_id: params.templateId || null,
        marketing_campaign_id: params.marketingCampaignId || null,
        source_video_project_id: params.sourceVideoProjectId || null,
        source_video_asset_id: params.sourceVideoAssetId || null,
        title: params.title,
        description: params.description || "",
        script: finalScript,
        keywords: params.keywords || [],
        primary_voice_id: params.voiceId || agentVoiceId || templateData?.default_voice_id || provider.config?.default_voice_id || "default",
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
async function generateScriptFromKeywords(keywords: string[], category?: string, userId?: string): Promise<string> {
  if (userId) {
    const access = await canAccessFeature(userId, "podcast_generation")
    if (!access.allowed) throw new Error(access.reason ?? "Podcast generation not available")
  }
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
    const response = await gatewayChat({
      model: "xai/grok-beta",
      temperature: 0.7,
      maxTokens: 2048,
      messages: [
        { role: "system", content: "You are a professional podcast script writer for real estate agents." },
        { role: "user", content: prompt },
      ],
    })

    if (!response.ok) {
      throw new Error(`Script API request failed: ${response.error}`)
    }
    if (!response.content) {
      throw new Error("Invalid API response: missing content")
    }
    return response.content
  } catch (error) {
    console.error("[v0] Error generating script:", error)
    throw new Error("Failed to generate script from keywords")
  }
}

// Public wrapper: generate a draft script from a topic / keywords for the wizard.
// Returns the draft script PLUS a brand-voice compliance summary so the UI can
// surface violations before the user proceeds.
export async function generatePodcastScriptDraft(params: {
  topic?: string
  keywords?: string[]
  category?: string
}): Promise<{
  success: boolean
  script?: string
  brandVoice?: { passed: boolean; violations: string[]; suggestions: string[] }
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.userId || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

    const seed: string[] = []
    if (params.topic?.trim()) seed.push(params.topic.trim())
    if (params.keywords?.length) seed.push(...params.keywords)
    if (seed.length === 0) return { success: false, error: "Provide a topic or at least one keyword." }

    const script = await generateScriptFromKeywords(seed, params.category, ctx.userId)

    // Run brand-voice check so the UI can show pass/fail before the user advances.
    const bv = await applyBrandVoice({
      brokerageId:   ctx.brokerageId,
      actorUserId:   ctx.userId,
      actorRole:     "agent",
      journeyType:   "buyer",
      persona:       "first_time",
      messageType:   "social",
      content:       script,
    })
    return {
      success: true,
      script,
      brandVoice: {
        passed:      bv.violations.length === 0,
        violations:  bv.violations,
        suggestions: bv.notes ?? [],
      },
    }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to generate script" }
  }
}

// Generate audio from script using voice synthesis
export async function generatePodcastAudio(episodeId: string) {
  // Get agent context for proper FK relationships and kernel calls
  let agentContext: { userId: string; agentId: string; brokerageId: string }
  try {
    const ctx = await getAgentContext()
    if (!ctx.agentId) return { success: false, error: "Missing agent context" }
    if (!ctx.brokerageId) return { success: false, error: "Missing agent context" }
    agentContext = {
      userId: ctx.userId,
      agentId: ctx.agentId,
      brokerageId: ctx.brokerageId,
    }
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
    if (episode.agent_id !== userId) {
      return { success: false, error: "Unauthorized" }
    }

    // Require a real ElevenLabs voice id before kicking off generation.
    // "default" is a sentinel value indicating no voice clone was configured —
    // surfacing a clear error here prevents silent empty-buffer failures downstream.
    if (!episode.primary_voice_id || episode.primary_voice_id === "default") {
      return {
        success: false,
        error: "Voice clone not configured. Set up your ElevenLabs voice clone at /dashboard/videos/voice before generating podcast audio.",
      }
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
    }).catch((err) => console.error("[podcast] kernel event PODCAST_EPISODE_FAILED failed:", err))

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

// Synthesize voice using ElevenLabs or HeyGen voice API based on resolved provider.
// Throws on failure so callers surface a real error to the user — never returns an empty buffer.
async function synthesizeVoice(
  text: string,
  voiceId: string,
  settings: any,
  providerKey: string = "heygen"
): Promise<Buffer> {
  if (!voiceId) {
    throw new Error(
      "Voice not configured. Set up your voice clone in Settings → Voice & Avatar Setup before generating audio."
    )
  }

  if (providerKey === "heygen") {
    if (!process.env.HEYGEN_API_KEY) {
      throw new Error("HEYGEN_API_KEY is not configured. Contact your administrator to enable HeyGen voice synthesis.")
    }
    const response = await callConnector<Buffer>({
      connector: "heygen",
      baseUrl: "https://api.heygen.com",
      path: "/v1/voice/tts",
      method: "POST",
      auth: { style: "header", name: "X-Api-Key", value: process.env.HEYGEN_API_KEY },
      headers: { Accept: "audio/mpeg" },
      responseType: "arraybuffer",
      body: { text, voice_id: voiceId, output_format: "mp3" },
    })

    if (!response.ok || !response.data) {
      throw new Error(`HeyGen voice synthesis failed: ${response.error ?? `HTTP ${response.status}`}`)
    }

    return response.data
  }

  // ElevenLabs
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is not configured. Contact your administrator to enable ElevenLabs voice synthesis.")
  }
  const response = await callConnector<Buffer>({
    connector: "elevenlabs",
    baseUrl: "https://api.elevenlabs.io",
    path: `/v1/text-to-speech/${voiceId}`,
    method: "POST",
    auth: { style: "header", name: "xi-api-key", value: process.env.ELEVENLABS_API_KEY },
    headers: { Accept: "audio/mpeg" },
    responseType: "arraybuffer",
    body: {
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: settings,
    },
  })

  if (!response.ok || !response.data) {
    throw new Error(`ElevenLabs voice synthesis failed: ${response.error ?? `HTTP ${response.status}`}`)
  }

  return response.data
}

// Get all podcast episodes for agent
export async function getPodcastEpisodes(filters?: { status?: string; category?: string }) {
  const { userId, brokerageId } = await getAgentContext()
  if (!userId || !brokerageId) {
    return { success: false, error: "Missing agent context", episodes: [] }
  }
  const supabase = await createClient()

  try {
    let query = supabase.from("podcast_episodes").select("*").eq("agent_id", userId).eq("brokerage_id", brokerageId).order("created_at", { ascending: false })

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

// Publish podcast episode with kernel wiring.
// Optional `scheduledAt` (ISO string) — if in the future, the episode is set to
// status="scheduled" with `scheduled_at` populated; a separate cron job actually
// fires the distribution at the scheduled time.
async function loadPodcastTeamId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  try {
    const { data } = await supabase.from("users").select("team_id").eq("id", userId).maybeSingle()
    return (data?.team_id as string | null) ?? null
  } catch {
    return null
  }
}

export async function publishPodcastEpisode(
  episodeId: string,
  channels: string[],
  scheduledAt?: string | null,
) {
  // Get agent context for proper FK relationships and kernel calls
  let agentContext: { userId: string; agentId: string; brokerageId: string }
  try {
    const ctx = await getAgentContext()
    if (!ctx.agentId) return { success: false, error: "Missing agent context" }
    if (!ctx.brokerageId) return { success: false, error: "Missing agent context" }
    agentContext = {
      userId: ctx.userId,
      agentId: ctx.agentId,
      brokerageId: ctx.brokerageId,
    }
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
    if (episode.agent_id !== userId) {
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

    // Determine if this is a scheduled publish (future) vs immediate.
    const scheduledTimestamp = scheduledAt ? new Date(scheduledAt) : null
    const isScheduled = scheduledTimestamp != null && scheduledTimestamp.getTime() > Date.now()

    // Update episode status and channels
    const { error } = await supabase
      .from("podcast_episodes")
      .update({
        status: isScheduled ? "scheduled" : "published",
        published_at: isScheduled ? null : new Date().toISOString(),
        scheduled_at: isScheduled ? scheduledTimestamp!.toISOString() : null,
        publish_channels: channels,
      })
      .eq("id", episodeId)
      .eq("agent_id", userId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    // For scheduled publishes, defer kernel distribution event until the cron picks it up.
    if (isScheduled) {
      return {
        success: true,
        scheduled: true,
        scheduledAt: scheduledTimestamp!.toISOString(),
      }
    }

    // Get enabled distribution channels for this brokerage
    const { data: distributionChannels } = await supabase
      .from("podcast_distribution_channels")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .eq("is_enabled", true)

    void distributionChannels // informational; actual channel reach is handled by the host's RSS

    // Resolve the per-tier podcast distributor through the unified ownership cascade
    // (agent → team → brokerage → platform) and syndicate ONCE. A host like Transistor publishes
    // the episode to its managed RSS, which fans out to Spotify / Apple / etc — so a single real
    // publish covers every requested channel (no per-channel API + no simulated success).
    const teamId = await loadPodcastTeamId(supabase, userId)
    const distributor = await resolveScopedConnection("transistor", {
      agentUserId: userId,
      teamId,
      brokerageId,
    }).catch(() => null)

    let syndication: SyndicateEpisodeResult
    if (!distributor?.apiKey) {
      syndication = { ok: false, error: "No podcast distributor connected. Connect one in the Connection Center." }
    } else {
      syndication = await syndicateEpisode({
        apiKey: distributor.apiKey,
        showId: ((distributor.config as Record<string, unknown> | null)?.show_id as string) ?? distributor.accountId ?? "",
        title: episode.title ?? "Episode",
        summary: episode.description ?? episode.summary ?? "",
        audioUrl: episode.audio_url ?? "",
      })
    }

    // One log row per requested channel, all reflecting the single real syndication result.
    const distributionResults: { channel: string; success: boolean; error?: string }[] = []
    for (const channel of channels) {
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

      if (syndication.ok) {
        if (logEntry) {
          await supabase
            .from("podcast_distribution_log")
            .update({
              distribution_status: "published",
              published_at: new Date().toISOString(),
              external_episode_id: syndication.episodeId,
              provider_response: { provider: "transistor", share_url: syndication.shareUrl ?? null },
            })
            .eq("id", logEntry.id)
        }
        distributionResults.push({ channel, success: true })
      } else {
        if (logEntry) {
          await supabase
            .from("podcast_distribution_log")
            .update({ distribution_status: "failed", error_message: syndication.error })
            .eq("id", logEntry.id)
        }
        distributionResults.push({ channel, success: false, error: syndication.error })
      }
    }

    await processKernelEvent({
      event: syndication.ok ? KernelEvent.PODCAST_EPISODE_DISTRIBUTED : KernelEvent.PODCAST_EPISODE_FAILED,
      brokerageId,
      entityType: "podcast_episode",
      entityId: episodeId,
    }).catch((err) => console.error("[podcast] kernel distribution event failed:", err))

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
  const { userId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: templates, error } = await supabase
      .from("podcast_templates")
      .select("*")
      .eq("agent_id", userId)
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
  const { userId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: template, error } = await supabase
      .from("podcast_templates")
      .insert({
        brokerage_id: brokerageId,
        agent_id: userId,
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
  const { userId, brokerageId } = await getAgentContext()
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
      .eq("agent_id", userId)
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
  const { userId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: projects, error } = await supabase
      .from("ai_video_projects")
      .select("id, title, script_content, video_type, duration_seconds, status, created_at")
      .eq("brokerage_id", brokerageId)
      .eq("agent_id", userId)
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
  const { userId, brokerageId } = await getAgentContext()
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
      .eq("agent_id", userId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    return { success: true }
  } catch (error: any) {
    console.error("[v0] Error deleting podcast episode:", error)
    return { success: false, error: error.message }
  }
}

export async function generatePodcastEpisodeDescription(params: {
  title: string
  keywords?: string[]
  targetAudience?: string
}): Promise<{ success: boolean; description?: string; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Unauthorized" }

    const { text } = await generateTextRouted({
      feature: "podcast_description_generation",
      maxTokens: 200,
      temperature: 0.7,
      prompt: `Write a compelling 2-3 sentence podcast episode description for a real estate professional.
Title: "${params.title}"
${params.keywords?.length ? `Keywords: ${params.keywords.join(", ")}` : ""}
Audience: ${params.targetAudience ?? "real estate agents and clients"}
Focus on what the listener gains — lead with the value, not the host.`,
    })

    return { success: true, description: text.trim() }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// J5A — My Show settings (per-agent show branding)
// ─────────────────────────────────────────────────────────────────────────────

export async function getPodcastShowSettings() {
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId || !brokerageId) return { success: false, error: "Missing agent context", settings: null }
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("podcast_show_settings")
    .select("*")
    .eq("agent_id", agentId)
    .maybeSingle()
  if (error) return { success: false, error: error.message, settings: null }
  return { success: true, settings: data }
}

export async function savePodcastShowSettings(params: {
  showName?: string
  hostName?: string
  description?: string
  category?: string
  language?: string
  coverArtUrl?: string
  websiteUrl?: string
}) {
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId || !brokerageId) return { success: false, error: "Missing agent context" }
  const supabase = await createClient()
  const { error } = await supabase
    .from("podcast_show_settings")
    .upsert(
      {
        agent_id: agentId,
        brokerage_id: brokerageId,
        show_name: params.showName ?? null,
        host_name: params.hostName ?? null,
        description: params.description ?? null,
        category: params.category ?? "Real Estate",
        language: params.language ?? "en",
        cover_art_url: params.coverArtUrl ?? null,
        website_url: params.websiteUrl ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" }
    )
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function uploadPodcastCoverArt(formData: FormData) {
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId || !brokerageId) return { success: false, error: "Missing agent context" }
  const file = formData.get("file") as File | null
  if (!file) return { success: false, error: "No file provided" }
  if (!file.type.startsWith("image/")) return { success: false, error: "File must be an image" }
  try {
    const ext = file.name.split(".").pop() ?? "png"
    const blob = await put(`podcast-cover-art/${agentId}-${Date.now()}.${ext}`, file, {
      access: "public",
      contentType: file.type,
    })
    return { success: true, url: blob.url }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// J5A — Distribution channel test connection
// ─────────────────────────────────────────────────────────────────────────────

export async function testDistributionChannelConnection(channelId: string): Promise<{
  success: boolean
  ok?: boolean
  message?: string
  error?: string
}> {
  const { brokerageId } = await getAgentContext()
  if (!brokerageId) return { success: false, error: "Missing agent context" }
  const supabase = await createClient()
  const { data: ch, error } = await supabase
    .from("podcast_distribution_channels")
    .select("id, channel_name, external_show_id, distribution_config, is_enabled")
    .eq("id", channelId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (error || !ch) return { success: false, error: error?.message ?? "Channel not found" }
  if (!ch.is_enabled) return { success: true, ok: false, message: "Channel disabled" }
  if (!ch.external_show_id) return { success: true, ok: false, message: "External show ID missing" }

  // Lightweight reachability check per platform — read-only, never writes.
  const name = (ch.channel_name ?? "").toLowerCase()
  const showId = ch.external_show_id
  try {
    let url: string | null = null
    if (name === "spotify") url = `https://open.spotify.com/show/${showId}`
    else if (name === "apple" || name === "apple_podcasts") url = `https://podcasts.apple.com/podcast/id${showId}`
    else if (name === "youtube") url = `https://www.youtube.com/channel/${showId}`
    else if (name === "rss") url = showId.startsWith("http") ? showId : null

    if (!url) {
      return { success: true, ok: false, message: `No reachability check available for ${name}` }
    }
    const res = await fetch(url, { method: "HEAD", redirect: "follow" })
    return {
      success: true,
      ok: res.ok,
      message: res.ok ? `Reachable (${res.status})` : `Unreachable (${res.status})`,
    }
  } catch (err: any) {
    return { success: true, ok: false, message: err?.message ?? "Connection failed" }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// J5A — Repurpose: snippet suggestions, blog post, newsletter teaser
// ─────────────────────────────────────────────────────────────────────────────

export async function generatePodcastSnippetSuggestions(params: { episodeId: string }) {
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId || !brokerageId) return { success: false, error: "Missing agent context", snippets: [] }
  const supabase = await createClient()
  const { data: episode } = await supabase
    .from("podcast_episodes")
    .select("id, title, script, category")
    .eq("id", params.episodeId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (!episode) return { success: false, error: "Episode not found", snippets: [] }
  if (!episode.script) return { success: false, error: "Episode has no script to extract from", snippets: [] }
  try {
    const { text } = await generateTextRouted({
      feature: "podcast_snippet_suggestions",
      maxTokens: 800,
      temperature: 0.7,
      prompt: `Extract 3-5 short, social-ready snippet suggestions from this real estate podcast episode.
Lead with the listener's value, not the host. Each snippet should be 30-60 seconds when read aloud.

Title: ${episode.title}
Category: ${episode.category ?? "general"}
Script:
${episode.script.slice(0, 4000)}

Return as JSON array of {hook: string, body: string, suggested_caption: string, estimated_duration_seconds: number}.`,
    })
    let snippets: any[] = []
    try {
      const match = text.match(/\[[\s\S]*\]/)
      snippets = match ? JSON.parse(match[0]) : []
    } catch {
      snippets = []
    }
    return { success: true, snippets }
  } catch (error: any) {
    return { success: false, error: error.message, snippets: [] }
  }
}

export async function generatePodcastBlogPost(params: { episodeId: string }) {
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId || !brokerageId) return { success: false, error: "Missing agent context" }
  const supabase = await createClient()
  const { data: episode } = await supabase
    .from("podcast_episodes")
    .select("id, title, description, script, category")
    .eq("id", params.episodeId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (!episode) return { success: false, error: "Episode not found" }
  if (!episode.script) return { success: false, error: "Episode has no script" }
  try {
    const { text } = await generateTextRouted({
      feature: "podcast_blog_post",
      maxTokens: 1500,
      temperature: 0.6,
      prompt: `Turn this podcast episode transcript into a long-form blog post (markdown, 600-900 words).
Lead with reader value. Use H2 section headers, short paragraphs, and a clear takeaway list at the end.

Title: ${episode.title}
Description: ${episode.description ?? ""}
Transcript:
${episode.script.slice(0, 6000)}`,
    })
    const blogTitle = `${episode.title}`
    // Persist to blog_posts table if it exists; fail gracefully if not.
    let savedId: string | null = null
    try {
      const { data: row } = await supabase
        .from("blog_posts")
        .insert({
          brokerage_id: brokerageId,
          author_id: agentId,
          title: blogTitle,
          content_md: text,
          status: "draft",
          source_type: "podcast",
          source_id: episode.id,
        })
        .select("id")
        .single()
      savedId = row?.id ?? null
    } catch {
      savedId = null
    }
    return { success: true, blogPostId: savedId, content: text, title: blogTitle }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function generatePodcastNewsletterTeaser(params: { episodeId: string }) {
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId || !brokerageId) return { success: false, error: "Missing agent context" }
  const supabase = await createClient()
  const { data: episode } = await supabase
    .from("podcast_episodes")
    .select("id, title, description, script")
    .eq("id", params.episodeId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (!episode) return { success: false, error: "Episode not found" }
  try {
    const { text } = await generateTextRouted({
      feature: "podcast_newsletter_teaser",
      maxTokens: 220,
      temperature: 0.65,
      prompt: `Write a 1-paragraph newsletter teaser (4-5 sentences) promoting this podcast episode.
Lead with what the reader gains. End with a CTA to listen.

Title: ${episode.title}
Description: ${episode.description ?? ""}
Transcript excerpt:
${(episode.script ?? "").slice(0, 1500)}`,
    })
    let teaserId: string | null = null
    try {
      const { data: row } = await supabase
        .from("newsletter_teasers")
        .insert({
          brokerage_id: brokerageId,
          agent_id: agentId,
          source_type: "podcast",
          source_id: episode.id,
          content: text,
          status: "draft",
        })
        .select("id")
        .single()
      teaserId = row?.id ?? null
    } catch {
      teaserId = null
    }
    return { success: true, teaserId, content: text }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// J5A — Analytics: per-channel breakdown, daily trend, completion rate, subscribers
// ─────────────────────────────────────────────────────────────────────────────

export async function getPodcastAdvancedAnalytics(params?: { trendDays?: number }) {
  const { brokerageId } = await getAgentContext()
  if (!brokerageId) return { success: false, error: "Missing agent context" }
  const supabase = await createClient()
  const trendDays = params?.trendDays ?? 30
  const sinceTrend = new Date(Date.now() - trendDays * 24 * 60 * 60 * 1000).toISOString()
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const since60 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

  try {
    const { data: events } = await supabase
      .from("podcast_analytics_events")
      .select("event_type, episode_id, platform, duration_listened_seconds, completion_pct, occurred_at, created_at")
      .eq("brokerage_id", brokerageId)

    const rows = events ?? []

    // Total plays
    const totalPlays = rows.filter((r: any) => r.event_type === "play").length

    // Total listen minutes
    const totalListenMinutes = Math.round(
      rows.reduce((s: number, r: any) => s + (r.duration_listened_seconds ?? 0), 0) / 60
    )

    // Avg completion rate (only for events that record completion_pct)
    const completionRows = rows.filter((r: any) => typeof r.completion_pct === "number")
    const avgCompletionRate = completionRows.length
      ? Math.round(
          (completionRows.reduce((s: number, r: any) => s + (r.completion_pct ?? 0), 0) / completionRows.length) * 100
        ) / 100
      : 0

    // Subscriber growth: new subscribe events over last 30 days vs prior 30 days
    const subs30 = rows.filter(
      (r: any) => r.event_type === "subscribe" && (r.occurred_at ?? r.created_at) >= since30
    ).length
    const subs60 = rows.filter(
      (r: any) =>
        r.event_type === "subscribe" &&
        (r.occurred_at ?? r.created_at) >= since60 &&
        (r.occurred_at ?? r.created_at) < since30
    ).length
    const subscriberGrowthPct = subs60 > 0 ? Math.round(((subs30 - subs60) / subs60) * 100) : null

    // Per-channel breakdown
    const byChannel: Record<string, { plays: number; minutes: number }> = {}
    for (const r of rows) {
      if (r.event_type !== "play") continue
      const k = (r.platform ?? "unknown").toString()
      if (!byChannel[k]) byChannel[k] = { plays: 0, minutes: 0 }
      byChannel[k].plays += 1
      byChannel[k].minutes += Math.round((r.duration_listened_seconds ?? 0) / 60)
    }
    const channelBreakdown = Object.entries(byChannel).map(([channel, v]) => ({
      channel,
      plays: v.plays,
      minutes: v.minutes,
    }))

    // Daily trend (plays per day, last `trendDays` days)
    const trendMap: Record<string, number> = {}
    for (let i = 0; i < trendDays; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
      const key = d.toISOString().slice(0, 10)
      trendMap[key] = 0
    }
    for (const r of rows) {
      if (r.event_type !== "play") continue
      const ts = (r.occurred_at ?? r.created_at) as string | null
      if (!ts || ts < sinceTrend) continue
      const key = ts.slice(0, 10)
      if (key in trendMap) trendMap[key] += 1
    }
    const dailyTrend = Object.entries(trendMap)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, plays]) => ({ date, plays }))

    // Per-episode with platform deep links
    const { data: episodeRows } = await supabase
      .from("podcast_episodes")
      .select("id, title, audio_url, publish_channels, status")
      .eq("brokerage_id", brokerageId)

    const playsByEpisode: Record<string, number> = {}
    for (const r of rows) {
      if (r.event_type !== "play") continue
      playsByEpisode[r.episode_id] = (playsByEpisode[r.episode_id] ?? 0) + 1
    }

    // Build per-channel deep link map from distribution channels (we use external_show_id)
    const { data: channels } = await supabase
      .from("podcast_distribution_channels")
      .select("channel_name, external_show_id, is_enabled")
      .eq("brokerage_id", brokerageId)

    const platformLinks: Record<string, string | null> = {}
    for (const ch of channels ?? []) {
      if (!ch.is_enabled || !ch.external_show_id) continue
      const n = ch.channel_name.toLowerCase()
      if (n === "spotify") platformLinks.spotify = `https://open.spotify.com/show/${ch.external_show_id}`
      else if (n === "apple" || n === "apple_podcasts")
        platformLinks.apple = `https://podcasts.apple.com/podcast/id${ch.external_show_id}`
      else if (n === "youtube") platformLinks.youtube = `https://www.youtube.com/channel/${ch.external_show_id}`
      else if (n === "rss") platformLinks.rss = ch.external_show_id
    }

    const perEpisode = (episodeRows ?? []).map((ep: any) => ({
      id: ep.id,
      title: ep.title,
      plays: playsByEpisode[ep.id] ?? 0,
      audioUrl: ep.audio_url,
      publishedChannels: ep.publish_channels ?? [],
      platformLinks,
    }))

    return {
      success: true,
      totalPlays,
      totalListenMinutes,
      avgCompletionRate,
      subscriberGrowthPct,
      subscribersLast30: subs30,
      channelBreakdown,
      dailyTrend,
      perEpisode,
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}
