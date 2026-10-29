/**
 * lib/contact-promotion/conversion-welcome.ts
 *
 * THE ONE THING THAT HAPPENS WHEN A LEAD BECOMES A CONTACT.
 *
 * OWNER RULING, verbatim: "the welcome email is the first on conversion that has
 * the welcome with portal info to also inclue the embedded personal video."
 * And earlier: "the video for the welcome email/portal info for the newly
 * converted lead to contact, FINISHES AND THEN EMBEDS into the email."
 *
 * Read together they settle a question a previous lane left explicitly open (see
 * the `welcome_avatar_video` entry in lib/kernel/manager-registry.ts — that entry
 * now itself ends "RESOLVED 2026-08-25 BY OWNER RULING" and names this file as
 * the shared entry point both conversion lanes call; the open question it
 * records resolving is the one this file exists to answer):
 *
 *   ONE welcome email. It is the FIRST thing a converted contact receives. It
 *   carries the portal information AND the embedded personal avatar video. The
 *   EMAIL waits for the video. The video does not arrive in a second, later mail.
 *
 * ── THE THREE SENDERS THAT BECAME ONE (§1.1) ────────────────────────────────
 *
 *   1. lib/portal/portal-invite-core.ts — an IMMEDIATE Supabase OTP magic-link
 *      mail plus a hardcoded generic portal greeting. This was the actual "first"
 *      email a converted contact got, and its body ("Hi ${first_name}, your client
 *      portal is ready. Log in to track your journey.") is precisely what the
 *      them-first ruling forbids. RETIRED as a welcome: the greeting is gone
 *      (tombstone in that file names its survivor), and the magic link is now
 *      suppressed on conversion whenever a real welcome will go out.
 *   2. lib/kernel/client-welcome.ts::ensureClientWelcome — THE SURVIVOR. Chosen on
 *      evidence: it is the only one of the three that already carried a portal
 *      block, an agent signature, a video block and compliance gating, plus the
 *      per-contact idempotency tag. It ran on NEITHER conversion lane.
 *   3. /api/cron/intro-video-email-backfill — a SEPARATE, LATER email carrying the
 *      video once the render landed. It no longer authors an email; it is now the
 *      SWEEPER that releases the survivor's one welcome.
 *
 * ── THE ACCESS GRANT AND THE EMAIL ARE DIFFERENT THINGS ─────────────────────
 *
 * `portal_contact_invites` — the row that IS the portal access — is created FIRST,
 * immediately, before any video is commissioned and regardless of what happens to
 * it. A contact can never lose portal access because a render failed, was
 * suppressed, or was never possible. Only the EMAIL waits.
 *
 * ── WHEN THE VIDEO CAN NEVER ARRIVE (this is the DEFAULT case today) ────────
 *
 * `agent_voice_profiles` holds ZERO rows on hrvaqgvukzxfskkcrwbt, so the intro
 * reactor's honest refusal — "agent voice/avatar profile not configured" — is what
 * every conversion hits right now. An email that waits for a video that cannot
 * come is worse than one that goes without it, so:
 *
 *   THE WAIT IS ARMED ONLY BY A RENDER THAT IS ACTUALLY IN FLIGHT.
 *
 * `ensureWelcomeAvatarVideo` returns `commissioned` / `already_commissioned` ONLY
 * after the reactor's `agent_intro_videos` ledger row exists — that row is the
 * thing the sweeper later finds. Every other outcome (no voice profile, contact
 * opted out of video, excluded contact type, a hard fair-housing refusal, a
 * provider failure, the spine unavailable) means no row will ever land in the
 * sweeper's set, so the welcome is sent RIGHT NOW, with no video block and no
 * mention of video. That is not a degradation of the ruling; it is the only
 * reading of it that terminates.
 *
 * ── AND WHEN THE RENDER STALLS: THE DEADLINE ────────────────────────────────
 *
 * A render can be in flight and still never finish — a provider that never calls
 * back, a row left at 'queued' by a crashed process, an assembly nobody enqueued.
 * So the wait is BOUNDED by `WELCOME_VIDEO_WAIT_MS`, measured from the
 * `agent_intro_videos` row's own `created_at` (i.e. from conversion). Past it the
 * sweeper sends the welcome WITHOUT the video and stamps the ledger row 'failed'
 * with the reason. Nothing waits forever, and nothing waits silently.
 *
 * The bound is NOT a new number. It is `COMPOSITE_WAIT_MS` — the same two hours
 * lib/video/avatar-render-orchestrator already uses for an assembly nobody picked
 * up, which is itself the video pipeline reaper's bound. §6: one vocabulary per
 * function; a second timeout constant is a second answer to the same question.
 * Measuring from conversion rather than from the avatar track's completion makes
 * it ONE end-to-end bound covering the D-ID render AND the Remotion assembly,
 * which is what "the welcome email is the first thing they receive" needs.
 *
 * ── ALL FOUR CONVERTERS CALL THIS, AND NONE HOLDS A COPY (§6) ───────────────
 *
 *   · lib/contact-promotion/promote-lead-to-contact.ts  (manual, direct-intake lane)
 *   · lib/kernel/lead-acquisition-handlers.ts::handleLeadAssigned (automatic)
 *   · lib/kernel/crm.ts::convertLeadToContact (manual, lead-desk lane — wired wave 49;
 *     this THIRD converter had no welcome of any kind until then, not even the retired
 *     generic sphere one, because it never dispatches KernelEvent.LEAD_CONVERTED_TO_CONTACT)
 *   · lib/ai-isa/convert-buyer-lead-on-intent.ts::convertBuyerLeadOnIntent (AI ISA,
 *     buyer lead converted on positive intent — wired wave 49 pt.2; this FOURTH
 *     converter had its OWN duplicate welcome — a direct "buyer_welcome_reel_handoff"
 *     signal to the Asset Manager, a second video pipeline feeding a human-gated
 *     email with no real portal grant. Retired with a tombstone at
 *     lib/kernel/manager-signals.ts and lib/kernel/signal-registry.ts naming this
 *     file:line as the survivor)
 *
 * That file records how they drifted before: the history carry was wired into the
 * manual lane only. Two things were still lane-shaped when this was written and
 * are now merged here — the automatic lane granted the portal only to
 * buyer/seller/investor while the manual lane used the documented
 * PORTAL_EXCLUDED_CONTACT_TYPES exclusion, and only the manual lane passed the
 * assigned agent's already-resolved users.id.
 *
 * ── NOT DOUBLE-SENDING ─────────────────────────────────────────────────────
 *
 * Three senders becoming one must not become two on a retried conversion. Three
 * independent guards, none of them new:
 *   1. the manual converter returns early on `leads.contact_id` (Step 2);
 *   2. the reactor's `uq_agent_intro_videos_per_trigger` partial unique index
 *      dedupes the render BEFORE any spend;
 *   3. `ensureClientWelcome` refuses when an `agent_client_messages` row already
 *      carries the welcome rationale tag — and it FAILS CLOSED when that ledger
 *      read is refused, because a missing welcome is recoverable and a duplicate
 *      is not. This module adds no fourth check; it respects that one.
 *
 * NEVER THROWS. The conversion tail is best-effort by construction: the contact
 * exists and the lead is deactivated before any of this runs.
 *
 * ── WAVE 144 (lane 144F) — THE WELCOME NO LONGER WAITS; THE VIDEO FOLLOWS ────
 *
 * OWNER RULING 13 (wave 144), which supersedes the 2026-08-25 "the email waits
 * for the video" reading above for the TIMING (the one-welcome rule stands):
 * "the moment a lead / new form input becomes a CONTACT, it gets its portal
 * invitation (welcome email with a valid activation path, correct tenant/agent
 * identity) plus the agent's personal welcome video when ready and authorized;
 * dispatch the immediately available welcome and follow with the video when the
 * real asset is ready; raw leads never get the portal invite; no duplicate
 * invite/first-touch on retried events."
 *
 * So the welcome goes NOW, always — with the portal door, from the assigned
 * agent — and a render in flight no longer holds it for up to two hours. When
 * the real asset lands, the sweeper sends ONE short follow-up carrying it
 * (lib/contact-promotion/welcome-avatar-video.ts deliverWelcomeVideoFollowUp),
 * never a second welcome. `decideWelcomeTiming` now answers whether a video
 * FOLLOWS; `classifyPendingWelcome` takes the welcome's own state so it can
 * tell a row whose welcome already went (follow up with the video, or close it)
 * from a pre-wave-144 row whose welcome is still held (release it as before).
 * Live on 2026-10-25: agent_intro_videos = 0 rows, agent_voice_profiles = 0 —
 * no held welcome exists to migrate.
 *
 * ── WAVE 145 (lane 145E) — THE WELCOME WAITS FOR THE AGENT'S VIDEO AGAIN ─────
 *
 * OWNER RULING 17 (2026-10-27), which REVERSES ruling 13's timing: "The welcome
 * email with the login info for the newly converted contact has to wait for the
 * avatar welcome email from the agent to finish and auto send after." The one
 * sequence, in order, idempotent end to end:
 *
 *   CONVERSION → agent relationship confirmed (contacts.agent_id, by the converter)
 *   → portal invite PREPARED (portal_contact_invites — the access, FIRST, always)
 *   → the agent's personal avatar video GENERATED (the one avatar spine) or
 *     SELECTED (the agent's standing personal video — lib/kernel/welcome-personal-
 *     video.ts, scope agent_personal) → VALIDATED (playable + compliance-passed:
 *     resolvePlayableVideo; the assembled cut, never the bare track while the
 *     assembly is pending)
 *   → ONE welcome email with the secure, password-less activation path (the
 *     portal door — sign-in by a one-time link to the invited email; the first
 *     access consumes the invite) + the approved video, AUTO-SENT when ready
 *     (/api/cron/intro-video-email-backfill releases it) → status + evidence
 *     (agent_intro_videos status, the welcome's agent_client_messages row, the
 *     action ledger).
 *
 * FAILURE is a visible, recoverable state with a HUMAN-APPROVED exception —
 * never a welcome falsely sent without the video, never silently pending forever:
 * no video possible / the render stalls past the deadline → the welcome is HELD
 * and an approval item (`welcome_without_video`, the ONE approval queue) asks a
 * person to approve sending it without the video (or to fix the video, which
 * then rides it). An approved exception is released by the sweeper; a rejected
 * one sends nothing. The contact's OWN choices still send at once: video opt-out,
 * or a stated accessibility preference for a format without video (contract C3 —
 * read through lib/contacts/accessibility-preferences.ts, never inferred).
 * The wave-144 follow-up arms below stay only for rows whose welcome already
 * went under ruling 13 (a transition path; nothing new reaches them).
 *
 * ── WAVE 146 (lane 146C) — THE WELCOME IS IMMEDIATE; THE VIDEO LIVES IN THE PORTAL ──
 *
 * OWNER RULING 6 (2026-10-29), which OVERRULES ruling 17 above: "Welcome email
 * shouldn't wait for a video so send welcome email out right away and put the
 * welcome personal video in-app contact portal so the contact sees it right
 * away." — "Welcome video is automatically sent in the portal regardless of the
 * contact's preferences." The one sequence now, in this order:
 *
 *   CONVERSION → lead-domain sends suppressed (the converter's deactivateLead,
 *   before this runs) → relationship confirmed (contacts.agent_id) → portal
 *   invite (portal_contact_invites — the access, FIRST) → the ONE welcome email
 *   SENT NOW (lib/kernel/client-welcome.ts — the portal door, a one-time sign-in
 *   link, never a password; a standing personal video rides it only if one is
 *   already validated) → the welcome CLAIMS the contact's first touch (the
 *   shared ledger, lib/campaign-sequences/first-touch-coordination.ts — so
 *   speed-to-lead's contact half and the welcome drip never greet them twice)
 *   → the agent's personal video COMMISSIONED, after the send (the one avatar
 *   spine, delivery 'portal') → it appears in THIS contact's portal the moment it
 *   is validated (lib/portal/welcome-video.ts portalWelcomeVideoFor — contract
 *   C3) → the sweeper reads it back through that reader and records it delivered.
 *
 * Nothing the video does can hold, cancel or follow the welcome: no
 * `hold_for_video`, no `welcome_without_video` approval item, no follow-up mail.
 * Channel preferences (video_opt_out) and a stated no-video format no longer
 * stop the commission — the portal video is a standard part of the contact's
 * portal journey, not a marketing message; accessibility preferences shape its
 * PLAYBACK (transcript open, never autoplay). A video that fails is recorded,
 * retried safely and told to a person (lib/portal/welcome-video.ts
 * recoverPortalWelcomeVideo); the portal never shows a false complete.
 * Live on 2026-10-29 (hrvaqgvukzxfskkcrwbt): agent_intro_videos 0 rows,
 * welcome_without_video items 0, client_welcome_v1 messages 0, converted leads
 * 0 — nothing held under ruling 17 needs a transition, so its doors are retired.
 */

