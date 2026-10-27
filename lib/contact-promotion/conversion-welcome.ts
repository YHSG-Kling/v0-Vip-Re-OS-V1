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
 */

import { COMPOSITE_WAIT_MS } from "@/lib/video/avatar-render-orchestrator"
import { resolveWelcomeManagers, welcomeJourneyFor } from "@/lib/kernel/client-welcome"
import { grantPortalAccessForPromotedContact } from "./portal-access"
import { ensureWelcomeAvatarVideo, type WelcomeAvatarVideoReason } from "./welcome-avatar-video"
import type { WelcomeOrigin } from "./welcome-situation"

export type { WelcomeOrigin } from "./welcome-situation"

/**
 * How long the ONE welcome email may wait for a personal video before going
 * without it, measured from the moment the render was commissioned.
 *
 * Deliberately the SAME constant the assembly reader already bounds on — see the
 * header. A welcome that has not arrived within two hours of conversion has
 * stopped being a welcome.
 */
export const WELCOME_VIDEO_WAIT_MS = COMPOSITE_WAIT_MS

// ─── DECISION 1: does the email wait at all? (PURE) ──────────────────────────

export type WelcomeTimingAction =
  /** Nothing to wait for: the contact's own choice (video off / a stated no-video format), a type that gets no video, or the
   *  agent's standing personal video is SELECTED (ready + validated) and rides the welcome now. */
  | "send_now"
  /** Wave 145 (ruling 17): a render is in flight — the ONE welcome WAITS; the sweeper auto-sends it WITH the video once validated. */
  | "hold_for_video"
  /** Wave 145 (ruling 17): no personal video can be generated or selected — the welcome is HELD (never sent without the video on
   *  its own) and a human-approved exception is filed (approval item `welcome_without_video`). */
  | "hold_for_exception"

export interface WelcomeTiming {
  action: WelcomeTimingAction
  /** Operator-readable justification. Always populated. */
  reason: string
}

/**
 * THE WAIT RULE (owner ruling 17, wave 145), as a pure function of the commissioning outcome.
 *
 * A render in flight HOLDS the welcome (the sweeper finds its `agent_intro_videos` row and sends the one welcome with the video).
 * The contact's own choices send now: video opt-out, a stated accessibility preference for a format without video. A contact
 * type that gets no video sends now. When no render can be produced, the agent's STANDING personal video, if one is ready and
 * validated, is SELECTED and the welcome goes now with it. Anything else — no avatar on file, a refused render, an unavailable
 * spine, a reason this function has never seen — HOLDS the welcome for a human-approved exception: fail closed means never
 * falsely sent, and the exception means never silently pending (the approval queue shows it, a person decides).
 */
export function decideWelcomeTiming(video: {
  commissioned: boolean
  reason: WelcomeAvatarVideoReason | string
  /** The agent's standing personal video is ready and validated (lib/kernel/welcome-personal-video.ts, scope agent_personal). */
  standingVideoReady?: boolean | null
  /** Contract C3: the contact STATED a communication format without video (never inferred). */
  statedNoVideo?: boolean | null
}): WelcomeTiming {
  if (video.statedNoVideo) {
    return { action: "send_now", reason: "the contact's stated accessibility preference is a format without video — the welcome goes now, as they asked" }
  }
  if (video.reason === "commissioned" && video.commissioned) {
    return { action: "hold_for_video", reason: "the agent's personal video is rendering — the ONE welcome waits for it and is sent with it automatically once it is validated" }
  }
  if (video.reason === "already_commissioned") {
    return { action: "hold_for_video", reason: "a personal video for this contact was already commissioned — the ONE welcome waits for it and is sent with it automatically" }
  }
  if (video.reason === "video_opt_out") {
    return { action: "send_now", reason: "the contact turned video off — there is nothing to wait for" }
  }
  if (video.reason === "excluded_contact_type") {
    return { action: "send_now", reason: "this contact type gets no welcome video — there is nothing to wait for" }
  }
  if (video.standingVideoReady) {
    return { action: "send_now", reason: `no personal render for this contact (${video.reason || "unknown"}) — the agent's standing personal video is selected (ready, validated) and rides the welcome now` }
  }
  if (video.reason === "agent_not_video_ready") {
    return {
      action: "hold_for_exception",
      reason:
        "the assigned agent has no cloned voice / avatar and no standing personal video on file — the welcome is HELD for a person: " +
        "set up the avatar (Settings → Voice & Avatar) so the welcome goes with the video, or approve sending it without one",
    }
  }
  return {
    action: "hold_for_exception",
    reason: `the personal video could not be produced (${video.reason || "unknown"}) — the welcome is HELD for a person to approve sending it without the video, never sent without it on its own`,
  }
}

