// lib/billing/subscriber-billing-handoff.ts
// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIBER → BROKERAGE BILLING HANDOFF — THE ONE SEAM (wave 141, lane 141A
// defines the contract; lane 141H implements the Stripe side behind it).
//
// OWNER, 2026-10-14: "stop individual billing at the right effective time →
// Stripe proration → no double billing → brokerage owns the seat/platform
// relationship; the brokerage MAY charge a tech fee through canonical Stripe
// rails (never a fabricated amount) … invoices immutable, no lost paid period,
// no fabricated refund."
//
// THE CONTRACT. The transfer rail (lib/kernel/brokerage-transfer.ts) calls
// exactly ONE billing function — this one — with canonical ids and the
// effective instant, and treats the result as the billing verdict:
//   ok:true   → the source tenant's individual billing stops at `effectiveAt`
//               (or never ran), the target brokerage holds the seat, and the
//               evidence says how; the rail may archive the source tenant.
//   ok:false  → NOTHING about billing changed; `code` says why, and the rail
//               records the step as pending, notifies the Finance Manager, and
//               does NOT archive the source (archiving a tenant Stripe is still
//               invoicing would be double billing by omission). A later run
//               retries this same call — it is idempotent.
//
// WHAT THIS DEFAULT IMPLEMENTATION DOES AT 01a71c3c2 (honest, no Stripe):
//   · source has no subscription row, or its row is already cancelled → ok,
//     mode "no_individual_billing" (a re-run on a finished handoff).
//   · source row is 'trialing' with NO Stripe subscription (no money ever
//     moved) → the row is cancelled at `effectiveAt`, COUNTED → ok, mode
//     "trial_closed".
//   · source row names a Stripe subscription → the Stripe side (cancel at the
//     effective time with proration, the brokerage's seat / tech-fee items,
//     invoice immutability) is LANE 141H's: `deps.stripeSide` when registered,
//     else ok:false code "stripe_handoff_pending". No price, fee or refund is
//     ever invented here (wave 139: tier pricing is not set; unknown stays unknown).
//   · source row is 'active' without Stripe (staff-invoiced, billing_mode
//     'active') → ok:false code "staff_invoiced_pending": a person on the
//     Finance side stops the invoice; nothing is guessed.
//   · target has no subscription row → ok:false code "target_subscription_missing"
//     (the brokerage must own the seat relationship before it takes a seat).
//
// TENANT: both ids are the transfer request's canonical ids — never a request
// body. Every write is counted (CLAUDE.md §3). No kernel / AI import edges:
// lib/billing stays on the proxy's own compile.

export interface SubscriberBillingHandoffInput {
  sourceBrokerageId: string
  targetBrokerageId: string
  /** ISO instant individual billing stops / the brokerage relationship begins. */
  effectiveAt: string
  /** brokerage_transfer_requests.id — the evidence key the Stripe side carries on its metadata. */
  transferRequestId: string
  /**
   * users.id of the APPROVING brokerage admin — the request's initiator, or a target admin retrying it —
   * NEVER the adopted subject (wave 142, lane 142A). The Stripe side's tenancy gate
   * (lib/billing/subscriber-handoff.ts) admits an admin of the TARGET or platform staff and refuses the
   * source side, so a subject's id here stalls every Stripe-linked adoption at stripe_handoff_pending.
   */
  actorUserId: string | null
}

export type SubscriberBillingHandoffMode = "no_individual_billing" | "trial_closed" | "stripe_prorated"

export type SubscriberBillingHandoffCode =
  | "source_subscription_unreadable"
  | "target_subscription_unreadable"
  | "target_subscription_missing"
  | "stripe_handoff_pending"
  | "staff_invoiced_pending"
  | "cancel_refused"

export type SubscriberBillingHandoffResult =
  | {
      ok: true
      mode: SubscriberBillingHandoffMode
      sourceSubscriptionId: string | null
      targetSubscriptionId: string
      effectiveAt: string
      evidence: Record<string, unknown>
    }
  | { ok: false; code: SubscriberBillingHandoffCode; error: string; evidence: Record<string, unknown> }

/** @proofSeam — the Stripe side (lane 141H) registers here; the transfer proof injects a stub. */
export interface SubscriberBillingHandoffDeps {
  /** Lane 141H: cancel the source Stripe subscription at `effectiveAt` with proration, attach the
   *  brokerage's seat / tech-fee items through canonical Stripe rails, return the evidence. */
  stripeSide?: (
    svc: any,
    input: SubscriberBillingHandoffInput & { sourceSubscriptionId: string; stripeSubscriptionId: string; targetSubscriptionId: string },
  ) => Promise<{ ok: true; evidence: Record<string, unknown> } | { ok: false; error: string; evidence?: Record<string, unknown> }>
  now?: () => Date
}

interface SubRow { id: string; status: string | null; stripe_subscription_id: string | null; stripe_customer_id: string | null; trial_end: string | null; current_period_end: string | null }

async function latestSubscription(svc: any, brokerageId: string): Promise<{ row: SubRow | null; error: string | null }> {
  const { data, error } = await svc
    .from("subscriptions")
    .select("id, status, stripe_subscription_id, stripe_customer_id, trial_end, current_period_end")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { row: null, error: error.message }
  return { row: (data ?? null) as SubRow | null, error: null }
}

