// lib/kernel/tenant-creation.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE TENANT-CREATION CORE (lane 77B, owner verbatim: "when a real estate
// subscriber wants to purchase the platform subscription there needs to be an
// easy way to convert a prospect to a subscriber or a new subscriber that isn't
// a prospect").
//
// Before this lane the brokerage row, the trial/active subscription row, the
// config snapshot, the prospect stamp and the day-one extras were spelled
// TWICE — once in app/actions/auth/signup-brokerage.ts (self-serve trial) and
// once in app/actions/admin/create-subscriber.ts (staff-provisioned active
// subscription) — and the two had drifted: only the self-serve door
// provisioned the tenant's AI-ISA actor, seeded the starter assistant, emitted
// SUBSCRIPTION_CREATED and assigned the onboarding library; only the staff
// door accepted a staff-picked snapshot. A third caller (the prospect →
// subscriber conversion, lib/platform/prospect-conversion.ts) would have been a
// third spelling. CLAUDE.md §1: merge what each survivor was missing onto ONE
// survivor, then make every door delegate. This module is that survivor; the
// two actions keep only what is genuinely theirs (the public throttle, input
// validation and the coupon/affiliate/territory extras for self-serve; the
// staff gate and the Stripe customer for the staff door).
//
// WHAT EVERY DOOR NOW GETS, in order:
//   1. tier row resolved from subscription_tiers (never a dangling tier_id)
//   2. duplicate-owner guard — an email that already owns a tenant is refused
//      (provisionTenantOwner re-pins an existing auth user, so without this a
//      staff-provisioned tenant could MOVE a live owner out of their brokerage)
//   3. brokerages row — slug'd (day-one /site/[slug]), plan_tier set so
//      fair-use caps apply on day one, trial window for the trial mode
//   4. provisionTenantOwner (lib/kernel/users.ts — auth user FIRST, id pinned,
//      tier-aware agents/teams/onboarding rows, magic-link invite) with the
//      counted rollback (lib/kernel/tenant-creation-rollback.ts) on failure
//   5. the subscription row — 'trialing' with trial_end written (the paywall
//      reads that column) or 'active' with the billing-cycle period end
//   6. config snapshot at creation — staff-picked id or the tier's live funnel
//      snapshot (snapshotForTier), applied through applySnapshotPayload only
//   7. PROSPECT LINK-BACK — stampProspectConversion by email / phone / id, so a
//      prospect who signs up on their own and a prospect converted by the
//      assistant or the growth board land on the SAME converted_brokerage_id
//   8. the tenant's AI-ISA actor, the starter assistant identity, the
//      SUBSCRIPTION_CREATED lifecycle event (the onboarding-curriculum hook)
//      and the onboarding library assignment + welcome bell
//
// Steps 6-8 are best-effort and reported per part — a branding, education or
// stamping problem must never cost a tenant that already exists, but nothing
// is swallowed silently (CLAUDE.md §3: supabase-js RESOLVES refusals; every
// write here reads its error).
//
// TENANT (CLAUDE.md §4): the new brokerage's id is MINTED here and returned —
// it never arrives in a request body. The actor is the staff caller
// (callerUserId) or null for the self-serve signer.

import type { ProspectConversionResult } from "@/lib/platform/prospect-conversion"

export type CanonicalTier = "solo_agent" | "team" | "brokerage" | "multi_location"
export const CANONICAL_TIERS: readonly CanonicalTier[] = ["solo_agent", "team", "brokerage", "multi_location"]

export function isCanonicalTier(v: unknown): v is CanonicalTier {
  return typeof v === "string" && (CANONICAL_TIERS as readonly string[]).includes(v)
}

/** brokerages.signup_source — the live CHECK vocabulary (scripts/check-vocabularies.ts:
 *  import | partner | self_serve | superadmin). A prospect converted by the
 *  assistant signed THEMSELVES up (self_serve); a staff conversion is
 *  superadmin — no new spelling is minted (CLAUDE.md §6). */
