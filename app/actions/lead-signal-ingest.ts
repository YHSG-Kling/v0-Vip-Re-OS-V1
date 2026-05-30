"use server"

/**
 * app/actions/lead-signal-ingest.ts
 *
 * Thin server actions that the rest of the codebase calls when a
 * qualifying event happens. They build the SignalDelta and apply it
 * through the existing scoring path — no new tables, no replacement of
 * the AI scoring logic.
 *
 * Existing call sites that should plug into these:
 *   • Buyer offer workflow → ingestOfferLostSignalAction (when an offer's
 *     final state is `lost` or `withdrawn_after_competing_accepted`)
 *   • Open house attendee submission → ingestOpenHouseAttendeeSignalAction
 *   • The existing lead-scraping pipeline → ingestPredictiveSellerSignalAction
 *     (each predictive contributor — equity threshold, life event, etc.
 *     — calls in with its own signalKey + confidence)
 */

import {
  applySignalDelta,
  buildOfferLostSignal,
  buildOpenHouseAttendeeSignal,
  buildPredictiveSellerSignal,
} from "@/lib/lead-intelligence/signal-extensions"

export async function ingestOfferLostSignalAction(input: {
  contactId: string
  offerId: string
  offerAmount: number
  losingMargin?: number
}) {
  const delta = buildOfferLostSignal(input)
  return applySignalDelta(delta)
}

export async function ingestOpenHouseAttendeeSignalAction(input: {
  contactId: string
  attendeeId: string
  listingId: string
  interestLevel?: 1 | 2 | 3 | 4 | 5
}) {
  const delta = buildOpenHouseAttendeeSignal(input)
  return applySignalDelta(delta)
}

export async function ingestPredictiveSellerSignalAction(input: {
  contactId: string
  signalKey: string
  signalLabel: string
  confidence: number
  evidenceId?: string | null
  evidence?: Record<string, unknown>
}) {
  const delta = buildPredictiveSellerSignal(input)
  return applySignalDelta(delta)
}