// ─── DECISION 2: what does the SWEEPER do with a pending welcome? (PURE) ─────

export type PendingWelcomeAction =
  /** The render is still coming and the deadline has not passed. Leave it. */
  | "wait"
  /** Release the welcome WITH the finished video embedded (a pre-wave-144 row whose welcome is still held). */
  | "send_with_video"
  /** Release the welcome WITHOUT a video — ONLY for the contact's own reasons (no email: the portal rail; a late video opt-out). */
  | "send_without_video"
  /** Wave 145 (ruling 17): the video ran out of time / its state cannot be read — the welcome stays HELD and a human-approved
   *  exception is filed (never auto-sent without the video, never left pending silently). */
  | "hold_for_exception"
  /** Wave 144: the welcome already went — send the ONE follow-up carrying the finished video. */
  | "send_video_follow_up"
  /** Wave 144: the welcome already went and the video will not follow (opt-out, no email, deadline) — stamp, send nothing. */
  | "close_video_follow_up"
  /** Nothing to do: this ledger row is already terminal. */
  | "skip"

/**
 * Wave 144: the welcome's OWN state, read from the survivor's idempotency tag (agent_client_messages, rationale
 * `client_welcome_v1…` — lib/kernel/client-welcome.ts WELCOME_RATIONALE_TAG):
 *   sent    a provider accepted it → the video FOLLOWS it
 *   held    proposed / approved, not yet sent → the video waits behind it (never precedes it)
 *   failed  failed / rejected → no video mail without a welcome; the agent was told
 *   none    no welcome row → a pre-144 row whose welcome is still held: release it as before
 */
export type WelcomeMessageState = "sent" | "held" | "failed" | "none"

export interface PendingWelcomeVerdict {
  action: PendingWelcomeAction
  /**
   * What to stamp on `agent_intro_videos.status` once the action is carried out.
   * NULL while waiting or skipping. Every value is in the live
   * `agent_intro_videos_status_check` vocabulary — there is no 'abandoned' arm to
   * write, so a timed-out render is recorded as 'failed' with the reason in
   * `error_message` rather than inventing a value the CHECK would refuse (23514).
   */
  ledgerStatus: "delivered" | "failed" | "suppressed" | null
  reason: string
}

/** The non-terminal `agent_intro_videos.status` values — the sweeper's whole set. */
export const PENDING_WELCOME_STATUSES: readonly string[] = ["queued", "rendering"]

/**
 * THE SWEEPER'S DECISION, with no I/O so both sides of every arm can be proved.
 *
 * ORDER IS THE DESIGN, not an accident:
 *
 *   1. a terminal row is skipped — the welcome for it has already resolved;
 *   2. no email address → release anyway (the survivor writes the portal rail and
 *      tells the agent), and record why the video never shipped;
 *   3. a LATE opt-out beats everything still pending — the contact changed their
 *      mind during the render and that answer is theirs;
 *   4. THE DEADLINE IS CHECKED BEFORE THE ASSEMBLY GATE. If it were checked after,
 *      an assembly stuck in 'pending' would hold the welcome forever — which is
 *      the exact failure this whole rule exists to prevent;
 *   5. only then may the assembly hold it;
 *   6. and only then does the absence of a rendered URL hold it.
 */
