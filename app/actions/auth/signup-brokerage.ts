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
 * Companion to app/actions/admin/create-subscriber.ts (superadmin-driven
 * provisioning). Both converge on the same shape of brokerage row so the
 * rest of the platform (fair-use, onboarding, billing webhooks) treats
 * them identically.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { provisionTenantOwner } from "@/lib/kernel/users"
import { rollbackTenantCreation } from "@/lib/kernel/tenant-creation-rollback"
import { applySnapshotPayload, type SnapshotPayload } from "@/lib/platform/config-snapshots"
import { validateFunnelCoupon, snapshotForTier } from "@/lib/platform/trial-funnel"
import { headers } from "next/headers"

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
   * provisioned from. The snapshot is now resolved SERVER-SIDE from `tier` via
   * snapshotForTier() — see the block at "Step 4a" below.
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
}

export interface SignupBrokerageResult {
  ok:           boolean
  error?:       string
  brokerageId?: string
  trialEndsAt?: string
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

  const service = createServiceClient()

  // Resolve tier_id from canonical tier_name so the subscription row links
  // to a real subscription_tiers record (used by billing + v_platform_margin).
  const { data: tierRow, error: tierErr } = await service
    .from("subscription_tiers")
    .select("id, monthly_price_cents")
    .eq("tier_name", input.tier)
    .eq("is_active", true)
    .maybeSingle()
  if (tierErr || !tierRow) {
    return { ok: false, error: `Plan tier not found: ${input.tier}` }
  }

  // Duplicate-email guard: refuse to provision twice for the same admin.
  // We're checking the users table because Supabase auth users + our domain
  // users diverge until callback; the latter is the authoritative tenant link.
  const { data: existingUser } = await service
    .from("users")
    .select("id, brokerage_id")
    .eq("email", input.adminEmail)
    .maybeSingle()
  if (existingUser?.brokerage_id) {
    return { ok: false, error: "An account with this email already exists. Sign in instead." }
  }

  // Step 1 — create brokerage with plan_tier + trial window + attribution
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
  const { data: brokerage, error: bErr } = await service
    .from("brokerages")
    .insert({
      name:               input.brokerageName.trim(),
      // The tenant's public slug — day one it powers /site/[slug] (their
      // full website, zero hosting) and /recruiting/[slug]. Kebab of the
      // name + a short suffix so collisions can't 500 a signup.
      slug: `${input.brokerageName.trim().toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "brokerage"}-${Math.random().toString(36).slice(2, 6)}`,
      email:              input.adminEmail.trim().toLowerCase(),
      city:               input.brokerageCity ?? null,
      state:              input.brokerageState ?? null,
      plan_tier:          input.tier,
      // Platform membership — for a SOLO agent the broker-side steps (CDA signature, compliance) route
      // to their external form platform unless their brokerage/team is also on the platform. For any
      // org tier the org IS the customer (its own broker/admin users handle those) → always true.
      brokerage_on_platform: input.tier === "solo_agent" ? (input.brokerageOnPlatform ?? false) : true,
      team_on_platform:      input.tier === "solo_agent" ? (input.teamOnPlatform ?? false) : true,
      trial_ends_at:      trialEndsAt.toISOString(),
      signup_source:      "self_serve",
      onboarding_status:  "pending",
      created_at:         new Date().toISOString(),
      updated_at:         new Date().toISOString(),
    })
    .select("id")
    .single()
  if (bErr || !brokerage) {
    return { ok: false, error: `Brokerage creation failed: ${bErr?.message ?? "unknown"}` }
  }

  // Step 2 — provision the tenant OWNER through the canonical identity path.
  // This creates the auth user FIRST (so public.users.id === auth.users.id — the
  // invariant every read path + RLS policy depends on), pins/enriches the users
  // row, creates the teams row for a team tenant, and — tier-aware — gives a
  // solo/team owner their agents row (+ commission + onboarding + role assignment)
  // so they can own a book of business on day one. The magic-link invite is sent
  // as part of this step. Replaces the old pre-insert (which collided with the
  // on_auth_user_created trigger's email-unique insert and orphaned the profile).
  const owner = await provisionTenantOwner({
    email:        input.adminEmail,
    firstName:    input.adminFirstName.trim(),
    lastName:     input.adminLastName.trim(),
    brokerageId:  brokerage.id,
    brokerageName: input.brokerageName.trim(),
    tier:         input.tier,
    redirectTo:   `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/dashboard/onboarding`,
    callerUserId: null,
  })
  if (!owner.success || !owner.userId) {
    // ROLL BACK THE HALF-BUILT TENANT — children first, and READ the answer.
    // The bare `.delete()` this replaces did neither: `users.brokerage_id` is
    // ON DELETE SET NULL, so a failed signup left a live user belonging to no
    // tenant (the auth trigger seeds that row from the invite metadata, and
    // provisionTenantOwner can fail after the invite has gone out), and
    // supabase-js RESOLVES a refused delete (CLAUDE.md §3), so a blocked
    // rollback was reported to the visitor as an ordinary provisioning failure.
    // See lib/kernel/tenant-creation-rollback.ts.
    const rollback = await rollbackTenantCreation(service, brokerage.id)
    if (!rollback.ok) {
      console.error("[signupBrokerage] tenant rollback incomplete:", rollback.error)
      return {
        ok: false,
        error: `Owner provisioning failed: ${owner.error ?? "unknown"}. ${rollback.error}`,
      }
    }
    return { ok: false, error: `Owner provisioning failed: ${owner.error ?? "unknown"}` }
  }
  const newUser = { id: owner.userId }

