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
 *   2. Resolve agents.id (kernel id on contacts.agent_id) → users.id, which the
 *      compliance actor context and dispatchVideo still speak. Every agent_id
 *      column written below stays in the agents class it arrived in.
 *   3. Gate on agent_voice_profiles — elevenlabs_voice_id + a Supabase-hosted
 *      avatar source URL (our storage, never D-ID-side).
 *   4. Insert agent_intro_videos (m121) — partial unique index = idempotency.
 *   5. Resolve the WRITING CONTEXT (persona, journey, newsletter membership).
 *      There is no separate draft step: the compliance loop in 6 makes the first
 *      draft itself, and a second one here was bought and thrown away.
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
 *   7b. REQUEST THE REMOTION ASSEMBLY — BOTH TRIGGERS. The D-ID talking head is
 *      the avatar TRACK, not the deliverable: provider_metadata carries
 *      target_composition_id + input_props + entity_type/entity_id so that when
 *      poll-did-videos completes the job, enqueueAvatarCompositionForProject
 *      wires the CLEAN avatar URL into an AgentTalkingHeadReel render and
 *      render-composition stamps the finished, brand-chromed composite back onto
 *      ai_video_projects.video_url. Before this the key was absent and the
 *      handoff skipped every intro video ever made; the anniversary lane kept
 *      skipping it one wave longer, on the strength of a type that claimed it had
 *      its own composition and had neither a writer nor a reader (see the
 *      tombstone below).
 *   8. DELIVERY, per trigger, both swept by app/api/cron/intro-video-email-backfill
 *      and both waiting on the ASSEMBLED render rather than the intermediate
 *      avatar track:
 *        - contact_agent_assigned → the ONE welcome email (delivery_channel
 *          'email'), released through lib/kernel/client-welcome.ts.
 *        - home_anniversary → the contact's equity_report PORTAL CARD
 *          (delivery_channel 'portal'), stamped with the assembled clip.
 *      Either way the ledger row reaches a terminal status; neither lane leaves
 *      a paid render sitting at 'rendering' with nobody reading it.
 *
 *      NOT via portal-stream-projector. This block used to claim the portal card
 *      "auto-renders via portal-stream-projector when VIDEO_GENERATION_COMPLETED
 *      lands". It does not and never did: lib/portal-stream/event-translator.ts
 *      has no entry for that event type — nor for any video event — so it is not
 *      in PROJECTABLE_EVENT_TYPES and the projector skips it. The lifecycle_events
 *      row this file writes at the end is an AUDIT record, not a delivery.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchVideo } from "@/lib/providers/dispatch"
import { generateTextRouted } from "@/lib/ai/models"
import { KernelEvent } from "@/lib/kernel/events"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { runWithComplianceRedraft } from "@/lib/kernel/compliance-redraft"
import { resolveAgentRecordToUserId } from "@/lib/kernel/agent-identity-resolver"
import { resolveDirectorIdentity, brandBlock } from "@/lib/video/director-content"
import {
  buildIntroCompositionRequest,
  describeIntroCompositionGap,
  type IntroCompositionRequest,
} from "@/lib/video/avatar-render-orchestrator"
import type { Persona, JourneyType } from "@/lib/kernel/types"

type IntroTrigger = "contact_agent_assigned" | "home_anniversary"

interface BaseInput {
  brokerageId:  string
  contactId:    string
  /** agents.id — the value stored on contacts.agent_id (per m111 / RLS).
   *  Written straight through to the ledger + project rows; also resolved to
   *  the agent's users.id inside the reactor for the actor-context consumers. */
  agentId:      string
  /** 'email' (default), 'portal', or 'both' */
  delivery?:    "email" | "portal" | "both"
}