export type TenantSignupSource = "self_serve" | "superadmin"

export type TenantBilling =
  /** Self-serve shape: no card, trial_end written, the paywall collects later. */
  | { mode: "trial"; trialDays?: number }
  /** Staff-provisioned shape: an active subscription for the chosen cycle. */
  | { mode: "active"; billingCycle: "monthly" | "annual"; stripeCustomerId?: string | null }

export interface TenantCreationInput {
  brokerageName: string
  adminEmail: string
  adminFirstName: string
  adminLastName: string
  tier: CanonicalTier
  /** brokerages.email — defaults to the admin email (the self-serve shape). */
  brokerageEmail?: string | null
  brokeragePhone?: string | null
  city?: string | null
  state?: string | null
  signupSource: TenantSignupSource
  billing: TenantBilling
  /** subscription_tiers.id when the caller already resolved it; else resolved from `tier`. */
  tierId?: string | null
  /** Solo-agent only: is their managing brokerage / team also on the platform? */
  brokerageOnPlatform?: boolean
  teamOnPlatform?: boolean
  /** Staff-picked platform_config_snapshots.id; null/omitted → the tier's live funnel snapshot. */
  snapshotId?: string | null
  /** The staff actor (users.id) or null for the self-serve signer. */
  callerUserId: string | null
  /** Prospect link-back keys beyond the admin/brokerage email + brokerage phone. */
  prospect?: { emails?: Array<string | null | undefined>; phone?: string | null; prospectIds?: string[] }
  /** Post-invite landing; defaults to the onboarding wizard. */
  redirectTo?: string
}

export interface TenantCreationResult {
  ok: boolean
  error?: string
  brokerageId?: string
  userId?: string
  subscriptionId?: string | null
  /** READ (§3) and reported — the tenant exists even when this row was refused. */
  subscriptionError?: string
  slug?: string
  trialEndsAt?: string | null
  inviteSent?: boolean
  inviteError?: string
  snapshotApplied?: string[]
  snapshotName?: string | null
  snapshotError?: string
  prospectStamp?: ProspectConversionResult
  /** Best-effort day-one extras that did not land, named — never swallowed. */
  extrasSkipped: string[]
}

const DEFAULT_TRIAL_DAYS = 14

/** PURE: the tenant's public slug — kebab of the name + a short suffix so a
 *  collision can never 500 a signup. */
export function buildTenantSlug(brokerageName: string, suffix: string = Math.random().toString(36).slice(2, 6)): string {
  const base = brokerageName.trim().toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "brokerage"
  return `${base}-${suffix}`
}

/** PURE: platform-membership flags — for a SOLO agent the broker-side steps
 *  (CDA signature, compliance) route to their external form platform unless
 *  their brokerage/team is also on the platform; any org tier IS the customer. */
export function platformMembershipFlags(input: Pick<TenantCreationInput, "tier" | "brokerageOnPlatform" | "teamOnPlatform">): { brokerage_on_platform: boolean; team_on_platform: boolean } {
  return {
    brokerage_on_platform: input.tier === "solo_agent" ? (input.brokerageOnPlatform ?? false) : true,
    team_on_platform: input.tier === "solo_agent" ? (input.teamOnPlatform ?? false) : true,
  }
}