/** THE STRIPE SIDE (lane 141H, integrated 2026-10-14): lib/billing/subscriber-handoff.ts stops the source
 *  subscription at the effective time with Stripe proration (scheduled cancel + create_prorations, or
 *  cancel-now + prorated final invoice), idempotent on the handoff cycle, evidenced; this orchestrator
 *  decides WHICH half applies (never billed / trial / Stripe) and the transfer rail calls only this door. */
const defaultStripeSide: NonNullable<SubscriberBillingHandoffDeps["stripeSide"]> = async (svc, input) => {
  // The Stripe side needs the approving HUMAN (its ledger actor + Stripe cancellation_details) — a transfer
  // with no actor never reaches Stripe (fail closed; the rail stalls and a human resumes it).
  if (!input.actorUserId) return { ok: false, error: "The Stripe handoff needs the approving human's user id — the transfer carries none; nothing was stopped or prorated." }
  const { handoffSubscriberBillingToBrokerage: stripeHandoff } = await import("@/lib/billing/subscriber-handoff")
  const r = await stripeHandoff(svc, { sourceBrokerageId: input.sourceBrokerageId, targetBrokerageId: input.targetBrokerageId, effectiveAt: input.effectiveAt, actorUserId: input.actorUserId, reason: `brokerage transfer ${input.transferRequestId}` })
  if (!r.ok) return { ok: false, error: r.error, evidence: { stripe_refusal: r.refused } }
  return { ok: true, evidence: { stripe_mode: r.source.mode, proration: r.source.proration, final_invoice_id: r.source.finalInvoiceId, replay: r.replay, target_seat: r.target.seat, target_tech_fee: r.target.techFee, ledger_action: r.evidence.ledgerAction, handoff_cycle: r.evidence.cycle } }
}

export async function handoffSubscriberBillingToBrokerage(
  svc: any,
  input: SubscriberBillingHandoffInput,
  deps: SubscriberBillingHandoffDeps = {},
): Promise<SubscriberBillingHandoffResult> {
  const base = { source_brokerage_id: input.sourceBrokerageId, target_brokerage_id: input.targetBrokerageId, transfer_request_id: input.transferRequestId, effective_at: input.effectiveAt, approved_by_user_id: input.actorUserId }
  const target = await latestSubscription(svc, input.targetBrokerageId)
  if (target.error) return { ok: false, code: "target_subscription_unreadable", error: `Target subscription read refused: ${target.error}`, evidence: base }
  if (!target.row) return { ok: false, code: "target_subscription_missing", error: "The adopting brokerage has no subscription row — it must own the seat relationship before it takes a seat.", evidence: base }
  const source = await latestSubscription(svc, input.sourceBrokerageId)
  if (source.error) return { ok: false, code: "source_subscription_unreadable", error: `Source subscription read refused: ${source.error}`, evidence: base }
  const evidence = { ...base, target_subscription_id: target.row.id, source_subscription_id: source.row?.id ?? null, source_status_before: source.row?.status ?? null, source_stripe_subscription_id: source.row?.stripe_subscription_id ?? null }

  // Nothing to stop: never billed, or already stopped (a re-run).
  if (!source.row || source.row.status === "cancelled") {
    return { ok: true, mode: "no_individual_billing", sourceSubscriptionId: source.row?.id ?? null, targetSubscriptionId: target.row.id, effectiveAt: input.effectiveAt, evidence }
  }

  // Stripe-linked: the proration / seat / invoice half is the Stripe side's (lane 141H).
  if (source.row.stripe_subscription_id) {
    const stripeSide = deps.stripeSide ?? defaultStripeSide
    const r = await stripeSide(svc, { ...input, sourceSubscriptionId: source.row.id, stripeSubscriptionId: source.row.stripe_subscription_id, targetSubscriptionId: target.row.id })
    if (!r.ok) return { ok: false, code: "stripe_handoff_pending", error: r.error, evidence: { ...evidence, ...(r.evidence ?? {}) } }
    return { ok: true, mode: "stripe_prorated", sourceSubscriptionId: source.row.id, targetSubscriptionId: target.row.id, effectiveAt: input.effectiveAt, evidence: { ...evidence, ...r.evidence } }
  }

  // No Stripe object. A trial never moved money — close it at the effective time, counted.
  if (source.row.status === "trialing") {
    const at = (deps.now ?? (() => new Date()))().toISOString()
    const { data: rows, error } = await svc
      .from("subscriptions")
      .update({ status: "cancelled", cancel_at: input.effectiveAt, cancelled_at: at, updated_at: at })
      .eq("id", source.row.id)
      .eq("brokerage_id", input.sourceBrokerageId)
      .select("id")
    if (error) return { ok: false, code: "cancel_refused", error: `Trial close refused: ${error.message}`, evidence }
    if ((rows ?? []).length !== 1) return { ok: false, code: "cancel_refused", error: "Trial close matched no subscription row — nothing changed.", evidence }
    return { ok: true, mode: "trial_closed", sourceSubscriptionId: source.row.id, targetSubscriptionId: target.row.id, effectiveAt: input.effectiveAt, evidence: { ...evidence, cancelled_at: at } }
  }

  // Staff-invoiced active (no Stripe): a person stops the invoice — never guessed here.
  return { ok: false, code: "staff_invoiced_pending", error: `The source subscription is '${source.row.status}' with no Stripe object (staff-invoiced); the Finance Manager must stop its invoicing at ${input.effectiveAt} — nothing was changed.`, evidence }
}
