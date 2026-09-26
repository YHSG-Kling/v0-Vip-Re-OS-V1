"use server"

/**
 * Self-serve brokerage signup (top-of-funnel).
 *
 * Anonymous prospect → completed brokerage tenant with:
 *   - brokerages row (plan_tier set so fair-use is correct on day 1)
 *   - billing-admin users row (user_type='admin', brokerage_id linked)
 *   - 14-day trial — trial_ends_at populated, no Stripe charge yet
 *   - magic-link invite email so the admin can finish onboarding
 *
 * Caller-less: NO superadmin auth required, since this is the public entry
 * point. The action runs with the service client (RLS bypass) to perform
 * the writes — auth happens later when the admin clicks the invite link.
 *
 * TOMBSTONE (lane 77B): the tier lookup, duplicate-owner guard, brokerages
 * insert, provisionTenantOwner + rollback, trial subscription row, config
 * snapshot, prospect conversion stamp, ISA actor, starter assistant,
 * SUBSCRIPTION_CREATED emit and onboarding-library assignment that stood in
 * this file were ONE of TWO spellings of tenant creation (the other:
 * app/actions/admin/create-subscriber.ts). SURVIVOR:
 * lib/kernel/tenant-creation.ts::createTenantCore — the ONE core every door
 * (this self-serve funnel, the staff door, and the prospect → subscriber
 * conversion in lib/platform/prospect-conversion.ts) delegates to. What
 * stays here is what is genuinely this door's: the public throttle, strict
 * input validation, the affiliate/coupon/territory carries and the self-serve
 * audit line.
 *
 * DIRECT SUBSCRIBER WHO WAS NEVER A PROSPECT: the core's prospect link-back
 * (stampProspectConversion by the admin email — the same idempotency key
 * lib/platform/prospect-capture.ts::upsertPlatformProspect uses) is a clean
 * zero when no prospect row exists, and links the row when one does. Both
 * shapes land on the same core.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { createTenantCore } from "@/lib/kernel/tenant-creation"
import { validateFunnelCoupon } from "@/lib/platform/trial-funnel"
import { headers } from "next/headers"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"

export type CanonicalTier = "solo_agent" | "team" | "brokerage" | "multi_location"

export interface SignupBrokerageInput {
  brokerageName:   string
  adminFirstName:  string
  adminLastName:   string
  adminEmail:      string
  tier:            CanonicalTier
  brokerageState?: string
  brokerageCity?:  string
  /** Solo-agent only: is the agent's managing brokerage / team also on the platform? */
  brokerageOnPlatform?: boolean
  teamOnPlatform?:      boolean
  /**
   * @deprecated NOT USED to choose the snapshot any more, and deliberately so.
   *
   * This is a REQUEST field on a `"use server"` action, so it is caller-supplied
   * and cannot decide which platform_config_snapshots row a new tenant is
   * provisioned from. The snapshot is resolved SERVER-SIDE from `tier` via
   * snapshotForTier() inside lib/kernel/tenant-creation.ts.
   *
   * Still accepted on the input so the existing /get-started form (which posts
   * it) keeps type-checking, and read for ONE thing only: to decide whether the
   * caller expected branding, so "no snapshot is live for this tier" is reported
   * back rather than passing silently.
   */
  snapshotId?:     string
  /** Self-serve funnel: coupon code to redeem for the new tenant. Recorded in the
   *  redemption ledger + brokerages.billing_metadata.coupon so billing honors it
   *  when the Stripe subscription is created. Best-effort — never fails signup. */
  couponCode?:     string
  /** External affiliate ref code (MRR-commission rail — NOT the rev-share tree).
   *  Defaults to the /api/ref attribution cookie when omitted. Best-effort —
   *  attribution never fails a signup. */
  affiliateCode?:  string
  /** TERRITORY MARKETPLACE carry (round 40, rec 4): the zip the prospect searched
   *  on /pricing (/signup?zip=). Stored as a SUGGESTION under
   *  billing_metadata.signup_intent for the onboarding market-setup prefill —
   *  a market/claim is NEVER auto-created from it. Best-effort. */
  territoryZip?:   string
  /** Wave 78A — the signer's choice: the 14-day trial (default) or ACTIVATE
   *  NOW, which mints a hosted checkout for the plan + the tier's one-time
   *  setup fee and returns it as `checkoutUrl`; access opens when it clears.
   *  A self-serve signer can never waive the fee (no waiver field here). */
  activation?:     "trial" | "paid"
  billingCycle?:   "monthly" | "annual"
  /** Lane 79D — the ONE subscriber door's self-serve entrance. Producing seats
   *  they run (staff never count) picks the band when `tier` is not chosen;
   *  a custom-pricing ask or a multi-location shape routes to SALES-ASSISTED
   *  (a person prices it; no tenant until then); what they use today opens
   *  the white-glove import task on the tenant the core mints. */
  producerSeats?:  number | null
  customPricingRequested?: boolean
  currentTools?:   string | null
  /** Honeypot — a human never fills it; a filled value is refused without any write. */
  website?:        string | null
}

