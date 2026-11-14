import "server-only"

// lib/platform/demo-tenant-provisioning.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE DEMO SHOWCASE TENANT — WRITE HALF (wave 153). Provisioning and reset of the
// one is_demo brokerage, split out of lib/platform/demo-tenant.ts so that the
// READ half (findDemoBrokerage, the constants, the seed plan and snapshot) no
// longer drags the brokerage signup action into every graph that merely looks
// the demo tenant up (the screenshot pipeline, the D-ID metering cron).
//
// Provisioning goes through the SAME canonical path self-serve signup uses
// (signupBrokerageAction) — no forked provisioning logic. The design rules in
// lib/platform/demo-tenant.ts's header govern this file unchanged.

import { createServiceClient } from "@/lib/supabase/service"
import { signupBrokerageAction } from "@/app/actions/auth/signup-brokerage"
import {
  DEMO_OWNER_EMAIL,
  DEMO_TENANT_NAME,
  DEMO_TENANT_SLUG,
  findDemoBrokerage,
  seedDemoData,
  type DemoSeededTable,
  type EnsureDemoTenantResult,
} from "@/lib/platform/demo-tenant"

/** The demo tenant's trial window is pushed a decade out so trial-expiry crons never nag it. */
const decadeAhead = () => new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000).toISOString()

/**
 * Find the demo brokerage (is_demo = true) or provision one through the SAME
 * canonical path self-serve signup uses (signupBrokerageAction), then flag it
 * is_demo, pin the stable slug, and neutralize billing (subscription paused,
 * trial pushed a decade out). Idempotent — safe to call repeatedly.
 */
export async function ensureDemoTenant(): Promise<EnsureDemoTenantResult> {
  const svc = createServiceClient()

  const existing = await findDemoBrokerage(svc)
  if (existing) return { ok: true, created: false, brokerage: existing }

  // Canonical provisioning: brokerage row + slug'd /site website + tenant owner
  // (auth user + users/agents/teams rows) + starter assistant + trial
  // subscription + onboarding curriculum — exactly what a real signup gets.
  // Tier "team" so the owner carries an agents row (the seeded CRM rows hang
  // off agents.id).
  const signup = await signupBrokerageAction({
    brokerageName: DEMO_TENANT_NAME,
    adminFirstName: "Demi",
    adminLastName: "Showcase",
    adminEmail: DEMO_OWNER_EMAIL,
    tier: "team",
    brokerageCity: "Austin",
    brokerageState: "TX",
  })
  if (!signup.ok || !signup.brokerageId) {
    return { ok: false, created: false, error: `Demo provisioning failed: ${signup.error ?? "unknown"}` }
  }
  const brokerageId = signup.brokerageId
  const now = new Date().toISOString()

  // Flag + pin identity. Stable slug first; if another tenant somehow owns
  // 'demo-showcase', fall back to keeping the signup-generated slug.
  const { error: flagErr } = await svc
    .from("brokerages")
    .update({
      is_demo: true,
      slug: DEMO_TENANT_SLUG,
      signup_source: "superadmin",
      onboarding_status: "completed",
      trial_ends_at: decadeAhead(),
      updated_at: now,
    })
    .eq("id", brokerageId)
  if (flagErr) {
    const { error: retryErr } = await svc
      .from("brokerages")
      .update({
        is_demo: true,
        signup_source: "superadmin",
        onboarding_status: "completed",
        trial_ends_at: decadeAhead(),
        updated_at: now,
      })
      .eq("id", brokerageId)
    if (retryErr) return { ok: false, created: true, error: `Provisioned but could not flag is_demo: ${retryErr.message}` }
  }

  // Never bills: pause the trial subscription (the same comp mechanism
  // brokerage-management uses; there is no Stripe customer at signup).
  // If this pause does not land, the demo tenant stays billable — the one thing
  // "never bills" has to guarantee. The provisioning result said ok either way.
  // COUNTED (CLAUDE.md §3): an UPDATE that matches nothing also resolves with error null —
  // byte-identical to a pause that worked — so the rows are selected back and counted. Zero
  // rows here is not "nothing to pause": canonical provisioning just wrote the subscription,
  // so zero means the predicate found no row and the demo tenant WOULD bill (lane 140O).
  const { data: paused, error: pauseError } = await svc
    .from("subscriptions")
    .update({ status: "paused", updated_at: now })
    .eq("brokerage_id", brokerageId)
    .select("id")
  if (pauseError) {
    return { ok: false, created: true, error: `Provisioned but could not pause billing on the demo subscription: ${pauseError.message}` }
  }
  if (((paused ?? []) as unknown[]).length === 0) {
    return { ok: false, created: true, error: "Provisioned but the billing pause matched no subscription row — the demo tenant would bill, so it is not reported as never-billing." }
  }

  const brokerage = await findDemoBrokerage(svc)
  return { ok: true, created: true, brokerage: brokerage ?? { id: brokerageId, name: DEMO_TENANT_NAME, slug: DEMO_TENANT_SLUG, status: "active", created_at: now } }
}

/** Ensure the demo tenant exists, then wipe + re-seed it. Idempotent. */
export async function resetDemoTenant(): Promise<EnsureDemoTenantResult & { counts?: Record<DemoSeededTable, number> }> {
  const ensured = await ensureDemoTenant()
  if (!ensured.ok || !ensured.brokerage) return ensured
  const seeded = await seedDemoData(ensured.brokerage.id)
  if (!seeded.ok) return { ...ensured, ok: false, error: seeded.error }
  return { ...ensured, counts: seeded.counts }
}
