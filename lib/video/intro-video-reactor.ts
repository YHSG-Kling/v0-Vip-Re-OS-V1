/**
 * lib/video/intro-video-reactor.ts
 *
 * Two trigger-driven personalized avatar videos that ride the egress:
 *
 *   dispatchAssignmentIntroVideo  — fired by the kernel reactor on LEAD_ASSIGNED.
 *   dispatchAnniversaryVideo      — fired by sendAnniversaryMessage in the
 *                                   lifetime-customer-touchpoints daily cron.
 *
 * Both share a single render path:
 *   1. Gate on contacts.video_opt_out (canonical opt-out column).
 *   2. Gate on the agent having a configured agent_voice_profiles row
 *      (cloned voice + D-ID avatar source). Skip cleanly if missing.
 *   3. Insert agent_intro_videos (m121) — the unique partial index makes the
 *      whole reactor idempotent; a second call for the same trigger returns
 *      'already_queued'.
 *   4. Generate a short, personalized script via the Vercel AI Gateway
 *      (generateTextRouted) using the contact's name + persona register.
 *   5. Create an ai_video_projects row + emit KernelEvent.VIDEO_GENERATION_REQUESTED
 *      so the poll-did-videos cron picks it up. The cron applies the canonical
 *      brand-overlay + intro/outro stitching pipeline and writes back the URL.
 *   6. Email delivery rides dispatchEmail (compliance + suppression + 1:1
 *      de-conflict gates already wired). The portal card is auto-rendered by
 *      the portal-stream-projector cron when VIDEO_GENERATION_COMPLETED fires.
 *
 * Both flows leave the network egress through callConnector exclusively
 * (ElevenLabs TTS + D-ID submission inside dispatchVideo); the local
 * lifecycle_events insert uses canonical KernelEvent values; the audit table
 * is the agent_intro_videos row.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchVideo } from "@/lib/providers/dispatch"
import { dispatchEmail } from "@/lib/providers/dispatch"
import { embedVideoInEmail } from "@/lib/ai-isa/video-generator"
import { generateTextRouted } from "@/lib/ai/models"
import { KernelEvent } from "@/lib/kernel/events"

type IntroTrigger = "lead_assigned" | "home_anniversary"

interface BaseInput {
  brokerageId:  string
  contactId:    string
  /** users.id of the assigned agent — matches ai_video_projects.agent_id FK */
  agentUserId:  string
  /** 'email' (default), 'portal', or 'both' */
  delivery?:    "email" | "portal" | "both"
}

export interface AssignmentIntroInput extends BaseInput {}

export interface AnniversaryVideoInput extends BaseInput {
  yearsAgo: number
}

export interface ReactorResult {
  ok:        boolean
  status:    "queued" | "rendering" | "delivered" | "suppressed" | "skipped" | "already_queued" | "failed"
  videoProjectId?: string
  introVideoId?:   string
  reason?:   string
}

// ─── Public entry points ────────────────────────────────────────────────────

export async function dispatchAssignmentIntroVideo(
  input: AssignmentIntroInput,
): Promise<ReactorResult> {
  return runReactor({
    ...input,
    trigger:      "lead_assigned",
    triggerYear:  null,
  })
}

export async function dispatchAnniversaryVideo(
  input: AnniversaryVideoInput,
): Promise<ReactorResult> {
  if (!Number.isFinite(input.yearsAgo) || input.yearsAgo <= 0) {
    return { ok: false, status: "skipped", reason: "invalid yearsAgo" }
  }
  // trigger_year keys to THIS calendar year so the partial unique index lets
  // a contact get one anniversary video per calendar year.
  const triggerYear = new Date().getUTCFullYear()
  return runReactor({
    brokerageId: input.brokerageId,
    contactId:   input.contactId,
    agentUserId: input.agentUserId,
    delivery:    input.delivery,
    trigger:     "home_anniversary",
    triggerYear,
    yearsAgo:    input.yearsAgo,
  })
}

// ─── Shared render path ─────────────────────────────────────────────────────

interface ReactorInput extends BaseInput {
  trigger:     IntroTrigger
  triggerYear: number | null
  yearsAgo?:   number
}

