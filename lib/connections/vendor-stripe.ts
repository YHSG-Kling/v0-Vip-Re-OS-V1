// lib/connections/vendor-stripe.ts
// Single source of truth for a vendor's Stripe Connect account, on the unified owner model.
// A vendor's Connect account lives in platform_credentials keyed by
// (owner_type="vendor", owner_id=<vendors.id>, platform="stripe"):
// NOTE: owner_id is a `vendors.id`, NOT a vendor_marketplace_profiles.id — those are
// disjoint id spaces (vendor_earnings/_invoices/_payouts and user_role_assignments.vendor_id
// all FK to `vendors`). This comment previously named the marketplace-profile id and
// app/vendor/earnings/page.tsx acted on it, which made that whole surface inert.
//   - account_id                       → the acct_… Connect id
//   - config.stripe_onboarding_complete → details_submitted && charges_enabled
// This is the same row the Connection Center's startStripeConnect writes, so onboarding via either
// surface (the vendor earnings page or the Connection Center) resolves to one record — no drift.

import type { createServiceClient } from "@/lib/supabase/service"

type ServiceClient = ReturnType<typeof createServiceClient>

export interface VendorStripeConnect {
  accountId: string | null
  onboardingComplete: boolean
}

/** Read a vendor's Stripe Connect account + onboarding flag from the owner-scoped credential. */
export async function readVendorStripeConnect(
  svc: ServiceClient,
  vendorId: string,
): Promise<VendorStripeConnect> {
  const { data } = await svc
    .from("platform_credentials")
    .select("account_id, config")
    .eq("owner_type", "vendor")
    .eq("owner_id", vendorId)
    .eq("platform", "stripe")
    .maybeSingle()

  const config = (data?.config ?? {}) as Record<string, unknown>
  return {
    accountId: (data?.account_id as string | null) ?? null,
    onboardingComplete: config.stripe_onboarding_complete === true,
  }
}

/** Owner-keyed create-or-update of the vendor's Connect account id (preserves existing config). */
export async function upsertVendorStripeAccount(
  svc: ServiceClient,
  params: { vendorId: string; brokerageId: string; accountId: string },
): Promise<{ error?: string }> {
  const { data: existing } = await svc
    .from("platform_credentials")
    .select("id, config")
    .eq("owner_type", "vendor")
    .eq("owner_id", params.vendorId)
    .eq("platform", "stripe")
    .maybeSingle()

  const config = {
    ...((existing?.config ?? {}) as Record<string, unknown>),
    stripe_onboarding_complete:
      ((existing?.config ?? {}) as Record<string, unknown>).stripe_onboarding_complete === true,
  }

  const row = {
    brokerage_id: params.brokerageId,
    owner_type: "vendor",
    owner_id: params.vendorId,
    platform: "stripe",
    scope: "vendor",
    account_id: params.accountId,
    config,
    is_active: true,
    updated_at: new Date().toISOString(),
  }

  const { error } = existing?.id
    ? await svc.from("platform_credentials").update(row).eq("id", existing.id)
    : await svc.from("platform_credentials").insert(row)

  return { error: error?.message }
}

/** Flip the onboarding flag for a vendor (by vendor id), merging into existing config. */
export async function setVendorStripeOnboarding(
  svc: ServiceClient,
  vendorId: string,
  complete: boolean,
): Promise<{ error?: string }> {
  const { data: existing } = await svc
    .from("platform_credentials")
    .select("id, config")
    .eq("owner_type", "vendor")
    .eq("owner_id", vendorId)
    .eq("platform", "stripe")
    .maybeSingle()

  if (!existing?.id) return { error: "No Stripe account found" }

  const config = {
    ...((existing.config ?? {}) as Record<string, unknown>),
    stripe_onboarding_complete: complete,
  }
  const { error } = await svc
    .from("platform_credentials")
    .update({ config, updated_at: new Date().toISOString() })
    .eq("id", existing.id)

  return { error: error?.message }
}

/** Webhook path: flip onboarding by the Stripe account id (the only identifier account.updated carries). */
export async function setStripeOnboardingByAccount(
  svc: ServiceClient,
  accountId: string,
  complete: boolean,
): Promise<void> {
  const { data: rows } = await svc
    .from("platform_credentials")
    .select("id, config")
    .eq("platform", "stripe")
    .eq("account_id", accountId)

  for (const r of rows ?? []) {
    const config = {
      ...((r.config ?? {}) as Record<string, unknown>),
      stripe_onboarding_complete: complete,
    }
    await svc
      .from("platform_credentials")
      .update({ config, updated_at: new Date().toISOString() })
      .eq("id", r.id)
  }
}