import { COMPOSITE_WAIT_MS } from "@/lib/video/avatar-render-orchestrator"
import { resolveWelcomeManagers, welcomeJourneyFor } from "@/lib/kernel/client-welcome"
import { grantPortalAccessForPromotedContact } from "./portal-access"
import { ensureWelcomeAvatarVideo, type WelcomeAvatarVideoReason } from "./welcome-avatar-video"
import type { WelcomeOrigin } from "./welcome-situation"
import { claimFirstTouch } from "@/lib/campaign-sequences/first-touch-coordination"

export type { WelcomeOrigin } from "./welcome-situation"

/**
 * How long the agent's personal welcome render may take, measured from the moment it was commissioned, before the portal
 * stops reading it as "preparing" and the manager's recovery takes it (lib/portal/welcome-video.ts). Under owner ruling 6 the
 * welcome EMAIL never waits on it.
 *
 * Deliberately the SAME constant the assembly reader already bounds on — §6: one vocabulary per function, not a second timeout.
 */
export const WELCOME_VIDEO_WAIT_MS = COMPOSITE_WAIT_MS

// ─── DECISION 1: does the email wait? (PURE) — WAVE 146: NEVER ──────────────

export type WelcomeTimingAction =
  /** The ONE welcome goes NOW, whatever the video does (owner ruling 6). The only value. */
  | "send_now"

