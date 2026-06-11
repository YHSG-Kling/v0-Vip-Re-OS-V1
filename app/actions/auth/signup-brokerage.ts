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
}

export interface SignupBrokerageResult {
  ok:           boolean
  error?:       string
  brokerageId?: string
  trialEndsAt?: string
}

const TRIAL_DAYS = 14

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
}

export async function signupBrokerageAction(
  input: SignupBrokerageInput,
): Promise<SignupBrokerageResult> {
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
      email:              input.adminEmail.trim().toLowerCase(),
      city:               input.brokerageCity ?? null,
      state:              input.brokerageState ?? null,
      plan_tier:          input.tier,
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

  // Step 2 — create admin user record
  const { data: newUser, error: uErr } = await service
    .from("users")
    .insert({
      email:        input.adminEmail.trim().toLowerCase(),
      first_name:   input.adminFirstName.trim(),
      last_name:    input.adminLastName.trim(),
      user_type:    "admin",
      role:         "admin",
      brokerage_id: brokerage.id,
      is_contact:   false,
      created_at:   new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .select("id")
    .single()
  if (uErr || !newUser) {
    await service.from("brokerages").delete().eq("id", brokerage.id)
    return { ok: false, error: `User creation failed: ${uErr?.message ?? "unknown"}` }
  }

  // Step 3 — seed agent_onboarding so first-login lands in the wizard
  try {
    await service.from("agent_onboarding").insert({
      agent_id:              newUser.id,
      user_id:               newUser.id,
      brokerage_id:          brokerage.id,
      status:                "not_started",
      current_day:           1,
      start_date:            new Date().toISOString().split("T")[0],
      completion_percentage: 0,
      created_at:            new Date().toISOString(),
      updated_at:            new Date().toISOString(),
    })
  } catch { /* non-fatal */ }

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

  // Step 5 — audit log entry (non-fatal)
  try {
    await service.from("activities").insert({
      activity_type: "brokerage.self_serve_signup",
      brokerage_id:  brokerage.id,
      agent_id:      newUser.id,
      title:         `Self-serve signup: ${input.brokerageName}`,
      notes:         JSON.stringify({
        tier:           input.tier,
        admin_email:    input.adminEmail,
        trial_ends_at:  trialEndsAt.toISOString(),
        user_agent:     (await headers()).get("user-agent") ?? null,
      }),
      created_at:    new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    })
  } catch { /* non-fatal */ }

  // Step 6 — magic-link invite email so admin can set a password
  try {
    await service.auth.admin.inviteUserByEmail(input.adminEmail.trim().toLowerCase(), {
      data: {
        first_name:   input.adminFirstName.trim(),
        last_name:    input.adminLastName.trim(),
        brokerage_id: brokerage.id,
        user_type:    "admin",
      },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/dashboard/onboarding`,
    })
  } catch (err: any) {
    // Non-fatal — admin can request a fresh invite from the login page.
    console.warn("[signupBrokerage] Invite email failed:", err?.message)
  }

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
  }
}
