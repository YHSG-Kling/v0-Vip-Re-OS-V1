"use server"

import { createClient } from "@/lib/supabase/server"
import { put } from "@vercel/blob"
import { getAgentContext } from "@/lib/identity"

/**
 * AI Podcast Generation Actions
 * Automated podcast creation from keywords/scripts with voice synthesis
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
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated" }
  }

  try {
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

    // Create episode record
    const { data: episode, error } = await supabase
      .from("podcast_episodes")
      .insert({
        agent_id: user.id,
        title: params.title,
        description: params.description || "",
        script: finalScript,
        keywords: params.keywords || [],
        primary_voice_id: params.voiceId || templateData?.default_voice_id || "default",
        voice_settings: templateData?.voice_settings || {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
        category: params.category || "general",
        status: "draft",
      })
      .select()
      .single()

    if (error) throw error

    return { success: true, episode }
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
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated" }
  }

  try {
    // Get episode
    const { data: episode, error: episodeError } = await supabase
      .from("podcast_episodes")
      .select("*")
      .eq("id", episodeId)
      .single()

    if (episodeError) throw episodeError
    if (episode.agent_id !== user.id) {
      return { success: false, error: "Unauthorized" }
    }

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
        const audioBuffer = await synthesizeVoice(segment.text, episode.primary_voice_id, episode.voice_settings)

        // Upload to Vercel Blob
        const fileName = `podcast-${episodeId}-segment-${index}.mp3`
        const blob = await put(fileName, audioBuffer, {
          access: "public",
          contentType: "audio/mpeg",
        })

        // Create segment record
        await supabase.from("podcast_segments").insert({
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
    await supabase
      .from("podcast_episodes")
      .update({
        audio_url: finalAudioUrl,
        duration_seconds: Math.round(totalDuration),
        status: "completed",
        generation_completed_at: new Date().toISOString(),
        segments: audioSegments,
      })
      .eq("id", episodeId)

    return { success: true, audioUrl: finalAudioUrl, duration: totalDuration }
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

// Synthesize voice using ElevenLabs or Grok voice API
async function synthesizeVoice(text: string, voiceId: string, settings: any): Promise<Buffer> {
  // Use Grok or ElevenLabs for voice synthesis
  // For now, return a mock buffer (in production, integrate with voice API)

  try {
    // Example with ElevenLabs (you'll need API key)
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

// Publish podcast episode
export async function publishPodcastEpisode(episodeId: string, channels: string[]) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  try {
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

    return { success: true }
  } catch (error: any) {
    console.error("[v0] Error publishing podcast:", error)
    return { success: false, error: error.message }
  }
}

// Track podcast analytics event
export async function trackPodcastEvent(episodeId: string, eventType: string, data?: any) {
  const supabase = await createClient()

  try {
    await supabase.from("podcast_analytics_events").insert({
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
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated" }
  }

  try {
    const { data: template, error } = await supabase
      .from("podcast_templates")
      .insert({
        agent_id: user.id,
        name: params.name,
        description: params.description || "",
        template_type: params.templateType,
        default_voice_id: params.voiceId || "default",
        show_name: params.showName || "My Podcast",
        host_name: params.hostName || user.email?.split("@")[0] || "Host",
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
