// lib/campaign-sequences/first-touch-coordination.ts
//
// THE BATON HAND-OFF — first-touch coordination between the AI ISA speed-to-lead engine and
// the Campaign Orchestrator's welcome drip, so a brand-new contact is NEVER greeted twice on
// the same channel within minutes. This is the line between an "agentic team" and the flat
// parallel automations every other platform ships: two of our managers both want to say hello
// to a fresh capture, and instead of colliding they share ONE ledger and hand off the baton.
//
// THE SHARED LEDGER — contacts.first_touched_at + contacts.first_touch_channel:
//   • speed-to-lead (lib/ai-isa/speed-to-lead.ts) already reads it (`first_touched_at IS NULL`
//     guard) and stamps it when it makes the first touch.
//   • the welcome drip (lib/campaign-sequences/step-executor.ts) now respects AND writes the
//     same ledger, so whichever manager reaches the contact first claims the baton and the
//     other stands down.
//
// SCOPE — coordination applies ONLY to the FIRST outreach step of a CONTACT_CAPTURED-triggered
// sequence (the welcome arc). Every other sequence's day-0 step is untouched: an OFFER_ACCEPTED
// "under contract!" email or a LISTING_PUBLISHED seller welcome is NOT a first hello and must
// always send (the contact was engaged weeks ago — first_touched_at is long set).
//
// DECISION (pure, exhaustively unit-tested):
//   "send"           — not a coordinated welcome first step, OR a DIFFERENT channel than the
//                      recorded first touch (a genuine second channel: the ISA called, the drip
//                      emails — two channels on minute one is a strong first impression, allowed)
//   "skip_duplicate" — the recorded first touch already used THIS channel → skip + advance + log
//                      the deferral so the Command Center shows AI ISA owns the first touch
//   "defer_to_arbiter" — no first touch on record yet AND the enrollment is still inside the arbiter's window
//                      (wave 145, lane 145Z — owner ruling 16: "Speed to lead should be consumed by the
//                      followup-arbiter and should be the arbiter decision"): the step WAITS one sweep so the
//                      FIRST hello is the arbiter's (lib/ai-isa/speed-to-lead.ts → engageContact → the arbiter,
//                      which stamps the ledger); the drip's own hello then re-runs this decision and is a second
//                      channel at most (send) or stands down (skip_duplicate).
//   "send_and_claim" — no first touch on record and the arbiter's window has PASSED (it made no first touch for this
//                      contact — ineligible, a wait decision, or no consent on its channels): this step IS the first
//                      touch; send it and STAMP the ledger so speed-to-lead's `first_touched_at IS NULL` guard skips.
//                      Bounded on purpose — a drip that waited forever on an arbiter that chose not to touch would
//                      silently drop the tenant's welcome.

import { KernelEvent } from "@/lib/kernel/events"

/** Channels that constitute an actual outreach "hello" (wait/condition/task steps don't count). */
export const FIRST_TOUCH_OUTREACH_CHANNELS = new Set<string>([
  "email", "sms", "voice_drop", "ai_call", "direct_mail",
])

export type FirstTouchAction = "send" | "skip_duplicate" | "send_and_claim" | "defer_to_arbiter"

/** How long the welcome drip's first hello waits for the arbiter's speed-to-lead first touch (the sweep runs every 2 minutes —
 *  lib/kernel/cron-dispatch.ts — so this is several sweeps). Past it the drip greets and claims. */
export const FIRST_TOUCH_ARBITER_WINDOW_MINUTES = 15

/** How long a deferred step sleeps before it re-asks (one speed-to-lead sweep and a margin). */
export const FIRST_TOUCH_DEFER_MINUTES = 3

export interface FirstTouchInput {
  /** True when this is the enrollment's first step (current_step === 0 → step_number 1). */
  isFirstStep: boolean
  /** The enrolling sequence's trigger_event (the column value, e.g. "contact_captured"). */
  sequenceTriggerEvent: string | null
  /** The channel this step would dispatch on. */
  stepChannel: string
  /** contacts.first_touched_at — null until some manager makes the first touch. */
  firstTouchedAt: string | null
  /** contacts.first_touch_channel — the channel that first touch used. */
  firstTouchChannel: string | null
  /** sequence_enrollments.enrolled_at — the start of the arbiter's window. Unknown (null/absent) = the window is treated
   *  as passed, so an unreadable stamp never stalls the welcome. */
  enrolledAt?: string | null
  /** The decision clock (defaults to now). */
  now?: Date
}

/**
 * Decide how the welcome drip's step should coordinate with the speed-to-lead first touch.
 * Pure — no I/O. The executor performs the side effects (skip/advance, send, stamp).
 */
export function decideFirstTouch(input: FirstTouchInput): FirstTouchAction {
  const isWelcomeFirstStep =
    input.isFirstStep &&
    input.sequenceTriggerEvent === KernelEvent.CONTACT_CAPTURED &&
    FIRST_TOUCH_OUTREACH_CHANNELS.has(input.stepChannel)

  // Anything that isn't a welcome arc's first hello always sends — no coordination.
  if (!isWelcomeFirstStep) return "send"

  // No first touch recorded → the ARBITER owns the first hello (ruling 16): wait inside its window; past it, this welcome
  // step claims the baton and stamps the ledger.
  if (!input.firstTouchedAt) {
    const enrolledMs = input.enrolledAt ? Date.parse(input.enrolledAt) : NaN
    const nowMs = (input.now ?? new Date()).getTime()
    if (Number.isFinite(enrolledMs) && nowMs - enrolledMs < FIRST_TOUCH_ARBITER_WINDOW_MINUTES * 60_000) return "defer_to_arbiter"
    return "send_and_claim"
  }

  // A first touch already went out. Same channel → duplicate greeting, defer. Different
  // channel → a genuine second channel, allowed (e.g. ISA called, drip emails).
  if (input.firstTouchChannel && input.firstTouchChannel === input.stepChannel) {
    return "skip_duplicate"
  }
  return "send"
}
