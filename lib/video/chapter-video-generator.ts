/**
 * Chapter Video Generator
 *
 * Produces N short videos — one per presentation chapter — using DID avatar
 * and the agent's cloned voice. Each chapter is its own video (not a
 * post-process segmentation of one big video). This sidesteps ffmpeg-based
 * splitting and works with HeyGen/D-ID generation APIs out of the box.
 *
 * Used by the listing-appt-prep chain to produce drip-ready content.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"

export interface PresentationChapter {
  title: string
  focus?: string
  /** Optional pre-written script — otherwise AI generates from focus + property data */
  script?: string
}

export interface ChapterVideoInput {
  brokerageId: string
  agentUserId: string | null
  contactId: string | null
  presentationId?: string
  chapters: PresentationChapter[]
  presentationContent?: string
  propertyData?: {
    address?: string
    city?: string
    state?: string
    bedrooms?: number
    bathrooms?: number
    sqft?: number
  }
}

export interface ChapterVideoResult {
  success: boolean
  videoIds: string[]
  chapterTitles: string[]
  error?: string
}

export async function generatePropertyChapterVideos(
  input: ChapterVideoInput
): Promise<ChapterVideoResult> {
  const svc = createServiceClient()

  // Resolve agent's voice + avatar config (needed for DID generation)
  let agentVoiceId: string | null = null
  let agentAvatarId: string | null = null
  let agentName = ""

  if (input.agentUserId) {
    const { data: agent } = await svc
      .from("agents")
      .select("voice_id, avatar_id, first_name, last_name")
      .eq("user_id", input.agentUserId)
      .maybeSingle()

    agentVoiceId = agent?.voice_id ?? null
    agentAvatarId = agent?.avatar_id ?? null
    agentName = [agent?.first_name, agent?.last_name].filter(Boolean).join(" ")
  }

  const videoIds: string[] = []
  const chapterTitles: string[] = []
  const failures: string[] = []

  for (let i = 0; i < input.chapters.length; i++) {
    const chapter = input.chapters[i]
    chapterTitles.push(chapter.title)

    try {
      // 1. Get or generate the script for this chapter
      const script =
        chapter.script ??
        (await generateChapterScript({
          chapter,
          presentationContent: input.presentationContent,
          propertyData: input.propertyData,
          agentName,
        }))

      // 2. Insert video_projects row in pending state — actual generation
      // is queued asynchronously to avoid blocking the workflow chain.
      const { data: project, error } = await svc
        .from("video_projects")
        .insert({
          brokerage_id: input.brokerageId,
          agent_user_id: input.agentUserId,
          contact_id: input.contactId,
          project_type: "presentation_chapter",
          title: chapter.title,
          script,
          script_metadata: {
            chapter_index: i,
            chapter_title: chapter.title,
            chapter_focus: chapter.focus,
            presentation_id: input.presentationId,
          },
          voice_id: agentVoiceId,
          avatar_id: agentAvatarId,
          provider: agentAvatarId ? "did" : "heygen",
          status: "queued",
          duration_seconds: estimateDurationFromScript(script),
        })
        .select("id")
        .single()

      if (error || !project) {
        failures.push(chapter.title)
        continue
      }

      videoIds.push(project.id)

      // 3. Emit kernel event so the video-generation worker picks this up
      // (workers consume video_projects rows where status='queued').
      await svc.from("lifecycle_events").insert({
        brokerage_id: input.brokerageId,
        actor_user_id: input.agentUserId,
        event_type: "video.queued",
        metadata: {
          video_project_id: project.id,
          chapter_title: chapter.title,
          presentation_id: input.presentationId,
        },
        entity_id: project.id,
        entity_type: "video",
        source: "workflow_orchestrator",
        processed: false,
      })
    } catch (err: any) {
      failures.push(chapter.title)
      console.error(`[chapter-video-generator] Chapter '${chapter.title}' failed:`, err)
    }
  }

  if (videoIds.length === 0) {
    return {
      success: false,
      videoIds: [],
      chapterTitles,
      error: `All ${input.chapters.length} chapter videos failed to queue`,
    }
  }

  return {
    success: true,
    videoIds,
    chapterTitles: input.chapters.slice(0, videoIds.length).map((c) => c.title),
    error: failures.length > 0 ? `${failures.length} chapter(s) failed: ${failures.join(", ")}` : undefined,
  }
}

// ---------------------------------------------------------------------------
// AI script generator for a single chapter
// ---------------------------------------------------------------------------

async function generateChapterScript(params: {
  chapter: PresentationChapter
  presentationContent?: string
  propertyData?: ChapterVideoInput["propertyData"]
  agentName: string
}): Promise<string> {
  const { chapter, presentationContent, propertyData, agentName } = params

  const propertyContext = propertyData
    ? `Property: ${propertyData.address ?? ""}, ${propertyData.city ?? ""}, ${propertyData.state ?? ""}` +
      (propertyData.bedrooms ? ` · ${propertyData.bedrooms} bed` : "") +
      (propertyData.bathrooms ? ` · ${propertyData.bathrooms} bath` : "") +
      (propertyData.sqft ? ` · ${propertyData.sqft} sqft` : "")
    : ""

  const prompt = `You are ${agentName || "a real estate agent"} speaking directly to a potential seller before a listing appointment.

Write a 45-60 second video script for the chapter titled "${chapter.title}".
Chapter focus: ${chapter.focus ?? "general"}
${propertyContext ? `${propertyContext}` : ""}

Style:
- Lead with value, not a sales pitch ("them first" — what does the seller get?)
- Conversational tone — first-person, warm
- Concrete and specific, not generic
- Open with a hook, close with a forward-look to the appointment
- 100-150 words

${presentationContent ? `Source material from the listing presentation:\n${presentationContent.slice(0, 2000)}\n` : ""}

Return only the script text — no scene directions, no headers, just what the agent will say on camera.`

  const { text } = await generateTextRouted({
    feature: "listing_presentation",
    prompt,
    maxTokens: 400,
    temperature: 0.7,
  })

  return text.trim()
}

function estimateDurationFromScript(script: string): number {
  // ~150 words per minute = 2.5 words per second
  const words = script.split(/\s+/).filter(Boolean).length
  return Math.max(20, Math.round(words / 2.5))
}
