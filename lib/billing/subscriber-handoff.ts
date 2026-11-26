// lib/billing/subscriber-handoff.ts
// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIBER → BROKERAGE BILLING HANDOFF (wave 141H). The Stripe side of lane
// 141A's relationship-transfer rail: an independent subscriber (a solo agent or
// team that paid the platform directly) is adopted by the ACTUAL brokerage
// location, and from `effectiveAt` the brokerage's subscription — its seat — is
// the billing relationship.
//
// Owner (wave 141, BROKERAGE IDENTITY, binding): "stop individual billing at the
// right effective time → Stripe proration → no double billing → brokerage owns
// the seat/platform relationship; the brokerage MAY charge a tech fee through
// canonical Stripe rails (never a fabricated amount). Migration: idempotent,
// cannot cross to the wrong brokerage/location, invoices immutable, no lost
// paid period, no fabricated refund."
//
// CONTRACT (lane 141A calls exactly this, by name):
//   handoffSubscriberBillingToBrokerage(svc, { sourceBrokerageId, targetBrokerageId, effectiveAt, actorUserId })
//
// SURVIVORS THIS RIDES (nothing rebuilt):
//   · subscriptions (the ONE row per tenant; lib/billing/subscription-activation.ts
//     upsertBrokerageSubscription is its writer from Stripe) — the source row's
//     cancel_at / status are written here COUNTED; Stripe's webhook mirrors the
//     rest (customer.subscription.updated / deleted → app/api/billing/webhook/route.ts).
//   · lib/billing/stripe-subscription-ops.ts stripeEndSubscriptionForHandoff —
//     the SDK call: cancel_at + create_prorations for a future date, or
//     cancel(prorate, invoice_now) when the date has arrived. Stripe computes
//     the proration; nothing here invents a credit or a refund.
//   · lib/kernel/action-ledger.ts withActionLedger — FINANCIAL, cycle =
//     (target, effectiveAt): a second run is a REPLAY that acts on nothing and
//     returns the recorded outcome. The Stripe idempotency key is the same cycle.
//   · lib/kernel/emit.ts SUBSCRIPTION_CANCELLED (the reactor routes it
//     finance_manager → data_steward; lib/kernel/event-reactor.ts:1011) with
//     metadata.reason "brokerage_handoff" — the human notification goes through
//     the registered managers, never a new one.
//   · lib/kernel/seat-usage.ts resolveSeatUsage / resolveCatalogSeatLimits /
//     resolveTenantSeatTerms + lib/kernel/tier-role-matrix.ts effectiveSeatLimit
//     — whether the target's plan SEATS the adopted producer. Over the limit the
//     verdict names the door (the target's commerce admin buys a package or
//     upgrades through app/actions/billing.ts — a purchase obligates the
//     brokerage to pay, so it is theirs to click, never this function's).
//   · brokerage_fee_types / agent_fee_assignments (app/actions/brokerage-fees.ts)
//     — the brokerage's configured recurring agent fees (tech / desk / E&O),
//     collected through the commission waterfall
//     (lib/commission/waterfall/10-fees.ts). At HEAD there is NO Stripe rail that
//     charges an agent a tech fee; the verdict REPORTS the configured fee types
//     and charges nothing (never a fabricated amount — an owner item).
//
// WHAT "NO DOUBLE BILLING / NO LOST PAID PERIOD" MEANS HERE: the individual's
// subscription keeps running until effectiveAt (service through what they paid
// for); the cancel at effectiveAt prorates the unused remainder of the current
// period as a Stripe credit (create_prorations) or onto the final invoice
// (invoice_now) — Stripe's arithmetic, Stripe's invoice. The target brokerage is
// billed for the seat through ITS subscription per its own tier/package terms
// (the seat verdict says whether a package is needed); nothing is charged twice
// because nothing is charged here at all.

import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { stripeEndSubscriptionForHandoff, type HandoffStripeResult } from "./stripe-subscription-ops"

const LIVE_STATUSES = ["active", "trialing", "past_due", "paused"] as const

export interface SubscriberHandoffInput {
  sourceBrokerageId: string
  targetBrokerageId: string
  /** ISO timestamp (or Date) the individual's billing stops; ≤ now ⇒ immediate. */
  effectiveAt: string | Date
  /** users.id of the human who approved the transfer (lane 141A verified the consent + authority). */
  actorUserId: string
  /** Free text for the Stripe cancellation_details comment + the evidence row. */
  reason?: string | null
}

