// lib/billing/billing-access.ts
// ─────────────────────────────────────────────────────────────────────────────
// The hands-off paywall brain: does a brokerage currently have paid access?
// Pure classifier (unit-testable) + a loader. The login gate uses this to route a
// lapsed-trial / past-due / cancelled tenant to billing so the money loop closes
// itself — a customer that stops paying stops getting the product, with no human
// in the loop. Conservative by design: a brokerage with NO subscription row is NOT
// blocked (legacy / staff-created accounts must never be locked out by accident).

export type BillingAccessState = "active" | "trialing" | "past_due" | "expired" | "none"

export interface BillingAccess {
  state: BillingAccessState
  /** True → the tenant should be routed to the paywall (billing page). */
  blocked: boolean
  /** Whole days left in the trial (>=0), or null when not trialing. */
  trialDaysLeft: number | null
  reason: string
}

export interface BillingSubRow {
  status: string | null
  trial_end: string | null
}

// CLASSIFY THROUGH THE ONE SHARED VOCABULARY, not a second local set.
//
// This used to hold its own literal set — `["past_due", "cancelled", "paused"]` —
// justified by the fact that subscriptions.status is CHECK-constrained to those
// spellings and so 'canceled' (Stripe's one-L spelling) "cannot happen". The
// premise was right about the column and wrong about the risk: the billing
// webhook was writing Stripe's RAW status into that column, the CHECK rejected
// every foreign spelling, the discarded update left the row on its previous
// 'active', and this function then read 'active' and let a cancelled tenant
// through. Reasoning from what a column ADMITS, when the writer was never
// checked, is how a paywall ends up never firing.
//
// The writer is fixed (lib/billing/stripe-status.ts toStoredSubscriptionStatus,
// wired into the webhook), but this stays defensive on purpose: it is the last
// gate before someone gets the product for free, legacy rows predate the fix,
// and normalizeStripeStatus is the same vocabulary the vendor billing path
// already classifies with. One vocabulary, both paths, every spelling.
import { normalizeStripeStatus, isCurrentStatus, isDelinquentStatus } from "./stripe-status"

/** PURE: classify a brokerage's access from its subscription row + now. */
export function resolveBillingAccess(sub: BillingSubRow | null, now: Date = new Date()): BillingAccess {
  if (!sub) return { state: "none", blocked: false, trialDaysLeft: null, reason: "no_subscription" }

  const status = (sub.status ?? "").toLowerCase()
  const canonical = normalizeStripeStatus(status)

  // canceled (either spelling) / past_due / unpaid / incomplete / paused all stop access.
  //
  // ONE PREDICATE, NOT A THIRD SPELLING (§6, wave 26). The delinquent set used to
  // be open-coded here, one import away from the file that owns it — so the
  // paywall and the vendor path could drift on what "not paying" means. It now
  // asks isDelinquentStatus.
  //
  // `paused` STAYS AN EXPLICIT CLAUSE, deliberately. isDelinquentStatus is
  // past_due | canceled | incomplete — it does NOT include paused, because a
  // paused subscription is not a DELINQUENCY (nobody failed to pay; billing is
  // suspended by arrangement). But it does stop access here. Folding paused into
  // the helper to shorten this line would silently widen "delinquent" for the
  // vendor path too; dropping it would silently UNBLOCK every paused tenant.
  // Both are paywall regressions, so the two ideas stay separate and named.
  if (isDelinquentStatus(status) || canonical === "paused") {
    return { state: canonical === "past_due" ? "past_due" : "expired", blocked: true, trialDaysLeft: null, reason: `status_${status}` }
  }

  // A trial that has run out is a hard paywall — this is the core enforcement.
  if (canonical === "trialing" && sub.trial_end) {
    const end = Date.parse(sub.trial_end)
    if (Number.isFinite(end)) {
      const msLeft = end - now.getTime()
      if (msLeft <= 0) return { state: "expired", blocked: true, trialDaysLeft: 0, reason: "trial_expired" }
      return { state: "trialing", blocked: false, trialDaysLeft: Math.ceil(msLeft / 86_400_000), reason: "trialing" }
    }
  }

  // Same one vocabulary for the paying side: isCurrentStatus is active|trialing.
  // The trial-expiry branch above has already run, so a trialing row reaching
  // here either has no trial_end or an unparseable one — it is still current.
  if (isCurrentStatus(status)) {
    return { state: canonical === "trialing" ? "trialing" : "active", blocked: false, trialDaysLeft: null, reason: `status_${status}` }
  }

  // Unknown status → don't lock out (fail-open), but surface it. Deliberate:
  // a status nobody recognises must never lock out a paying customer. Every
  // status Stripe actually emits is classified above, so reaching here means a
  // genuinely new value, and the reason string carries it for the operator.
  return { state: "none", blocked: false, trialDaysLeft: null, reason: `status_unknown_${status || "empty"}` }
}