// TOMBSTONE (wave 146, lane 146C — owner ruling 6 OVERRULES ruling 17): the `hold_for_video` and `hold_for_exception` arms of
// WelcomeTimingAction are gone. The welcome no longer waits for, or is held over, the agent's video; the video's own lifecycle
// (preparing → validated → in the portal, or failed → retried / told to a person) lives in lib/portal/welcome-video.ts
// (portalWelcomeVideoFor / classifyPortalWelcomeVideo / recoverPortalWelcomeVideo — contract C3).

export interface WelcomeTiming {
  action: WelcomeTimingAction
  /** Operator-readable justification: where the video goes instead. Always populated. */
  reason: string
}

/**
 * THE TIMING RULE (owner ruling 6, wave 146), as a pure function of the commissioning outcome: the welcome is sent NOW for every
 * outcome — a render in flight, a refused or impossible render, the contact's channel opt-out, a stated no-video format, an
 * excluded type, a reason nobody has written yet. The outcome only decides what the REASON says about the portal video.
 */
export function decideWelcomeTiming(video: {
  commissioned: boolean
  reason: WelcomeAvatarVideoReason | string
  /** The agent's standing personal video is ready and validated — it shows in the portal (and may ride the email) now. */
  standingVideoReady?: boolean | null
  /** Contract C3 (wave 145): the contact STATED a format without video — the portal opens its transcript first; never a wait. */
  statedNoVideo?: boolean | null
}): WelcomeTiming {
  const portal = video.commissioned
    ? "the agent's personal video is rendering and appears in the contact's portal the moment it is validated"
    : video.reason === "excluded_contact_type"
      ? "this contact type gets no welcome video"
      : video.standingVideoReady
        ? `no personal render for this contact (${video.reason || "unknown"}) — the agent's standing personal video shows in the portal now`
        : `the personal video could not be commissioned (${video.reason || "unknown"}) — the portal shows nothing false; the manager retries or tells a person`
  const format = video.statedNoVideo ? " (their stated text format opens the transcript first)" : ""
  return { action: "send_now", reason: `the welcome email goes now and never waits for a video (owner ruling 6); ${portal}${format}` }
}