  // Step 4 — create trial subscription. No Stripe customer at signup —
  // the billing webhook + /dashboard/admin/billing path will collect card
  // before trial_ends_at expires.
  await service.from("subscriptions").insert({
    brokerage_id:        brokerage.id,
    tier_id:             tierRow.id,
    status:              "trialing",
    current_period_start: new Date().toISOString(),
    current_period_end:   trialEndsAt.toISOString(),
    created_at:          new Date().toISOString(),
    updated_at:          new Date().toISOString(),
  })

  // AI-ISA SYSTEM ACTOR — provision the tenant's ISA identity at birth.
  // Idempotent (returns the cached ai_isa_system_user_id when present). Without
  // this call nothing in the tree ever provisioned the actor, so
  // getIsaSystemUserId returned null for every brokerage forever and each
  // ISA audit write fell back to the admin's user_id. Best-effort — an actor
  // provisioning problem must never cost the signup.
  try {
    const { provisionIsaActorForBrokerage } = await import("@/lib/auth/provision-isa-actor")
    await provisionIsaActorForBrokerage({
      brokerageId: brokerage.id,
      brokerageName: input.brokerageName.trim(),
      brokerageSlug: (brokerage as { slug?: string | null }).slug ?? null,
    })
  } catch (err) { console.warn("[signupBrokerage] ISA actor provisioning failed (non-fatal):", (err as any)?.message) }

  // AFFILIATE ATTRIBUTION (external MRR-commission rail — NOT the rev-share tree).
  // Explicit param wins; else the 90-day /api/ref cookie. One insert, first-wins
  // per tenant (UNIQUE(brokerage_id)); best-effort — never fails the signup.
  try {
    const { cookies } = await import("next/headers")
    const { attributeSignupToAffiliate, AFFILIATE_REF_COOKIE } = await import("@/lib/platform/affiliates")
    const refCode = input.affiliateCode?.trim() || (await cookies()).get(AFFILIATE_REF_COOKIE)?.value || null
    if (refCode) await attributeSignupToAffiliate(refCode, brokerage.id, service)
  } catch (err) { console.warn("[signupBrokerage] affiliate attribution failed (non-fatal):", (err as any)?.message) }

  // ── SELF-SERVE FUNNEL EXTRAS — snapshot + coupon, applied AFTER provisioning.
  // Both are best-effort: a template or discount problem must NEVER cost us the
  // signup itself. The result reports each outcome honestly instead.

  // Step 4a — apply the tier funnel's config snapshot through THE one apply path
  // (allow-listed layers only — never name/slug/email/status/tier/billing), so
  // the day-one /site/[slug] website comes up branded.
  let snapshotApplied: string[] | undefined
  let snapshotError:   string | undefined
  let snapshotName:    string | null = null
  try {
    // WHICH SNAPSHOT A SELF-SERVE SIGNUP GETS IS A SERVER DECISION.
    //
    // This block used to read `input.snapshotId` and apply whatever row that id
    // named. `input` arrives from the browser — app/get-started/trial-funnel-form.tsx:96
    // posts `snapshotId: funnelSnapshots[tier]?.id` into this `"use server"`
    // action, so the id is a REQUEST FIELD, not a server fact, and nothing
    // checked that the snapshot it named had anything to do with the tier being
    // signed up for. A crafted request could hand a brand-new tenant any row in
    // platform_config_snapshots — a different tier's branding, or an internal
    // snapshot never meant for self-serve — and applySnapshotPayload would apply
    // it. Reading the id back from the database does not fix that: the row is
    // real, it is simply the wrong one.
    //
    // lib/platform/trial-funnel.ts:75 `snapshotForTier(tier)` is the resolver
    // written for this and never called, and that module's header names this
    // action as one of the two surfaces meant to share it: "the newest-per-tier
    // rule is a PURE exported function so ... server surfaces (get-started page,
    // signup action) share one resolver". It re-derives the answer from the TIER
    // this signup is actually for — newest snapshot whose
    // payload.recommendedTier === tier — and returns null for a non-canonical
    // tier, so an unrecognised value provisions from platform defaults instead
    // of from whatever the caller asked for.
    //
    // The tier itself is already validated upstream in this action, so it is the
    // safe thing to key on. `input.snapshotId` is now ignored entirely; the
    // /get-started page keeps computing it through liveFunnelSnapshots() for
    // DISPLAY (attaching "this is what you get" to each tier card), which is
    // what it was for.
    const snap = await snapshotForTier(input.tier, service)
    if (!snap) {
      // Not an error worth failing a signup over — the funnel still provisions,
      // the tenant just starts from unbranded defaults. Only say so when the
      // caller expected branding.
      if (input.snapshotId) {
        snapshotError = "No config snapshot is live for this tier — starting from platform defaults."
      }
    } else {
      snapshotName = snap.name
      const { applied } = await applySnapshotPayload(
        snap.payload as SnapshotPayload,
        brokerage.id,
        newUser.id,
        service,
      )
      snapshotApplied = applied
    }
  } catch (err) {
    snapshotError = err instanceof Error ? err.message : "Snapshot apply failed"
    console.warn("[signupBrokerage] snapshot apply failed (non-fatal):", err)
  }

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