interface SubscriberHandoffDeps {
  /** Stripe seam (default: stripeEndSubscriptionForHandoff). */
  endSubscription?: typeof stripeEndSubscriptionForHandoff
  /** Ledger client seam (default: the service client inside withActionLedger). */
  ledgerClient?: { from: (table: string) => any }
  /** Kernel-event seam (default: emitKernelEvent). */
  emit?: (e: Record<string, unknown>) => Promise<unknown>
  now?: Date
}

type SubscriberHandoffRefusal =
  | "same_tenant"
  | "invalid_effective_at"
  | "actor_not_authorized"
  | "source_tenant_unknown"
  | "target_tenant_unknown"
  | "target_not_subscribed"
  | "source_read_refused"
  | "stripe_refused"
  | "stripe_unconfigured"
  | "local_write_refused"

interface TargetSeatVerdict {
  tier: string | null
  seatCount: number | null
  limit: number | null
  /** The adopted producer fits the target's current band + packages. */
  fits: boolean | null
  /** Sentence for the target's commerce admin when it does not fit (the door). */
  message: string | null
}

interface TargetTechFeeVerdict {
  /** "none" = the brokerage configured no active recurring agent fee; "configured_waterfall" = fee
   *  types exist and are collected through the commission waterfall; nothing is charged here. */
  status: "none" | "configured_waterfall" | "unreadable"
  feeTypeIds: string[]
  chargedCents: 0
}

export type SubscriberHandoffResult =
  | {
      ok: true
      /** true ⇒ this (source, target, effectiveAt) was already handed off — nothing acted again. */
      replay: boolean
      source: {
        subscriptionId: string | null
        stripeSubscriptionId: string | null
        /** stripe_scheduled_cancel: Stripe cancels at effectiveAt with create_prorations ·
         *  stripe_cancelled_now: cancelled with prorate + invoice_now (final invoice issued) ·
         *  local_scheduled: no Stripe subscription (trial / invoiced) — cancel_at written, the daily
         *  lifecycle sweep moves it to 'cancelled' when the date arrives ·
         *  local_cancelled_now: no Stripe subscription, date reached — status 'cancelled' now ·
         *  no_subscription: the source had no live subscription row (nothing to stop). */
        mode: "stripe_scheduled_cancel" | "stripe_cancelled_now" | "local_scheduled" | "local_cancelled_now" | "no_subscription"
        effectiveAt: string
        proration: "create_prorations" | "prorate_invoice_now" | "none"
        finalInvoiceId: string | null
      }
      target: { brokerageId: string; subscriptionId: string | null; stripeLinked: boolean; seat: TargetSeatVerdict; techFee: TargetTechFeeVerdict }
      evidence: { ledgerAction: string; cycle: string; eventEmitted: boolean }
    }
  | { ok: false; refused: SubscriberHandoffRefusal; error: string }

type SubRow = { id: string; brokerage_id: string; status: string | null; stripe_subscription_id: string | null; stripe_customer_id: string | null; cancel_at: string | null; current_period_end: string | null }

const LEDGER_ACTION = "billing.subscription.handoff_to_brokerage"

/** @proofSeam the handoff below is its runtime caller; scripts/coupons-and-handoff-guard.ts asserts the Stripe idempotency key equals this cycle.
 *  PURE: the ledger cycle / Stripe idempotency key of a handoff — one per (source, target, effective date-time). */
export function handoffCycle(sourceBrokerageId: string, targetBrokerageId: string, effectiveAtIso: string): string {
  return `handoff:${sourceBrokerageId}:${targetBrokerageId}:${effectiveAtIso}`
}

async function liveSubscription(svc: any, brokerageId: string): Promise<{ row: SubRow | null; error: string | null }> {
  const { data, error } = await svc
    .from("subscriptions")
    .select("id, brokerage_id, status, stripe_subscription_id, stripe_customer_id, cancel_at, current_period_end")
    .eq("brokerage_id", brokerageId)
    .in("status", [...LIVE_STATUSES])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { row: null, error: error.message }
  return { row: (data as SubRow | null) ?? null, error: null }
}