// ─── THE SWEEPER'S SET ───────────────────────────────────────────────────────

/** The non-terminal `agent_intro_videos.status` values — the welcome sweeper's whole set. */
export const PENDING_WELCOME_STATUSES: readonly string[] = ["queued", "rendering"]

// TOMBSTONE (wave 146, lane 146C — §1.3, the functionality moved): `classifyPendingWelcome`, `PendingWelcomeAction`,
// `PendingWelcomeVerdict` and `WelcomeMessageState`. They decided when the sweeper RELEASED the welcome email with or without
// the video (ruling 17), sent the wave-144 video follow-up mail (ruling 13) or filed the `welcome_without_video` exception.
// Under owner ruling 6 the welcome went at conversion and the video lives in the portal, so the sweeper's one decision is now
// lib/portal/welcome-video.ts classifyPortalWelcomeVideo (wait / place / fail / skip — the deadline still checked BEFORE the
// assembly gate). Live on 2026-10-29: agent_intro_videos 0 rows — no held welcome or pending follow-up needed a transition.

// ─── THE LIVE ENTRY POINT EVERY CONVERTER CALLS ──────────────────────────────

export interface ConversionWelcomeParams {
  /** contacts.id — the PRIMARY key (contacts also carries a secondary `contact_id`). */
  contactId: string
  /** agents.id of the assigned agent. `agents.id` and `users.id` are DISJOINT. */
  agentId: string
  /** users.id of that agent when the caller already resolved it (saves a read). */
  agentUserId?: string | null
  brokerageId: string
  /** Canonical contacts.contact_type. */
  contactType?: string | null
  firstName?: string | null
  lastName?: string | null
  /**
   * Set when this contact came from an open house rather than an ordinary lead
   * conversion (owner ruling 2026-09-10, wave 51: "contact came from open house —
   * same welcome email but mentions the open house with welcome video/portal
   * invite"). One context field on THIS path — never a second implementation.
   */
  origin?: WelcomeOrigin | null
}