async function runReactor(input: ReactorInput): Promise<ReactorResult> {
  const svc      = createServiceClient()
  const delivery = input.delivery ?? "email"

  // 1. Contact opt-out + persona resolution
  const { data: contact } = await svc
    .from("contacts")
    .select("first_name, last_name, email, contact_persona, video_opt_out")
    .eq("id", input.contactId)
    .maybeSingle()
  if (!contact) return { ok: false, status: "skipped", reason: "contact not found" }
  if (contact.video_opt_out) {
    await svc.from("agent_intro_videos").insert({
      brokerage_id: input.brokerageId,
      contact_id:   input.contactId,
      agent_id:     input.agentUserId,
      trigger:      input.trigger,
      trigger_year: input.triggerYear,
      status:       "suppressed",
      delivery_channel: delivery,
      error_message: "contact has video_opt_out=true",
    })
    return { ok: true, status: "suppressed", reason: "video_opt_out" }
  }

  // 2. Agent voice profile gate — no profile = nothing to render with
  const { data: profile } = await svc
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_photo_url, did_video_url")
    .eq("agent_id", input.agentUserId)
    .maybeSingle()
  if (!profile?.elevenlabs_voice_id || (!profile.did_photo_url && !profile.did_video_url)) {
    await svc.from("agent_intro_videos").insert({
      brokerage_id: input.brokerageId,
      contact_id:   input.contactId,
      agent_id:     input.agentUserId,
      trigger:      input.trigger,
      trigger_year: input.triggerYear,
      status:       "failed",
      delivery_channel: delivery,
      error_message: "agent has no voice/avatar profile — Settings → Voice & Avatar",
    }).select("id").maybeSingle()
    return { ok: false, status: "failed", reason: "agent voice/avatar profile not configured" }
  }

  // 3. Idempotency — the unique partial index on m121 enforces this. A duplicate
  //    insert returns 23505 which we resolve to 'already_queued'.
  const ledger = await svc
    .from("agent_intro_videos")
    .insert({
      brokerage_id: input.brokerageId,
      contact_id:   input.contactId,
      agent_id:     input.agentUserId,
      trigger:      input.trigger,
      trigger_year: input.triggerYear,
      status:       "queued",
      delivery_channel: delivery,
    })
    .select("id")
    .maybeSingle()
  if (ledger.error) {
    if ((ledger.error as { code?: string }).code === "23505") {
      return { ok: true, status: "already_queued", reason: "duplicate trigger" }
    }
    return { ok: false, status: "failed", reason: `ledger insert: ${ledger.error.message}` }
  }
  const introVideoId = ledger.data?.id as string | undefined

  // 4. Script via Vercel AI Gateway — short, persona-aware, no jargon.
  let script: string
  try {
    script = await draftScript({
      trigger:        input.trigger,
      firstName:      contact.first_name ?? "there",
      persona:        contact.contact_persona ?? null,
      yearsAgo:       input.yearsAgo,
      brokerageId:    input.brokerageId,
      agentUserId:    input.agentUserId,
    })
  } catch (err) {
    await svc.from("agent_intro_videos")
      .update({ status: "failed", error_message: `script: ${(err as Error).message}` })
      .eq("id", introVideoId!)
    return { ok: false, status: "failed", reason: "script generation failed" }
  }

  // 5. Create the ai_video_projects row + dispatch via the platform vendor
  //    selector (D-ID-first per getPlatformVideoProvider). The poll-did-videos
  //    cron handles render polling, brand overlay, intro/outro stitching.
  const videoType = input.trigger === "lead_assigned" ? "agent_intro" : "just_sold"
  const { data: project, error: projErr } = await svc
    .from("ai_video_projects")
    .insert({
      brokerage_id:   input.brokerageId,
      agent_id:       input.agentUserId,
      contact_id:     input.contactId,
      title:          input.trigger === "lead_assigned"
                        ? `Intro for ${contact.first_name}`
                        : `Home anniversary (${input.yearsAgo}y) — ${contact.first_name}`,
      script_content: script,
      video_type:     videoType,
      status:         "queued",
      usage_intent:   "public_marketing",
      audience_type:  "customer_facing",
      duration_seconds: 45,
      video_metadata: {
        trigger:           input.trigger,
        trigger_year:      input.triggerYear,
        intro_video_id:    introVideoId,
        years_ago:         input.yearsAgo ?? null,
      },
    })
    .select("id")
    .single()
  if (projErr || !project) {
    await svc.from("agent_intro_videos")
      .update({ status: "failed", error_message: `ai_video_projects: ${projErr?.message}` })
      .eq("id", introVideoId!)
    return { ok: false, status: "failed", reason: "video project insert failed" }
  }

  await svc.from("agent_intro_videos")
    .update({ video_project_id: project.id, status: "rendering" })
    .eq("id", introVideoId!)

  // Submit to the vendor (D-ID by default). This is async — the poll-did-videos
  // cron will fill in video_url + heygen_video_id and emit
  // VIDEO_GENERATION_COMPLETED when the render lands.
  const submission = await dispatchVideo({
    brokerageId:    input.brokerageId,
    userId:         input.agentUserId,
    contactId:      input.contactId,
    templateId:     script,
    recipientEmail: contact.email ?? "",
    recipientName:  contact.first_name ?? undefined,
    scriptVars: {
      first_name:   contact.first_name ?? "",
      trigger:      input.trigger,
      years_ago:    String(input.yearsAgo ?? 0),
    },
    systemSource:   `intro_video.${input.trigger}`,
    metadata: {
      ai_video_project_id: project.id,
      intro_video_id:      introVideoId,
    },
  })
  if (!submission.success) {
    await svc.from("agent_intro_videos")
      .update({ status: "failed", error_message: `dispatchVideo: ${submission.error}` })
      .eq("id", introVideoId!)
    return { ok: false, status: "failed", reason: submission.error ?? "dispatchVideo failed" }
  }

  // 6. Lifecycle event — the reactor picks up VIDEO_GENERATION_REQUESTED for
  //    sequence enrollment + portal-card eligibility downstream.
  await svc.from("lifecycle_events").insert({
    brokerage_id:  input.brokerageId,
    actor_user_id: input.agentUserId,
    event_type:    KernelEvent.VIDEO_GENERATION_REQUESTED,
    metadata: {
      intro_video_id:      introVideoId,
      ai_video_project_id: project.id,
      trigger:             input.trigger,
    },
    entity_id:   project.id,
    entity_type: "ai_video_project",
    source:      "system",
    processed:   false,
  })

  // 7. Email delivery (when requested). For 'lead_assigned' we send the
  //    "Hi I'm your new agent" email with the video embedded. For
  //    'home_anniversary' the existing sendAnniversaryMessage handles the
  //    email — the reactor only renders + delivers the portal-side card.
  if ((delivery === "email" || delivery === "both") && contact.email && input.trigger === "lead_assigned") {
    const subject  = `${contact.first_name ?? "Hi"} — a quick intro from your agent`
    const baseHtml = `<p>Hi ${contact.first_name ?? ""},</p><p>I wanted to introduce myself.</p><p>[Video will be embedded here]</p>`
    // The video URL won't be ready synchronously (D-ID render is async).
    // We still queue the email NOW with a placeholder; a follow-up worker
    // rewrites the email when the URL lands. For this first ship the
    // placeholder fallback in embedVideoInEmail() handles the case.
    const html = await embedVideoInEmail(baseHtml, null)
    await dispatchEmail({
      brokerageId:    input.brokerageId,
      userId:         input.agentUserId,
      contactId:      input.contactId,
      systemSource:   "intro_video_email",
      channelPurpose: "conversation",
      from:           "agent@platform.com",
      to:             contact.email,
      subject,
      html,
      metadata: { ai_video_project_id: project.id, intro_video_id: introVideoId },
    })
  }

  return {
    ok:             true,
    status:         "rendering",
    videoProjectId: project.id,
    introVideoId,
  }
}

