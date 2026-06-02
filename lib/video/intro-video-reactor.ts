/**
 * lib/video/intro-video-reactor.ts
 *
 * Two trigger-driven personalized avatar videos that ride the egress:
 *
 *   dispatchAssignmentIntroVideo  — fired by the kernel reactor on
 *                                   CONTACT_AGENT_ASSIGNED (m122 trigger).
 *                                   Per the app rule: raw_leads → platform,
 *                                   leads → AI ISA + brokerage, contacts →
 *                                   agents. The intro fires on the contact-to-
 *                                   agent assignment, not lead assignment.
 *   dispatchAnniversaryVideo      — fired by sendAnniversaryMessage in the
 *                                   lifetime-customer-touchpoints daily cron.
 *
 * Both share a single render path:
 *   1. Gate on contacts.video_opt_out.
 *   2. Resolve agents.id (the kernel id stored on contacts.agent_id) to
 *      users.id (the FK target for ai_video_projects.agent_id +
 *      agent_voice_profiles.agent_id) via the agents table.
 *   3. Gate on the agent_voice_profiles row — must have elevenlabs_voice_id
 *      AND a Supabase-hosted avatar (did_photo_url OR did_video_url uploaded
 *      by the agent during onboarding). The avatar is OUR storage URL, never
 *      a D-ID-side asset; D-ID renders pull from our URL and we re-host the
 *      output via poll-did-videos cron.
 *   4. Insert agent_intro_videos (m121) — the unique partial index makes the
 *      whole reactor idempotent.
 *   5. Generate a short personalized script via the Vercel AI Gateway.
 *   6. Create an ai_video_projects row + dispatchVideo (D-ID-first per
 *      getPlatformVideoProvider). The poll-did-videos cron polls D-ID,
 *      downloads the finished mp4 to OUR Supabase storage, writes
 *      ai_video_projects.video_url, and emits VIDEO_GENERATION_COMPLETED.
 *   7. NO placeholder email goes out. The intro-video-email-backfill cron
 *      (registered alongside this wave) sweeps rendered videos and queues
 *      the assignment email via dispatchEmail at that point — using OUR
 *      Supabase URL embedded.
 *   8. Portal card auto-renders via the portal-stream-projector cron when
 *      VIDEO_GENERATION_COMPLETED lands.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchVideo } from "@/lib/providers/dispatch"
import { generateTextRouted } from "@/lib/ai/models"
import { KernelEvent } from "@/lib/kernel/events"

type IntroTrigger = "lead_assigned" | "home_anniversary"

interface BaseInput {
  brokerageId:  string
  contactId:    string
  /** agents.id — the value stored on contacts.agent_id (per m111 / RLS).
   *  Resolved to the agent's users.id inside the reactor before passing to
   *  agent_voice_profiles / ai_video_projects (both of which key on users.id). */
  agentId:      string
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
  // The m121 ledger uses 'lead_assigned' as the historical trigger key — kept
  // for back-compat with already-inserted rows. The trigger semantically means
  // "contact got assigned to an agent for the first time".
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
  const triggerYear = new Date().getUTCFullYear()
  return runReactor({
    brokerageId: input.brokerageId,
    contactId:   input.contactId,
    agentId:     input.agentId,
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

  // 2. Resolve agents.id → users.id. agent_voice_profiles + ai_video_projects
  //    both FK to users.id; contacts.agent_id (and the m121 ledger) hold
  //    agents.id. agents.user_id is the bridge.
  const { data: agentRow } = await svc
    .from("agents")
    .select("id, user_id")
    .eq("id", input.agentId)
    .maybeSingle()
  const agentUserId = (agentRow?.user_id as string | null) ?? null
  if (!agentUserId) {
    return { ok: false, status: "skipped", reason: "agent record not found or missing user_id" }
  }

  if (contact.video_opt_out) {
    await svc.from("agent_intro_videos").insert({
      brokerage_id: input.brokerageId,
      contact_id:   input.contactId,
      agent_id:     agentUserId, // ledger.agent_id FKs to users.id per m121
      trigger:      input.trigger,
      trigger_year: input.triggerYear,
      status:       "suppressed",
      delivery_channel: delivery,
      error_message: "contact has video_opt_out=true",
    })
    return { ok: true, status: "suppressed", reason: "video_opt_out" }
  }

  // 3. Voice + avatar gate. Both URLs are OUR Supabase storage URLs (the
  //    avatar was uploaded by the agent during onboarding; D-ID fetches from
  //    our URL when rendering). Missing either = nothing to render with.
  const { data: profile } = await svc
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_photo_url, did_video_url")
    .eq("agent_id", agentUserId)
    .maybeSingle()
  if (!profile?.elevenlabs_voice_id || (!profile.did_photo_url && !profile.did_video_url)) {
    await svc.from("agent_intro_videos").insert({
      brokerage_id: input.brokerageId,
      contact_id:   input.contactId,
      agent_id:     agentUserId,
      trigger:      input.trigger,
      trigger_year: input.triggerYear,
      status:       "failed",
      delivery_channel: delivery,
      error_message: "agent has no voice/avatar profile — Settings → Voice & Avatar",
    })
    return { ok: false, status: "failed", reason: "agent voice/avatar profile not configured" }
  }

  // 4. Idempotency — the m121 partial unique index does the work.
  const ledger = await svc
    .from("agent_intro_videos")
    .insert({
      brokerage_id:     input.brokerageId,
      contact_id:       input.contactId,
      agent_id:         agentUserId,
      trigger:          input.trigger,
      trigger_year:     input.triggerYear,
      status:           "queued",
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

  // 5. Script via Vercel AI Gateway — short, persona-aware, no jargon.
  let script: string
  try {
    script = await draftScript({
      trigger:     input.trigger,
      firstName:   contact.first_name ?? "there",
      persona:     contact.contact_persona ?? null,
      yearsAgo:    input.yearsAgo,
      brokerageId: input.brokerageId,
      agentUserId,
    })
  } catch (err) {
    await svc.from("agent_intro_videos")
      .update({ status: "failed", error_message: `script: ${(err as Error).message}` })
      .eq("id", introVideoId!)
    return { ok: false, status: "failed", reason: "script generation failed" }
  }

  // 6. ai_video_projects + dispatchVideo. agent_id keys to users.id per the
  //    table's FK (caught and fixed in Wave 6).
  const videoType = input.trigger === "lead_assigned" ? "agent_intro" : "just_sold"
  const { data: project, error: projErr } = await svc
    .from("ai_video_projects")
    .insert({
      brokerage_id:   input.brokerageId,
      agent_id:       agentUserId,
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
        trigger:        input.trigger,
        trigger_year:   input.triggerYear,
        intro_video_id: introVideoId,
        years_ago:      input.yearsAgo ?? null,
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

  const submission = await dispatchVideo({
    brokerageId:    input.brokerageId,
    userId:         agentUserId,
    contactId:      input.contactId,
    templateId:     script,
    recipientEmail: contact.email ?? "",
    recipientName:  contact.first_name ?? undefined,
    scriptVars: {
      first_name: contact.first_name ?? "",
      trigger:    input.trigger,
      years_ago:  String(input.yearsAgo ?? 0),
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

  // 7. Canonical lifecycle event so the reactor picks up the request for
  //    sequence enrollment + portal-card eligibility downstream.
  await svc.from("lifecycle_events").insert({
    brokerage_id:  input.brokerageId,
    actor_user_id: agentUserId,
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

  // 8. Email delivery is NOT sent here. The intro-video-email-backfill cron
  //    polls for agent_intro_videos rows whose linked ai_video_projects.video_url
  //    is populated and sends the email then — embedding OUR Supabase URL.
  //    This avoids both the placeholder-email problem AND the double-send risk.

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