export interface ConversionWelcomeResult {
  /** A portal_contact_invites row exists for this contact. The access, not the email. */
  portalGranted: boolean
  /**
   * WHY the grant did or did not happen — portal-access.ts's machine-readable reason
   * (`granted`, `no_email_on_file`, `excluded_contact_type`, …). Carried so the door
   * that added the contact can REPORT a contact who got no invite (wave 94), rather
   * than reading `portalGranted: false` as one undifferentiated failure.
   */
  portalReason: string
  /** Was the invite core's own OTP mail used as the delivery (no agent welcome due)? */
  magicLinkSent: boolean
  /**
   * The manager(s) that pick this welcome up, owner first. EMPTY is the exact
   * complement of "the magic link was armed" — that is the one-email invariant,
   * stated as data rather than left implicit in a boolean.
   */
  welcomeManagers: string[]
  /**
   * Which journey map the welcome is written from — buyer / seller / both /
   * lifetime, the same four values the welcome REEL routes on. NULL when no
   * manager picks this contact up. Derived from the manager set, never from
   * contact_type a second time (§6).
   */
  welcomeJourney: string | null
  videoReason: WelcomeAvatarVideoReason
  /** Wave 146: always "send_now" — the welcome never waits for the video (owner ruling 6). */
  timing: WelcomeTimingAction
  /** Where the video goes instead. Always populated. */
  timingReason: string
  /** `WelcomeSendState` of the welcome sent on this call; null when no welcome is due (or it could not be attempted). */
  emailState: string | null
  /** Wave 146: the welcome CLAIMED the contact's first touch on the shared ledger (contacts.first_touched_at). */
  firstTouch: { claimed: boolean; channel: string | null; reason: string }
  /** Wave 146 (contract C3): the portal welcome video as commissioned on this call — it lives in the portal, never in a mail. */
  portalVideo: { commissioned: boolean; reason: WelcomeAvatarVideoReason; videoProjectId: string | null; recovery: string | null }
  /** Wave 145 (contract C3): the contact's STATED accessibility preferences the welcome honours (null = unread; defaults apply). */
  accessibility: WelcomeAccessibility | null
  /** Everything the operator needs. NEVER a reason to unwind a committed conversion. */
  warnings: string[]
}

// ─── CONTRACT C3 (wave 145): THE CONTACT'S STATED ACCESSIBILITY PREFERENCES ──

/**
 * What the welcome honours from the contact's OWN stated preferences (owner ruling 18 — explicit, user-controllable fields;
 * never inferred from age or any demographic). Read ONLY through lane 145H's reader
 * (lib/contacts/accessibility-preferences.ts readAccessibilityPreferences — contract C3); this is the welcome's view of it.
 */
export interface WelcomeAccessibility {
  /** The contact stated a communication format WITHOUT video (text / written). Wave 146: it shapes the PORTAL's playback (the
   *  transcript opens first) — it no longer stops the commission or delays anything (owner ruling 6). */
  statedNoVideo: boolean
  /** Captions / a transcript were asked for — the welcome carries the video's own script as text under it. */
  transcript: boolean
  /** Larger text was asked for — the welcome body renders at a larger size. */
  largeText: boolean
  /** contacts.preferred_language as H's reader returns it (the copy and the video already resolve language through the one
   *  language resolver — carried for the record, not re-applied here). */
  language: string | null
  /** True when any accessibility preference was actually stated (false = the defaults; nothing about the person was guessed). */
  stated: boolean
}