export interface SignupBrokerageResult {
  ok:           boolean
  error?:       string
  brokerageId?: string
  trialEndsAt?: string
  /** Which door was taken; `checkoutUrl` is set only for a paid activation whose checkout was minted. */
  activation?:  "trial" | "paid"
  checkoutUrl?: string | null
  checkoutError?: string
  setupFeeCents?: number
  /** Lane 79D — the activation checkout was ALSO emailed (the redirect's safety net). */
  checkoutEmailed?: boolean
  checkoutEmailError?: string
  /** Lane 79D — the route the door took. 'sales_assisted' = no tenant yet: the
   *  signer is captured as a platform prospect, staff are rung, and the booking
   *  path is the demo survivor. 'existing_subscriber' = this email already owns
   *  a tenant — sign in instead. */
  route?: "self_serve" | "sales_assisted" | "existing_subscriber"
  tier?: string
  humanReasons?: string[]
  prospectId?: string | null
  bookingPath?: string
  staffNotified?: number
  /** Snapshot outcome — honest per-part reporting (only set when snapshotId was given). */
  snapshotApplied?: string[]
  snapshotError?:   string
  /** Coupon outcome — honest per-part reporting (only set when couponCode was given). */
  couponApplied?: { code: string; summary: string }
  couponError?:   string
}

const TRIAL_DAYS = 14

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
}

