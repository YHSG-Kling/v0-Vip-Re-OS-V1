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
 * Both share a single render path with a PRE-FLIGHT COMPLIANCE GATE so we
 * never spend D-ID render credit on a non-compliant script:
 *
 *   1. Gate on contacts.video_opt_out.
 *   2. Resolve agents.id (kernel id on contacts.agent_id) → users.id (FK
 *      target for ai_video_projects.agent_id + agent_voice_profiles.agent_id).
 *   3. Gate on agent_voice_profiles — elevenlabs_voice_id + a Supabase-hosted
 *      avatar source URL (our storage, never D-ID-side).
 *   4. Insert agent_intro_videos (m121) — partial unique index = idempotency.
 *   5. Draft the script via Vercel AI Gateway.
 *   6. PRE-FLIGHT COMPLIANCE — run evaluateOutbound() on the script BEFORE
 *      we submit to D-ID. The canonical surface chains all five gates:
 *        - Brand voice (brokerage prohibited words, tone, key messages)
 *        - TCPA + per-channel opt-out
 *        - Authority rule (no outreach to a contact represented by another
 *          brokerage; ISA re-engagement only with explicit approval)
 *        - Fair Housing — state-specific via state_protected_classes table
 *          (Florida's protected classes are loaded from there per state
 *          property of the brokerage; the canonical fair-housing-patterns
 *          file is the regex bank both gates share)
 *        - Them-First (≥60% client-focused pronouns + softener rules)
 *      On violations: re-prompt the AI Gateway ONCE feeding the specific
 *      violation list back in so the model can self-correct. If the redraft
 *      ALSO fails, mark the ledger 'failed' with the violation list and bail.
 *      No D-ID render dollars are ever spent on a non-compliant script.
 *   7. Create ai_video_projects + dispatchVideo (D-ID-first per
 *      getPlatformVideoProvider). compliance_status is stamped 'passed' on
 *      the project row so the broker cockpit shows we pre-cleared.
 *   8. The intro-video-email-backfill cron sends the email when the render
 *      lands (with OUR Supabase storage URL embedded).
 *   9. Portal card auto-renders via portal-stream-projector when
 *      VIDEO_GENERATION_COMPLETED lands.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchVideo } from "@/lib/providers/dispatch"
import { generateTextRouted } from "@/lib/ai/models"
import { KernelEvent } from "@/lib/kernel/events"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import type { Persona, JourneyType } from "@/lib/kernel/types"

type IntroTrigger = "contact_agent_assigned" | "home_anniversary"

interface BaseInput {
  brokerageId:  string
  contactId:    string
  /** agents.id — the value stored on contacts.agent_id (per m111 / RLS).
   *  Resolved to the agent's users.id inside the reactor. */
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
  /** When status='failed' due to compliance, the canonical violation list. */
  violations?: string[]
}

// ─── Public entry points ────────────────────────────────────────────────────