/**
 * The contact's stated accessibility preferences, through lane 145H's ONE reader (contract C3 —
 * lib/contacts/accessibility-preferences.ts readAccessibilityPreferences) and H's ONE adaptation table (accessibilityAdaptations —
 * "what every reader applies"; no second parser of the stored vocabulary here, §6). NEVER THROWS: an absent module / column
 * (m868 not applied), a refused read or a throw returns null plus the reason, and the welcome uses the defaults (nothing
 * inferred). Used by deliverConversionWelcome and by the composer lib/kernel/client-welcome.ts ensureClientWelcome (large text /
 * the transcript) — every welcome path reads the same answer.
 *   statedNoVideo ← communication_format 'text' (the person asked for written communication)
 *   transcript    ← captions OR transcript OR a screen-reader portal (H's table) — the welcome carries the video's own script as
 *                   text; burnt-in captions are not something this path can guarantee (a published blind spot)
 *   largeText     ← text_size large / extra_large
 */
export async function readWelcomeAccessibility(
  svc: unknown,
  a: { brokerageId: string; contactId: string },
): Promise<{ accessibility: WelcomeAccessibility | null; blindSpot: string | null }> {
  if (!a.brokerageId || !a.contactId) return { accessibility: null, blindSpot: "accessibility: no brokerage / contact to read" }
  try {
    const { readAccessibilityPreferences, accessibilityAdaptations } = await import("@/lib/contacts/accessibility-preferences")
    const read = await readAccessibilityPreferences(svc as never, a.brokerageId, a.contactId)
    if (!read.ok) return { accessibility: null, blindSpot: `accessibility preferences unreadable (${read.error}) — defaults apply` }
    const adapt = accessibilityAdaptations(read.preferences)
    return {
      accessibility: {
        statedNoVideo: adapt.format === "text",
        transcript: adapt.transcript || adapt.captions,
        largeText: adapt.textSize !== "standard",
        language: read.language ?? null,
        stated: adapt.stated,
      },
      blindSpot: null,
    }
  } catch (e) {
    return { accessibility: null, blindSpot: `accessibility preferences unavailable (${e instanceof Error ? e.message : String(e)}) — defaults apply` }
  }
}

// TOMBSTONE (wave 146, lane 146C — owner ruling 6 OVERRULES ruling 17; §1.3, the functionality is gone by ruling and its
// remaining duty moved): `WELCOME_EXCEPTION_ITEM_TYPE` ('welcome_without_video'), `WelcomeExceptionFiling`,
// `holdWelcomeForException` and `releaseApprovedWelcomeExceptions`. They HELD a welcome no video could ride and released it
// only after a person approved an approval_items row. The welcome is never held over its video now, so there is nothing to
// approve; a video that cannot be produced is recorded, retried safely and told to a person by
// lib/portal/welcome-video.ts recoverPortalWelcomeVideo / escalatePortalWelcomeVideo (the error console + the agent, once per
// contact). Measured before retiring (hrvaqgvukzxfskkcrwbt, 2026-10-29): approval_items with item_type 'welcome_without_video'
// = 0 (pending 0, approved 0), so no held welcome is stranded.

/** Seams for the proofs (the real doors are the defaults). */
export interface ConversionWelcomeDeps {
  /** THE welcome survivor (lib/kernel/client-welcome.ts ensureClientWelcome). */
  sendWelcome?: (
    supabase: any,
    contact: { id: string; brokerageId: string; contactType: string | null; firstName: string | null; lastName: string | null },
    opts: { origin: WelcomeOrigin | null; accessibility: WelcomeAccessibility | null },
  ) => Promise<{ state: string; reason?: string | null; situationWarnings?: string[] }>
  /** THE avatar commission (./welcome-avatar-video ensureWelcomeAvatarVideo). */
  commissionVideo?: typeof ensureWelcomeAvatarVideo
  /** THE portal welcome video's recovery (lib/portal/welcome-video.ts recoverPortalWelcomeVideo). */
  recoverVideo?: (supabase: any, p: { brokerageId: string; contactId: string; agentId: string | null; introVideoId: string | null; reason: WelcomeAvatarVideoReason; detail: string }) => Promise<{ action: string; outcome: string }>
  now?: () => Date
}

/**
 * Grant the portal, SEND the one welcome email NOW, claim the first touch, then commission the personal video for the portal.
 *
 * NEVER THROWS.
 */