/** PURE: the subscription row for the chosen billing mode. */
export function buildSubscriptionRow(input: { brokerageId: string; tierId: string; billing: TenantBilling; now?: Date }): Record<string, unknown> & { status: "trialing" | "active"; current_period_end: string } {
  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  if (input.billing.mode === "trial") {
    const end = new Date(now.getTime() + (input.billing.trialDays ?? DEFAULT_TRIAL_DAYS) * 24 * 60 * 60 * 1000).toISOString()
    return {
      brokerage_id: input.brokerageId, tier_id: input.tierId, status: "trialing",
      current_period_start: nowIso, current_period_end: end,
      // trial_end IS WRITTEN — lib/billing/billing-access.ts reads exactly this
      // column to decide whether the trial ran out; NULL was a trial that never ended.
      trial_end: end,
      created_at: nowIso, updated_at: nowIso,
    }
  }
  const days = input.billing.billingCycle === "annual" ? 365 : 30
  return {
    brokerage_id: input.brokerageId, tier_id: input.tierId, status: "active",
    stripe_customer_id: input.billing.stripeCustomerId ?? null,
    current_period_start: nowIso,
    current_period_end: new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
    created_at: nowIso, updated_at: nowIso,
  }
}

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
}

/**
 * Create a tenant end to end. `service` is the service client (RLS bypass —
 * the caller has already gated: a platform-staff capability, or the public
 * throttle on the self-serve door).
 */