export function classifyPendingWelcome(input: {
  /** agent_intro_videos.status */
  status: string | null
  /** Milliseconds since agent_intro_videos.created_at. Null = unknown → treated as fresh. */
  ageMs: number | null
  /** The assembly gate's answer, or null when no project row exists yet. */
  composite: "not_requested" | "pending" | "landed" | "abandoned" | null
  /** ai_video_projects.video_url (or the composite's own URL) is populated. */
  hasRenderedUrl: boolean
  videoOptOut: boolean
  hasEmail: boolean
  /**
   * Wave 144: the welcome's own state (readWelcomeState). UNDEFINED / NULL — a caller that did not (or could not) say — WAITS and
   * stamps nothing: under the immediate-welcome rule a released "send_with_video" against a welcome that already went would be
   * deduped by the survivor and the row stamped 'delivered' for a video nobody sent. Fail closed: nobody checked ≠ checked and fine.
   */
  welcomeState?: WelcomeMessageState | null
  /** Override for the simulator. Production always uses WELCOME_VIDEO_WAIT_MS. */
  waitMs?: number
}): PendingWelcomeVerdict {
  const waitMs = input.waitMs ?? WELCOME_VIDEO_WAIT_MS

  if (!input.status || !PENDING_WELCOME_STATUSES.includes(input.status)) {
    return {
      action: "skip",
      ledgerStatus: null,
      reason: `agent_intro_videos.status '${input.status ?? "null"}' is terminal — this welcome already resolved`,
    }
  }

  if (input.welcomeState === undefined || input.welcomeState === null) {
    // Past the deadline the row is CLOSED 'failed' (the video was never delivered — true whatever the welcome did) and — wave 145,
    // ruling 17 — the welcome is handed to a PERSON (the exception): whether it already went cannot be read, so nothing is sent on a
    // guess, and nothing hangs silently. The exception's release goes through the survivor, whose own idempotency tag refuses a
    // second welcome. A 'delivered' is never stamped without the state.
    if (input.ageMs !== null && input.ageMs > waitMs) {
      return { action: "hold_for_exception", ledgerStatus: "failed", reason: `the personal video did not land within ${Math.round(waitMs / 60000)} minutes and the welcome's state could not be read — held for a person to decide, never sent on a guess` }
    }
    return {
      action: "wait",
      ledgerStatus: null,
      reason: "the welcome's own state was not read — nothing is released or stamped until the sweeper says whether the welcome already went (wave 144)",
    }
  }

  // ── WAVE 144: THE WELCOME WENT FIRST; THE VIDEO FOLLOWS IT (or is closed) ──
  if (input.welcomeState !== "none") {
    const overdue144 = input.ageMs !== null && input.ageMs > waitMs
    if (input.welcomeState === "failed") {
      return { action: "close_video_follow_up", ledgerStatus: "failed", reason: "the welcome itself failed or was rejected (the agent was told) — a video never goes out without its welcome" }
    }
    if (input.welcomeState === "held") {
      return overdue144
        ? { action: "close_video_follow_up", ledgerStatus: "failed", reason: `the welcome is still awaiting approval past ${Math.round(waitMs / 60000)} minutes — the video stays on the portal card; no mail goes ahead of the welcome` }
        : { action: "wait", ledgerStatus: null, reason: "the welcome is awaiting brokerage approval — the video follows it, never precedes it" }
    }
    if (!input.hasEmail) {
      return { action: "close_video_follow_up", ledgerStatus: "failed", reason: "contact has no email — the video stays on the portal card; no follow-up mail" }
    }
    if (input.videoOptOut) {
      return { action: "close_video_follow_up", ledgerStatus: "suppressed", reason: "the contact turned video off — the welcome already went; no video follows" }
    }
    if (overdue144) {
      return { action: "close_video_follow_up", ledgerStatus: "failed", reason: `the personal video has not landed within ${Math.round(waitMs / 60000)} minutes of conversion — the welcome already went; no late video mail` }
    }
    if (input.composite === "pending") {
      return { action: "wait", ledgerStatus: null, reason: "the Remotion assembly has not landed — mailing the bare avatar track is the defect it exists to fix" }
    }
    if (!input.hasRenderedUrl) return { action: "wait", ledgerStatus: null, reason: "the render is still in flight" }
    return { action: "send_video_follow_up", ledgerStatus: "delivered", reason: "the finished personal video is ready — it follows the welcome as one short note" }
  }

  if (!input.hasEmail) {
    return {
      action: "send_without_video",
      ledgerStatus: "failed",
      reason: "contact has no email at send time — the welcome goes to the portal rail instead",
    }
  }

  if (input.videoOptOut) {
    return {
      action: "send_without_video",
      ledgerStatus: "suppressed",
      reason: "the contact turned video off during the render — the welcome still goes, without it",
    }
  }

  const overdue = input.ageMs !== null && input.ageMs > waitMs
  if (overdue) {
    // WAVE 145 (ruling 17): no longer "send without it" — the welcome waits for the video, and when the video fails a PERSON
    // approves the exception (never falsely sent; never silently pending — the approval item is the visible state).
    return {
      action: "hold_for_exception",
      ledgerStatus: "failed",
      reason:
        `the personal video has not landed within ${Math.round(waitMs / 60000)} minutes of conversion — ` +
        `the welcome is held for a person to approve sending it without the video (or to fix the video)`,
    }
  }

  if (input.composite === "pending") {
    return {
      action: "wait",
      ledgerStatus: null,
      reason: "the Remotion assembly has not landed — mailing the bare avatar track is the defect it exists to fix",
    }
  }

  if (!input.hasRenderedUrl) {
    return { action: "wait", ledgerStatus: null, reason: "the render is still in flight" }
  }

  return { action: "send_with_video", ledgerStatus: "delivered", reason: "the finished personal video is ready to embed" }
}

