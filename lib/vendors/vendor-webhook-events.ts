// lib/vendors/vendor-webhook-events.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE EVENT VOCABULARY OF THE VENDOR MARKETPLACE WEBHOOK — derived, not typed.
//
// Lane 80A registered the tenant-billing endpoint's events through the Stripe
// SDK and refused the vendor endpoint BY NAME: "its route dispatches through an
// event map, not a switch — a list this code cannot derive would be a second
// spelling". That was the honest refusal for the day; this is the derivation
// (lane 81E, 2026-09-24). The vendor route (app/api/webhooks/stripe/vendor/
// route.ts) has exactly two lanes, and each lane already OWNS its vocabulary
// as data:
//
//   · PAYOUT COMPLETION — lib/vendors/vendor-payout-events.ts ::
//     VENDOR_PAYOUT_COMPLETION_EVENTS (the map the route dispatches through:
//     transfer.created / transfer.reversed / payout.paid / payout.failed).
//   · SUBSCRIPTION LIFECYCLE — lib/kernel/vendor-subscription.ts ::
//     VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS (mapStripeEventToStatus's labels plus
//     customer.subscription.updated, which resolves on the object's status).
//
// So the endpoint's list is the UNION of the two, read from them. Nothing here
// is a third spelling: add an event to either lane and it is registered; add
// one here alone and the guard goes red (a registered-but-unhandled event is a
// lie the dashboard would believe).
//
// USED BY lib/billing/stripe-webhook-registration.ts (requiredWebhookEvents)
// and the launch checklist's vendor drift item. Pure — no client, no network.

import { VENDOR_PAYOUT_COMPLETION_EVENTS } from "./vendor-payout-events"
import { VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS } from "@/lib/kernel/vendor-subscription"

/** Every Stripe event type the vendor marketplace endpoint handles — payout
 *  completion ∪ subscription lifecycle, sorted so two derivations compare. */
export const VENDOR_MARKETPLACE_WEBHOOK_EVENTS: readonly string[] = Object.freeze(
  [...new Set([...Object.keys(VENDOR_PAYOUT_COMPLETION_EVENTS), ...VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS])].sort(),
)
