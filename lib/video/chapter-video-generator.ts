/**
 * Chapter Video Generator
 *
 * Produces N short videos — one per presentation chapter — using the platform
 * video vendor (D-ID by default + ElevenLabs voice clone; HeyGen on superadmin
 * override). Each chapter is its own video (not a post-process split of one
 * long render). Used by the listing-appt-prep chain to produce drip-ready
 * content.
 *
 * Routes through the canonical kernel surface:
 *   1. createVideoProject() inserts into ai_video_projects (NOT the deprecated
 *      video_projects table — see m118 deprecation notice). The poll-did-videos
 *      cron consumes ai_video_projects, so chapter renders land in the same
 *      compositing + brand-overlay pipeline as the rest of the platform.
 *   2. Emits KernelEvent.VIDEO_GENERATION_REQUESTED on lifecycle_events (was
 *      previously the dotted "video.queued" string — caught by the kernel-
 *      event-vocab drift audit on PR #44).
 *   3. The actual provider submission is queued via the kernel/dispatcher
 *      path the rest of the app uses — no direct HeyGen call here.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import { KernelEvent } from "@/lib/kernel/events"

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

  // Resolve agent name for script personalization. The voice + avatar IDs
  // live on agent_voice_profiles and are resolved at dispatch time by
  // lib/providers/dispatch.ts.
  //
  // Note: ai_video_projects.agent_id FKs to users.id (NOT agents.id), so we
  // pass input.agentUserId directly. The column name is historical — the FK
  // is the source of truth.
  let agentName = ""
  if (input.agentUserId) {
    const { data: user } = await svc
      .from("users")
      .select("first_name, last_name")
      .eq("id", input.agentUserId)
      .maybeSingle()
    agentName = [user?.first_name, user?.last_name].filter(Boolean).join(" ")
  }

  if (!input.agentUserId) {
    return {
      success: false,
      videoIds: [],
      chapterTitles: input.chapters.map((c) => c.title),
      error: "Cannot create chapter videos — agentUserId is required (ai_video_projects.agent_id FK)",
    }
  }
  const agentId = input.agentUserId

  const videoIds: string[] = []
  const chapterTitles: string[] = []
  const failures: string[] = []

  for (let i = 0; i < input.chapters.length; i++) {
    const chapter = input.chapters[i]
    chapterTitles.push(chapter.title)

    try {
      const script =
        chapter.script ??
        (await generateChapterScript({
          chapter,
          presentationContent: input.presentationContent,
          propertyData: input.propertyData,
          agentName,
        }))

      // Insert into the canonical ai_video_projects table. The poll-did-videos
      // cron picks rows up by status, brand-overlay-composites them, and
      // updates with the final URLs. Chapter videos are public-marketing
      // listing presentations, so usage_intent='public_marketing'.
      const { data: project, error } = await svc
        .from("ai_video_projects")
        .insert({
          brokerage_id:     input.brokerageId,
          agent_id:         agentId,
          contact_id:       input.contactId,
          title:            chapter.title,
          script_content:   script,
          video_type:       "presentation_chapter",
          status:           "queued",
          duration_seconds: estimateDurationFromScript(script),
          usage_intent:     "public_marketing",
          audience_type:    "customer_facing",
          video_metadata: {
            chapter_index:   i,
            chapter_title:   chapter.title,
            chapter_focus:   chapter.focus,
            presentation_id: input.presentationId,
          },
        })
        .select("id")
        .single()

      if (error || !project) {
        failures.push(chapter.title)
        continue
      }

      videoIds.push(project.id)

      // Canonical KernelEvent — the kernel notification engine picks up
      // VIDEO_GENERATION_REQUESTED rows and routes them to the poll-did-videos
      // submission path. Previously this emitted the dotted "video.queued"
      // which the underscore-form KernelEvent reactor never matched.
      await svc.from("lifecycle_events").insert({
        brokerage_id:  input.brokerageId,
        actor_user_id: input.agentUserId,
        event_type:    KernelEvent.VIDEO_GENERATION_REQUESTED,
        metadata: {
          video_project_id: project.id,
          chapter_title:    chapter.title,
          presentation_id:  input.presentationId,
        },
        entity_id:   project.id,
        entity_type: "ai_video_project",
        source:      "system",
        processed:   false,
      })
    } catch (err: unknown) {
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