  // DAY-ONE ASSISTANT — seed the starter AI identity (name + generated headshot
  // + narration voice) so Aria answers the phone and hosts the first weekly show
  // immediately; the settings page becomes personalization, not setup. Best-effort.
  try {
    const { seedStarterAssistant } = await import("@/lib/kernel/assistant-starter")
    await seedStarterAssistant(service, brokerage.id)
  } catch (err) { console.warn("[signupBrokerage] assistant seed failed:", (err as any)?.message) }

  // SUBSCRIPTION_CREATED — emit the lifecycle event (best-effort, never blocks signup) so downstream
  // reactors have a real-time hook; the weekly cron is the idempotent safety net that authors the tier
  // onboarding curriculum if this misses.
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    const { KernelEvent } = await import("@/lib/kernel/events")
    await emitKernelEvent({
      event: KernelEvent.SUBSCRIPTION_CREATED, brokerageId: brokerage.id,
      entityType: "brokerage", entityId: brokerage.id, metadata: { tier: input.tier },
    })
  } catch (err) { console.warn("[signupBrokerage] SUBSCRIPTION_CREATED emit failed:", (err as any)?.message) }

  // Step 5 — audit log entry (non-fatal)
  try {
    await service.from("activities").insert({
      activity_type: "brokerage.self_serve_signup",
      brokerage_id:  brokerage.id,
      // IDENTITY CLASS (m365). activities.agent_id FKs AGENTS and newUser.id is
      // a users id, so this insert was rejected — inside a try/catch marked
      // "non-fatal", which is why the audit entry for a brokerage signing up
      // has never once been written. No agents row exists at signup, and the
      // column is nullable: NULL is the truthful value, not a users id.
      agent_id:      null,
      title:         `Self-serve signup: ${input.brokerageName}`,
      notes:         JSON.stringify({
        tier:           input.tier,
        admin_email:    input.adminEmail,
        trial_ends_at:  trialEndsAt.toISOString(),
        user_agent:     (await headers()).get("user-agent") ?? null,
        // Self-serve funnel outcome — honest either way (null when not requested).
        snapshot_id:      input.snapshotId ?? null,
        snapshot_name:    snapshotName,
        snapshot_applied: snapshotApplied ?? null,
        snapshot_error:   snapshotError ?? null,
        territory_zip:    input.territoryZip?.trim() || null,
        coupon_code:      couponApplied?.code ?? (input.couponCode?.trim() || null),
        coupon_applied:   couponApplied ?? null,
        coupon_error:     couponError ?? null,
      }),
      created_at:    new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    })
  } catch { /* non-fatal */ }

  // (The magic-link invite was sent by provisionTenantOwner in Step 2.)

  // SUBSCRIBER ONBOARDING EDUCATION — day-one learning path. Assign the platform's
  // published onboarding modules (brokerage_id IS NULL = platform library; audience
  // 'agent'/'broker') to the new admin + welcome them to their AI team. Best-effort —
  // education must never block a signup.
  try {
    const { data: mods } = await service
      .from("learning_modules").select("id")
      .is("brokerage_id", null).eq("status", "published")
      .overlaps("audience_roles", ["agent", "broker"])
      .order("display_priority", { ascending: false }).limit(3)
    let assigned = 0
    for (const m of (mods ?? []) as Array<{ id: string }>) {
      const { error } = await service.from("learning_assignments").upsert({
        brokerage_id: brokerage.id, module_id: m.id, agent_user_id: newUser.id,
        status: "open", signal_source: "subscriber_onboarding",
      }, { onConflict: "agent_user_id,module_id", ignoreDuplicates: true })
      if (!error) assigned += 1
    }
    await service.from("notifications").insert({
      user_id: newUser.id, brokerage_id: brokerage.id, type: "agent_onboarding",
      title: "Welcome — meet your AI team",
      body: assigned > 0
        ? `Your ${input.tier.replace(/_/g, " ")} plan is live. Start with your ${assigned}-lesson onboarding path — your eleven AI managers are already on duty.`
        : `Your ${input.tier.replace(/_/g, " ")} plan is live — your eleven AI managers are already on duty. Your onboarding wizard is ready.`,
      priority: "high", is_read: false,
    })
  } catch (err) {
    console.warn("[signupBrokerage] onboarding education failed (non-fatal):", err)
  }

  return {
    ok:          true,
    brokerageId: brokerage.id,
    trialEndsAt: trialEndsAt.toISOString(),
    snapshotApplied,
    snapshotError,
    couponApplied,
    couponError,
  }
}
