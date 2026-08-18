// lib/billing/ai-overage.ts
// ─────────────────────────────────────────────────────────────────────────────
// AI OVERAGE — served and billed, not refused (m479; owner ruling verbatim:
// "ai is a platform covered and their tier plan determines usage to bill them
// extra if goes over a quota").
//
// ONE VOCABULARY: usage has a single canon — usage_counters, written by the
// ledger under the m474 period convention (lib/usage/period.ts). Overage is
// therefore DERIVED at read time as max(0, used − included_total), never
// accrued into a second counter — a second accrual table would be a second
// canon. included_total = plan_limits.limit_value + approved ai_quota_overrides
// (an override EXTENDS the included quota; overage starts after both).
//
// BILLING WRITETHROUGH: at period close, runAIOverageBilling() turns each
// tenant's derived overage into ONE Stripe invoice item on the brokerage's
// subscription customer. Idempotency is a DB fact, not a hope: the
// ai_overage_invoices UNIQUE(brokerage_id, period_start, metric) row is
// CLAIMED (status 'pending') before Stripe is called, and flipped to 'billed'
// only WITH the provider's invoice-item id — never billed without a provider
// result. A rerun sees the claim and cannot double-bill. If Stripe is not
// configured, the run refuses loudly and records NOTHING.
//
// NOT server-only: the pure derivation is simulator-driven; the impure
// functions lazily import the service client / Stripe (the
// stripe-subscription-ops precedent).

import { currentUsagePeriod } from "@/lib/usage/period"
import { isStripeConfigured } from "@/lib/billing/stripe-subscription-ops"

// One metric vocabulary — declared in the PURE plan-catalog module (client-safe)
export { AI_OVERAGE_METRIC } from "./plan-catalog"
import { AI_OVERAGE_METRIC } from "./plan-catalog"

// ── PURE: the overage math contract ──────────────────────────────────────────

export interface OverageInputs {
  /** Tokens used this period (usage_counters value). */
  usedTokens: number
  /** plan_limits.limit_value for the tier. -1 = unlimited. */
  includedLimit: number
  /** Approved ai_quota_overrides extra tokens (extends the INCLUDED quota). */
  overrideTokens: number
  /** plan_limits.overage_allowed for the tier. */
  overageAllowed: boolean
  /** plan_limits.overage_rate_cents_per_1k — integer cents per 1K tokens. */
  overageRateCentsPer1k: number
}

export interface OverageDerivation {
  /** limit + override. -1 = unlimited (no overage possible). */
  includedTokens: number
  usedTokens: number
  /** max(0, used − included). Derived even when terms are off — it is the
   *  measurable fact; only the AMOUNT is gated on the terms. */
  overageTokens: number
  overageRateCents: number
  /** ceil(overageTokens × rate / 1000); 0 unless overage_allowed and rate > 0. */
  overageAmountCents: number
}

/** PURE — the one derivation. Unlimited included (−1) can never produce
 *  overage; override extends included before the subtraction; the amount
 *  rounds UP to the next cent (a partial 1K block is still served tokens). */
export function deriveAIOverage(i: OverageInputs): OverageDerivation {
  const usedTokens = Math.max(0, Math.floor(i.usedTokens))
  const overrideTokens = Math.max(0, Math.floor(i.overrideTokens))
  const includedTokens = i.includedLimit < 0 ? -1 : Math.max(0, Math.floor(i.includedLimit)) + overrideTokens
  const overageTokens = includedTokens < 0 ? 0 : Math.max(0, usedTokens - includedTokens)
  const overageRateCents = Math.max(0, Math.floor(i.overageRateCentsPer1k))
  const overageAmountCents =
    i.overageAllowed && overageRateCents > 0 && overageTokens > 0
      ? Math.ceil((overageTokens * overageRateCents) / 1000)
      : 0
  return { includedTokens, usedTokens, overageTokens, overageRateCents, overageAmountCents }
}

// ── READER: derived overage for one brokerage + period ───────────────────────