/** Does the target's plan seat the adopted producer? Read through the ONE seat facts. */
async function targetSeatVerdict(svc: any, targetBrokerageId: string): Promise<TargetSeatVerdict> {
  const { resolveSeatUsage, resolveCatalogSeatLimits, resolveTenantSeatTerms } = await import("@/lib/kernel/seat-usage")
  const { effectiveSeatLimit, parseSeatOverride, TIER_LABELS, isCanonicalTier } = await import("@/lib/kernel/tier-role-matrix")
  const [{ data: brk }, usage, catalog, terms] = await Promise.all([
    svc.from("brokerages").select("plan_tier, billing_metadata").eq("id", targetBrokerageId).maybeSingle(),
    resolveSeatUsage(svc, targetBrokerageId),
    resolveCatalogSeatLimits(svc),
    resolveTenantSeatTerms(svc, targetBrokerageId),
  ])
  const tier = (brk as { plan_tier?: string | null } | null)?.plan_tier ?? null
  if (!usage.ok || !catalog.ok || !terms.ok) {
    return { tier, seatCount: usage.ok ? usage.seatCount : null, limit: null, fits: null, message: "The brokerage's seats could not be read — its admin must confirm the seat from Billing." }
  }
  const { limit } = effectiveSeatLimit(tier, parseSeatOverride((brk as { billing_metadata?: unknown } | null)?.billing_metadata), catalog.limits, terms.terms)
  // The adopted producer is already (or about to be) counted on the target by lane 141A's migration;
  // the question is whether the CURRENT count fits the CURRENT limit.
  const fits = limit === null ? true : usage.seatCount <= limit
  const label = isCanonicalTier(tier) ? TIER_LABELS[tier] : (tier ?? "the current plan")
  return {
    tier, seatCount: usage.seatCount, limit, fits,
    message: fits ? null : `${label} seats ${limit} producers and the brokerage now has ${usage.seatCount} — buy a seat package or upgrade from Billing before the next billing date.`,
  }
}

/** The target's configured recurring agent fees — REPORTED, never charged (no Stripe tech-fee rail at HEAD). */
async function targetTechFeeVerdict(svc: any, targetBrokerageId: string): Promise<TargetTechFeeVerdict> {
  const { data, error } = await svc.from("brokerage_fee_types").select("id, is_active").eq("brokerage_id", targetBrokerageId).eq("is_active", true)
  if (error) return { status: "unreadable", feeTypeIds: [], chargedCents: 0 }
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  return { status: ids.length > 0 ? "configured_waterfall" : "none", feeTypeIds: ids, chargedCents: 0 }
}

/**
 * THE HANDOFF. Validates (fail closed), stops the individual's direct subscription
 * at `effectiveAt` through Stripe with proration (or locally when it was never
 * Stripe-linked), records the evidence, emits the cancellation event, and reports
 * the target's seat + fee posture. Idempotent per (source, target, effectiveAt).
 */