// ─── THE LIVE ENTRY POINT BOTH CONVERTERS CALL ───────────────────────────────

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
  timing: WelcomeTimingAction
  /** Why the email waited, or why it did not. Always populated. */
  timingReason: string
  /** `WelcomeSendState` when the welcome was sent on this call; null when deferred. */
  emailState: string | null
  /** Wave 145 (ruling 17): the human-approved exception filed for a welcome held without a possible video (null = none needed). */
  exception: WelcomeExceptionFiling | null
  /** Wave 145 (contract C3): the contact's STATED accessibility preferences the welcome honours (null = unread; defaults apply). */
  accessibility: WelcomeAccessibility | null
  /** Everything the operator needs. NEVER a reason to unwind a committed conversion. */
  warnings: string[]
}

// ─── CONTRACT C3: THE CONTACT'S STATED ACCESSIBILITY PREFERENCES ─────────────

/**
 * What the welcome honours from the contact's OWN stated preferences (owner ruling 18 — explicit, user-controllable fields;
 * never inferred from age or any demographic). Read ONLY through lane 145H's reader
 * (lib/contacts/accessibility-preferences.ts readAccessibilityPreferences — contract C3); this is the welcome's view of it.
 */
export interface WelcomeAccessibility {
  /** The contact stated a communication format WITHOUT video (text / written) — the welcome does not wait for, or carry, a video. */
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
 * inferred). Used by deliverConversionWelcome (does the welcome wait for a video?) and by the composer
 * lib/kernel/client-welcome.ts ensureClientWelcome (large text / the transcript) — every welcome path reads the same answer.
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

// ─── RULING 17: THE HUMAN-APPROVED EXCEPTION ─────────────────────────────────

/** approval_items.item_type of a welcome held because no personal video can ride it (item_id = contacts.id — one per contact). */
export const WELCOME_EXCEPTION_ITEM_TYPE = "welcome_without_video"

export interface WelcomeExceptionFiling {
  /** A pending approval item now exists for this contact's held welcome (filed on this call, or already there). */
  filed: boolean
  /** It already existed (pending / approved / rejected) — a retried conversion or sweep never files a second. */
  existing: boolean
  error: string | null
}

/**
 * File the HUMAN-APPROVED EXCEPTION for a welcome that cannot carry the agent's video (ruling 17): one PENDING approval item in the
 * ONE approval queue (approval_items → lib/kernel/approval-queue-aggregator.ts — the agent's / broker's approvals feed), plus the
 * decision on the action ledger. Idempotent per contact (any prior item, whatever its status, is never re-filed). Tenant-pinned;
 * every read is read for its error; the insert is COUNTED. Nothing is sent here. NEVER THROWS.
 */