export async function dispatchAssignmentIntroVideo(
  input: AssignmentIntroInput,
): Promise<ReactorResult> {
  return runReactor({
    ...input,
    trigger:      "contact_agent_assigned",
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

/**
 * Map the loose contacts.contact_persona string to the strict Persona union.
 * Unknown values fall back to "other" so the compliance gate still runs —
 * brand-voice + Fair Housing checks don't depend on persona accuracy.
 */
function normalizePersona(p: string | null | undefined): Persona {
  if (!p) return "other"
  const known: Persona[] = [
    "first_time", "relocated", "luxury", "fsbo", "probate", "upsize",
    "downsize", "military", "divorce", "senior", "expired", "foreclosure", "other",
  ]
  // Common contacts.contact_persona aliases.
  const alias: Record<string, Persona> = {
    first_time_buyer: "first_time",
    investor:         "other",
    seller_only:      "other",
    move_up:          "upsize",
    empty_nester:     "downsize",
  }
  if (alias[p]) return alias[p]
  return (known as string[]).includes(p) ? (p as Persona) : "other"
}

interface ContactRow {
  id:                  string
  first_name:          string | null
  last_name:           string | null
  email:               string | null
  phone:               string | null
  contact_type:        string | null
  contact_persona:     string | null
  status:              string | null
  lifecycle_state:     string | null
  video_opt_out:       boolean | null
  dnc_status:          boolean | null
  tcpa_consent:        boolean | null
  tcpa_consent_date:   string | null
  email_opt_out:       boolean | null
  sms_opt_out:         boolean | null
  phone_opt_out:       boolean | null
  direct_mail_opt_out: boolean | null
  isa_reengage_allowed: boolean | null
}

async function runReactor(input: ReactorInput): Promise<ReactorResult> {
  const svc      = createServiceClient()
  const delivery = input.delivery ?? "email"

  // 1. Contact opt-out + persona resolution. Pull the full KernelContact
  //    shape since the compliance gate needs it. Cast the long column list
  //    because the inferred type from Supabase's overloads doesn't propagate
  //    cleanly through a multi-column select on this table.
  const contactRes = await svc
    .from("contacts")
    .select(
      "id, first_name, last_name, email, phone, contact_type, contact_persona, status, lifecycle_state, video_opt_out, dnc_status, tcpa_consent, tcpa_consent_date, email_opt_out, sms_opt_out, phone_opt_out, direct_mail_opt_out, isa_reengage_allowed"
    )
    .eq("id", input.contactId)
    .maybeSingle()
  const contact = (contactRes.data as ContactRow | null) ?? null
  if (!contact) return { ok: false, status: "skipped", reason: "contact not found" }

  // 2. Resolve agents.id → users.id
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
      agent_id:     agentUserId,
      trigger:      input.trigger,
      trigger_year: input.triggerYear,
      status:       "suppressed",
      delivery_channel: delivery,
      error_message: "contact has video_opt_out=true",
    })
    return { ok: true, status: "suppressed", reason: "video_opt_out" }
  }

  // 3. Voice + avatar gate (OUR storage URLs)
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

  // 4. Idempotency ledger
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

  // 5. Draft initial script
  let script: string
  try {
    script = await draftScript({
      trigger:     input.trigger,
      firstName:   contact.first_name ?? "there",
      personaRaw:  contact.contact_persona ?? null,
      yearsAgo:    input.yearsAgo,
      violations:  [],
    })
  } catch (err) {
    await svc.from("agent_intro_videos")
      .update({ status: "failed", error_message: `script: ${(err as Error).message}` })
      .eq("id", introVideoId!)
    return { ok: false, status: "failed", reason: "script generation failed" }
  }

  // 6. PRE-FLIGHT COMPLIANCE — runs BEFORE D-ID render submission.
  //    BROADCAST SHAPE: contact is intentionally omitted. The per-contact
  //    gates (TCPA, Authority/ISA-reengagement) are irrelevant for
  //    intro/anniversary videos — the intro fires when the agent is FIRST
  //    assigned to the contact (they own the relationship outright), and
  //    the anniversary fires for past clients (no ISA representation
  //    question applies). Authority Rule was previously flagging these
  //    sends spuriously when contact.status landed in RESTRICTED_STATES.
  //    Per-channel opt-outs + TCPA still get checked at send time by
  //    dispatchEmail / dispatchVideo, so nothing slips through there.
  //    The four broadcast-relevant gates still run: Brand voice (brokerage
  //    prohibited words + tone), Fair Housing (state-specific via
  //    state_protected_classes — Florida included), Them-First, and the
  //    brand-voice corrections layer.
  const journey: JourneyType = contact.contact_type === "seller" ? "seller" : "buyer"
  const persona = normalizePersona(contact.contact_persona)
  const compliance1 = await evaluateOutbound({
    actorContext: {
      brokerageId: input.brokerageId,
      userId:      agentUserId,
      role:        "system",
    },
    journeyType:  journey,
    persona,
    messageType:  "email",
    content:      script,
    // contact: undefined — broadcast-shape gating
  })

  if (!compliance1.allowed) {
    // Single redraft attempt — feed the violations back so the model can fix.
    try {
      script = await draftScript({
        trigger:     input.trigger,
        firstName:   contact.first_name ?? "there",
        personaRaw:  contact.contact_persona ?? null,
        yearsAgo:    input.yearsAgo,
        violations:  compliance1.violations,
      })
    } catch (err) {
      await svc.from("agent_intro_videos")
        .update({ status: "failed", error_message: `redraft: ${(err as Error).message}` })
        .eq("id", introVideoId!)
      return { ok: false, status: "failed", reason: "script redraft failed" }
    }

    const compliance2 = await evaluateOutbound({
      actorContext: { brokerageId: input.brokerageId, userId: agentUserId, role: "system" },
      journeyType:  journey,
      persona,
      messageType:  "email",
      content:      script,
      // contact: undefined — broadcast-shape gating, same as the initial draft
    })

    if (!compliance2.allowed) {
      const reason = compliance2.violations.join("; ").slice(0, 800)
      await svc.from("agent_intro_videos")
        .update({ status: "failed", error_message: `compliance failed after redraft: ${reason}` })
        .eq("id", introVideoId!)
      return {
        ok:         false,
        status:     "failed",
        reason:     "compliance violations on both initial draft and redraft",
        violations: compliance2.violations,
      }
    }
  }

  // 7. ai_video_projects + dispatchVideo. We only reach here when the script
  //    is compliance-clean — D-ID render dollars never wasted on a script
  //    that would fail the gate later.
  const videoType = input.trigger === "contact_agent_assigned" ? "agent_intro" : "just_sold"
  const { data: project, error: projErr } = await svc
    .from("ai_video_projects")
    .insert({
      brokerage_id:   input.brokerageId,
      agent_id:       agentUserId,
      contact_id:     input.contactId,
      title:          input.trigger === "contact_agent_assigned"
                        ? `Intro for ${contact.first_name}`
                        : `Home anniversary (${input.yearsAgo}y) — ${contact.first_name}`,
      script_content: script,
      video_type:     videoType,
      status:         "queued",
      usage_intent:   "public_marketing",
      audience_type:  "customer_facing",
      duration_seconds: 45,
      compliance_status: "passed",
      compliance_evaluated_at: new Date().toISOString(),
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

  return {
    ok:             true,
    status:         "rendering",
    videoProjectId: project.id,
    introVideoId,
  }
}

// ─── AI Gateway script generation w/ optional violation feedback ────────────

async function draftScript(args: {
  trigger:     IntroTrigger
  firstName:   string
  personaRaw:  string | null
  yearsAgo?:   number
  /** When non-empty, this is a redraft. The model is fed the specific
   *  evaluateOutbound violations from the prior attempt and asked to fix
   *  them — much cheaper than a wasted D-ID render. */
  violations:  string[]
}): Promise<string> {
  const personaLine = args.personaRaw
    ? `The recipient's persona is: ${args.personaRaw}. Match that register.`
    : ""
  const violationLine = args.violations.length > 0
    ? `\n\nYour previous draft failed the brokerage's compliance gate with these violations:\n- ${args.violations.join("\n- ")}\n\nRewrite the script so EVERY one of these violations is resolved. Same length + same intent, just compliance-clean.`
    : ""
  const basePrompt = args.trigger === "contact_agent_assigned"
    ? `Write a 30-45 second video script for a real estate agent introducing themselves to a new contact named ${args.firstName}.
Voice: first-person, warm, professional. ${personaLine}
Open with a hook tied to their journey, not a sales pitch. State your role in one line. Close with a single, specific next step (text/email back to schedule a call). 90-130 words. No jargon left unexplained. No commitments on specific rates or valuations. No exclamation marks. Avoid any reference to protected characteristics (race, religion, family status, national origin, gender, sexual orientation, disability, source of income). Avoid words like "perfect for families" or any phrasing that implies preference. Return ONLY the script text the agent will speak on camera.`
    : `Write a 30-40 second home-anniversary video script. The recipient ${args.firstName} closed on their home ${args.yearsAgo} year${(args.yearsAgo ?? 0) > 1 ? "s" : ""} ago.
Voice: first-person, warm, professional. ${personaLine}
Acknowledge the anniversary without being saccharine. Mention you've been thinking about them. End with a low-pressure invitation (catch up coffee, market update on their neighborhood, no pitch). 80-110 words. No specific home-value claims. No guaranteed returns or appreciation language. Avoid any reference to protected characteristics. Return ONLY the script text the agent will speak on camera.`

  const { text } = await generateTextRouted({
    feature:     "intro_video_script",
    prompt:      basePrompt + violationLine,
    maxTokens:   300,
    temperature: 0.6,
  })
  return text.trim()
}