export async function deliverConversionWelcome(
  supabase: any,
  params: ConversionWelcomeParams,
  deps: ConversionWelcomeDeps = {},
): Promise<ConversionWelcomeResult> {
  const warnings: string[] = []
  const now = deps.now ?? (() => new Date())

  // WILL AN AGENT-SIGNED WELCOME GO OUT AT ALL? Asked FIRST, because it decides
  // whether the portal invite must carry its own magic-link mail as the delivery.
  // One function answers it here and inside the survivor (§6).
  //
  // It answers with the SET OF MANAGERS that pick this welcome up — seller →
  // listing_concierge, buyer → shopping_agent, both → BOTH (owner ruling). This lane
  // only needs the SIZE of that set: non-empty means a welcome is coming and carries
  // the portal door; empty means the magic link is the only thing that will ever
  // tell them the portal exists.
  const welcomeManagers = resolveWelcomeManagers(params.contactType)
  const welcomeJourney = welcomeJourneyFor(welcomeManagers)

  // ── STEP 1: THE ACCESS GRANT. IMMEDIATE, AND FIRST. ───────────────────────
  // The portal_contact_invites row IS the access. It is created before the email and before any video, so no render outcome
  // can cost a contact their portal.
  const portal = await grantPortalAccessForPromotedContact(supabase, {
    contactId: params.contactId,
    agentId: params.agentId,
    agentUserId: params.agentUserId ?? null,
    contactType: params.contactType ?? null,
    // ONE EMAIL: suppressed when the agent's welcome will carry the door, kept as
    // the fallback delivery when no welcome is due for this contact type.
    sendMagicLink: welcomeManagers.length === 0,
  })
  warnings.push(...portal.warnings)

  // ── STEP 1b (wave 145, contract C3): THE CONTACT'S STATED ACCESSIBILITY PREFERENCES ──
  // Read through lane 145H's one reader for the composer (larger type, the transcript). Wave 146: a stated no-video format no
  // longer stops the portal video — it opens the portal's transcript first (lib/portal/welcome-video.ts playback).
  const access = await readWelcomeAccessibility(supabase, { brokerageId: params.brokerageId, contactId: params.contactId })
  if (access.blindSpot) warnings.push(access.blindSpot)

  const out: ConversionWelcomeResult = {
    portalGranted: portal.granted,
    portalReason: portal.reason,
    magicLinkSent: portal.emailSent,
    welcomeManagers: [...welcomeManagers],
    welcomeJourney,
    videoReason: "unavailable",
    timing: "send_now",
    timingReason: "",
    emailState: null,
    firstTouch: { claimed: false, channel: null, reason: "no welcome was sent on this call" },
    portalVideo: { commissioned: false, reason: "unavailable", videoProjectId: null, recovery: null },
    accessibility: access.accessibility,
    warnings,
  }

  // ── STEP 2 (WAVE 146, owner ruling 6): THE ONE WELCOME EMAIL GOES NOW — before any video work ──
  // Dynamic import: client-welcome pulls the governed egress rail, and a static
  // import would drag it into every module graph reaching the converters —
  // including the plain `tsx` simulators. Same reason portal-access defers the
  // invite core.
  if (welcomeManagers.length === 0) {
    // No agent-signed welcome is due for this contact type. The magic link above
    // was the delivery; saying so is what keeps "one email" auditable.
    warnings.push(
      `no agent-signed welcome for contact ${params.contactId}: contact_type '${params.contactType ?? "null"}' ` +
        `is picked up by no manager, so the portal invite's magic link is the delivery.`,
    )
  } else {
    try {
      const send = deps.sendWelcome ?? (async (svc, contact, opts) => (await import("@/lib/kernel/client-welcome")).ensureClientWelcome(svc, contact, opts))
      const welcome = await send(supabase, {
        id: params.contactId,
        brokerageId: params.brokerageId,
        contactType: params.contactType ?? null,
        firstName: params.firstName ?? null,
        lastName: params.lastName ?? null,
      }, { origin: params.origin ?? null, accessibility: access.accessibility })
      out.emailState = welcome.state
      warnings.push(...(welcome.situationWarnings ?? []))
      if (welcome.state !== "sent" && welcome.state !== "skipped") {
        warnings.push(`the welcome email for contact ${params.contactId} did not send: ${welcome.reason ?? welcome.state}`)
      }

      // ── STEP 2b (WAVE 146): THE WELCOME IS THIS CONTACT'S FIRST TOUCH — CLAIM IT ON THE SHARED LEDGER ──
      // A welcome that went (or that the owning manager's posture holds for a human to release) owns the first hello; so does
      // one that already exists (a retried conversion). speed-to-lead's contact half (`first_touched_at IS NULL`) and the
      // welcome drip's first email step (skip_duplicate) then stand down — no second first touch. A welcome that FAILED, had no
      // agent or no inbox claims nothing: the contact arbiter may still answer them. Claimed AFTER the outcome is known (never
      // a "touched" stamp with no welcome behind it); the conditional write never overwrites a first touch already on record.
      const welcomeOwnsFirstTouch =
        welcome.state === "sent" || welcome.state === "held_for_approval" || (welcome.state === "skipped" && !welcome.reason)
      if (welcomeOwnsFirstTouch) {
        const claim = await claimFirstTouch(supabase, "contacts", { id: params.contactId, brokerageId: params.brokerageId, at: now(), channel: "email" })
        out.firstTouch = claim.ok
          ? { claimed: true, channel: "email", reason: `the welcome (${welcome.state}) is the contact's first touch` }
          : { claimed: false, channel: null, reason: claim.error ?? "a first touch was already on record for this contact" }
        if (!claim.ok && claim.error) warnings.push(`the welcome's first-touch claim for contact ${params.contactId} was refused: ${claim.error}`)
      } else {
        out.firstTouch = { claimed: false, channel: null, reason: `the welcome is '${welcome.state}' — no first touch is claimed for it` }
      }
    } catch (e: any) {
      out.emailState = "send_failed"
      warnings.push(
        `the welcome email for contact ${params.contactId} could not be attempted: ` +
          `${e?.message ?? "the welcome package is unavailable"}. The portal invite is unaffected.`,
      )
    }
  }

  // ── STEP 3 (WAVE 146): THE PORTAL WELCOME VIDEO — commissioned AFTER the send, regardless of channel preferences ──
  // The ONE avatar spine renders it asynchronously (delivery 'portal'); lib/portal/welcome-video.ts shows it in the contact's
  // portal the moment it is validated. It is commissioned after the email on purpose: nothing the render does — a model draft,
  // a refusal, a provider outage — can delay the welcome.
  const videoArgs = {
    contactId: params.contactId,
    agentId: params.agentId,
    brokerageId: params.brokerageId,
    origin: params.origin ?? null,
  }
  const video = deps.commissionVideo
    ? await deps.commissionVideo(supabase, videoArgs)
    : await ensureWelcomeAvatarVideo(supabase, videoArgs)
  warnings.push(...video.warnings)
  out.videoReason = video.reason
  out.portalVideo = { commissioned: video.commissioned, reason: video.reason, videoProjectId: video.videoProjectId, recovery: null }

  // ── STEP 3b: A VIDEO THAT COULD NOT BE COMMISSIONED IS RECORDED, RECOVERED, TOLD — never silently absent ──
  // The manager's recovery (the agent's standing video stands in, one safe re-render, or a person is told once per contact).
  // An excluded counterparty type gets no welcome video by design — nothing to recover.
  if (!video.commissioned && video.reason !== "excluded_contact_type") {
    try {
      const recover = deps.recoverVideo ?? (async (svc, p) => {
        const wv = await import("@/lib/portal/welcome-video")
        return wv.recoverPortalWelcomeVideo(svc, {
          brokerageId: p.brokerageId, contactId: p.contactId, agentId: p.agentId, introVideoId: p.introVideoId,
          failureKind: wv.failureKindOf({ commissionReason: p.reason }), reason: p.detail,
        })
      })
      const rec = await recover(supabase, {
        brokerageId: params.brokerageId, contactId: params.contactId, agentId: params.agentId ?? null, introVideoId: null,
        reason: video.reason, detail: `the personal welcome video could not be commissioned (${video.reason})`,
      })
      out.portalVideo.recovery = `${rec.action}:${rec.outcome}`
    } catch (e) {
      warnings.push(`the portal welcome video's recovery could not run for contact ${params.contactId}: ${(e as Error).message}`)
    }
  }

  // ── THE TIMING, STATED: the welcome never waited; this is where the video goes instead. ──
  const timing = decideWelcomeTiming(video)
  out.timing = timing.action
  out.timingReason = timing.reason
  return out
}