export async function createTenantCore(service: any, input: TenantCreationInput): Promise<TenantCreationResult> {
  const extrasSkipped: string[] = []
  const brokerageName = (input.brokerageName ?? "").trim()
  const adminEmail = (input.adminEmail ?? "").trim().toLowerCase()
  const firstName = (input.adminFirstName ?? "").trim()
  const lastName = (input.adminLastName ?? "").trim()
  if (brokerageName.length < 2) return { ok: false, error: "Brokerage name is required (2+ chars).", extrasSkipped }
  if (!firstName) return { ok: false, error: "Admin first name is required.", extrasSkipped }
  if (!isValidEmail(adminEmail)) return { ok: false, error: "Valid admin email required.", extrasSkipped }
  if (!isCanonicalTier(input.tier)) return { ok: false, error: "Invalid tier — choose Solo Agent, Team, Brokerage, or Multi-Location.", extrasSkipped }

  // 1. The tier row — the subscription links to a real subscription_tiers record
  //    (billing + v_platform_margin key on it).
  let tierId = input.tierId ?? null
  if (!tierId) {
    const { data: tierRow, error: tierErr } = await service
      .from("subscription_tiers").select("id").eq("tier_name", input.tier).eq("is_active", true).maybeSingle()
    if (tierErr || !tierRow) return { ok: false, error: `Plan tier not found: ${input.tier}`, extrasSkipped }
    tierId = (tierRow as { id: string }).id
  }

  // 2. Duplicate-owner guard. users is the authoritative tenant link; an email
  //    that already owns a tenant must sign in, not be re-pinned to a new one.
  const { data: existingUser, error: existingErr } = await service
    .from("users").select("id, brokerage_id").eq("email", adminEmail).maybeSingle()
  if (existingErr) return { ok: false, error: `Could not verify the owner email: ${existingErr.message}`, extrasSkipped }
  if ((existingUser as { brokerage_id?: string | null } | null)?.brokerage_id) {
    return { ok: false, error: "An account with this email already exists. Sign in instead.", extrasSkipped }
  }

  // 3. The brokerage row.
  const nowIso = new Date().toISOString()
  const trialEndsAt = input.billing.mode === "trial"
    ? new Date(Date.now() + (input.billing.trialDays ?? DEFAULT_TRIAL_DAYS) * 24 * 60 * 60 * 1000).toISOString()
    : null
  const slug = buildTenantSlug(brokerageName)
  const { data: brokerage, error: bErr } = await service
    .from("brokerages")
    .insert({
      name: brokerageName,
      slug,
      email: (input.brokerageEmail ?? "").trim().toLowerCase() || adminEmail,
      phone: (input.brokeragePhone ?? "").trim() || null,
      city: input.city ?? null,
      state: input.state ?? null,
      plan_tier: input.tier,
      ...platformMembershipFlags(input),
      trial_ends_at: trialEndsAt,
      signup_source: input.signupSource,
      onboarding_status: "pending",
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("id")
    .single()
  if (bErr || !brokerage) return { ok: false, error: `Brokerage creation failed: ${bErr?.message ?? "unknown"}`, extrasSkipped }
  const brokerageId = (brokerage as { id: string }).id

  // 4. The owner — the canonical identity path, with the counted rollback.
  const { provisionTenantOwner } = await import("@/lib/kernel/users")
  const owner = await provisionTenantOwner({
    email: adminEmail, firstName, lastName, brokerageId, brokerageName, tier: input.tier,
    redirectTo: input.redirectTo ?? `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/dashboard/onboarding`,
    callerUserId: input.callerUserId,
  })
  if (!owner.success || !owner.userId) {
    const { rollbackTenantCreation } = await import("@/lib/kernel/tenant-creation-rollback")
    const rollback = await rollbackTenantCreation(service, brokerageId)
    if (!rollback.ok) {
      console.error("[tenant-creation] tenant rollback incomplete:", rollback.error)
      return { ok: false, error: `Owner provisioning failed: ${owner.error ?? "unknown"}. ${rollback.error}`, extrasSkipped }
    }
    return { ok: false, error: `Owner provisioning failed: ${owner.error ?? "unknown"}`, extrasSkipped }
  }
  const userId = owner.userId

  // 5. The subscription row — the error is READ; a refused row is reported,
  //    never mistaken for a tenant with a trial.
  const subscriptionRow = buildSubscriptionRow({ brokerageId, tierId, billing: input.billing })
  const { data: subscription, error: subErr } = await service
    .from("subscriptions").insert(subscriptionRow).select("id").single()
  let subscriptionError: string | undefined
  if (subErr || !subscription) {
    subscriptionError = subErr?.message ?? "subscription insert returned no row"
    console.error("[tenant-creation] subscription INSERT rejected — this tenant has no subscription row:", subscriptionError, { brokerageId, tierId })
  }
  const subscriptionId = (subscription as { id: string } | null)?.id ?? null

  // 6. Config snapshot at creation — ONE apply path for every door.
  let snapshotApplied: string[] | undefined
  let snapshotName: string | null = null
  let snapshotError: string | undefined
  try {
    const { applySnapshotPayload } = await import("@/lib/platform/config-snapshots")
    const { snapshotForTier } = await import("@/lib/platform/trial-funnel")
    let payload: Record<string, unknown> | null = null
    if (input.snapshotId) {
      const { data: snap, error: snapErr } = await service
        .from("platform_config_snapshots").select("name, payload").eq("id", input.snapshotId).maybeSingle()
      if (snapErr) snapshotError = `Snapshot read failed: ${snapErr.message}`
      else if (!snap) snapshotError = "Config snapshot not found — tenant provisioned from platform defaults."
      else { snapshotName = (snap as { name: string }).name; payload = ((snap as { payload?: Record<string, unknown> }).payload ?? {}) }
    } else {
      const snap = await snapshotForTier(input.tier, service)
      if (snap) { snapshotName = snap.name; payload = snap.payload as Record<string, unknown> }
    }
    if (payload) {
      const { applied } = await applySnapshotPayload(payload as never, brokerageId, userId, service)
      snapshotApplied = applied
    }
  } catch (err) {
    snapshotError = err instanceof Error ? err.message : "Snapshot apply failed"
    console.warn("[tenant-creation] snapshot apply failed (non-fatal):", err)
  }

  // 7. PROSPECT LINK-BACK — counted + idempotent + never-clobber.
  let prospectStamp: ProspectConversionResult | undefined
  try {
    const { stampProspectConversion } = await import("@/lib/platform/prospect-conversion")
    prospectStamp = await stampProspectConversion(service, {
      brokerageId,
      emails: [adminEmail, input.brokerageEmail, ...(input.prospect?.emails ?? [])],
      phone: input.brokeragePhone ?? input.prospect?.phone ?? null,
      prospectIds: input.prospect?.prospectIds ?? [],
      outcome: input.billing.mode === "trial" ? "trial" : "converted",
    })
    if (prospectStamp.errors.length > 0) {
      console.warn("[tenant-creation] prospect conversion stamp incomplete:", prospectStamp.errors.join("; "), { matched: prospectStamp.matched, linked: prospectStamp.linked })
    }
  } catch (err) {
    extrasSkipped.push("prospect_stamp")
    console.warn("[tenant-creation] prospect conversion stamp failed (non-fatal):", (err as Error)?.message)
  }

  // 8a. The tenant's AI-ISA actor — idempotent; without it every ISA audit write
  //     falls back to the admin's user_id forever.
  try {
    const { provisionIsaActorForBrokerage } = await import("@/lib/auth/provision-isa-actor")
    await provisionIsaActorForBrokerage({ brokerageId, brokerageName, brokerageSlug: slug })
  } catch (err) { extrasSkipped.push("isa_actor"); console.warn("[tenant-creation] ISA actor provisioning failed (non-fatal):", (err as Error)?.message) }

  // 8b. Day-one assistant identity (name + headshot + narration voice).
  try {
    const { seedStarterAssistant } = await import("@/lib/kernel/assistant-starter")
    await seedStarterAssistant(service, brokerageId)
  } catch (err) { extrasSkipped.push("starter_assistant"); console.warn("[tenant-creation] assistant seed failed (non-fatal):", (err as Error)?.message) }

  // 8c. SUBSCRIPTION_CREATED — the lifecycle hook the onboarding curriculum and
  //     every downstream reactor key on; the weekly cron is the idempotent net.
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    const { KernelEvent } = await import("@/lib/kernel/events")
    await emitKernelEvent({
      event: KernelEvent.SUBSCRIPTION_CREATED, brokerageId,
      entityType: "brokerage", entityId: brokerageId,
      metadata: { tier: input.tier, billing_mode: input.billing.mode, signup_source: input.signupSource },
    })
  } catch (err) { extrasSkipped.push("subscription_created_event"); console.warn("[tenant-creation] SUBSCRIPTION_CREATED emit failed (non-fatal):", (err as Error)?.message) }

  // 8d. Onboarding library + welcome bell — the day-one learning path.
  try {
    const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
    const { data: mods } = await service
      .from("learning_modules").select("id")
      .is("brokerage_id", null).eq("status", "published")
      .overlaps("audience_roles", ["agent", "broker"])
      .order("display_priority", { ascending: false }).limit(3)
    let assigned = 0
    for (const m of (mods ?? []) as Array<{ id: string }>) {
      const { error } = await service.from("learning_assignments").upsert({
        brokerage_id: brokerageId, module_id: m.id, agent_user_id: userId,
        status: "open", signal_source: "subscriber_onboarding",
      }, { onConflict: "agent_user_id,module_id", ignoreDuplicates: true })
      if (!error) assigned += 1
    }
    const planLabel = input.tier.replace(/_/g, " ")
    await sentinelWrite(service, service.from("notifications").insert({
      user_id: userId, brokerage_id: brokerageId, type: "agent_onboarding",
      title: "Welcome — meet your AI team",
      body: assigned > 0
        ? `Your ${planLabel} plan is live. Start with your ${assigned}-lesson onboarding path — your eleven AI managers are already on duty.`
        : `Your ${planLabel} plan is live — your eleven AI managers are already on duty. Your onboarding wizard is ready.`,
      priority: "high", is_read: false,
    }), { table: "notifications", flow: "tenant_creation_welcome", brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
  } catch (err) { extrasSkipped.push("onboarding_education"); console.warn("[tenant-creation] onboarding education failed (non-fatal):", (err as Error)?.message) }

  return {
    ok: true,
    brokerageId, userId, subscriptionId, subscriptionError, slug, trialEndsAt,
    inviteSent: owner.inviteSent, inviteError: owner.inviteError,
    snapshotApplied, snapshotName, snapshotError,
    prospectStamp, extrasSkipped,
  }
}