export async function holdWelcomeForException(
  svc: { from: (t: string) => any },
  p: { brokerageId: string; contactId: string; agentId: string | null; reason: string; now?: Date },
): Promise<WelcomeExceptionFiling> {
  const now = p.now ?? new Date()
  try {
    if (!p.brokerageId || !p.contactId) return { filed: false, existing: false, error: "no brokerage / contact" }
    const { data: prior, error: priorErr } = await svc.from("approval_items").select("id, status")
      .eq("brokerage_id", p.brokerageId).eq("item_type", WELCOME_EXCEPTION_ITEM_TYPE).eq("item_id", p.contactId).limit(1)
    if (priorErr) return { filed: false, existing: false, error: `approval_items read refused: ${priorErr.message ?? "unknown"}` }
    if ((prior ?? []).length > 0) return { filed: true, existing: true, error: null }
    const { data: ins, error: insErr } = await svc.from("approval_items").insert({
      brokerage_id: p.brokerageId, agent_id: p.agentId ?? null, item_type: WELCOME_EXCEPTION_ITEM_TYPE, item_id: p.contactId,
      status: "pending", submitted_at: now.toISOString(),
      // The reviewer's view (the queue decodes `excerpt`): what is held, why, and what each answer does.
      review_notes: JSON.stringify({
        violations: [],
        excerpt: `Welcome email HELD — ${p.reason}. Approve: the welcome (with the portal sign-in link) is sent now without the personal video. Reject: nothing is sent; fix the video and it goes with it.`.slice(0, 500),
      }),
    }).select("id")
    if (insErr) return { filed: false, existing: false, error: `approval_items insert refused: ${insErr.message ?? "unknown"}` }
    if ((ins ?? []).length !== 1) return { filed: false, existing: false, error: `approval_items insert returned ${(ins ?? []).length} rows` }
    try {
      const { recordNonAction } = await import("@/lib/kernel/action-ledger")
      const rec = await recordNonAction({
        brokerageId: p.brokerageId, domain: "welcome_video", decision: "wait", actor: { type: "system" },
        subject: { type: "contact", id: p.contactId }, reasonCode: "CONTACT_WELCOME",
        reasonDetail: `held for a human-approved exception: ${p.reason}`.slice(0, 500), cycle: "conversion_exception",
      }, { client: svc as never })
      if (!rec.recorded && rec.error) console.warn(`[conversion-welcome] exception not ledgered for ${p.contactId}: ${rec.error}`)
    } catch (e) {
      console.warn(`[conversion-welcome] exception not ledgered for ${p.contactId}: ${(e as Error).message}`)
    }
    return { filed: true, existing: false, error: null }
  } catch (e) {
    return { filed: false, existing: false, error: `holdWelcomeForException threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * THE ONLY RELEASE of a held welcome a PERSON approved (ruling 17's "human-approved exception … auto-send after"): approved
 * `welcome_without_video` items reviewed inside the last `windowDays`, for contacts with no welcome yet, are sent through THE
 * survivor (lib/kernel/client-welcome.ts ensureClientWelcome — its idempotency tag refuses a second welcome, and it still embeds a
 * personal video if one has become ready since). A pending or rejected item is never released. Called by the welcome sweeper
 * (/api/cron/intro-video-email-backfill). NEVER THROWS.
 */
export async function releaseApprovedWelcomeExceptions(
  svc: { from: (t: string) => any },
  opts: { now?: Date; windowDays?: number; limit?: number; brokerageId?: string | null },
  /** THE SWEEPER'S survivor call (the cron passes lib/kernel/client-welcome.ts ensureClientWelcome) — this module keeps exactly one
   *  call site of the survivor (deliverConversionWelcome), so the release is the sweeper's own send, never a third path. */
  deps: { ensureWelcome: (contact: { id: string; brokerageId: string; contactType: string | null; firstName: string | null; lastName: string | null }) => Promise<{ state: string; reason?: string | null }> },
): Promise<{ examined: number; released: number; results: Array<{ contactId: string; outcome: string; reason?: string | null }>; error: string | null }> {
  const now = opts.now ?? new Date()
  const out = { examined: 0, released: 0, results: [] as Array<{ contactId: string; outcome: string; reason?: string | null }>, error: null as string | null }
  try {
    const since = new Date(now.getTime() - (opts.windowDays ?? 14) * 86_400_000).toISOString()
    let q = svc.from("approval_items").select("id, brokerage_id, item_id, reviewed_at")
      .eq("item_type", WELCOME_EXCEPTION_ITEM_TYPE).eq("status", "approved").gte("reviewed_at", since)
    if (opts.brokerageId) q = q.eq("brokerage_id", opts.brokerageId)
    const { data, error } = await q.order("reviewed_at", { ascending: true }).limit(Math.max(1, Math.min(opts.limit ?? 50, 200)))
    if (error) return { ...out, error: `approval_items read refused: ${error.message ?? "unknown"} — nothing released` }
    // Lazy: the sweeper is the only caller, and the converters' module graph never needs the welcome-state reader.
    const { readWelcomeState } = await import("./welcome-avatar-video")
    for (const item of (data ?? []) as Array<{ brokerage_id: string | null; item_id: string | null }>) {
      if (!item.brokerage_id || !item.item_id) continue
      out.examined++
      const contactId = item.item_id
      const state = await readWelcomeState(svc, { contactId, brokerageId: item.brokerage_id })
      if (state === null) { out.results.push({ contactId, outcome: "skipped", reason: "the welcome's state could not be read — nothing sent on a guess" }); continue }
      if (state !== "none") { out.results.push({ contactId, outcome: "already_welcomed", reason: `the welcome is already '${state}'` }); continue }
      const { data: c, error: cErr } = await svc.from("contacts").select("id, contact_type, first_name, last_name")
        .eq("id", contactId).eq("brokerage_id", item.brokerage_id).maybeSingle()
      if (cErr) { out.results.push({ contactId, outcome: "skipped", reason: `contact read refused: ${cErr.message}` }); continue }
      if (!c) { out.results.push({ contactId, outcome: "skipped", reason: "contact not in this brokerage" }); continue }
      const row = c as { contact_type?: string | null; first_name?: string | null; last_name?: string | null }
      const welcome = await deps.ensureWelcome({ id: contactId, brokerageId: item.brokerage_id, contactType: row.contact_type ?? null, firstName: row.first_name ?? null, lastName: row.last_name ?? null })
      if (welcome.state === "sent") out.released++
      out.results.push({ contactId, outcome: welcome.state === "sent" ? "released_without_video" : welcome.state, reason: welcome.reason ?? null })
    }
    return out
  } catch (e) {
    return { ...out, error: `releaseApprovedWelcomeExceptions threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * Grant the portal, commission the personal video, and either send the ONE
 * welcome email now or hand it to the sweeper.
 *
 * NEVER THROWS.
 */
export async function deliverConversionWelcome(
  supabase: any,
  params: ConversionWelcomeParams,
): Promise<ConversionWelcomeResult> {
  const warnings: string[] = []

  // WILL AN AGENT-SIGNED WELCOME GO OUT AT ALL? Asked FIRST, because it decides
  // whether the portal invite must carry its own magic-link mail as the delivery.
  // One function answers it here and inside the survivor (§6).
  //
  // It answers with the SET OF MANAGERS that pick this welcome up — seller →
  // listing_concierge, buyer → shopping_agent, both → BOTH, lifetime customer →
  // sphere_of_influence (owner ruling). This lane only needs the SIZE of that set:
  // non-empty means a welcome is coming and carries the portal door; empty means the
  // magic link is the only thing that will ever tell them the portal exists.
  const welcomeManagers = resolveWelcomeManagers(params.contactType)
  const welcomeJourney = welcomeJourneyFor(welcomeManagers)

  // ── STEP 1: THE ACCESS GRANT. IMMEDIATE, AND FIRST. ───────────────────────
  // The portal_contact_invites row IS the access. It is created before any video
  // is commissioned and before any email decision, so no render outcome can cost
  // a contact their portal.
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
  // Read through lane 145H's one reader. A stated format without video means no render is commissioned (no spend on a video
  // the contact asked not to get) and the welcome does not wait. Unread → the defaults, said; never inferred.
  const access = await readWelcomeAccessibility(supabase, { brokerageId: params.brokerageId, contactId: params.contactId })
  if (access.blindSpot) warnings.push(access.blindSpot)
  const statedNoVideo = access.accessibility?.statedNoVideo === true

  // ── STEP 2: COMMISSION THE PERSONAL VIDEO ─────────────────────────────────
  // Second on purpose. It is the step that can be refused for a dozen legitimate
  // reasons; ordering it after the grant means a refusal can never cost the portal.
  const video: Awaited<ReturnType<typeof ensureWelcomeAvatarVideo>> = statedNoVideo
    ? { commissioned: false, reason: "video_opt_out", videoProjectId: null, situational: false, language: null, warnings: [] }
    : await ensureWelcomeAvatarVideo(supabase, {
        contactId: params.contactId,
        agentId: params.agentId,
        brokerageId: params.brokerageId,
        origin: params.origin ?? null,
      })
  warnings.push(...video.warnings)

  // ── STEP 2b (wave 145, ruling 17): no render for THIS contact → can the agent's STANDING personal video be SELECTED? ──
  // Only asked when nothing is in flight and the reason is not the contact's own choice. Validated by the one reader
  // (lib/kernel/welcome-personal-video.ts → resolvePlayableVideo: finished, customer-facing, compliance-passed).
  let standingVideoReady = false
  const failedRender = !video.commissioned && !statedNoVideo && video.reason !== "video_opt_out" && video.reason !== "excluded_contact_type"
  if (failedRender && welcomeManagers.length > 0 && params.agentId) {
    try {
      const { resolveWelcomePersonalVideo } = await import("@/lib/kernel/welcome-personal-video")
      const standing = await resolveWelcomePersonalVideo(supabase, { brokerageId: params.brokerageId, contactId: params.contactId, agentRecordId: params.agentId })
      standingVideoReady = standing.state === "ready"
      if (standing.state !== "ready") warnings.push(`no standing personal video can be selected for contact ${params.contactId}: ${standing.reason}`)
    } catch (e) {
      warnings.push(`the agent's standing personal video could not be checked (${(e as Error).message}) — treated as none`)
    }
  }

  // ── STEP 3: DOES THE EMAIL WAIT? ──────────────────────────────────────────
  const timing = decideWelcomeTiming({ ...video, standingVideoReady, statedNoVideo })

  const out: ConversionWelcomeResult = {
    portalGranted: portal.granted,
    portalReason: portal.reason,
    magicLinkSent: portal.emailSent,
    welcomeManagers: [...welcomeManagers],
    welcomeJourney,
    videoReason: video.reason,
    timing: timing.action,
    timingReason: timing.reason,
    emailState: null,
    exception: null,
    accessibility: access.accessibility,
    warnings,
  }

  if (welcomeManagers.length === 0) {
    // No agent-signed welcome is due for this contact type. The magic link above
    // was the delivery; saying so is what keeps "one email" auditable.
    warnings.push(
      `no agent-signed welcome for contact ${params.contactId}: contact_type '${params.contactType ?? "null"}' ` +
        `is picked up by no manager, so the portal invite's magic link is the delivery.`,
    )
    return out
  }

  if (timing.action === "hold_for_video") {
    // WAVE 145 (ruling 17): the ONE welcome WAITS for the agent's video. The wait is recorded once per conversion (the cycle) as
    // the decision it is, with its deadline, so the Command Center can see a welcome is owed and by when. Never a send.
    // /api/cron/intro-video-email-backfill releases the welcome WITH the validated video, or — past the deadline — files the
    // human-approved exception (never a silent send without it, never a silent forever-pending).
    warnings.push(
      `the ${welcomeJourney} welcome email for contact ${params.contactId} WAITS for the agent's personal video ` +
        `(${timing.reason}). /api/cron/intro-video-email-backfill sends it with the video when the render is validated, or ` +
        `hands it to a person after ${Math.round(WELCOME_VIDEO_WAIT_MS / 60000)} minutes.`,
    )
    try {
      const { recordNonAction } = await import("@/lib/kernel/action-ledger")
      const rec = await recordNonAction({
        brokerageId: params.brokerageId,
        domain: "welcome_video",
        decision: "wait",
        actor: { type: "system" },
        subject: { type: "contact", id: params.contactId },
        reasonCode: "CONTACT_WELCOME",
        reasonDetail: timing.reason,
        cycle: "conversion",
        until: new Date(Date.now() + WELCOME_VIDEO_WAIT_MS).toISOString(),
      })
      if (!rec.recorded && rec.error) warnings.push(`welcome wait not ledgered: ${rec.error}`)
    } catch (e) {
      warnings.push(`welcome wait not ledgered: ${(e as Error).message}`)
    }
    return out
  }

  if (timing.action === "hold_for_exception") {
    // WAVE 145 (ruling 17): no personal video can ride the welcome — it is HELD, and a PERSON decides (approve: it goes without
    // the video; reject: nothing goes). The approval item IS the visible, recoverable state; the sweeper releases an approved one.
    const exception = await holdWelcomeForException(supabase, {
      brokerageId: params.brokerageId, contactId: params.contactId, agentId: params.agentId ?? null, reason: timing.reason,
    })
    out.exception = exception
    warnings.push(
      exception.filed
        ? `the ${welcomeJourney} welcome email for contact ${params.contactId} is HELD for a person (${timing.reason}) — ` +
            `approval item '${WELCOME_EXCEPTION_ITEM_TYPE}'${exception.existing ? " (already filed)" : ""}; the portal invite is unaffected.`
        : `the welcome for contact ${params.contactId} is HELD but its exception could NOT be filed (${exception.error ?? "unknown"}) — ` +
            `it is not sent without the video; an automation error was filed so a person sees it.`,
    )
    if (!exception.filed) {
      // Never silently pending: the failed filing itself lands on the error console (automation_errors, tenant-anchored).
      try {
        const { collectError } = await import("@/lib/errors/collect-error")
        await collectError({
          workflowName: "conversion_welcome_exception", severity: "high", brokerageId: params.brokerageId, client: supabase,
          errorMessage: `welcome held for contact ${params.contactId} but its approval item could not be filed: ${exception.error ?? "unknown"}`,
          context: { contactId: params.contactId, agentId: params.agentId ?? null, reason: timing.reason },
        })
      } catch { /* the warning above still travels to the converter */ }
    }
    return out
  }

  // ── STEP 4: SEND IT NOW (nothing to wait for — the contact's own choice, no video for this type, or the standing video). ──
  // Dynamic import: client-welcome pulls the governed egress rail, and a static
  // import would drag it into every module graph reaching the converters —
  // including the plain `tsx` simulators. Same reason portal-access defers the
  // invite core.
  try {
    const { ensureClientWelcome } = await import("@/lib/kernel/client-welcome")
    const welcome = await ensureClientWelcome(supabase, {
      id: params.contactId,
      brokerageId: params.brokerageId,
      contactType: params.contactType ?? null,
      firstName: params.firstName ?? null,
      lastName: params.lastName ?? null,
    }, { origin: params.origin ?? null, accessibility: access.accessibility })
    out.emailState = welcome.state
    warnings.push(...welcome.situationWarnings)
    if (welcome.state !== "sent" && welcome.state !== "skipped") {
      warnings.push(
        `the welcome email for contact ${params.contactId} did not send: ${welcome.reason ?? welcome.state}`,
      )
    }
  } catch (e: any) {
    out.emailState = "send_failed"
    warnings.push(
      `the welcome email for contact ${params.contactId} could not be attempted: ` +
        `${e?.message ?? "the welcome package is unavailable"}. The portal invite is unaffected.`,
    )
  }

  return out
}