/**
 * THE SITUATION THE SCRIPT IS WRITTEN FROM, and the compliance rules it is
 * written UNDER. Both are INPUTS to the writing prompt — CLAUDE.md §5: "Video
 * scripts are written COMPLIANCE-FIRST — fair housing in the writing prompt,
 * not only in the post-hoc scan."
 *
 * OPTIONAL and ADDITIVE. Omitting it reproduces the prior prompt exactly, which
 * is what the anniversary trigger and any caller that has no situation to give
 * still do. Supplying it is how the conversion lanes satisfy the owner's ruling
 * that content be "personalized and situation, them first" — a welcome video
 * that opens with a generic hello is the defect, not the baseline.
 *
 * The producer is lib/contact-promotion/welcome-situation.ts
 * `buildWelcomeSituation`, which SCREENS every free-text fact against the
 * fair-housing pattern bank before it can land here: a hard (severity 'high')
 * hit drops the fact, softer hits ride through as warnings per the ruling. So
 * the strings arriving here are already scrubbed, and `complianceDirectives`
 * carries the floor plus the market-specific steering ban.
 *
 * This does NOT replace the pre-flight `evaluateOutbound` gate below — that
 * still runs, still redrafts once, and still refuses to spend render credit on
 * a script that fails. It makes the FIRST draft clean rather than hoping the
 * scan catches it.
 */
export interface ScriptSituation {
  /** Them-first fact lines the writer may use. Already fair-housing screened. */
  facts: string[]
  /** Writing constraints, phrased as instructions. Never empty in practice. */
  complianceDirectives: string[]
}

export interface AssignmentIntroInput extends BaseInput {
  /** Optional situational fact set + compliance directives for the writer. */
  situation?: ScriptSituation
}

