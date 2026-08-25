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
 * the `welcome_avatar_video` entry in lib/kernel/manager-registry.ts, which ends
 * "UNRESOLVED AND A PRODUCT CALL, NOT A LANE CALL"):
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
 * ── BOTH CONVERTERS CALL THIS, AND NEITHER HOLDS A COPY (§6) ───────────────
 *
 *   · lib/contact-promotion/promote-lead-to-contact.ts  (manual)
 *   · lib/kernel/lead-acquisition-handlers.ts::handleLeadAssigned (automatic)
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
 */

import { COMPOSITE_WAIT_MS } from "@/lib/video/avatar-render-orchestrator"
import { resolveWelcomeSide } from "@/lib/kernel/client-welcome"
import { grantPortalAccessForPromotedContact } from "./portal-access"
import { ensureWelcomeAvatarVideo, type WelcomeAvatarVideoReason } from "./welcome-avatar-video"

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
  /** Nothing is in flight and nothing will be. Send the welcome now, no video. */
  | "send_now"
  /** A render exists. The sweeper releases the welcome when it lands or times out. */
  | "wait_for_video"

export interface WelcomeTiming {
  action: WelcomeTimingAction
  /** Operator-readable justification. Always populated. */
  reason: string
}

/**
 * THE WAIT RULE, as a pure function of the commissioning outcome.
 *
 * Exactly two reasons arm the wait, and both of them mean an `agent_intro_videos`
 * row exists for the sweeper to find. Everything else — including the DEFAULT
 * case on this platform today, an agent with no voice/avatar profile — sends
 * immediately. Keeping this pure is what lets the simulator drive both sides,
 * including a reason value that does not exist yet: an unknown reason must fall
 * to `send_now`, because "we don't recognise this" must never render as "wait
 * forever" (§4, fail closed — a gate that cannot decide refuses to hold).
 */
export function decideWelcomeTiming(video: {
  commissioned: boolean
  reason: WelcomeAvatarVideoReason | string
}): WelcomeTiming {
  if (video.reason === "commissioned" && video.commissioned) {
    return { action: "wait_for_video", reason: "a personal video render is in flight — the welcome waits for it" }
  }
  if (video.reason === "already_commissioned") {
    return {
      action: "wait_for_video",
      reason: "a personal video for this contact was already commissioned — the welcome waits for that one",
    }
  }
  if (video.reason === "video_opt_out") {
    return { action: "send_now", reason: "the contact turned video off — there is nothing to wait for" }
  }
  if (video.reason === "agent_not_video_ready") {
    return {
      action: "send_now",
      reason:
        "the assigned agent has no cloned voice / avatar on file, so no video can ever be produced for " +
        "this welcome — it goes now, without a video block and without mentioning one",
    }
  }
  if (video.reason === "excluded_contact_type") {
    return { action: "send_now", reason: "this contact type gets no welcome video — there is nothing to wait for" }
  }
  return {
    action: "send_now",
    reason: `no video render is in flight (${video.reason || "unknown"}) — waiting would be waiting forever`,
  }
}

// ─── DECISION 2: what does the SWEEPER do with a pending welcome? (PURE) ─────

export type PendingWelcomeAction =
  /** The render is still coming and the deadline has not passed. Leave it. */
  | "wait"
  /** Release the welcome WITH the finished video embedded. */
  | "send_with_video"
  /** Release the welcome WITHOUT a video — it is not coming, or it ran out of time. */
  | "send_without_video"
  /** Nothing to do: this ledger row is already terminal. */
  | "skip"

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
    return {
      action: "send_without_video",
      ledgerStatus: "failed",
      reason:
        `the personal video has not landed within ${Math.round(waitMs / 60000)} minutes of conversion — ` +
        `the welcome goes now without it rather than never going at all`,
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
}

export interface ConversionWelcomeResult {
  /** A portal_contact_invites row exists for this contact. The access, not the email. */
  portalGranted: boolean
  /** Was the invite core's own OTP mail used as the delivery (no agent welcome due)? */
  magicLinkSent: boolean
  videoReason: WelcomeAvatarVideoReason
  timing: WelcomeTimingAction
  /** Why the email waited, or why it did not. Always populated. */
  timingReason: string
  /** `WelcomeSendState` when the welcome was sent on this call; null when deferred. */
  emailState: string | null
  /** Everything the operator needs. NEVER a reason to unwind a committed conversion. */
  warnings: string[]
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
  const side = resolveWelcomeSide(params.contactType)

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
    sendMagicLink: side === null,
  })
  warnings.push(...portal.warnings)

  // ── STEP 2: COMMISSION THE PERSONAL VIDEO ─────────────────────────────────
  // Second on purpose. It is the step that can be refused for a dozen legitimate
  // reasons; ordering it after the grant means a refusal can never cost the portal.
  const video = await ensureWelcomeAvatarVideo(supabase, {
    contactId: params.contactId,
    agentId: params.agentId,
    brokerageId: params.brokerageId,
  })
  warnings.push(...video.warnings)

  // ── STEP 3: DOES THE EMAIL WAIT? ──────────────────────────────────────────
  const timing = decideWelcomeTiming(video)

  const out: ConversionWelcomeResult = {
    portalGranted: portal.granted,
    magicLinkSent: portal.emailSent,
    videoReason: video.reason,
    timing: timing.action,
    timingReason: timing.reason,
    emailState: null,
    warnings,
  }

  if (side === null) {
    // No agent-signed welcome is due for this contact type. The magic link above
    // was the delivery; saying so is what keeps "one email" auditable.
    warnings.push(
      `no agent-signed welcome for contact ${params.contactId}: contact_type '${params.contactType ?? "null"}' ` +
        `resolves to no welcome journey, so the portal invite's magic link is the delivery.`,
    )
    return out
  }

  if (timing.action === "wait_for_video") {
    warnings.push(
      `the welcome email for contact ${params.contactId} is WAITING for the personal video ` +
        `(${timing.reason}). /api/cron/intro-video-email-backfill releases it when the render lands, ` +
        `or without the video after ${Math.round(WELCOME_VIDEO_WAIT_MS / 60000)} minutes.`,
    )
    return out
  }

  // ── STEP 4: SEND IT NOW. ──────────────────────────────────────────────────
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
    })
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
