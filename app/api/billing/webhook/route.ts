import { NextRequest, NextResponse } from "next/server"
import { getPlatformStripe } from "@/lib/stripe"
import { verifyStripeWebhook } from "@/lib/billing/stripe-webhook-secrets"
import { createServiceClient } from "@/lib/supabase/service"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { syncBrokeragePlanTier } from "@/lib/billing/sync-plan-tier"
import { setStripeOnboardingByAccount } from "@/lib/connections/vendor-stripe"
import { buildSubscriptionPatch, upsertBrokerageSubscription, type NormalizedStripeSub } from "@/lib/billing/subscription-activation"
import { deriveSubscriptionSeatState, itemFactsOf, normalizeStripeSubscription, type TierSeatLink } from "@/lib/billing/seat-packages"
import { TENANT_BILLING_WEBHOOK_EVENTS } from "@/lib/billing/stripe-account-scope"
import { emitSubscriptionTransition, reminderCycle, sendSubscriptionReminder, resolveStripeEventTenant, withStripeEventLedger } from "@/lib/billing/stripe-subscription-ops"
// The tenant-admin roster, DERIVED (CLAUDE.md §4: spread the Set, never retype
// `["broker", "admin", …]`) — lane 140O replaced the inline owner lookup below.
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import Stripe from "stripe"

/** Every status this webhook moves emits its kernel event (wave 99A, LAW 5) — from the
 *  row's status BEFORE the write (upsertBrokerageSubscription returns it) to the patch's. */
async function emitWebhookTransition(
  brokerageId: string,
  res: { id: string | null; previousStatus?: string | null },
  patch: Record<string, unknown>,
): Promise<void> {
  const to = typeof patch.status === "string" ? patch.status : null
  if (!res.id || !to || (res.previousStatus ?? null) === to) return
  const r = await emitSubscriptionTransition({ brokerageId, subscriptionId: res.id, from: res.previousStatus ?? null, to, source: "webhook" })
  if (!r.ok) console.error("[Billing Webhook] subscription transition event not recorded:", r.error)
}

/** Normalize a Stripe subscription into the shape buildSubscriptionPatch wants,
 *  READING THE ITEMS (wave 79A): the plan item names the tier the tenant is
 *  billed for and the seat-package item's quantity is the seats they bought,
 *  so tier + extra seats follow Stripe on every subscription event. Status
 *  still goes through the ONE shared vocabulary (lib/billing/stripe-status.ts)
 *  — Stripe's 'canceled' / 'unpaid' / 'incomplete' spellings are not values
 *  subscriptions.status can hold, and a rejected write once left a cancelled
 *  tenant on a stale 'active'.
 *
 *  TOMBSTONE: the private `normalizeSub` that lived here moved to
 *  lib/billing/seat-packages.ts::normalizeStripeSubscription (the survivor the
 *  daily reconcile shares). A refused catalogue read falls back to
 *  metadata.tier_id for the tier and leaves the seat columns UNTOUCHED (the
 *  patch omits them), never zeroing what a tenant bought. */
async function normalizeSub(svc: ReturnType<typeof createServiceClient>, s: Stripe.Subscription): Promise<NormalizedStripeSub> {
  const { data: tiers, error } = await svc
    .from("subscription_tiers")
    .select("id, tier_name, stripe_price_id, stripe_seat_price_id, seat_package_size")
  if (error) {
    console.error("[Billing Webhook] catalogue read refused — tier from metadata only, seat columns left alone:", error.message)
    return normalizeStripeSubscription(s, null)
  }
  const seat = deriveSubscriptionSeatState(itemFactsOf(s as any), (tiers ?? []) as TierSeatLink[])
  if (seat.unmatchedPriceIds.length > 0) console.warn("[Billing Webhook] subscription items not in the catalogue:", s.id, seat.unmatchedPriceIds)
  return normalizeStripeSubscription(s, seat)
}