// ─── AI Gateway script generation ────────────────────────────────────────────

async function draftScript(args: {
  trigger:     IntroTrigger
  firstName:   string
  persona:     string | null
  yearsAgo?:   number
  brokerageId: string
  agentUserId: string
}): Promise<string> {
  const personaLine = args.persona
    ? `The recipient's persona is: ${args.persona}. Match that register.`
    : ""
  const prompt = args.trigger === "lead_assigned"
    ? `Write a 30-45 second video script for a real estate agent introducing themselves to a new contact named ${args.firstName}.
Voice: first-person, warm, professional. ${personaLine}
Open with a hook tied to their journey, not a sales pitch. State your role in one line. Close with a single, specific next step (text/email back to schedule a call). 90-130 words. No jargon left unexplained. No commitments on specific rates or valuations. No exclamation marks. Return ONLY the script text the agent will speak on camera.`
    : `Write a 30-40 second home-anniversary video script. The recipient ${args.firstName} closed on their home ${args.yearsAgo} year${(args.yearsAgo ?? 0) > 1 ? "s" : ""} ago.
Voice: first-person, warm, professional. ${personaLine}
Acknowledge the anniversary without being saccharine. Mention you've been thinking about them. End with a low-pressure invitation (catch up coffee, market update on their neighborhood, no pitch). 80-110 words. No specific home-value claims. Return ONLY the script text the agent will speak on camera.`

  const { text } = await generateTextRouted({
    feature:     "intro_video_script",
    prompt,
    maxTokens:   300,
    temperature: 0.6,
  })
  return text.trim()
}