export async function handoffSubscriberBillingToBrokerage(
  svc: any,
  input: SubscriberHandoffInput,
  deps: SubscriberHandoffDeps = {},
): Promise<SubscriberHandoffResult> {
  const now = deps.now ?? new Date()
  const source = String(input.sourceBrokerageId ?? "").trim()
  const target = String(input.targetBrokerageId ?? "").trim()
  if (!source || !target) return { ok: false, refused: "source_tenant_unknown", error: "Both the source and the target brokerage are required." }
  if (source === target) return { ok: false, refused: "same_tenant", error: "The source and the target are the same tenant — nothing to hand off." }
  const effMs = input.effectiveAt instanceof Date ? input.effectiveAt.getTime() : Date.parse(String(input.effectiveAt))
  if (!Number.isFinite(effMs)) return { ok: false, refused: "invalid_effective_at", error: "The effective date is not a valid timestamp." }
  const effectiveAt = new Date(effMs).toISOString()
  const cycle = handoffCycle(source, target, effectiveAt)

  // Tenancy (fail closed): the actor must be an admin OF THE TARGET (the adopting brokerage) or
  // platform staff (platform_role). A source-side or unrelated actor cannot move billing anywhere.
  const { data: actor, error: actorErr } = await svc.from("users").select("id, brokerage_id, user_type, platform_role").eq("id", input.actorUserId).maybeSingle()
  if (actorErr) return { ok: false, refused: "actor_not_authorized", error: `The approving user could not be read: ${actorErr.message}` }
  const a = actor as { brokerage_id?: string | null; user_type?: string | null; platform_role?: string | null } | null
  const platformStaff = !!a?.platform_role
  const targetAdmin = a?.brokerage_id === target && TENANT_ADMIN_USER_TYPES.has(String(a?.user_type ?? "").toLowerCase())
  if (!a || (!platformStaff && !targetAdmin)) return { ok: false, refused: "actor_not_authorized", error: "Only an admin of the adopting brokerage or platform staff can hand billing off." }

  const [{ data: srcBrk, error: sErr }, { data: tgtBrk, error: tErr }] = await Promise.all([
    svc.from("brokerages").select("id, name").eq("id", source).maybeSingle(),
    svc.from("brokerages").select("id, name").eq("id", target).maybeSingle(),
  ])
  if (sErr || !srcBrk) return { ok: false, refused: "source_tenant_unknown", error: sErr ? `Source brokerage read refused: ${sErr.message}` : "The source brokerage does not exist." }
  if (tErr || !tgtBrk) return { ok: false, refused: "target_tenant_unknown", error: tErr ? `Target brokerage read refused: ${tErr.message}` : "The target brokerage does not exist." }

  // The brokerage must OWN a platform relationship to take the seat onto.
  const tgt = await liveSubscription(svc, target)
  if (tgt.error) return { ok: false, refused: "target_not_subscribed", error: `Target subscription read refused: ${tgt.error}` }
  if (!tgt.row) return { ok: false, refused: "target_not_subscribed", error: "The adopting brokerage has no live subscription to carry the seat — activate its plan first." }

  const src = await liveSubscription(svc, source)
  if (src.error) return { ok: false, refused: "source_read_refused", error: `Source subscription read refused: ${src.error}` }

  const seat = await targetSeatVerdict(svc, target)
  const techFee = await targetTechFeeVerdict(svc, target)
  const targetOut = { brokerageId: target, subscriptionId: tgt.row.id, stripeLinked: !!tgt.row.stripe_subscription_id, seat, techFee }

  if (!src.row) {
    return {
      ok: true, replay: false,
      source: { subscriptionId: null, stripeSubscriptionId: null, mode: "no_subscription", effectiveAt, proration: "none", finalInvoiceId: null },
      target: targetOut, evidence: { ledgerAction: LEDGER_ACTION, cycle, eventEmitted: false },
    }
  }
  const row = src.row
  const immediate = effMs <= now.getTime()
  const endSubscription = deps.endSubscription ?? stripeEndSubscriptionForHandoff
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const ledgerOpts = deps.ledgerClient ? { client: deps.ledgerClient } : undefined

  type Acted = {
    replay: boolean
    mode: "stripe_scheduled_cancel" | "stripe_cancelled_now" | "local_scheduled" | "local_cancelled_now"
    proration: "create_prorations" | "prorate_invoice_now" | "none"
    finalInvoiceId: string | null
    error: string | null
    refused: SubscriberHandoffRefusal | null
  }

  const acted = await withActionLedger<Acted>(
    {
      brokerageId: source, action: LEDGER_ACTION, actor: { type: "user", userId: input.actorUserId },
      subject: { type: "subscription", id: row.id, ref: target }, cycle, reasonCode: "SUBSCRIPTION_LIFECYCLE",
      reasonDetail: input.reason ?? "independent subscriber adopted by its brokerage — billing moves to the brokerage seat",
      riskClass: "FINANCIAL", systemSource: "billing_lifecycle",
      detail: { source_brokerage_id: source, target_brokerage_id: target, effective_at: effectiveAt, stripe_subscription_id: row.stripe_subscription_id, immediate, target_seat: seat, target_tech_fee: techFee },
    },
    async (): Promise<Acted> => {
      if (row.stripe_subscription_id) {
        const r: HandoffStripeResult = await endSubscription(row.stripe_subscription_id, Math.floor(effMs / 1000), Math.floor(now.getTime() / 1000), cycle, input.reason ?? undefined)
        if (!r.applied) {
          return { replay: false, mode: immediate ? "stripe_cancelled_now" : "stripe_scheduled_cancel", proration: "none", finalInvoiceId: null, error: r.skipped ? "Stripe is not configured — the subscription cannot be ended from this environment." : `Stripe refused: ${r.error ?? "unknown"}`, refused: r.skipped ? "stripe_unconfigured" : "stripe_refused" }
        }
        // Local mirror of INTENT only (cancel_at); Stripe's webhook writes status / cancelled_at. COUNTED.
        const { data: w, error: wErr } = await svc.from("subscriptions")
          .update({ cancel_at: effectiveAt, updated_at: now.toISOString() })
          .eq("id", row.id).eq("brokerage_id", source).select("id")
        if (wErr || ((w ?? []) as unknown[]).length !== 1) {
          console.error("[subscriber-handoff] Stripe accepted the cancel but the local cancel_at write was refused — the reconcile mirrors Stripe:", wErr?.message ?? "matched no row")
        }
        return { replay: false, mode: r.mode === "cancelled_now" ? "stripe_cancelled_now" : "stripe_scheduled_cancel", proration: r.mode === "cancelled_now" ? "prorate_invoice_now" : "create_prorations", finalInvoiceId: r.finalInvoiceId ?? null, error: null, refused: null }
      }
      // Never Stripe-linked (a local trial / a staff-invoiced tenant): nothing to prorate. Scheduled →
      // cancel_at (the daily sweep enforces it); reached → cancelled now. COUNTED (§3).
      const patch = immediate
        ? { status: "cancelled", cancelled_at: now.toISOString(), cancel_at: effectiveAt, updated_at: now.toISOString() }
        : { cancel_at: effectiveAt, updated_at: now.toISOString() }
      const { data: w, error: wErr } = await svc.from("subscriptions").update(patch).eq("id", row.id).eq("brokerage_id", source).select("id")
      if (wErr) return { replay: false, mode: immediate ? "local_cancelled_now" : "local_scheduled", proration: "none", finalInvoiceId: null, error: `The subscription row refused the change: ${wErr.message}`, refused: "local_write_refused" }
      if (((w ?? []) as unknown[]).length !== 1) return { replay: false, mode: immediate ? "local_cancelled_now" : "local_scheduled", proration: "none", finalInvoiceId: null, error: "The subscription row matched nothing — the tenant predicate refused.", refused: "local_write_refused" }
      return { replay: false, mode: immediate ? "local_cancelled_now" : "local_scheduled", proration: "none", finalInvoiceId: null, error: null, refused: null }
    },
    {
      settle: (r) => ({ status: r.error ? "failed" : "executed", outcome: r.error ? (r.refused ?? "refused") : r.mode, provider: row.stripe_subscription_id ? "stripe" : null, providerRef: row.stripe_subscription_id ?? null, error: r.error }),
      // A replay / in-flight / unknown / refused claim acts on nothing: the first run's outcome stands.
      replay: (claim) => ({
        replay: claim.kind === "replay",
        mode: (claim.kind === "replay" || claim.kind === "unknown") && claim.entry?.outcome && /^(stripe_scheduled_cancel|stripe_cancelled_now|local_scheduled|local_cancelled_now)$/.test(claim.entry.outcome)
          ? (claim.entry.outcome as Acted["mode"])
          : (row.stripe_subscription_id ? (immediate ? "stripe_cancelled_now" : "stripe_scheduled_cancel") : (immediate ? "local_cancelled_now" : "local_scheduled")),
        proration: row.stripe_subscription_id ? (immediate ? "prorate_invoice_now" : "create_prorations") : "none",
        finalInvoiceId: null,
        error: claim.kind === "refused" ? claim.error : claim.kind === "in_flight" ? "A handoff for this subscription is already in progress." : null,
        refused: claim.kind === "refused" || claim.kind === "in_flight" ? "local_write_refused" : null,
      }),
    },
    ledgerOpts,
  )
  if (acted.error) return { ok: false, refused: acted.refused ?? "stripe_refused", error: acted.error }

  // Evidence the reactor fans out (finance_manager → data_steward): deduped on the cycle, so a
  // replay (which did not act) does not emit a second cancellation.
  let eventEmitted = false
  if (!acted.replay) {
    try {
      const { KernelEvent } = await import("@/lib/kernel/events")
      const emit = deps.emit ?? (async (e: Record<string, unknown>) => (await import("@/lib/kernel/emit")).emitKernelEvent(e as any))
      await emit({
        event: KernelEvent.SUBSCRIPTION_CANCELLED, brokerageId: source, entityType: "subscription", entityId: row.id,
        actorUserId: input.actorUserId, source: "system",
        metadata: { reason: "brokerage_handoff", target_brokerage_id: target, effective_at: effectiveAt, mode: acted.mode, proration: acted.proration, final_invoice_id: acted.finalInvoiceId, stripe_subscription_id: row.stripe_subscription_id, cancelled_by: input.actorUserId },
        dedupeKey: cycle, dedupeWindowSec: 7 * 86_400,
      })
      eventEmitted = true
    } catch (err) {
      console.warn("[subscriber-handoff] SUBSCRIPTION_CANCELLED emit failed (ledger row stands):", (err as Error)?.message)
    }
  }

  return {
    ok: true, replay: acted.replay,
    source: { subscriptionId: row.id, stripeSubscriptionId: row.stripe_subscription_id, mode: acted.mode, effectiveAt, proration: acted.proration, finalInvoiceId: acted.finalInvoiceId },
    target: targetOut,
    evidence: { ledgerAction: LEDGER_ACTION, cycle, eventEmitted },
  }
}
