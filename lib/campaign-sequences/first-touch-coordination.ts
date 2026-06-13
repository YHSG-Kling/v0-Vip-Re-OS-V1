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
//   "send_and_claim" — no first touch on record yet → this step IS the first touch; send it and
//                      STAMP the ledger so speed-to-lead's `first_touched_at IS NULL` guard skips

import { KernelEvent } from "@/lib/kernel/events"

/** Channels that constitute an actual outreach "hello" (wait/condition/task steps don't count). */
export const FIRST_TOUCH_OUTREACH_CHANNELS = new Set<string>([
  "email", "sms", "voice_drop", "ai_call", "direct_mail",
])

export type FirstTouchAction = "send" | "skip_duplicate" | "send_and_claim"

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

  // No first touch recorded → this welcome step claims the baton and stamps the ledger.
  if (!input.firstTouchedAt) return "send_and_claim"

  // A first touch already went out. Same channel → duplicate greeting, defer. Different
  // channel → a genuine second channel, allowed (e.g. ISA called, drip emails).
  if (input.firstTouchChannel && input.firstTouchChannel === input.stepChannel) {
    return "skip_duplicate"
  }
  return "send"
}