export async function signupBrokerageAction(
  input: SignupBrokerageInput,
): Promise<SignupBrokerageResult> {
  // Public-surface throttle — this action provisions a full tenant with the
  // service client, so it gets the tightest window. Per-instance (honest
  // limitation documented in lib/security/public-rate-limit.ts).
  {
    const { checkPublicRateLimit, publicCallerIp } = await import("@/lib/security/public-rate-limit")
    const verdict = checkPublicRateLimit("signup", await publicCallerIp(), { limit: 5, windowMs: 10 * 60_000 })
    if (!verdict.allowed) {
      return { ok: false, error: `Too many signup attempts from this connection — try again in ${verdict.retryAfterSeconds}s.` }
    }
  }

  // Input validation — strict, since this endpoint is public
  if (!input.brokerageName?.trim() || input.brokerageName.trim().length < 2) {
    return { ok: false, error: "Brokerage name is required (2+ chars)." }
  }
  if (!input.adminFirstName?.trim() || !input.adminLastName?.trim()) {
    return { ok: false, error: "Admin first and last name required." }
  }
  if (!isValidEmail(input.adminEmail)) {
    return { ok: false, error: "Valid admin email required." }
  }
  if (!["solo_agent", "team", "brokerage", "multi_location"].includes(input.tier)) {
    return { ok: false, error: "Invalid tier — choose Solo Agent, Team, Brokerage, or Multi-Location." }
  }

  // THE DOOR'S ROUTING RULE (lane 79D, lib/platform/subscriber-door.ts): the
  // seat band and the humans-when-warranted rule are the SAME derivations the
  // prospect conversion uses — never restated here.
  const { planSubscriberEntrance, salesAssistedIntake, sendActivationCheckoutEmail } = await import("@/lib/platform/subscriber-door")
  const plan = planSubscriberEntrance({
    declaredTier: input.tier, producerSeats: input.producerSeats ?? null,
    activation: input.activation ?? "trial", billingCycle: input.billingCycle ?? null,
    customPricingRequested: input.customPricingRequested === true, currentTools: input.currentTools ?? null,
    honeypot: input.website ?? null,
  })
  // A filled honeypot is a bot: refuse before any write, and say nothing useful.
  if (plan.bot) return { ok: false, error: "Sign-up failed." }

  const service = createServiceClient()

  // SALES-ASSISTED: multi-location is custom-priced per seat and a custom-
  // pricing ask is a commercial decision — a person prices it BEFORE a tenant
  // exists. The signer lands on the ONE prospect rail (idempotent by email),
  // staff are rung, the handoff is open, and the growth board's Convert to
  // subscriber button is the other entrance, prefilled from this row.
  if (plan.route === "sales_assisted") {
    const intake = await salesAssistedIntake(service, {
      email: input.adminEmail, name: `${input.adminFirstName.trim()} ${input.adminLastName.trim()}`.trim(),
      company: input.brokerageName.trim(), tier: plan.tier, producerSeats: plan.producerSeats,
      currentTools: input.currentTools ?? null, territory: input.territoryZip?.trim() || null,
      activation: plan.billing.mode === "paid" ? "paid" : "trial", humanReasons: plan.humanReasons,
      source: "get_started:sales_assisted",
    })
    if (!intake.ok) return { ok: false, error: intake.error }
    if (intake.alreadySubscriber) return { ok: true, route: "existing_subscriber", tier: plan.tier, prospectId: null }
    return {
      ok: true, route: "sales_assisted", tier: plan.tier, humanReasons: plan.humanReasons,
      prospectId: intake.prospectId, bookingPath: intake.bookingPath, staffNotified: intake.staffNotified,
    }
  }

  // The signer's stated choice (wave 78A): trial by default; 'paid' mints the
  // activation checkout inside the core. No waiver can arrive on this public
  // door — TenantBilling's setupFeeWaiver is simply never set here.
  const activation: "trial" | "paid" = plan.billing.mode === "paid" ? "paid" : "trial"
  const billing = plan.billing.mode === "paid"
    ? { mode: "paid" as const, billingCycle: plan.billing.billingCycle }
    : { mode: "trial" as const, trialDays: TRIAL_DAYS }

  // THE ONE CORE — brokerage + owner (invite-first, id pinned, tier-aware) +
  // trial subscription (trial_end written) + tier snapshot + prospect
  // link-back + ISA actor + starter assistant + SUBSCRIPTION_CREATED +
  // onboarding library. Fails closed on the tier lookup, the duplicate-owner
  // guard and owner provisioning (with the counted rollback).
  const created = await createTenantCore(service, {
    brokerageName: input.brokerageName.trim(),
    adminEmail: input.adminEmail,
    adminFirstName: input.adminFirstName.trim(),
    adminLastName: input.adminLastName.trim(),
    tier: plan.tier,
    city: input.brokerageCity ?? null,
    state: input.brokerageState ?? null,
    signupSource: "self_serve",
    billing,
    brokerageOnPlatform: input.brokerageOnPlatform,
    teamOnPlatform: input.teamOnPlatform,
    callerUserId: null,
  })
  if (!created.ok || !created.brokerageId || !created.userId) {
    return { ok: false, error: created.error ?? "Signup failed" }
  }
  const brokerage = { id: created.brokerageId }
  const newUser = { id: created.userId }
  const trialEndsAt = new Date(created.trialEndsAt ?? Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000)

  // PAID: the browser is redirected to the checkout, and the SAME checkout is
  // emailed as the safety net (a blocked redirect, a closed tab) through the
  // ONE sender every entrance uses. Best-effort, reported by name.
  let checkoutEmailed: boolean | undefined
  let checkoutEmailError: string | undefined
  if (activation === "paid" && created.checkoutUrl) {
    try {
      const { loadProductBrand } = await import("@/lib/platform/product-brand")
      const brand = await loadProductBrand(service).catch(() => ({ name: "the platform" }))
      const sent = await sendActivationCheckoutEmail(service, {
        to: input.adminEmail, firstName: input.adminFirstName.trim(), brandName: brand.name,
        tier: plan.tier, billingCycle: billing.mode === "paid" ? billing.billingCycle : "monthly",
        checkoutUrl: created.checkoutUrl, setupFeeCents: created.setupFeeCents ?? null, setupFeeWaived: created.setupFeeWaived,
      })
      checkoutEmailed = sent.sent
      if (!sent.sent) checkoutEmailError = sent.error
    } catch (err) { checkoutEmailed = false; checkoutEmailError = (err as Error)?.message ?? "checkout email failed" }
  }

  // A CRM MIGRATION is white-glove SERVICE on a tenant that now exists — the
  // same platform-staff task the staff conversion raises, raised here for the
  // direct signer (humans when warranted, never by default).
  let staffNotified = 0
  if (plan.humanReasons.length > 0) {
    try {
      const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
      staffNotified = await notifyPlatformStaff(service as never, {
        type: "platform_subscriber_white_glove",
        title: "New subscriber needs a person",
        body: `${input.brokerageName.trim()} (${input.adminEmail}) just signed up for ${plan.tier.replace(/_/g, " ")} (${activation}): ${plan.humanReasonLabels.join("; ")}. See the tenant in the god console.`,
        entityType: "brokerage", entityId: brokerage.id, priority: "high",
      })
    } catch (err) { console.warn("[signupBrokerage] white-glove bell failed (non-fatal):", (err as Error)?.message) }
  }

  // Snapshot outcome — only say "no snapshot is live" when the caller expected branding.
  let snapshotApplied: string[] | undefined = created.snapshotApplied
  let snapshotError:   string | undefined = created.snapshotError
  const snapshotName:  string | null = created.snapshotName ?? null
  if (!snapshotApplied && !snapshotError && input.snapshotId) {
    snapshotError = "No config snapshot is live for this tier — starting from platform defaults."
  }

  // AFFILIATE ATTRIBUTION (external MRR-commission rail — NOT the rev-share tree).
  // Explicit param wins; else the 90-day /api/ref cookie. One insert, first-wins
  // per tenant (UNIQUE(brokerage_id)); best-effort — never fails the signup.
  try {
    const { cookies } = await import("next/headers")
    const { attributeSignupToAffiliate, AFFILIATE_REF_COOKIE } = await import("@/lib/platform/affiliates")
    const refCode = input.affiliateCode?.trim() || (await cookies()).get(AFFILIATE_REF_COOKIE)?.value || null
    if (refCode) await attributeSignupToAffiliate(refCode, brokerage.id, service)
  } catch (err) { console.warn("[signupBrokerage] affiliate attribution failed (non-fatal):", (err as any)?.message) }

  // Step 4b — redeem the coupon. Same rules + same two-write idiom as the
  // superadmin redemption path: validate via the pure layer, (1) INSERT the
  // redemption row FIRST — UNIQUE(coupon_id, brokerage_id) is the concurrency
  // guard — then (2) set redeemed_count from a fresh COUNT of the ledger.
  // The coupon is then stored in brokerages.billing_metadata.coupon (jsonb)
  // so the billing rail can honor it when the Stripe subscription is created.
  let couponApplied: { code: string; summary: string } | undefined
  let couponError:   string | undefined
  if (input.couponCode?.trim()) {
    try {
      const check = await validateFunnelCoupon(input.couponCode, input.tier, service)
      if (!check.ok) {
        couponError = check.message
      } else {
        const { error: insErr } = await service.from("platform_coupon_redemptions").insert({
          coupon_id:    check.couponId,
          brokerage_id: brokerage.id,
          redeemed_by:  newUser.id,
        })
        if (insErr) {
          couponError = (insErr as any).code === "23505"
            ? `${check.code} was already redeemed for this account`
            : insErr.message
        } else {
          // redeemed_count = COUNT(ledger) — derived from the source of truth.
          const { count } = await service
            .from("platform_coupon_redemptions")
            .select("id", { count: "exact", head: true })
            .eq("coupon_id", check.couponId)
          const { error: cntErr } = await service
            .from("platform_coupons")
            .update({ redeemed_count: count ?? check.coupon.redeemed_count + 1 })
            .eq("id", check.couponId)
          if (cntErr) console.warn("[signupBrokerage] redeemed_count sync failed (ledger row exists):", cntErr.message)

          // billing_metadata is a jsonb bag (stripe_customer_id / billing_cycle /
          // subscription_status …) — merge, never replace, and add the coupon under
          // its own key so the checkout/billing rail can apply it later.
          const { data: bmRow } = await service
            .from("brokerages")
            .select("billing_metadata")
            .eq("id", brokerage.id)
            .maybeSingle()
          const existingBm = (bmRow as any)?.billing_metadata
          const bm = existingBm && typeof existingBm === "object" ? existingBm : {}
          await service
            .from("brokerages")
            .update({
              billing_metadata: {
                ...bm,
                coupon: {
                  id:               check.couponId,
                  code:             check.code,
                  stripe_coupon_id: check.coupon.stripe_coupon_id ?? null,
                  percent_off:      check.coupon.percent_off,
                  amount_off_cents: check.coupon.amount_off_cents,
                  duration:         check.coupon.duration,
                  duration_months:  check.coupon.duration_months,
                  summary:          check.summary,
                  redeemed_at:      new Date().toISOString(),
                  source:           "self_serve_funnel",
                },
              },
              updated_at: new Date().toISOString(),
            })
            .eq("id", brokerage.id)
          couponApplied = { code: check.code, summary: check.summary }
        }
      }
    } catch (err) {
      couponError = err instanceof Error ? err.message : "Coupon redemption failed"
      console.warn("[signupBrokerage] coupon redemption failed (non-fatal):", err)
    }
  }

  // TERRITORY MARKETPLACE carry (round 40, rec 4) — persist the /pricing-searched
  // zip as a SUGGESTION under billing_metadata.signup_intent (the same jsonb
  // carry-bag as the coupon: merge, never replace; read AFTER the coupon merge so
  // neither clobbers the other). Onboarding market setup reads it back as the
  // prefilled first market (lib/platform/territory-marketplace.ts →
  // loadCarriedTerritoryZip). No market, claim, or service area is created here.
  try {
    const { cleanCarriedZip } = await import("@/lib/platform/territory-marketplace")
    const carriedZip = cleanCarriedZip(input.territoryZip)
    if (carriedZip) {
      const { data: bmRow } = await service
        .from("brokerages")
        .select("billing_metadata")
        .eq("id", brokerage.id)
        .maybeSingle()
      const existingBm = (bmRow as any)?.billing_metadata
      const bm = existingBm && typeof existingBm === "object" ? existingBm : {}
      await service
        .from("brokerages")
        .update({
          billing_metadata: {
            ...bm,
            signup_intent: {
              ...(bm.signup_intent && typeof bm.signup_intent === "object" ? bm.signup_intent : {}),
              territory_zip: carriedZip,
              captured_at:   new Date().toISOString(),
              source:        "pricing_territory_marketplace",
            },
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", brokerage.id)
    }
  } catch (err) { console.warn("[signupBrokerage] territory-zip carry failed (non-fatal):", (err as any)?.message) }

  // Step 5 — audit log entry (non-fatal)
  await sentinelWrite(
    service,
    service.from("activities").insert({
      activity_type: "brokerage.self_serve_signup",
      brokerage_id:  brokerage.id,
      // IDENTITY CLASS (m365). activities.agent_id FKs AGENTS and newUser.id is
      // a users id, so this insert was rejected — under a swallow marked
      // "non-fatal", which is why the audit entry for a brokerage signing up
      // has never once been written. No agents row exists at signup, and the
      // column is nullable: NULL is the truthful value, not a users id.
      agent_id:      null,
      title:         `Self-serve signup: ${input.brokerageName}`,
      notes:         JSON.stringify({
        tier:           plan.tier,
        producer_seats: plan.producerSeats,
        human_reasons:  plan.humanReasons,
        staff_notified: staffNotified,
        checkout_emailed: checkoutEmailed ?? null,
        admin_email:    input.adminEmail,
        trial_ends_at:  trialEndsAt.toISOString(),
        user_agent:     (await headers()).get("user-agent") ?? null,
        // Self-serve funnel outcome — honest either way (null when not requested).
        snapshot_id:      input.snapshotId ?? null,
        snapshot_name:    snapshotName,
        snapshot_applied: snapshotApplied ?? null,
        snapshot_error:   snapshotError ?? null,
        subscription_error: created.subscriptionError ?? null,
        activation,
        checkout_created: activation === "paid" ? !!created.checkoutUrl : null,
        checkout_error:   created.checkoutError ?? null,
        setup_fee_cents:  created.setupFeeCents ?? null,
        prospect_linked:  created.prospectStamp?.linked ?? 0,
        extras_skipped:   created.extrasSkipped,
        territory_zip:    input.territoryZip?.trim() || null,
        coupon_code:      couponApplied?.code ?? (input.couponCode?.trim() || null),
        coupon_applied:   couponApplied ?? null,
        coupon_error:     couponError ?? null,
      }),
      created_at:    new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    }),
    {
      table: "activities",
      flow: "brokerage_self_serve_signup_audit_log",
      brokerageId: brokerage.id,
      reason:
        "the brokerage, its owner and its subscription are already committed above; a signup audit echo must not fail a tenant that already exists — but the loss is now logged instead of vanishing the way the m365 FK rejection did",
    },
  )

  // (The magic-link invite was sent by provisionTenantOwner inside the core.)

  return {
    ok:          true,
    brokerageId: brokerage.id,
    trialEndsAt: trialEndsAt.toISOString(),
    activation,
    route: "self_serve",
    tier: plan.tier,
    humanReasons: plan.humanReasons,
    staffNotified,
    checkoutUrl: activation === "paid" ? (created.checkoutUrl ?? null) : undefined,
    checkoutError: created.checkoutError,
    setupFeeCents: created.setupFeeCents,
    checkoutEmailed,
    checkoutEmailError,
    snapshotApplied,
    snapshotError,
    couponApplied,
    couponError,
  }
}
