// lib/billing/billing-access.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE "MAY THIS TENANT USE IT, AND CAN IT AFFORD IT" ANSWER (wave 99A, LAW 2).
//
// Pure classifier (resolveBillingAccess) + loader (loadBillingAccess) + the kernel
// resolver every gate delegates to (mayUseAndAfford), and the request-boundary
// form of it (resolveRequestAccess, called by proxy.ts).
//
// FAIL CLOSED (owner, wave 99). This file used to be conservative the other way:
// "a brokerage with NO subscription row is NOT blocked", an unknown status was let
// through, and a refused subscriptions read was read as "no row" — so the paywall
// could only fire on a row it had read successfully AND recognised. Every one of
// those is now a refusal WITH ITS REASON: a read error, no subscription row, an
// unknown status, a trial with no end, a past-due episode with no anchor, an
// unknown capability. "Nobody checked" never renders as "checked and fine" (§4).
// Legacy tenants are not locked out by accident because m692 gives every
// brokerage that predates the subscription writer an explicit row.
//
// Rules preserved: trial in window is allowed; past_due is allowed for
// PAST_DUE_GRACE_DAYS (the day the dunning ladder's step 3 says "access is
// restricted"); platform staff (users.platform_role, plus the legacy
// superadmin/support user_type the login gate always exempted) bypass the
// access half; public routes, webhooks and crons never reach this file.
export type BillingAccessState = "active" | "trialing" | "past_due" | "expired" | "none"

export interface BillingAccess {
  state: BillingAccessState
  /** True → the tenant should be routed to the paywall (billing page). */
  blocked: boolean
  /** Whole days left in the trial (>=0), or null when not trialing. */
  trialDaysLeft: number | null
  /** Whole days of past-due grace left (>0) while access is still allowed, else null. */
  graceDaysLeft?: number | null
  /** brokerages.plan_tier when the loader read it — the "plan" half of the answer. */
  planTier?: string | null
  reason: string
}

export interface BillingSubRow {
  status: string | null
  trial_end: string | null
  /** When the current past-due episode began (dunning.ts episodeAnchor). Only read for past_due. */
  past_due_since?: string | null
}