/**
 * Load a brokerage's most-recent subscription and classify access.
 *
 * ── THE TRIAL END IS SPELLED TWICE AND THIS READER ONLY KNEW ONE SPELLING ────
 *
 * `subscriptions.trial_end` had exactly TWO writers, and neither runs on a
 * self-serve signup:
 *   · app/api/billing/webhook/route.ts (buildSubscriptionPatch) — needs a LIVE
 *     Stripe subscription, and signup deliberately creates none
 *     ("No Stripe customer at signup", app/actions/auth/signup-brokerage.ts:214);
 *   · app/actions/superadmin/brokerage-management.ts extendTrialAction — a
 *     staff comp, not something every tenant gets.
 *
 * What signup DOES write is `brokerages.trial_ends_at` (signup-brokerage.ts:163)
 * plus a `subscriptions` row with status='trialing' and `trial_end` left NULL.
 * The clause below reads `sub.trial_end`, finds NULL, skips the expiry branch
 * entirely and falls through to "trialing ⇒ not blocked" — so a 14-day trial
 * never expired and the tenant kept the whole product for free, forever. The
 * simulator could not see it because scripts/billing-access-simulator.ts SEEDS
 * `trial_end` itself (line 109) rather than signing a tenant up, so it proved
 * the classifier and never the writer.
 *
 * The reconciliation below is NOT invented here — it is the rule the other two
 * readers of this same fact already use, adopted so all three agree (§6):
 *   · lib/platform/subscription-oversight.ts:155  `sub?.trial_end ?? b.trial_ends_at`
 *   · app/api/cron/platform-sentinel/route.ts:312 `subTrialEnd.get(t.id) ?? t.trial_ends_at`
 *
 * The subscription column still WINS when present: a staff trial extension
 * writes both, and a Stripe-linked subscription's trial is the billed truth.
 * `brokerages.trial_ends_at` is only consulted when the subscription has no
 * answer — which, before Stripe is reconnected, is every self-serve tenant.
 *
 * A refused brokerages read is NOT allowed to invent a trial end: it leaves the
 * value null, which lands on the same fail-open path a missing row already took.
 */
export async function loadBillingAccess(svc: any, brokerageId: string, now: Date = new Date()): Promise<BillingAccess> {
  const [subRes, brkRes] = await Promise.all([
    svc
      .from("subscriptions")
      .select("status, trial_end, created_at")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc.from("brokerages").select("trial_ends_at").eq("id", brokerageId).maybeSingle(),
  ])

  const sub = (subRes?.data as BillingSubRow | null) ?? null
  if (!sub) return resolveBillingAccess(null, now)

  // supabase-js RESOLVES refusals (§3) — a refused brokerages read must not be
  // read as "this tenant has no trial deadline", so the error is checked before
  // the fallback is trusted.
  const tenantTrialEnd = brkRes?.error
    ? null
    : ((brkRes?.data as { trial_ends_at?: string | null } | null)?.trial_ends_at ?? null)

  return resolveBillingAccess({ ...sub, trial_end: sub.trial_end ?? tenantTrialEnd }, now)
}