// Stripe webhook handler — THE PLATFORM'S BILLING LEDGER.
// Handles: checkout.session.completed, invoice.paid, invoice.payment_failed,
//          customer.subscription.created, customer.subscription.updated,
//          customer.subscription.deleted, customer.subscription.trial_will_end,
//          account.updated
// — exactly TENANT_BILLING_WEBHOOK_EVENTS (lib/billing/stripe-account-scope.ts),
// the ONE vocabulary the Stripe-SDK registration and the launch checklist
// read; scripts/stripe-webhook-events-guard.ts holds this switch equal to it
// (wave 80A). Add a case → add it there → the registration action enables it.
//
// ── WHOSE STRIPE ACCOUNT SIGNS THIS ENDPOINT ────────────────────────────────
//
// Every event handled below writes the PLATFORM's ledger of what tenants owe US:
// `subscriptions`, `billing_invoices`, `brokerages.plan_tier`, and the Connect
// onboarding flag that gates payouts. The merchant on that money is the platform
// (lib/billing/stripe-account-scope.ts — the account belongs to the PAYEE), so
// the only account whose deliveries may write here is the platform's.
//
// Verification no longer reads one hardcoded env secret. `verifyStripeWebhook`
// walks the platform's signing secret and then every TENANT's, and reports WHICH
// account signed — because with per-tenant Stripe accounts a tenant's own
// deliveries WILL arrive here, and answering them "invalid signature" is
// indistinguishable from an attack and so gets investigated as neither.
//
// A tenant-signed delivery is REFUSED for this ledger, by name. That refusal is
// the tenancy gate CLAUDE.md §4 asks for, in the one form available to a request
// with no session: the principal is the account that signed, and
// `metadata.brokerage_id` is written by whoever owns that account. Accepting a
// tenant-signed event here would let any tenant with a Stripe account move any
// other tenant's subscription row by putting their id in metadata — the IDOR
// shape, cryptographically closed instead of argued about.
export async function POST(request: NextRequest) {
  const body = await request.text()
  const signature = request.headers.get("stripe-signature")

  if (!signature) {
    return NextResponse.json({ error: "No signature" }, { status: 400 })
  }

  const verification = await verifyStripeWebhook({ endpoint: "tenant_billing", body, signature })

  if (verification.status === "no_candidates") {
    console.error("[Billing Webhook] REFUSED —", verification.message)
    return NextResponse.json({ error: verification.message }, { status: 500 })
  }
  if (verification.status === "unreadable") {
    // Fail CLOSED and say so. A 503 asks Stripe to retry; a 400 would tell the
    // sender their signature was bad when in fact WE could not check it.
    console.error("[Billing Webhook] REFUSED —", verification.message)
    return NextResponse.json({ error: verification.message }, { status: 503 })
  }
  if (verification.status === "unverified") {
    console.error("[Billing Webhook] REFUSED —", verification.message)
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  const event: Stripe.Event = verification.event

  if (verification.ownerType !== "platform") {
    // Signed by a TENANT's own Stripe account. Their money, their ledger — not
    // the platform's subscription ledger, which is the only thing this route
    // writes. 200 so Stripe stops retrying a delivery that will never be
    // applicable; `applied:false` and a reason so it is never mistaken for done.
    const reason =
      `Delivery to /api/billing/webhook was signed by ${verification.ownerType} ${verification.ownerId}'s own Stripe account. ` +
      `This endpoint writes the PLATFORM's billing ledger (what tenants owe the platform) and accepts platform-signed events only. ` +
      `Refusing rather than attributing a tenant-account event to the platform's books.`
    console.error("[Billing Webhook] REFUSED —", reason, "event:", event.type)
    return NextResponse.json({ received: true, applied: false, reason }, { status: 200 })
  }

  // THE PLATFORM's Stripe client, resolved (platform-owned credential row first,
  // STRIPE_SECRET_KEY as the platform's own floor) — never a tenant's.
  const stripe = await getPlatformStripe()

  // Webhook is authenticated by Stripe signature verification above. There is
  // no user session in this request, so the RLS-enforced server client would
  // block every upsert (current_user_brokerage_id() returns null → the
  // billing_invoices_tenant_* and subscriptions_tenant_* policies reject the
  // row). Use the service client.
  const supabase = createServiceClient()

  // AT MOST ONCE PER EVENT ID (wave 140J). The tenant is resolved BEFORE the switch
  // so the whole application of this event is one action-ledger claim keyed by the
  // Stripe event id (lib/billing/stripe-subscription-ops.ts withStripeEventLedger):
  // a redelivery replays the recorded outcome and inserts no second bell, emits no
  // second transition, advances no prospect twice. The row writers inside stay
  // idempotent by their own keys — this guards the side effects around them.
  const eventTenant = await resolveStripeEventTenant(stripe, event)

  try {
    const applied = await withStripeEventLedger({ eventId: event.id, eventType: event.type, brokerageId: eventTenant }, async () => {
    switch (event.type) {
      // ─── CHECKOUT COMPLETED → ACTIVATE + LINK (no duplicate row) ──────────────
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session
        const brokerageId = eventTenant
        if (!brokerageId) { console.error("[Billing Webhook] checkout.session.completed: no brokerage_id"); break }

        // Link the Stripe subscription to the brokerage's EXISTING (trialing) row —
        // never insert a duplicate. This is the activation that flips the account live.
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string)
          const patch = buildSubscriptionPatch(await normalizeSub(supabase, sub))
          await emitWebhookTransition(brokerageId, await upsertBrokerageSubscription(supabase, brokerageId, patch), patch)
          await syncBrokeragePlanTier(brokerageId)
          // THE TRIAL → CONVERTED MOMENT (wave 78A). The prospect row was
          // stamped 'trial' when the tenant was created (a free trial or a paid
          // activation awaiting this very event); money has now moved, so every
          // prospect linked to this brokerage advances. COUNTED (§3) — a zero is
          // the direct signer who was never a prospect, and is reported as zero.
          {
            const { data: advanced, error: advErr } = await supabase.from("platform_prospects")
              .update({ status: "converted", updated_at: new Date().toISOString() })
              .eq("converted_brokerage_id", brokerageId).eq("status", "trial")
              .select("id")
            if (advErr) console.error("[Billing Webhook] prospect trial→converted advance refused:", advErr.message)
            else if ((advanced ?? []).length > 0) console.log(`[Billing Webhook] ${(advanced ?? []).length} prospect(s) advanced trial→converted for ${brokerageId}`)
          }
          // Safety: ensure the paid account is fully provisioned (idempotent no-op
          // when signup already provisioned it).
          try {
            // THE OWNER = the tenant's first seat on the admin roster, OR the agent / team_lead a solo
            // tenant adopted with their REAL user_type (createTenantCore adoptExistingOwner — never
            // re-typed admin). `agent` is the one deliberate addition to the roster; the roster itself
            // is spread, not retyped. READ the error (§3): a refused read is not "no owner".
            const { data: owners, error: ownerErr } = await supabase.from("users").select("id").eq("brokerage_id", brokerageId)
              .in("user_type", ["agent", ...TENANT_ADMIN_USER_TYPES]).order("created_at", { ascending: true }).limit(1)
            if (ownerErr) console.error("[Billing Webhook] owner lookup for the safety repair refused:", ownerErr.message)
            const owner = ((owners ?? []) as Array<{ id: string }>)[0] ?? null
            if (owner?.id) {
              const { repairIncompleteAccountSetup } = await import("@/lib/kernel/users")
              await repairIncompleteAccountSetup(owner.id)
            }
            // SUBSCRIBER CONVERGENCE (wave 140C): money landed — if the tenant's
            // provisioning record (lib/kernel/tenant-creation.ts) still carries a
            // failed or missing step, the ONE core re-runs ONLY that step. A
            // complete record is a no-op, so a duplicate delivery of this event
            // can never mint a second website, actor, assistant, event or row.
            const { resumeTenantProvisioning } = await import("@/lib/kernel/tenant-creation")
            const resumed = await resumeTenantProvisioning(supabase, brokerageId)
            if (resumed.resumable && !resumed.result.ok) console.error("[Billing Webhook] provisioning resume refused:", resumed.result.error)
            else if (resumed.resumable) console.log(`[Billing Webhook] provisioning resumed for ${brokerageId}: pending ${resumed.result.provisioning?.completed_at ? "none" : "still open"}`)
          } catch (err) { console.warn("[Billing Webhook] provisioning safety-repair failed:", (err as any)?.message) }
          // IMMEDIATE POST-CONDITION (wave 141B — billing_activation), after the link + the safety net:
          // re-read the tenant's subscription row and verify it carries THIS Stripe subscription in an
          // operating state. Money: the consumer never auto-corrects it — the readiness subscription /
          // billing checks are BLOCKED to Finance and a human is told NOW, not on the next drift sweep.
          // The tenant sees only the activation sentence; the evidence row carries the Stripe ids.
          try {
            const { data: subRow, error: subErr } = await supabase.from("subscriptions").select("id, status, stripe_subscription_id, stripe_customer_id")
              .eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(1).maybeSingle()
            const row = subRow as { id: string; status: string | null; stripe_subscription_id: string | null; stripe_customer_id: string | null } | null
            const linked = !!row && row.stripe_subscription_id === sub.id && (row.status === "active" || row.status === "trialing")
            const { reportOperationOutcome } = await import("@/lib/kernel/immediate-operations")
            await reportOperationOutcome(supabase, {
              operation: "billing_activation", brokerageId, ok: !subErr && linked,
              subjectType: "subscription", subjectId: row?.id ?? null, source: "webhook", platformVisible: true,
              evidence: { stripe_event: event.id, expected_subscription: sub.id, row: row ? { id: row.id, status: row.status, linked_subscription: row.stripe_subscription_id === sub.id, has_customer: !!row.stripe_customer_id } : null },
              error: subErr ? `subscription re-read refused: ${subErr.message}` : linked ? null : `subscription row ${row ? `is ${row.status ?? "null"} / linked ${row.stripe_subscription_id ?? "none"}` : "absent"} after activation`,
              tenantFacing: !subErr && linked ? null : "your plan activation is being verified by Finance — you will hear from us if anything is needed",
            })
          } catch (verifyErr) { console.warn("[Billing Webhook] activation post-condition not reported:", (verifyErr as Error)?.message) }
        }
        break
      }

      // ─── INVOICE PAID ────────────────────────────────────────────────────────
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice
        const stripeInvoiceId = invoice.id

        // The tenant from the invoice's subscription metadata (resolved once, above).
        const brokerageId = eventTenant
        if (!brokerageId) {
          console.error("[Billing Webhook] No brokerage_id in subscription metadata")
          break
        }

        // Update or insert invoice record
        const { error } = await supabase
          .from("billing_invoices")
          .upsert({
            stripe_invoice_id: stripeInvoiceId,
            brokerage_id: brokerageId,
            amount_cents: invoice.amount_paid,
            status: "paid",
            invoice_date: new Date(invoice.created * 1000).toISOString().split("T")[0],
            paid_at: new Date().toISOString(),
            pdf_url: invoice.invoice_pdf || null,
          }, {
            onConflict: "stripe_invoice_id",
          })

        if (error) {
          console.error("[Billing Webhook] Failed to update invoice:", error)
        } else {
          // RECONCILIATION (wave 141H, m777): the discount STRIPE applied, from the invoice's own
          // total_discount_amounts — amount_cents above is already the discounted amount_paid. A
          // SEPARATE write: until m777 is applied the column is absent and this UPDATE is refused
          // entirely (PGRST204) — logged, and the invoice row above is untouched by it.
          const { invoiceDiscountCents } = await import("@/lib/billing/discount-codes")
          const discountCents = invoiceDiscountCents(invoice as any)
          if (discountCents > 0) {
            const { data: stamped, error: dErr } = await supabase.from("billing_invoices")
              .update({ discount_cents: discountCents }).eq("stripe_invoice_id", stripeInvoiceId).eq("brokerage_id", brokerageId).select("id")
            if (dErr) console.error("[Billing Webhook] invoice discount_cents not recorded (m777 applied?):", dErr.message)
            else if ((stamped ?? []).length !== 1) console.error(`[Billing Webhook] invoice discount_cents matched ${(stamped ?? []).length} rows for ${stripeInvoiceId}`)
          }
        }
        break
      }

      // ─── INVOICE PAYMENT FAILED ──────────────────────────────────────────────
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice
        const stripeInvoiceId = invoice.id

        // The tenant from the invoice's subscription metadata (resolved once, above).
        const brokerageId = eventTenant
        if (!brokerageId) {
          console.error("[Billing Webhook] No brokerage_id in subscription metadata")
          break
        }

        // Update invoice status to open (unpaid)
        const { error } = await supabase
          .from("billing_invoices")
          .upsert({
            stripe_invoice_id: stripeInvoiceId,
            brokerage_id: brokerageId,
            amount_cents: invoice.amount_due,
            status: "open",
            invoice_date: new Date(invoice.created * 1000).toISOString().split("T")[0],
            pdf_url: invoice.invoice_pdf || null,
          }, {
            onConflict: "stripe_invoice_id",
          })

        if (error) {
          console.error("[Billing Webhook] Failed to update invoice:", error)
        }

        // Emit payment failed alert notification. Blind-spot burn-down (lane
        // 75D, notification fan-out census) — sentinelWrite (service-role client).
        await sentinelWrite(supabase, supabase.from("notifications").insert({
          brokerage_id: brokerageId,
          type: "billing_alert",
          title: "Payment Failed",
          body: `Your subscription payment of $${(invoice.amount_due / 100).toFixed(2)} failed. Please update your payment method.`,
          priority: "high",
        }), { table: "notifications", flow: "billing_payment_failed_alert", brokerageId, reason: "the invoice row itself already recorded the failure; this is only the in-app alert" })

        break
      }

      // ─── SUBSCRIPTION CREATED / UPDATED (items: tier + seat packages) ────────
      // A tier change made in the Stripe dashboard, a seat-package quantity
      // change, a downgrade, a reprice — every one arrives here and the row
      // follows the ITEMS (wave 79A: "subscriptions will be setup in stripe so
      // they sync"). `created` is handled by the same branch so a subscription
      // staff mint directly in Stripe (custom multi_location pricing) lands too.
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription
        const brokerageId = subscription.metadata?.brokerage_id

        if (!brokerageId) {
          console.error("[Billing Webhook] No brokerage_id in subscription metadata")
          break
        }

        // Link/update the brokerage's ONE subscription row (never a duplicate) —
        // the signup row has no stripe_subscription_id, so a raw upsert-by-that-id
        // used to insert a second row here.
        const patch = buildSubscriptionPatch(await normalizeSub(supabase, subscription))
        await emitWebhookTransition(brokerageId, await upsertBrokerageSubscription(supabase, brokerageId, patch), patch)

        // Keep brokerages.plan_tier in sync with the active subscription so
        // cap-enforcement reflects upgrades/downgrades immediately. Failure
        // here is logged but doesn't fail the webhook.
        await syncBrokeragePlanTier(brokerageId)

        // RECONCILIATION (wave 141H, m777): the coupon Stripe actually carries on this subscription
        // stamps the tenant's redemption row (stripe_discount_id / stripe_applied_at) — the ledger
        // learns from Stripe, never the other way round. Separate write; refused-and-logged until m777.
        {
          const { subscriptionDiscountCoupon, stampCouponStripeApplication } = await import("@/lib/billing/discount-codes")
          const carried = subscriptionDiscountCoupon(subscription)
          if (carried) {
            const r = await stampCouponStripeApplication(supabase, { brokerageId, stripeCouponId: carried.stripeCouponId, stripeDiscountId: carried.stripeDiscountId, appliedAt: new Date().toISOString() })
            if (!r.ok) console.error("[Billing Webhook] coupon redemption not reconciled to Stripe (m777 applied?):", r.error)
          }
        }
        break
      }

      // ─── SUBSCRIPTION DELETED/CANCELLED ──────────────────────────────────────
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription
        const brokerageId = subscription.metadata?.brokerage_id

        if (!brokerageId) {
          console.error("[Billing Webhook] No brokerage_id in subscription metadata")
          break
        }

        // Update subscription status to cancelled
        const { data: cancelledRows, error } = await supabase
          .from("subscriptions")
          .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", subscription.id)
          .select("id")

        if (error) {
          console.error("[Billing Webhook] Failed to cancel subscription:", error)
        } else if ((cancelledRows ?? []).length === 0) {
          // An UPDATE matching nothing resolves too (§3) — say so, never read it as done.
          console.error(`[Billing Webhook] customer.subscription.deleted matched no local row for ${subscription.id}`)
        }
        for (const row of (cancelledRows ?? []) as Array<{ id: string }>) {
          await emitWebhookTransition(brokerageId, { id: row.id, previousStatus: null }, { status: "cancelled" })
        }

        // Cap-enforcement: with no active subscription the brokerage falls
        // back to the entry-level tier. Caps tighten immediately so we can't
        // burn paid features on a cancelled account.
        await syncBrokeragePlanTier(brokerageId)

        // Notify brokerage
        await sentinelWrite(supabase, supabase.from("notifications").insert({
          brokerage_id: brokerageId,
          type: "billing_alert",
          title: "Subscription Cancelled",
          body: "Your subscription has been cancelled. Your access will be limited.",
          priority: "high",
        }), { table: "notifications", flow: "billing_subscription_cancelled_alert", brokerageId, reason: "the tier downgrade itself already applied; this is only the in-app alert" })

        break
      }

      // ─── TRIAL WILL END (wave 99A) — Stripe's 3-day notice → the trial reminder ──
      // The SAME sender and ledger cycle the daily sweep uses
      // (lib/billing/stripe-subscription-ops.ts sendSubscriptionReminder,
      // cycle = trial_end:<date>:<recipient>), so whichever of the two arrives
      // first sends and the other replays from the action ledger. The tenant is
      // the platform-signed event's metadata AND must match a row carrying this
      // Stripe subscription id — never a body field.
      case "customer.subscription.trial_will_end": {
        const subscription = event.data.object as Stripe.Subscription
        const brokerageId = subscription.metadata?.brokerage_id
        if (!brokerageId || !subscription.trial_end) {
          console.error("[Billing Webhook] trial_will_end without brokerage_id or trial_end:", subscription.id)
          break
        }
        const { data: row, error: rowErr } = await supabase
          .from("subscriptions").select("id, brokerage_id")
          .eq("stripe_subscription_id", subscription.id).eq("brokerage_id", brokerageId)
          .maybeSingle()
        if (rowErr || !row) {
          console.error("[Billing Webhook] trial_will_end: no local subscription row —", rowErr?.message ?? subscription.id)
          break
        }
        const aboutIso = new Date(subscription.trial_end * 1000).toISOString()
        const sent = await sendSubscriptionReminder(supabase, row as { id: string; brokerage_id: string }, { kind: "trial_end", cycle: reminderCycle("trial_end", aboutIso), aboutIso })
        if (sent.error) console.error("[Billing Webhook] trial reminder not sent:", sent.error)
        break
      }

      // ─── STRIPE CONNECT: ACCOUNT UPDATED (onboarding complete) ───────────────
      case "account.updated": {
        const account = event.data.object as Stripe.Account
        // PASS the computed boolean, do not GATE on it. This branch used to be
        // `if (details_submitted && charges_enabled) set(..., true)` — it could
        // only ever promote. When Stripe later RESTRICTS a connected account
        // (expired verification documents, failed KYC, charges_enabled flipping
        // back to false) that fires another account.updated with the flag false,
        // and the old shape simply ignored it: `stripe_onboarding_complete`
        // stayed true forever.
        //
        // That is a money defect, not a cosmetic one. `initiateVendorPayout`
        // hard-gates on `connect.onboardingComplete` immediately before
        // `stripe.transfers.create()`, so a stale-true flag kept the payout lane
        // transferring to a destination that can no longer receive.
        //
        // Merged from app/actions/vendor-payments.ts:completeStripeConnectOnboarding,
        // which computed the same boolean and passed it through — the only
        // implementation in the tree that could DEMOTE. (Orphan burn-down w2s2:
        // the orphan held the correct behaviour and the wired survivor held the
        // hole — the same shape as the voice-clone ownership guard in wave 1.)
        await setStripeOnboardingByAccount(
          supabase,
          account.id,
          Boolean(account.details_submitted && account.charges_enabled),
        )
        break
      }

      default:
        // A delivery of an event the registration vocabulary NAMES but this
        // switch does not handle is drift between the two — the guard holds
        // them equal at build time; at run time it is logged as an error, not
        // as the routine "unhandled" line Stripe's extra events get.
        if (TENANT_BILLING_WEBHOOK_EVENTS.includes(event.type)) {
          console.error(`[Billing Webhook] DRIFT — ${event.type} is in TENANT_BILLING_WEBHOOK_EVENTS but has no case here`)
        } else {
          console.log(`[Billing Webhook] Unhandled event type: ${event.type}`)
        }
    }
    return "applied" as const
    })

    switch (applied.kind) {
      case "applied":
        return NextResponse.json({ received: true, ledgered: applied.ledgered })
      case "replay":
        // The SAME event id was already applied — acknowledged, nothing re-ran.
        console.log(`[Billing Webhook] replay of ${event.id} (${event.type}) — already applied, nothing re-ran`)
        return NextResponse.json({ received: true, applied: false, replay: true })
      case "in_flight":
        return NextResponse.json({ received: true, applied: false, reason: "a concurrent delivery of this event is being applied" })
      case "unknown":
        console.error(`[Billing Webhook] ${event.id} (${event.type}): an earlier attempt's outcome is unknown — not re-run; the daily Stripe reconcile re-mirrors the subscription`)
        return NextResponse.json({ received: true, applied: false, reason: "earlier attempt outcome unknown — reconcile will mirror Stripe" })
      case "refused":
        // Fail CLOSED and retryable: without the at-most-once claim this event is not applied.
        console.error("[Billing Webhook] REFUSED — action ledger claim:", applied.error)
        return NextResponse.json({ error: applied.error }, { status: 503 })
    }
  } catch (err) {
    console.error("[Billing Webhook] Error processing event:", err)
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 })
  }
}