export type AIOverageStatus =
  | ({
      ok: true
      brokerageId: string
      planTier: string
      overageAllowed: boolean
      periodStartIso: string
      periodEndIso: string
    } & OverageDerivation)
  | { ok: false; error: string }

/**
 * Derived overage state for a brokerage in the UTC month containing `at`
 * (default: now → the CURRENT period; the period-close cron passes an instant
 * inside the closed period). Every Supabase read destructures error; a refusal
 * is reported as a refusal, never as a zero.
 */
export async function getAIOverageStatus(brokerageId: string, at: Date = new Date()): Promise<AIOverageStatus> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  let svc: ReturnType<typeof createServiceClient>
  try {
    svc = createServiceClient()
  } catch (e: any) {
    return { ok: false, error: `service client unavailable: ${e?.message ?? String(e)}` }
  }
  const { periodStartIso, periodEndIso } = currentUsagePeriod(at)

  // 1. Tier.
  const { data: brokerage, error: brokerageError } = await svc
    .from("brokerages")
    .select("plan_tier")
    .eq("id", brokerageId)
    .maybeSingle()
  if (brokerageError) return { ok: false, error: `brokerage read refused: ${brokerageError.message}` }
  if (!brokerage) return { ok: false, error: "brokerage not found" }
  const planTier = (brokerage.plan_tier as string | null) ?? "solo_agent"

  // 2. Included limit + overage terms for the tier.
  const { data: limitRow, error: limitError } = await svc
    .from("plan_limits")
    .select("limit_value, overage_allowed, overage_rate_cents_per_1k")
    .eq("plan_tier", planTier)
    .eq("metric", AI_OVERAGE_METRIC)
    .maybeSingle()
  if (limitError) return { ok: false, error: `plan_limits read refused: ${limitError.message}` }
  // No limit row = uncapped tier (matches check-cap) — no overage possible.
  const includedLimit = limitRow ? Number(limitRow.limit_value) : -1
  const overageAllowed = !!limitRow?.overage_allowed
  const overageRateCentsPer1k = Number(limitRow?.overage_rate_cents_per_1k ?? 0)

  // 3. Approved overrides still effective INSIDE the period being read
  //    (an override extends the included quota; overage starts after both).
  const { data: overrides, error: overridesError } = await svc
    .from("ai_quota_overrides")
    .select("extra_tokens, effective_until")
    .eq("brokerage_id", brokerageId)
    .eq("status", "approved")
  if (overridesError) return { ok: false, error: `ai_quota_overrides read refused: ${overridesError.message}` }
  const periodStartMs = Date.parse(periodStartIso)
  const overrideTokens = (overrides ?? [])
    .filter(r => !r.effective_until || Date.parse(r.effective_until as string) > periodStartMs)
    .reduce((sum, r) => sum + Number(r.extra_tokens ?? 0), 0)

  // 4. Usage — the ONE canon. Reader keys on period_start alone (m474).
  const { data: counter, error: counterError } = await svc
    .from("usage_counters")
    .select("value")
    .eq("brokerage_id", brokerageId)
    .eq("metric", AI_OVERAGE_METRIC)
    .eq("period_start", periodStartIso)
    .maybeSingle()
  if (counterError) return { ok: false, error: `usage_counters read refused: ${counterError.message}` }
  const usedTokens = Number(counter?.value ?? 0) // no row = genuinely zero usage

  const derived = deriveAIOverage({
    usedTokens,
    includedLimit,
    overrideTokens,
    overageAllowed,
    overageRateCentsPer1k,
  })

  return { ok: true, brokerageId, planTier, overageAllowed, periodStartIso, periodEndIso, ...derived }
}

// ── PERIOD-CLOSE BILLING WRITETHROUGH ────────────────────────────────────────

export interface OverageBillingOutcome {
  brokerageId: string
  status: "billed" | "skipped" | "refused" | "needs_reconciliation"
  reason: string
  amountCents?: number
  overageTokens?: number
  stripeInvoiceItemId?: string
}