/** A refusal that is not a classification — the gate could not decide, so it refuses (§4). */
function refusedAccess(reason: string): BillingAccess {
  return { state: "none", blocked: true, trialDaysLeft: null, graceDaysLeft: null, reason }
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
// The grace length and the episode anchor are dunning's — the paywall reads them,
// it does not re-derive them (§6). Read from dunning's PURE leaf, not ./dunning:
// this module is imported by proxy.ts, and ./dunning's sweep lazy-imports
// @/lib/providers/messaging, which webpack compiles into the proxy bundle (827
// first-party modules vs 18 — see lib/billing/past-due-clock.ts header, wave 100D).
import { PAST_DUE_GRACE_DAYS, daysBetween, episodeAnchor } from "./past-due-clock"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"

/** PURE: classify a brokerage's access from its subscription row + now. */
export function resolveBillingAccess(sub: BillingSubRow | null, now: Date = new Date()): BillingAccess {
  // No row is NOT "legacy, let them in" any more (wave 99A, fail closed). m692
  // backfills an explicit row for every brokerage that predates the writer.
  if (!sub) return refusedAccess("no_subscription")

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
  // PAST-DUE GRACE (wave 99A). A past_due tenant keeps access for
  // PAST_DUE_GRACE_DAYS from the start of the episode — the window the dunning
  // ladder's own copy promises (step 3, "access is restricted", fires at it).
  // No anchor means the episode's age is unknown, and unknown refuses.
  if (canonical === "past_due") {
    const since = sub.past_due_since ? Date.parse(sub.past_due_since) : NaN
    if (!Number.isFinite(since)) {
      return { state: "past_due", blocked: true, trialDaysLeft: null, graceDaysLeft: null, reason: "past_due_episode_unanchored" }
    }
    const daysPastDue = daysBetween(new Date(since).toISOString(), now.toISOString())
    if (daysPastDue < PAST_DUE_GRACE_DAYS) {
      return { state: "past_due", blocked: false, trialDaysLeft: null, graceDaysLeft: PAST_DUE_GRACE_DAYS - daysPastDue, reason: "past_due_in_grace" }
    }
    return { state: "past_due", blocked: true, trialDaysLeft: null, graceDaysLeft: null, reason: "past_due_grace_elapsed" }
  }

  if (isDelinquentStatus(status) || canonical === "paused") {
    return { state: "expired", blocked: true, trialDaysLeft: null, graceDaysLeft: null, reason: `status_${status}` }
  }

  // A trial that has run out is a hard paywall — this is the core enforcement.
  // A trial with NO readable end is an indefinite trial nobody granted: refused
  // (it used to fall through to "still current", which is how a 14-day trial
  // once never expired — see loadBillingAccess below).
  if (canonical === "trialing") {
    const end = sub.trial_end ? Date.parse(sub.trial_end) : NaN
    if (!Number.isFinite(end)) return { state: "trialing", blocked: true, trialDaysLeft: null, graceDaysLeft: null, reason: "trial_end_unknown" }
    const msLeft = end - now.getTime()
    if (msLeft <= 0) return { state: "expired", blocked: true, trialDaysLeft: 0, graceDaysLeft: null, reason: "trial_expired" }
    return { state: "trialing", blocked: false, trialDaysLeft: Math.ceil(msLeft / 86_400_000), graceDaysLeft: null, reason: "trialing" }
  }

  // Same one vocabulary for the paying side: isCurrentStatus is active|trialing
  // (trialing is fully decided above).
  if (isCurrentStatus(status)) {
    return { state: "active", blocked: false, trialDaysLeft: null, graceDaysLeft: null, reason: `status_${status}` }
  }

  // Unknown status → REFUSED with the value in the reason (wave 99A). It used to
  // be let through; a status nobody recognises is a gate that cannot decide.
  return refusedAccess(`status_unknown_${status || "empty"}`)
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
 * value null, and a trialing row with no end is now REFUSED (trial_end_unknown).
 *
 * FAIL CLOSED (wave 99A): a refused subscriptions read used to be read as "no
 * row" and let through. It is now a refusal naming the error. The past-due
 * episode anchor is dunning's episodeAnchor over the open invoices — the same
 * date the ladder ages from — and a refused invoice read leaves it unanchored,
 * which refuses.
 */
export async function loadBillingAccess(svc: any, brokerageId: string, now: Date = new Date()): Promise<BillingAccess> {
  const [subRes, brkRes] = await Promise.all([
    svc
      .from("subscriptions")
      .select("status, trial_end, updated_at, created_at")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc.from("brokerages").select("trial_ends_at, plan_tier").eq("id", brokerageId).maybeSingle(),
  ])

  if (!subRes || subRes.error) return refusedAccess(`subscription_read_refused: ${subRes?.error?.message ?? "no response"}`)
  const sub = (subRes.data as (BillingSubRow & { updated_at?: string | null }) | null) ?? null
  if (!sub) return resolveBillingAccess(null, now)

  // supabase-js RESOLVES refusals (§3) — a refused brokerages read must not be
  // read as "this tenant has no trial deadline", so the error is checked before
  // the fallback is trusted.
  const tenantTrialEnd = brkRes?.error
    ? null
    : ((brkRes?.data as { trial_ends_at?: string | null } | null)?.trial_ends_at ?? null)
  const planTier = brkRes?.error ? null : ((brkRes?.data as { plan_tier?: string | null } | null)?.plan_tier ?? null)

  let pastDueSince: string | null = null
  if (normalizeStripeStatus(sub.status) === "past_due") {
    const { data: openInvoices, error: invErr } = await svc
      .from("billing_invoices").select("invoice_date, due_date")
      .eq("brokerage_id", brokerageId).eq("status", "open")
      .order("invoice_date", { ascending: true }).limit(10)
    pastDueSince = invErr ? null : episodeAnchor({ updated_at: sub.updated_at ?? null }, (openInvoices ?? []) as Array<{ invoice_date: string | null; due_date: string | null }>)
  }

  const access = resolveBillingAccess({ ...sub, trial_end: sub.trial_end ?? tenantTrialEnd, past_due_since: pastDueSince }, now)
  return { ...access, planTier }
}

// ─── THE KERNEL RESOLVER: mayUseAndAfford ─────────────────────────────────────
//
// ONE answer to "may this tenant use this capability, and can it afford it?"
// (LAW 2). It COMPOSES the survivors rather than re-spelling them:
//   · access    — loadBillingAccess above (subscription state, trial, grace)
//   · AI budget — lib/ai/fair-use.ts checkAIFairUse (tier cap + override + overage terms)
//   · spend     — lib/vendor-governance/budget-gate.ts checkVendorBudget (platform vendor ceiling)
// The two budget halves keep their documented contracts unchanged: a refused
// budget-ledger read is fail-open there (degraded:true is passed through as
// `budgetDegraded`), because a broken meter must never silence a consented send
// — that is an existing business rule, not this resolver's call to change.
// Everything this resolver itself decides fails CLOSED.

export type CapabilityBudget = "none" | "ai_tokens" | "vendor_spend"

/**
 * The paid-capability registry. A capability not named here is REFUSED.
 *   graceAllowed — served while past_due is inside PAST_DUE_GRACE_DAYS.
 *   accessExempt — served whatever the subscription state (the notice that tells a
 *                  lapsed tenant how to pay must reach a lapsed tenant).
 */
export const PAID_CAPABILITIES: Readonly<Record<string, { graceAllowed: boolean; budget: CapabilityBudget; accessExempt?: boolean }>> = Object.freeze({
  "app.access":     { graceAllowed: true,  budget: "none" },
  "ai.generate":    { graceAllowed: true,  budget: "ai_tokens" },
  "comms.send":     { graceAllowed: true,  budget: "vendor_spend" },
  // Lead scraping never served past_due (lib/lead-pipeline/subscription-gate.ts,
  // pre-99A): preserved — platform spend does not run on an unpaid account.
  "lead.scrape":    { graceAllowed: false, budget: "none" },
  "billing.notice": { graceAllowed: true,  budget: "none", accessExempt: true },
  // Wave 100 (lane 100C — 99A open item 3): a PLAN FEATURE (feature_flags tier / rollout / overrides /
  // usage limit) composed as a capability. The subscription half runs first; the feature half is THE
  // survivor lib/kernel/0.1-feature-access.ts::canAccessFeature, called with the caller's own client
  // (input.feature.client — the session client seam) so RLS-scoped reads and the webhook's verified
  // service client both keep working. Requires input.feature; refuses without it.
  "feature.use":    { graceAllowed: true,  budget: "none" },
})

/** dispatch systemSource values that are the platform's own billing notices to the tenant. */
export const BILLING_NOTICE_SOURCES: ReadonlySet<string> = new Set(["billing_lifecycle"])

export interface MayUseAndAffordInput {
  /** The VERIFIED tenant — from the session or the event, never a request body (§4). */
  brokerageId: string | null | undefined
  capability: string
  /** Estimated USD of vendor spend for this use (vendor_spend capabilities). */
  estCostUsd?: number
  /** Estimated model tokens for this use (ai_tokens capabilities). */
  estTokens?: number
  /** Who is asking — platform staff bypass the ACCESS half (never the budget half). */
  actor?: { platformRole?: string | null; userType?: string | null } | null
  now?: Date
  /** Service client (defaults to createServiceClient, loaded lazily). */
  client?: any
  /** "feature.use" only — WHICH plan feature, for WHOM (a VERIFIED user id, or the tenant id for a
   *  tenant-gated rail), read through `client`: the caller's session client, or the verified service
   *  client of a cookieless webhook (canAccessFeature's own client contract). */
  feature?: { userId: string; featureKey: string; userTier?: string; client?: any }
  /** Test seams — default to the real survivors. */
  deps?: {
    featureAccess?: (userId: string, featureKey: string, userTier: string | undefined, client: any) => Promise<{ allowed: boolean; reason?: string; [k: string]: unknown }>
    loadAccess?: (svc: any, brokerageId: string, now: Date) => Promise<BillingAccess>
    aiBudget?: (p: { brokerageId: string; addTokens?: number }) => Promise<{ allowed: boolean; tokensUsed: number; tokensLimit: number; message?: string; softWarning?: boolean }>
    vendorBudget?: (p: { brokerageId: string; addCost?: number }) => Promise<{ allowed: boolean; spent: number; budget: number; softWarning: boolean; degraded?: boolean }>
  }
}

export interface MayUseAndAffordDecision {
  allowed: boolean
  /** Machine reason — always set, on allow and on refuse. */
  reason: string
  /** The plan half: subscription state + tier (null when never read). */
  plan: { state: BillingAccessState; tier: string | null; trialDaysLeft: number | null; graceDaysLeft: number | null } | null
  /** Tokens (ai_tokens) or USD (vendor_spend) left this period; null = unmetered / unlimited / unknown. */
  remainingBudget: number | null
  /** Human message for the caller's surface, when one exists. */
  message?: string
  softWarning?: boolean
  /** The budget half could not read its ledger and failed open (its documented contract). */
  budgetDegraded?: boolean
  /** "feature.use" only — the plan-feature verdict as canAccessFeature returned it (limits, usage, beta …). */
  feature?: { allowed: boolean; reason?: string; [k: string]: unknown }
}

/** PURE: is this actor platform staff for the access bypass? */
function isAccessBypassActor(actor: MayUseAndAffordInput["actor"]): boolean {
  if (!actor) return false
  // ONE platform-staff definition (lib/auth/resolve-user-role.ts isPlatformStaffIdentity — the same
  // rule public.is_platform_staff() applies: platform_role, plus the legacy user_type 'superadmin').
  // A tenant-side user_type 'support' is not platform staff (CLAUDE.md §4: staff live in platform_role).
  return isPlatformStaffIdentity(actor.userType ?? null, actor.platformRole ?? null)
}

export async function mayUseAndAfford(input: MayUseAndAffordInput): Promise<MayUseAndAffordDecision> {
  const now = input.now ?? new Date()
  const cap = Object.prototype.hasOwnProperty.call(PAID_CAPABILITIES, input.capability) ? PAID_CAPABILITIES[input.capability] : undefined
  if (!cap) return { allowed: false, reason: `unknown_capability:${input.capability}`, plan: null, remainingBudget: null }

  const staff = isAccessBypassActor(input.actor)
  if (!input.brokerageId) {
    return staff
      ? { allowed: true, reason: "platform_staff", plan: null, remainingBudget: null }
      : { allowed: false, reason: "no_tenant", plan: null, remainingBudget: null }
  }
  const brokerageId = input.brokerageId

  let plan: MayUseAndAffordDecision["plan"] = null
  if (!staff && !cap.accessExempt) {
    let access: BillingAccess
    try {
      const load = input.deps?.loadAccess ?? loadBillingAccess
      const svc = input.client ?? (input.deps?.loadAccess ? null : (await import("@/lib/supabase/service")).createServiceClient())
      access = await load(svc, brokerageId, now)
    } catch (e) {
      access = refusedAccess(`access_check_threw: ${(e as Error)?.message ?? String(e)}`)
    }
    plan = { state: access.state, tier: access.planTier ?? null, trialDaysLeft: access.trialDaysLeft, graceDaysLeft: access.graceDaysLeft ?? null }
    if (access.blocked) return { allowed: false, reason: access.reason, plan, remainingBudget: null }
    if (access.reason === "past_due_in_grace" && !cap.graceAllowed) {
      return { allowed: false, reason: `past_due_not_served:${input.capability}`, plan, remainingBudget: null }
    }
  }
  const allowReason = staff ? "platform_staff" : cap.accessExempt ? "access_exempt" : plan?.state === "past_due" ? "past_due_in_grace" : "subscription_current"

  // THE PLAN-FEATURE HALF (wave 100, lane 100C). Fails CLOSED: no feature named, or a gate that threw
  // (canAccessFeature throws on a refused flag / user read), is a refusal — never "nobody checked".
  if (input.capability === "feature.use") {
    const f = input.feature
    if (!f?.userId || !f.featureKey) return { allowed: false, reason: "feature_unspecified", plan, remainingBudget: null }
    let verdict: { allowed: boolean; reason?: string; [k: string]: unknown }
    try {
      const gate = input.deps?.featureAccess
        ?? (async (u: string, k: string, t: string | undefined, c: any) =>
          (await import("@/lib/kernel/0.1-feature-access")).canAccessFeature(u, k, t as any, c) as unknown as { allowed: boolean; reason?: string })
      verdict = await gate(f.userId, f.featureKey, f.userTier, f.client)
    } catch (e) {
      return { allowed: false, reason: `feature_check_threw: ${(e as Error)?.message ?? String(e)}`, plan, remainingBudget: null }
    }
    if (!verdict.allowed) {
      return { allowed: false, reason: `feature_refused:${f.featureKey}`, plan, remainingBudget: null, message: verdict.reason, feature: verdict }
    }
    return { allowed: true, reason: allowReason, plan, remainingBudget: null, feature: verdict }
  }

  if (cap.budget === "ai_tokens") {
    const fair = input.deps?.aiBudget
      ? await input.deps.aiBudget({ brokerageId, addTokens: input.estTokens ?? 0 })
      : await (await import("@/lib/ai/fair-use")).checkAIFairUse({ brokerageId, addTokens: input.estTokens ?? 0 })
    const remaining = fair.tokensLimit < 0 ? null : Math.max(0, fair.tokensLimit - fair.tokensUsed)
    if (!fair.allowed) return { allowed: false, reason: "ai_budget_exhausted", plan, remainingBudget: remaining, message: fair.message }
    return { allowed: true, reason: allowReason, plan, remainingBudget: remaining, message: fair.message, softWarning: !!fair.softWarning }
  }
  if (cap.budget === "vendor_spend") {
    const vb = input.deps?.vendorBudget
      ? await input.deps.vendorBudget({ brokerageId, addCost: input.estCostUsd ?? 0 })
      : await (await import("@/lib/vendor-governance/budget-gate")).checkVendorBudget({ brokerageId, addCost: input.estCostUsd ?? 0 })
    const remaining = Math.max(0, vb.budget - vb.spent)
    if (!vb.allowed) return { allowed: false, reason: "vendor_budget_exhausted", plan, remainingBudget: remaining }
    return { allowed: true, reason: allowReason, plan, remainingBudget: remaining, softWarning: vb.softWarning, budgetDegraded: !!vb.degraded }
  }
  return { allowed: true, reason: allowReason, plan, remainingBudget: null }
}

// ─── THE CALL-SITE FORM OF "feature.use" (wave 101C) ──────────────────────────
//
// Seventy plan-feature gates (content creators, ads, repurposer, tier assigner,
// newsletters, video, training, …) called canAccessFeature DIRECTLY and so asked
// only the plan-feature half: a tenant whose subscription had lapsed still passed
// every one of them. mayUseFeature is not a second gate — it is mayUseAndAfford
// capability "feature.use", with the two inputs every one of those sites lacked
// spelled once:
//   · the TENANT and the ACTOR — read off the VERIFIED user's own users row (the
//     caller vouches for userId: a session user, or a verified webhook actor). A
//     tenant-gated rail that passes a brokerages.id here (the competitor monitor)
//     has no users row; the id IS the tenant — canAccessFeature's own
//     TENANT-ID FALLBACK, mirrored, not re-decided. An explicit opts.brokerageId
//     (the caller's session context) wins.
//   · the result SHAPE — canAccessFeature's own FeatureAccessCheck (allowed,
//     reason, usage, trial …) so every gate keeps its message and its limits;
//     the full decision rides along as `.decision`.
// The feature half reads through opts.client — THE SESSION SEAM: the caller's own
// session client (RLS-scoped), or a verified service client for a cookieless
// webhook. Omitted, canAccessFeature builds the request's cookie client itself,
// which is the session client. The subscription half reads through the service
// client, as resolveRequestAccess does. FAILS CLOSED: a refused users read, no
// tenant, a lapsed subscription or a gate that threw all refuse.
// No new import edge: everything here is already in this module's graph (proxy.ts).
export interface FeatureUseResult {
  allowed: boolean
  reason?: string
  usage?: { current: number; limit: number; remaining: number }
  trial?: boolean
  trial_expires_at?: string
  disabled?: boolean
  disabled_reason?: string
  decision: MayUseAndAffordDecision
}

/** Human copy for a refusal decided by the SUBSCRIPTION half (the feature half carries its own). */
function featureUseRefusalMessage(d: MayUseAndAffordDecision): string {
  if (d.message) return d.message
  if (d.reason === "no_tenant") return "This feature needs a brokerage account."
  if (d.reason.startsWith("feature_check_threw") || d.reason.startsWith("user_read_refused")) return "We could not verify access to this feature right now. Please try again."
  return "Your subscription is not active. Renew it in Billing to use this feature."
}

export async function mayUseFeature(
  userId: string,
  featureKey: string,
  opts: {
    brokerageId?: string | null
    userTier?: string
    /** THE SESSION SEAM — the client the plan-feature half reads through. */
    client?: any
    now?: Date
    /** Test seams. `service` stands in for the service client of the tenant/actor read and the subscription half. */
    deps?: MayUseAndAffordInput["deps"] & { service?: any }
  } = {},
): Promise<FeatureUseResult> {
  const fail = (reason: string): FeatureUseResult => {
    const decision: MayUseAndAffordDecision = { allowed: false, reason, plan: null, remainingBudget: null }
    return { allowed: false, reason: featureUseRefusalMessage(decision), decision }
  }
  if (!userId || !featureKey) return fail("feature_unspecified")
  let svc: any
  try {
    svc = opts.deps?.service ?? (await import("@/lib/supabase/service")).createServiceClient()
  } catch (e) {
    return fail(`user_read_refused: ${(e as Error)?.message ?? String(e)}`)
  }
  const { data: u, error } = await svc.from("users").select("brokerage_id, user_type, platform_role").eq("id", userId).maybeSingle()
  if (error) return fail(`user_read_refused: ${error.message}`)
  const row = (u ?? null) as { brokerage_id: string | null; user_type: string | null; platform_role: string | null } | null
  const actor = row ? { platformRole: row.platform_role ?? null, userType: row.user_type ?? null } : null
  const brokerageId = opts.brokerageId ?? (row ? row.brokerage_id : userId)
  const decision = await mayUseAndAfford({
    brokerageId, capability: "feature.use", actor, now: opts.now, client: svc,
    feature: { userId, featureKey, userTier: opts.userTier, client: opts.client },
    deps: opts.deps,
  })
  const verdict = (decision.feature ?? {}) as Omit<FeatureUseResult, "decision">
  return {
    ...verdict,
    allowed: decision.allowed,
    reason: decision.allowed ? verdict.reason : decision.feature ? (verdict.reason ?? featureUseRefusalMessage(decision)) : featureUseRefusalMessage(decision),
    decision,
  }
}

// ─── THE REQUEST BOUNDARY (proxy.ts) ──────────────────────────────────────────

/** Dashboard paths that stay reachable when access is refused — where a refused tenant is sent. */
const PAYWALL_EXEMPT_PREFIXES: readonly string[] = Object.freeze([
  "/dashboard/admin/billing",
  "/dashboard/onboarding",
  "/dashboard/superadmin",
])

/** PURE: does the request-boundary paywall judge this path? */
export function isPaywalledPath(pathname: string): boolean {
  if (pathname !== "/dashboard" && !pathname.startsWith("/dashboard/")) return false
  return !PAYWALL_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * The paywall at the request boundary: the SESSION's user → their tenant → the
 * resolver. Called by proxy.ts for every paywalled path. A refused users read
 * refuses. A user with NO tenant has no subscription to judge and is passed to
 * the existing onboarding gates (lib/kernel/onboarding.ts routes them).
 */
export async function resolveRequestAccess(svc: any, userId: string, now: Date = new Date()): Promise<MayUseAndAffordDecision & { redirectTo: string | null }> {
  const { data: u, error } = await svc.from("users").select("brokerage_id, user_type, platform_role").eq("id", userId).maybeSingle()
  if (error) return { allowed: false, reason: `user_read_refused: ${error.message}`, plan: null, remainingBudget: null, redirectTo: "/dashboard/admin/billing" }
  const row = (u ?? null) as { brokerage_id: string | null; user_type: string | null; platform_role: string | null } | null
  const actor = { platformRole: row?.platform_role ?? null, userType: row?.user_type ?? null }
  if (!row?.brokerage_id && !isAccessBypassActor(actor)) {
    return { allowed: true, reason: "no_tenant_scope", plan: null, remainingBudget: null, redirectTo: null }
  }
  const d = await mayUseAndAfford({ brokerageId: row?.brokerage_id ?? null, capability: "app.access", actor, now, client: svc })
  return { ...d, redirectTo: d.allowed ? null : "/dashboard/admin/billing" }
}