// TOMBSTONE (orphan doctrine §1.3) — REMOVED: `AnniversaryEquityReelInput` and
// the `equityReel` field on AnniversaryVideoInput.
//
// It described itself as live — "the reactor mints the tracked anniversary QR +
// stamps the EquityReportReel composition id, its inputProps, and the QR onto
// the ai_video_projects row's video_metadata" — and none of that existed. The
// field had NO WRITER (the only occurrence of the identifier `equityReel` in the
// whole tree was its own declaration) and NO READER (`dispatchAnniversaryVideo`
// never forwarded it to runReactor, and `ReactorInput` had no such member, so it
// could not have been read even if someone had passed it). A type that lies
// about behaviour is worse than an absent one: it reads to the next lane as a
// wired capability that only needs a caller.
//
// WHERE THE FUNCTIONALITY WENT — it was already there, twice, and both are live:
//   · lib/video/video-director.ts:283 — selectVideoFormat({ kind: "anniversary" })
//     returns compositionId "EquityReportReel", and commissionVideo stages the
//     ai_video_projects row for it.
//   · lib/kernel/equity-trigger.ts:662 — the Sphere's equity/refi trigger
//     commissions exactly that reel from the SAME computeEquityLine numbers this
//     interface was going to re-carry, with the tracked QR
//     (remotion/EquityReportReel.tsx renders it, remotion_compositions has it
//     registered and active for every tier).
// Re-deriving the request here would have been a second path to one composition
// — §6 — competing with the Director rail that already owns it.
//
// The anniversary lane's OWN video still gets a Remotion assembly: it is the
// avatar-led personal piece to camera, so it rides AgentTalkingHeadReel through
// the same buildIntroCompositionRequest the assignment lane uses (see step 7b
// below). That is the half that WAS missing and is built, rather than a
// duplicate of the data reel.
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
  situation?:  ScriptSituation
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
  // THE WRITER AND THE READER HAD DISAGREED (§6). `delivery` defaulted to
  // "email" for BOTH triggers, while app/api/cron/intro-video-email-backfill —
  // the only consumer of the column — filters `trigger='contact_agent_assigned'`
  // and says in its header that "home-anniversary videos are portal-only by
  // design". So every anniversary row was stamped 'email', no cron ever mailed
  // it, and the row sat at status='rendering' forever: a D-ID render that was
  // paid for, completed, and then read by nobody. The design side of that
  // disagreement wins — the anniversary NOTE is a gated agent proposal that
  // never auto-sends (lib/kernel/anniversary-equity.ts), so auto-mailing its
  // video would have contradicted the gate — and the column now says what the
  // lane actually does. 'portal' is a live value of the delivery_channel CHECK.
  const delivery = input.delivery
    ?? (input.trigger === "home_anniversary" ? "portal" : "email")

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

  // 2. Resolve agents.id → users.id via the canonical resolver
  //    (lib/kernel/agent-identity-resolver.ts — cached at module scope).
  //    input.agentId is already the AGENTS id (it comes off contacts.agent_id),
  //    which is what agent_intro_videos / ai_video_projects want now. This
  //    resolve stays because the users.id is still needed downstream — the
  //    compliance actor context, dispatchVideo, lifecycle_events.actor_user_id —
  //    and because a resolve that comes back empty means the agents row is gone,
  //    so there is nothing to attribute the video to either way.
  const agentUserId = await resolveAgentRecordToUserId(input.agentId)
  if (!agentUserId) {
    return { ok: false, status: "skipped", reason: "agent record not found or missing user_id" }
  }
  const agentRecordId = input.agentId

  if (contact.video_opt_out) {
    await svc.from("agent_intro_videos").insert({
      brokerage_id: input.brokerageId,
      contact_id:   input.contactId,
      agent_id:     agentRecordId,
      trigger:      input.trigger,
      trigger_year: input.triggerYear,
      status:       "suppressed",
      delivery_channel: delivery,
      error_message: "contact has video_opt_out=true",
    })
    return { ok: true, status: "suppressed", reason: "video_opt_out" }
  }

  // 3. Voice + avatar gate (OUR storage URLs). agent_voice_profiles.agent_id is
  //    the same agents.id we already hold — no second round-trip through users.
  const { data: profile } = await svc
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_photo_url, did_video_url")
    .eq("agent_id", agentRecordId)
    .maybeSingle()
  if (!profile?.elevenlabs_voice_id || (!profile.did_photo_url && !profile.did_video_url)) {
    await svc.from("agent_intro_videos").insert({
      brokerage_id: input.brokerageId,
      contact_id:   input.contactId,
      agent_id:     agentRecordId,
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
      agent_id:         agentRecordId,
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

  // 5. THE WRITING CONTEXT, resolved BEFORE any model call.
  //
  // ── ONE DRAFT PER ATTEMPT. THE SECOND ONE WAS PAID FOR AND THROWN AWAY ──────
  // A separate "5. Draft initial script" block used to sit here, calling
  // draftScript({ violations: [] }) into `script`. Its result was never used:
  // runWithComplianceRedraft (lib/kernel/compliance-redraft.ts:58) opens with
  // `let script = await args.draft({ violations: [] })` — it makes the first
  // draft ITSELF — and this function then overwrote `script` with
  // complianceResult.script on the pass path and returned on the fail path. So
  // every welcome and every anniversary video bought TWO scripts and shipped
  // ONE, and the redraft path bought three.
  //
  // That is a §5 defect, not a tidiness one, and it got WORSE the moment the
  // tenant was correctly threaded through: while `brokerageId` was missing the
  // wasted call was merely invisible; once lib/ai/models.ts started writing the
  // ai_tool_usage row, the wasted call became a real billed token charge on the
  // tenant, feeding meter_readings.ai_tokens and the overage projection. A
  // wrong number there is a wrong invoice.
  //
  // The two siblings that share this helper never had the defect — both
  // lib/video/listing-promo-reactor.ts:230 and lib/podcast/auto-producer.ts:336
  // draft ONLY inside the loop — so this file was the outlier, not the pattern.
  //
  // The newsletter lookup and the persona/journey resolution move ABOVE the loop
  // because they are WRITING inputs, not grading inputs: the discarded draft was
  // also the only draft that never saw isNewsletterSubscriber, so the line the
  // recipient was supposed to read only ever appeared on a redraft.
  const journey: JourneyType = contact.contact_type === "seller" ? "seller" : "buyer"
  const persona = normalizePersona(contact.contact_persona)

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
  //
  // Wave 22 — assignment intro is the ONE moment we set context for the
  // ongoing relationship. If this contact is already on the agent's
  // newsletter list, the script mentions the cadence so they recognize
  // the next Tuesday send. We DON'T fire a separate newsletter-welcome
  // trigger — assignment IS the welcome, with the newsletter line added
  // when applicable. The anniversary trigger doesn't need this; recipients
  // are years-deep into the relationship by then.
  let isNewsletterSubscriber = false
  if (input.trigger === "contact_agent_assigned") {
    try {
      const { data: sub } = await svc
        .from("newsletter_subscribers")
        .select("id")
        .eq("contact_id", input.contactId)
        .eq("status", "subscribed")
        .limit(1)
        .maybeSingle()
      isNewsletterSubscriber = !!sub
    } catch { /* best-effort — fall back to non-newsletter script */ }
  }

  let script: string
  let complianceResult: Awaited<ReturnType<typeof runWithComplianceRedraft>>
  try {
    complianceResult = await runWithComplianceRedraft({
    draft: ({ violations }) => draftScript({
      trigger:               input.trigger,
      firstName:             contact.first_name ?? "there",
      personaRaw:            contact.contact_persona ?? null,
      yearsAgo:              input.yearsAgo,
      situation:             input.situation,
      // A REDRAFT IS A SECOND BILLABLE CALL. It was invisible for the same
      // reason the first draft was; both are booked now.
      brokerageId:           input.brokerageId,
      agentUserId,
      agentRecordId,
      isNewsletterSubscriber,
      violations,
    }),
    gate: async (s) => {
      const r = await evaluateOutbound({
        actorContext: { brokerageId: input.brokerageId, userId: agentUserId, role: "system" },
        journeyType:  journey,
        persona,
        messageType:  "email",
        content:      s,
        // contact: undefined — broadcast-shape gating
      })
      return { allowed: r.allowed, violations: r.violations }
    },
    })
  } catch (err) {
    // A GATEWAY FAILURE IS NOT A COMPLIANCE FAILURE, and it must not read as
    // one. The discarded draft used to own this catch; the loop owns it now, so
    // the ledger still lands on 'failed' with the model's own message when the
    // AI Gateway refuses, times out, or the redraft throws.
    await svc.from("agent_intro_videos")
      .update({ status: "failed", error_message: `script: ${(err as Error).message}`.slice(0, 800) })
      .eq("id", introVideoId!)
    return { ok: false, status: "failed", reason: "script generation failed" }
  }
  if (complianceResult.ok) {
    script = complianceResult.script
  } else {
    const reason = complianceResult.violations.join("; ").slice(0, 800)
    await svc.from("agent_intro_videos")
      .update({ status: "failed", error_message: `compliance failed after redraft: ${reason}` })
      .eq("id", introVideoId!)
    return {
      ok:         false,
      status:     "failed",
      reason:     "compliance violations on both initial draft and redraft",
      violations: complianceResult.violations,
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
      agent_id:       agentRecordId,
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

  // ─── ASK FOR THE ASSEMBLY, NOT JUST THE AVATAR ──────────────────────────────
  // OWNER RULING: "the video for the welcome email/portal info for the newly
  // converted lead to contact, finishes and then embeds into the email. usually
  // the did avatar url is taken from the user's settings (twin studio created),
  // then remotion assembles the complete video together."
  //
  // Every part of that was built except the request. Twin Studio writes
  // agent_voice_profiles, presenter-media resolves the avatar off it, step 3
  // above gates on it, /api/did/generate-video submits, poll-did-videos polls,
  // and on completion poll-did-videos calls enqueueAvatarCompositionForProject —
  // which enqueues the Remotion composition with the avatar URL wired into
  // input_props. But that handoff fires ONLY when the project declares
  // provider_metadata.target_composition_id, and the ONLY writers of that key
  // were the listing-presentation path and the Director rail. This file had ZERO
  // occurrences of it, so the welcome video was the one avatar lane that skipped
  // the handoff: `skipped: "no target_composition_id — not a composition
  // request"`, forever, silently. The deliverable was a bare D-ID talking head —
  // no Remotion assembly, no brand chrome, no bookends, no outro CTA.
  //
  // BOTH TRIGGERS, ONE REQUEST. This was assignment-only while
  // `AnniversaryEquityReelInput` sat above claiming the anniversary lane had its
  // own intended composition. It did not: that type had no writer and no reader
  // (see the tombstone at the top of this file), so "the anniversary declares
  // EquityReportReel" was a comment, not a wire, and the anniversary video
  // shipped as the same bare talking head the welcome video used to ship as —
  // the identical defect, one trigger over. The data-driven equity reel lives on
  // the Director rail (lib/video/video-director.ts selectVideoFormat, commissioned
  // by lib/kernel/equity-trigger.ts) and is untouched by this.
  //
  // The eyebrow and CTA differ per trigger and come out of the ONE chrome table
  // in lib/video/avatar-render-orchestrator.ts; a trigger with no chrome row
  // yields no request rather than a guessed one.
  //
  // COMPLIANCE SURVIVES THE STEP (§5). This runs AFTER the pre-flight
  // evaluateOutbound + redraft gate above, and `script` here is the gated text.
  // The only client-facing string the assembly adds is the caption strip, which
  // is cut VERBATIM from that gated script — the assembly authors nothing, so
  // there is no copy in the finished video that the fair-housing gate never saw.
  let compositionRequest: IntroCompositionRequest | null = null
  {
    try {
      const identity = await resolveDirectorIdentity(svc, input.brokerageId, agentUserId)
      const params = {
        projectId:     project.id,
        script,
        agentName:     identity.agentName,
        agentPhotoUrl: identity.agentPhotoUrl,
        brand:         brandBlock(identity),
        trigger:       input.trigger,
      }
      compositionRequest = buildIntroCompositionRequest(params)
      if (!compositionRequest) {
        // The builder asks the SAME content-contract question render-composition
        // asks, so a null here means the render would have been CANCELLED. Say
        // which prop was missing rather than parking the welcome email behind a
        // composite that was never coming; the D-ID cut stands as the deliverable.
        console.warn(
          `[intro-video-reactor] project ${project.id}: no Remotion assembly requested — ` +
          `${describeIntroCompositionGap(params).join(", ") || "unknown"} could not be established. ` +
          `The D-ID cut will be delivered un-assembled.`
        )
      }
    } catch (e) {
      console.warn(`[intro-video-reactor] project ${project.id}: assembly request skipped — ${(e as Error).message}`)
    }
  }

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
  if (!submission.success || !submission.messageId) {
    // BOTH ledgers, not just one. The ai_video_projects row was inserted above
    // at 'queued'; leaving it there while agent_intro_videos says 'failed' is
    // two tables disagreeing about the same render, and the videos board reads
    // the one that still claims to be in flight.
    await svc.from("agent_intro_videos")
      .update({ status: "failed", error_message: `dispatchVideo: ${submission.error ?? "no provider job id returned"}` })
      .eq("id", introVideoId!)
    await svc.from("ai_video_projects")
      .update({
        status:        "failed",
        error_message: `Render not started: ${submission.error ?? "the video provider returned no job id"}`.slice(0, 800),
      })
      .eq("id", project.id)
    return { ok: false, status: "failed", reason: submission.error ?? "dispatchVideo failed" }
  }

  // ─── LINK THE RENDER TO THE POLLER ──────────────────────────────────────────
  // Submitting is not the same as being pollable. app/api/cron/poll-did-videos
  // selects status='generating' AND provider_job_id IS NOT NULL AND
  // provider_metadata->>provider='did'; a row left at 'queued' with no job id
  // matches none of it. Without this stamp D-ID renders the video and bills for
  // it, the poller never adopts the job, video_url is never written, and
  // app/api/cron/intro-video-email-backfill — which waits on project.video_url
  // — never sends. The submission half was here; the submission→poll link was
  // not, so every intro and anniversary reel rendered into a void.
  // `mode` is read back by that cron to choose /clips vs /talks (a wrong guess
  // makes it take a 404 as terminal on a live render).
  const { error: stampError } = await svc
    .from("ai_video_projects")
    .update({
      status:          "generating",
      provider_job_id: submission.messageId,
      provider_status: "processing",
      video_provider:  "did",
      provider_metadata: {
        provider:       "did",
        mode:           profile.did_video_url ? "clip" : "talk",
        talk_id:        submission.messageId,
        intro_video_id: introVideoId,
        trigger:        input.trigger,
        // target_composition_id + input_props + entity_type/entity_id. THE
        // MISSING LINK: without these keys enqueueAvatarCompositionForProject
        // skips this project and the Remotion assembly is never requested.
        // Spread last and possibly empty, so the anniversary lane's metadata is
        // byte-identical to what it was before this change.
        ...(compositionRequest ?? {}),
      },
      error_message: null,
    })
    .eq("id", project.id)

  if (stampError) {
    // The D-ID job is REAL but unlinked, so it cannot be polled. Left at
    // 'queued' on purpose — that is the truthful "staged, no worker took it"
    // state the 2h reaper owns — and the job id is logged so the render can be
    // reattached by hand. Marking it 'failed' would be a second false claim.
    console.error(
      `[intro-video-reactor] project ${project.id} could not be linked to D-ID job ${submission.messageId}: ${stampError.message}`
    )
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
  /**
   * THE SITUATION, AND THE RULES, AS INPUTS TO THE WRITING (§5).
   *
   * Owner ruling: "we only sent content to leads and contacts that are
   * personalized and situation, them first messaging." A welcome video that
   * opens "Hi there, great to have you" is the defect — the platform already
   * knows why this person is here.
   *
   * Both halves are rendered into the prompt BELOW the role line and ABOVE the
   * length rules, so the model reads what it may say and what it may not before
   * it reads how long to be. The facts arrive already fair-housing screened by
   * lib/contact-promotion/welcome-situation.ts; the directives are the floor
   * (protected classes, "perfect for", steering proxies, no price promises)
   * plus, when a market is named, the explicit "name the place, say nothing
   * about its people" rule.
   *
   * Omitted → the prompt is byte-identical to the prior one.
   */
  situation?:  ScriptSituation
  /**
   * THE TENANT THE SPEND BELONGS TO. lib/ai/models.ts writes the
   * `ai_tool_usage` row only when `brokerageId` is present; without it the call
   * is not ledgered anywhere and the caller is responsible for booking it. No
   * caller here ever did, so every intro / anniversary script and every
   * compliance redraft was unbilled and uncapped spend against a ledger that
   * feeds `meter_readings.ai_tokens` and the overage projection.
   */
  brokerageId?: string | null
  /** users.id — `ai_tool_usage.user_id` FKs to users. */
  agentUserId?: string | null
  /** agents.id — `ai_tool_usage.agent_id` FKs to agents. The two are DISJOINT. */
  agentRecordId?: string | null
  /** Wave 22 — when the contact is already on the newsletter list at
   *  assignment time, the script mentions the weekly cadence so they
   *  recognize the next Tuesday send. Ignored for anniversary trigger. */
  isNewsletterSubscriber?: boolean
  /** When non-empty, this is a redraft. The model is fed the specific
   *  evaluateOutbound violations from the prior attempt and asked to fix
   *  them — much cheaper than a wasted D-ID render. */
  violations:  string[]
}): Promise<string> {
  const personaLine = args.personaRaw
    ? `The recipient's persona is: ${args.personaRaw}. Match that register.`
    : ""
  // The situation block. THEM-FIRST is stated as an instruction, not assumed:
  // the gate scores the produced script on client-focused pronouns, so the
  // writer is told the target rather than being graded against it afterwards.
  const situationBlock = args.situation && args.situation.facts.length > 0
    ? `\n\nWHAT YOU ALREADY KNOW ABOUT THEM — build the script around THIS, not around yourself. Speak to their situation in their words, and never read a fact back as a label:\n- ${args.situation.facts.join("\n- ")}\n\nEvery sentence should be about THEM and what happens next for them. Do not list your credentials, your brokerage's history, or your production numbers.`
    : ""
  // The compliance block, written as WRITING RULES. This is the §5 requirement
  // in its literal form — the rules reach the model that composes the script,
  // not only the scan that grades it.
  const complianceBlock = args.situation && args.situation.complianceDirectives.length > 0
    ? `\n\nRULES THAT GOVERN WHAT YOU MAY WRITE (these bind the script itself — a script that breaks one is rewritten, not published):\n- ${args.situation.complianceDirectives.join("\n- ")}`
    : ""
  // Wave 22 — newsletter cadence reference (assignment trigger only).
  const newsletterLine = args.trigger === "contact_agent_assigned" && args.isNewsletterSubscriber
    ? "They're also signed up for the weekly newsletter — mention they'll get the first issue next Tuesday so they recognize it in their inbox. Keep it to one short line."
    : ""
  const violationLine = args.violations.length > 0
    ? `\n\nYour previous draft failed the brokerage's compliance gate with these violations:\n- ${args.violations.join("\n- ")}\n\nRewrite the script so EVERY one of these violations is resolved. Same length + same intent, just compliance-clean.`
    : ""
  const basePrompt = args.trigger === "contact_agent_assigned"
    ? `Write a 30-45 second video script for a real estate agent introducing themselves to a new contact named ${args.firstName}.
Voice: first-person, warm, professional. ${personaLine} ${newsletterLine}${situationBlock}${complianceBlock}
Open with a hook tied to their journey, not a sales pitch. State your role in one line. Close with a single, specific next step (text/email back to schedule a call). 90-130 words. No jargon left unexplained. No commitments on specific rates or valuations. No exclamation marks. Avoid any reference to protected characteristics (race, religion, family status, national origin, gender, sexual orientation, disability, source of income). Avoid words like "perfect for families" or any phrasing that implies preference. Return ONLY the script text the agent will speak on camera.`
    : `Write a 30-40 second home-anniversary video script. The recipient ${args.firstName} closed on their home ${args.yearsAgo} year${(args.yearsAgo ?? 0) > 1 ? "s" : ""} ago.
Voice: first-person, warm, professional. ${personaLine}
Acknowledge the anniversary without being saccharine. Mention you've been thinking about them. End with a low-pressure invitation (catch up coffee, market update on their neighborhood, no pitch). 80-110 words. No specific home-value claims. No guaranteed returns or appreciation language. Avoid any reference to protected characteristics. Return ONLY the script text the agent will speak on camera.`

  const { text } = await generateTextRouted({
    feature:     "intro_video_script",
    prompt:      basePrompt + violationLine,
    maxTokens:   300,
    temperature: 0.6,
    // BOOK THE SPEND. `?? null` and not `?? ""` — these land in uuid columns and
    // Postgres refuses '' with 22P02, which logAIUsage swallows into a console
    // line, so a malformed id would vanish from the ledger exactly like the
    // missing brokerage did.
    brokerageId: args.brokerageId ?? null,
    ...(args.agentUserId   ? { userId:  args.agentUserId }   : {}),
    ...(args.agentRecordId ? { agentId: args.agentRecordId } : {}),
  })
  return text.trim()
}
