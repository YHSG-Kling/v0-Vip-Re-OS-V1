"use server"

/**
 * Superadmin-driven manual subscriber provisioning.
 *
 * Thin wrapper around app/actions/admin/create-subscriber.ts:createSubscriber
 * that adds:
 *   - Explicit superadmin gate (createSubscriber already gates, but we double-check)
 *   - Pre-flight tier_id lookup (subscription_tiers.tier_name → tier_id) so
 *     superadmin doesn't need to know UUIDs
 *   - Audit log entry to superadmin_audit_log on success/failure
 *
 * Use case: a broker reaches out via sales call → superadmin provisions them
 * directly without going through the self-serve signup. Bypasses email
 * marketing flows; the new admin still receives the magic-link invite.
 */

import { createClient } from "@/lib/supabase/server"
import { resolvePlatformRole } from "@/lib/platform/require-capability"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"
import { createServiceClient } from "@/lib/supabase/service"
import { createSubscriber } from "@/app/actions/admin/create-subscriber"
import { headers } from "next/headers"

export interface ManualProvisionInput {
  brokerageName:   string
  brokerageCity?:  string
  brokerageState?: string
  brokerageEmail:  string
  brokeragePhone?: string
  adminFirstName:  string
  adminLastName:   string
  adminEmail:      string
  tier:            "solo_agent" | "team" | "brokerage" | "multi_location"
  billingCycle:    "monthly" | "annual"
  notes?:          string
  /** Optional config snapshot to provision from — the tenant's day-one website
   *  comes up fully branded (brand + voice + site + features). When omitted,
   *  createSubscriber applies the tier's live funnel snapshot instead
   *  (snapshotForTier), so a manually provisioned tenant still snapshots at
   *  creation like every other creation path. */
  snapshotId?:     string
}

export interface ManualProvisionResult {
  ok: boolean
  error?: string
  brokerageId?: string
  userId?: string
  subscriptionId?: string
  inviteSent?: boolean
  inviteError?: string
  /** Layers applied from the config snapshot (when snapshotId was given). */
  snapshotApplied?: string[]
  snapshotError?: string
}

export async function manualProvisionSubscriberAction(
  input: ManualProvisionInput,
): Promise<ManualProvisionResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const { data: profile } = await supabase
    .from("users")
    .select("user_type, email")
    .eq("id", user.id)
    .maybeSingle()
  // ROUND-19 PARITY: subscription creation is a 'tenants' capability — platform
  // ADMIN staff provision subscribers too (GHL model); resolved the canonical way.
  const platformRole = resolvePlatformRole(profile as any)
  if (!platformStaffCan(platformRole, "tenants")) return { ok: false, error: "Forbidden — requires platform 'tenants' capability" }

  const svc = createServiceClient()

  // Resolve tier_id from canonical tier_name
  const { data: tier, error: tierErr } = await svc
    .from("subscription_tiers")
    .select("id, monthly_price_cents")
    .eq("tier_name", input.tier)
    .eq("is_active", true)
    .maybeSingle()
  if (tierErr || !tier) return { ok: false, error: `Tier not found: ${input.tier}` }

  // Resolve the config snapshot BEFORE creating anything — fail fast if it's gone.
  // (Existence check only; the apply happens INSIDE createSubscriber — see below.)
  let snapshotName: string | null = null
  let snapshotRecommendedTier: string | null = null
  if (input.snapshotId) {
    const { data: snap } = await svc
      .from("platform_config_snapshots")
      .select("id, name, payload")
      .eq("id", input.snapshotId)
      .maybeSingle()
    if (!snap) return { ok: false, error: "Config snapshot not found" }
    snapshotName = (snap as any).name
    snapshotRecommendedTier = (((snap as any).payload ?? {}) as { recommendedTier?: string }).recommendedTier ?? null
  }

  const result = await createSubscriber({
    brokerageName:   input.brokerageName,
    brokerageCity:   input.brokerageCity,
    brokerageState:  input.brokerageState,
    brokerageEmail:  input.brokerageEmail,
    brokeragePhone:  input.brokeragePhone,
    adminFirstName:  input.adminFirstName,
    adminLastName:   input.adminLastName,
    adminEmail:      input.adminEmail,
    tierId:          tier.id as string,
    tierName:        input.tier,
    billingCycle:    input.billingCycle,
    notes:           input.notes,
    snapshotId:      input.snapshotId,
  })

  // TOMBSTONE (orphan doctrine §1.1, 2026-08-27): the applySnapshotPayload call
  // that lived here moved INTO the survivor, app/actions/admin/create-subscriber.ts
  // (the shared provisioning inner path), which now applies the explicit
  // snapshotId when given and otherwise defaults to the tier's live funnel
  // snapshot (snapshotForTier) — so EVERY provisioned tenant snapshots at
  // creation (owner ruling), not only the ones a staffer hand-picked one for.
  // The outcome comes back on the result and is audited below.
  const snapshotApplied = result.snapshotApplied
  const snapshotError = result.snapshotError
  if (result.success && result.brokerageId && (snapshotApplied?.length || input.snapshotId)) {
    try {
      const hdrs = await headers()
      await svc.from("superadmin_audit_log").insert({
        actor_user_id: user.id,
        actor_email:   profile?.email ?? user.email,
        action:        "tenant.provisioned_from_snapshot",
        target_type:   "brokerage",
        target_id:     result.brokerageId,
        details: {
          snapshot_id:      input.snapshotId ?? null,
          snapshot_name:    result.snapshotName ?? snapshotName,
          recommended_tier: snapshotRecommendedTier,
          selected_tier:    input.tier,
          applied:          snapshotApplied ?? null,
          snapshot_error:   snapshotError ?? null,
        },
        ip_address:    hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
        user_agent:    hdrs.get("user-agent"),
      })
    } catch (err) {
      console.error("[manualProvisionSubscriber] snapshot audit log write failed:", err)
    }
  }

  // Always write the audit row — successful or failed provisioning.
  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: user.id,
      actor_email:   profile?.email ?? user.email,
      action:        result.success ? "brokerage.manually_provisioned" : "brokerage.manual_provision_failed",
      target_type:   "brokerage",
      target_id:     result.brokerageId ?? null,
      details: {
        brokerage_name: input.brokerageName,
        admin_email:    input.adminEmail,
        tier:           input.tier,
        billing_cycle:  input.billingCycle,
        invite_sent:    result.inviteSent ?? null,
        invite_error:   result.inviteError ?? null,
        error:          result.error ?? null,
        notes:          input.notes ?? null,
        snapshot_id:    input.snapshotId ?? null,
        snapshot_name:  result.snapshotName ?? snapshotName,
        snapshot_applied: snapshotApplied ?? null,
        snapshot_error: snapshotError ?? null,
      },
      ip_address:    hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent:    hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[manualProvisionSubscriber] audit log write failed:", err)
  }

  return {
    ok:             result.success,
    error:          result.error,
    brokerageId:    result.brokerageId,
    userId:         result.userId,
    subscriptionId: result.subscriptionId,
    inviteSent:     result.inviteSent,
    inviteError:    result.inviteError,
    snapshotApplied,
    snapshotError,
  }
}