export type OverageBillingRun =
  | {
      ok: true
      periodStartIso: string
      periodEndIso: string
      outcomes: OverageBillingOutcome[]
      billed: number
      skipped: number
      refused: number
      needsReconciliation: number
    }
  | { ok: false; error: string }

/**
 * Bill every brokerage's AI overage for the CLOSED period (the UTC month
 * before `now`'s month) as a Stripe invoice item on its subscription customer.
 *
 * Idempotent by construction: the ai_overage_invoices unique row is claimed
 * BEFORE Stripe is called and marked 'billed' only with the provider's
 * invoice-item id. Reruns are safe; a pending claim from a crashed run is
 * surfaced as needs_reconciliation, never silently re-billed.
 *
 * REFUSES LOUDLY when Stripe is not configured — records nothing: a billed
 * marker without a provider result must be unrepresentable.
 */
export async function runAIOverageBilling(opts?: { now?: Date }): Promise<OverageBillingRun> {
  if (!isStripeConfigured()) {
    return { ok: false, error: "REFUSED: STRIPE_SECRET_KEY is not configured — AI overage billing recorded nothing (never mark billed without a provider result)" }
  }

  const now = opts?.now ?? new Date()
  // The CLOSED period: one instant before this month's canonical start, run
  // back through the one canon — no private period re-derivation.
  const cur = currentUsagePeriod(now)
  const prevInstant = new Date(Date.parse(cur.periodStartIso) - 1)
  const { periodStartIso, periodEndIso } = currentUsagePeriod(prevInstant)

  const { createServiceClient } = await import("@/lib/supabase/service")
  let svc: ReturnType<typeof createServiceClient>
  try {
    svc = createServiceClient()
  } catch (e: any) {
    return { ok: false, error: `service client unavailable: ${e?.message ?? String(e)}` }
  }

  // Candidates: only tenants that actually metered AI tokens in the period.
  const { data: counters, error: countersError } = await svc
    .from("usage_counters")
    .select("brokerage_id, value")
    .eq("metric", AI_OVERAGE_METRIC)
    .eq("period_start", periodStartIso)
  if (countersError) {
    return { ok: false, error: `usage_counters read refused: ${countersError.message}` }
  }

  const outcomes: OverageBillingOutcome[] = []
  const push = (o: OverageBillingOutcome) => { outcomes.push(o); return o }

  for (const row of counters ?? []) {
    const brokerageId = row.brokerage_id as string
    if (!brokerageId) continue

    const status = await getAIOverageStatus(brokerageId, prevInstant)
    if (!status.ok) { push({ brokerageId, status: "refused", reason: status.error }); continue }
    if (status.overageTokens <= 0) { push({ brokerageId, status: "skipped", reason: "no_overage" }); continue }
    if (!status.overageAllowed) {
      // Tokens over included with terms OFF should not exist (fair-use hard
      // blocks) — surface, never bill unagreed overage.
      push({ brokerageId, status: "skipped", reason: "overage_not_allowed_for_tier", overageTokens: status.overageTokens })
      continue
    }
    if (status.overageAmountCents <= 0) { push({ brokerageId, status: "skipped", reason: "zero_amount" }); continue }

    // Idempotency: has this (brokerage, period) already been claimed/billed?
    const { data: existing, error: existingError } = await svc
      .from("ai_overage_invoices")
      .select("id, status")
      .eq("brokerage_id", brokerageId)
      .eq("period_start", periodStartIso)
      .eq("metric", AI_OVERAGE_METRIC)
      .maybeSingle()
    if (existingError) { push({ brokerageId, status: "refused", reason: `marker read refused: ${existingError.message}` }); continue }
    if (existing?.status === "billed") { push({ brokerageId, status: "skipped", reason: "already_billed" }); continue }
    if (existing?.status === "pending") {
      // A prior run claimed the row but the provider outcome is unknown —
      // rebilling could double-charge. Human/reconciler decides.
      push({ brokerageId, status: "needs_reconciliation", reason: "pending_claim_without_provider_result" })
      continue
    }

    // The Stripe customer: the brokerage's subscription row.
    const { data: sub, error: subError } = await svc
      .from("subscriptions")
      .select("stripe_customer_id, stripe_subscription_id")
      .eq("brokerage_id", brokerageId)
      .not("stripe_customer_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (subError) { push({ brokerageId, status: "refused", reason: `subscription read refused: ${subError.message}` }); continue }
    const customerId = (sub?.stripe_customer_id as string | null) ?? null
    if (!customerId) { push({ brokerageId, status: "skipped", reason: "no_stripe_customer", overageTokens: status.overageTokens, amountCents: status.overageAmountCents }); continue }

    // CLAIM the idempotency row BEFORE calling Stripe. A 23505 means a
    // concurrent run holds the claim — stand down.
    const { data: claim, error: claimError } = await svc
      .from("ai_overage_invoices")
      .insert({
        brokerage_id: brokerageId,
        metric: AI_OVERAGE_METRIC,
        period_start: periodStartIso,
        period_end: periodEndIso,
        included_tokens: Math.max(0, status.includedTokens),
        used_tokens: status.usedTokens,
        overage_tokens: status.overageTokens,
        overage_rate_cents_per_1k: status.overageRateCents,
        amount_cents: status.overageAmountCents,
        stripe_customer_id: customerId,
        status: "pending",
      })
      .select("id")
      .single()
    if (claimError) {
      if (claimError.code === "23505") { push({ brokerageId, status: "skipped", reason: "claimed_by_concurrent_run" }); continue }
      push({ brokerageId, status: "refused", reason: `claim insert refused: ${claimError.message}` })
      continue
    }

    // PROVIDER: one invoice item on the subscription customer — it lands on
    // the next subscription invoice.
    let invoiceItemId: string | null = null
    try {
      const { stripe } = await import("@/lib/stripe")
      const item = await stripe.invoiceItems.create({
        customer: customerId,
        currency: "usd",
        amount: status.overageAmountCents,
        ...(sub?.stripe_subscription_id ? { subscription: sub.stripe_subscription_id as string } : {}),
        description: `AI usage overage — ${status.overageTokens.toLocaleString("en-US")} tokens over the included quota (${periodStartIso.slice(0, 10)} billing period)`,
      })
      invoiceItemId = item.id
    } catch (stripeErr: any) {
      // No provider result → release the claim so a rerun can retry cleanly.
      const { error: releaseError } = await svc
        .from("ai_overage_invoices")
        .delete()
        .eq("id", claim.id)
        .eq("status", "pending")
      if (releaseError) {
        push({ brokerageId, status: "needs_reconciliation", reason: `stripe refused (${stripeErr?.message ?? String(stripeErr)}) AND claim release refused: ${releaseError.message}` })
      } else {
        push({ brokerageId, status: "refused", reason: `stripe invoice item refused: ${stripeErr?.message ?? String(stripeErr)}` })
      }
      continue
    }

    // OUTCOME: billed only WITH the provider result in hand.
    const { error: markError } = await svc
      .from("ai_overage_invoices")
      .update({ status: "billed", stripe_invoice_item_id: invoiceItemId, billed_at: new Date().toISOString() })
      .eq("id", claim.id)
    if (markError) {
      // The provider item EXISTS but the marker didn't flip — loud, with the
      // provider id so a human can reconcile; never retried blindly.
      push({ brokerageId, status: "needs_reconciliation", reason: `billed at provider (${invoiceItemId}) but marker update refused: ${markError.message}`, stripeInvoiceItemId: invoiceItemId })
      continue
    }
    push({ brokerageId, status: "billed", reason: "invoice_item_created", amountCents: status.overageAmountCents, overageTokens: status.overageTokens, stripeInvoiceItemId: invoiceItemId })
  }

  return {
    ok: true,
    periodStartIso,
    periodEndIso,
    outcomes,
    billed: outcomes.filter(o => o.status === "billed").length,
    skipped: outcomes.filter(o => o.status === "skipped").length,
    refused: outcomes.filter(o => o.status === "refused").length,
    needsReconciliation: outcomes.filter(o => o.status === "needs_reconciliation").length,
  }
}
