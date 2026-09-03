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
 *   1. Inserts into ai_video_projects (NOT the deprecated video_projects table —
 *      see m118 deprecation notice), agents-class agent_id per m366.
 *   2. SUBMITS THE RENDER — dispatchVideo() (lib/providers/dispatch.ts), the
 *      same platform-locked D-ID + ElevenLabs egress lib/video/intro-video-
 *      reactor.ts and app/actions/creative-playbooks.ts use — then stamps the
 *      row with status='generating' + provider_job_id + provider_status +
 *      provider_metadata.provider='did'. That triple IS the eligibility filter
 *      app/api/cron/poll-did-videos selects on, so the render is now actually
 *      polled, persisted to our Supabase bucket, brand-overlaid, and completed.
 *      A REFUSED submission writes status='failed' + error_message on the spot;
 *      the row is never left at 'queued' pretending to be in flight.
 *   3. Emits KernelEvent.VIDEO_GENERATION_REQUESTED on lifecycle_events AFTER a
 *      successful submission (was previously the dotted "video.queued" string —
 *      caught by the kernel-event-vocab drift audit on PR #44). It is an AUDIT
 *      RECORD ONLY: that event has five emitters and zero consumers repo-wide.
 *      Nothing reads it, so nothing is dispatched by emitting it.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import { KernelEvent } from "@/lib/kernel/events"
import { buildComplianceSystemBlocks, postcheckScript, type QueryableClient } from "@/lib/video/script-compliance"
// THE ONE speaking-pace vocabulary (§6). A chapter video is a pure D-ID
// talking head (provider_metadata carries no target_composition_id, so no
// Remotion frame cap — the clip is as long as the speech). The SECONDS are the
// product decision below; the words the prompt asks for and the token ceiling
// paid for both DERIVE from them through script-structure, never a typed range.
import {
  estimateDurationSeconds,
  narrationBudget,
  narrationMaxTokens,
  spokenWords,
  targetWordCount,
} from "@/lib/video/script-structure"

/**
 * The declared runtime of one presentation chapter clip. Drip-ready content:
 * long enough to teach one chapter, short enough to hold attention. These two
 * numbers are the ONLY length decision in this file — every word count and
 * token budget derives from them at WORDS_PER_MINUTE.
 */
const CHAPTER_TARGET_SECONDS_MIN = 45
const CHAPTER_TARGET_SECONDS_MAX = 60

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
  // live on agent_voice_profiles and are resolved again at dispatch time by
  // lib/providers/dispatch.ts.
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
  const agentUserId = input.agentUserId

  // IDENTITY CLASS. m366 re-pointed ai_video_projects.agent_id at agents(id) —
  // writing a users.id into it is a 23503 FK violation, not a mislink. The
  // resolve is brokerage-scoped (agents.user_id + agents.brokerage_id), so it
  // is also the tenant gate: a users.id with no agents row in THIS brokerage
  // gets no project. agentUserId stays for dispatchVideo (users-class) and
  // lifecycle_events.actor_user_id.
  const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
  const agentId = await resolveUserIdToAgentRecord(agentUserId, input.brokerageId)
  if (!agentId) {
    return {
      success: false,
      videoIds: [],
      chapterTitles: input.chapters.map((c) => c.title),
      error: "Cannot create chapter videos — no agents record for this user in this brokerage (ai_video_projects.agent_id FKs agents.id since m366)",
    }
  }

  // Voice + avatar pre-flight (the intro-video-reactor gate). Two reasons to
  // read this HERE and not leave it all to dispatchVideo: (1) without a clone
  // + avatar every chapter is a guaranteed refusal, so checking once saves N
  // AI-Gateway script generations that can never be rendered; (2) the D-ID
  // endpoint dispatchVideo posts to depends on it — a did_video_url source
  // goes to /clips, a photo to /talks — and poll-did-videos reads the engine
  // back off provider_metadata.mode. Guess it wrong and the poller GETs the
  // wrong endpoint, takes the 404 as terminal, and fails a live render.
  const { data: voiceProfile } = await svc
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_photo_url, did_video_url")
    .eq("agent_id", agentId)
    .maybeSingle()
  if (!voiceProfile?.elevenlabs_voice_id || (!voiceProfile.did_photo_url && !voiceProfile.did_video_url)) {
    return {
      success: false,
      videoIds: [],
      chapterTitles: input.chapters.map((c) => c.title),
      error: "Cannot create chapter videos — the agent has no voice/avatar profile (Settings → Voice & Avatar)",
    }
  }
  const didMode = voiceProfile.did_video_url ? "clip" : "talk"

  const { dispatchVideo } = await import("@/lib/providers/dispatch")

  const videoIds: string[] = []
  const chapterTitles: string[] = []
  const failures: string[] = []
  /** Titles of the chapters that actually reached the provider, index-aligned
   *  with videoIds. Kept separately because the success return used to name
   *  them with input.chapters.slice(0, videoIds.length) — a COUNT-based slice,
   *  so a partial run (chapters 1 and 3 submitted, 2 refused) reported "1, 2":
   *  the refused chapter named as a success and the submitted one dropped. */
  const succeededTitles: string[] = []

  for (let i = 0; i < input.chapters.length; i++) {
    const chapter = input.chapters[i]
    chapterTitles.push(chapter.title)

    // Held outside the try so a THROW between the insert and the provider
    // stamp (dispatchVideo reaches ElevenLabs, Supabase storage and D-ID —
    // any of them can throw) can still tell the truth on the row instead of
    // abandoning it at 'queued'.
    let projectId: string | null = null

    try {
      const script =
        chapter.script ??
        (await generateChapterScript({
          chapter,
          presentationContent: input.presentationContent,
          propertyData: input.propertyData,
          agentName,
          brokerageId: input.brokerageId,
          client: svc,
        }))

      // Graded AFTER generation and on EVERY script — including a caller-
      // supplied chapter.script, which skips the steered prompt entirely and is
      // therefore the path most likely to carry a violation. Advisory by
      // design (lib/video/script-compliance.ts): the verdict is recorded on the
      // row, it does not refuse the render. A silent audit is the defect this
      // module exists to prevent, so the result is persisted, not logged.
      const complianceWarnings = await postcheckScript(
        { userId: agentUserId, brokerageId: input.brokerageId },
        script,
        "seller", // a chapter reel addresses a prospective seller pre-listing-appointment
        // The SERVICE client (integrator, 2026-09-03): this generator is reached
        // from a cron-driven chain with no session, and without a client the
        // brand-voice + prohibited-phrase read fell to the cookie client, failed
        // silently, and the verdict came back UNKNOWN (script-compliance.ts:234-237
        // names "the cron-reached chapter generator" as the reason the seam exists).
        { client: svc },
      )

      // Insert into the canonical ai_video_projects table. 'queued' is the
      // honest state for the few lines it lasts — staged, not yet handed to a
      // provider. The submission + provider stamp below is what makes the row
      // visible to poll-did-videos, which then brand-overlay-composites it and
      // writes the final URLs. Chapter videos are public-marketing listing
      // presentations, so usage_intent='public_marketing'.
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
          // 'needs_review', not 'failed': the postcheck is advisory and the
          // render proceeds. ai_video_projects_compliance_status_check admits
          // exactly not_evaluated | passed | failed | needs_review.
          compliance_status:       complianceWarnings?.length ? "needs_review" : "passed",
          compliance_violations:   complianceWarnings?.length ? complianceWarnings : null,
          compliance_evaluated_at: new Date().toISOString(),
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
      projectId = project.id

      // ─── SUBMIT THE RENDER ───────────────────────────────────────────────
      // Nothing else will. VIDEO_GENERATION_REQUESTED has no consumer, so a
      // row that is only inserted sits at 'queued' until the video reaper
      // escalates it at 2h. This is the same egress intro-video-reactor and
      // creative-playbooks use.
      //
      // contactId is deliberately NOT passed. dispatchVideo's only use of it
      // is the de-conflict gate on the contact's EMAIL allowance — but this
      // call renders, it does not send: no email leaves here. Spending the
      // allowance now would suppress chapters 2..N of the SAME presentation
      // under the over-touch cap and mark live product as failed. The touch
      // that does reach the seller goes out through dispatchEmail later, which
      // runs suppression + compliance + de-conflict itself. contact_id is
      // still stamped on the project row above for attribution.
      const submission = await dispatchVideo({
        brokerageId:    input.brokerageId,
        userId:         agentUserId,
        agentId,
        templateId:     script,
        recipientEmail: "",
        systemSource:   "chapter_video.listing_appt_prep",
        metadata: {
          ai_video_project_id: project.id,
          chapter_index:       i,
          presentation_id:     input.presentationId,
        },
      })

      if (!submission.success || !submission.messageId) {
        // HONEST REFUSAL. The provider never took the job, so the row must not
        // sit in a state that claims a render is in flight — the reaper and the
        // videos board would both report a lie for two hours.
        await svc
          .from("ai_video_projects")
          .update({
            status:        "failed",
            error_message: `Render not started: ${submission.error ?? "the video provider refused the job"}`.slice(0, 800),
          })
          .eq("id", project.id)
        failures.push(chapter.title)
        continue
      }

      // Exactly what app/api/cron/poll-did-videos selects on: status='generating'
      // AND provider_job_id IS NOT NULL AND provider_metadata->>provider='did'.
      // `mode` is read back by that cron to choose /clips vs /talks.
      const { error: stampError } = await svc
        .from("ai_video_projects")
        .update({
          status:          "generating",
          provider_job_id: submission.messageId,
          provider_status: "processing",
          video_provider:  "did",
          provider_metadata: {
            provider:        "did",
            mode:            didMode,
            talk_id:         submission.messageId,
            chapter_index:   i,
            presentation_id: input.presentationId ?? null,
          },
          error_message: null,
        })
        .eq("id", project.id)

      if (stampError) {
        // The D-ID job is REAL but unlinked, so it cannot be polled. The row is
        // left at 'queued' on purpose: that is the truthful state (staged, no
        // worker will pick it up) and the 2h reaper escalates it. Marking it
        // 'failed' here would be a second false claim, and the job id is logged
        // so the render can be reattached by hand.
        console.error(
          `[chapter-video-generator] project ${project.id} could not be linked to D-ID job ${submission.messageId}: ${stampError.message}`
        )
        failures.push(chapter.title)
        continue
      }

      videoIds.push(project.id)
      succeededTitles.push(chapter.title)

      // Canonical KernelEvent, emitted only once the provider has the job.
      // AUDIT RECORD ONLY — VIDEO_GENERATION_REQUESTED has five emitters and
      // zero consumers repo-wide; no dispatcher, cron or switch case reads it.
      // The render moves because dispatchVideo submitted it and the stamp above
      // made it visible to poll-did-videos, not because this row exists.
      // (Previously this emitted the dotted "video.queued" which the
      // underscore-form KernelEvent reactor never matched either.)
      const { emitKernelEvent } = await import("@/lib/kernel/emit")
      await emitKernelEvent({
        brokerageId: input.brokerageId,
        actorUserId: agentUserId,
        event:       KernelEvent.VIDEO_GENERATION_REQUESTED,
        metadata: {
          video_project_id: project.id,
          chapter_title:    chapter.title,
          presentation_id:  input.presentationId,
        },
        entityId:   project.id,
        entityType: "ai_video_project",
        source:     "system",
      })
    } catch (err: unknown) {
      failures.push(chapter.title)
      console.error(`[chapter-video-generator] Chapter '${chapter.title}' failed:`, err)
      // A project row that exists but never reached the provider stamp is not
      // 'queued' in any useful sense — say so, so the board and the reaper are
      // reading a fact. Best-effort: the throw is already the record of truth.
      if (projectId) {
        await svc
          .from("ai_video_projects")
          .update({
            status:        "failed",
            error_message: `Render not started: ${(err as Error)?.message ?? "chapter video generation threw"}`.slice(0, 800),
          })
          .eq("id", projectId)
          .then(({ error: markErr }) => {
            if (markErr) console.error(`[chapter-video-generator] could not mark project ${projectId} failed:`, markErr.message)
          })
      }
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
    chapterTitles: succeededTitles,
    error: failures.length > 0 ? `${failures.length} chapter(s) failed: ${failures.join(", ")}` : undefined,
  }
}

async function generateChapterScript(params: {
  chapter: PresentationChapter
  presentationContent?: string
  propertyData?: ChapterVideoInput["propertyData"]
  agentName: string
  brokerageId: string
  /** Service client for the compliance reads — no session on the cron-reached path. */
  client?: QueryableClient | null
}): Promise<string> {
  const { chapter, presentationContent, propertyData, agentName, brokerageId, client } = params

  // COMPLIANCE, PROACTIVELY. This generator was the sixth AI video-script
  // producer and the only one not running lib/video/script-compliance.ts — the
  // guard at scripts/video-script-compliance-guard.ts enumerates five, and this
  // one was invisible to it because nothing here ever rendered. It renders now,
  // so these words become spoken, customer-facing marketing.
  //
  // The blocks go in the SYSTEM slot rather than being graded afterwards: they
  // carry the brokerage's brand voice, the them-first framing this prompt only
  // gestured at in a style bullet, and the Fair Housing constraints. Steering
  // generation cannot refuse a chapter — the alternative, hard-blocking on a
  // post-hoc verdict, would trade a never-renders bug for a never-passes one.
  const complianceBlocks = await buildComplianceSystemBlocks(brokerageId, undefined, client)

  const propertyContext = propertyData
    ? `Property: ${propertyData.address ?? ""}, ${propertyData.city ?? ""}, ${propertyData.state ?? ""}` +
      (propertyData.bedrooms ? ` · ${propertyData.bedrooms} bed` : "") +
      (propertyData.bathrooms ? ` · ${propertyData.bathrooms} bath` : "") +
      (propertyData.sqft ? ` · ${propertyData.sqft} sqft` : "")
    : ""

  // ── THE ASK IS DERIVED FROM THE DECLARED SECONDS (§2/§6) ──────────────────
  // WHAT STOOD HERE, kept unbroken for the record (the guard asserts it is gone
  // from live, comment-stripped code — a tombstone is not a call site):
  //   "Write a 45-60 second video script … - 100-150 words"
  // with a flat `maxTokens: 400`. The seconds and the words were two separate
  // hand-typed answers to one question; now the words and the token ceiling
  // both derive from CHAPTER_TARGET_SECONDS_* at the one WORDS_PER_MINUTE.
  // headroom 0 because nothing cuts a pure D-ID clip — the declared seconds are
  // an editorial target, not a frame cap.
  const chapterBudget = narrationBudget("chapter_video", CHAPTER_TARGET_SECONDS_MAX, 0)

  const prompt = `You are ${agentName || "a real estate agent"} speaking directly to a potential seller before a listing appointment.

Write a ${CHAPTER_TARGET_SECONDS_MIN}-${CHAPTER_TARGET_SECONDS_MAX} second video script for the chapter titled "${chapter.title}".
Chapter focus: ${chapter.focus ?? "general"}
${propertyContext ? `${propertyContext}` : ""}

Style:
- Lead with value, not a sales pitch ("them first" — what does the seller get?)
- Conversational tone — first-person, warm
- Concrete and specific, not generic
- Open with a hook, close with a forward-look to the appointment
- ${targetWordCount(CHAPTER_TARGET_SECONDS_MIN)}-${chapterBudget.maxWords} words (that is ${CHAPTER_TARGET_SECONDS_MIN}-${CHAPTER_TARGET_SECONDS_MAX} seconds at a natural speaking pace)

${presentationContent ? `Source material from the listing presentation:\n${presentationContent.slice(0, 2000)}\n` : ""}

Return only the script text — no scene directions, no headers, just what the agent will say on camera.`

  const { text } = await generateTextRouted({
    feature: "listing_presentation",
    system: complianceBlocks.join("\n\n"),
    prompt,
    // brokerageId is what meters this call against the tenant's AI fair-use
    // budget (lib/ai/models.ts:663). Omitting it billed chapter scripts to
    // nobody — N generations per presentation, uncounted.
    brokerageId,
    // Sized from the SAME derived word budget (§5 — the flat 400 that stood
    // here paid for text the target length never wanted).
    maxTokens: narrationMaxTokens(chapterBudget),
    temperature: 0.7,
  })

  return text.trim()
}

function estimateDurationFromScript(script: string): number {
  // TOMBSTONE (§6): the private `words / 2.5` arithmetic that lived here was a
  // second spelling of WORDS_PER_MINUTE. Survivor: lib/video/script-structure.ts
  // estimateDurationSeconds + spokenWords. The 20s floor is this caller's own
  // (a chapter clip is never billed shorter than its D-ID minimum).
  return Math.max(20, estimateDurationSeconds(spokenWords(script).length))
}
