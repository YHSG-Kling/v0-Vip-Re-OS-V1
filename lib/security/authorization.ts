"use server"

import { createClient } from "@/lib/supabase/server"
import type { AuthorizedUser, SubscriptionContext } from "./types"

export async function requireSuperAdmin(): Promise<AuthorizedUser> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    console.warn("[Security] Unauthorized access attempt to super admin resource")
    throw new Error("Unauthorized: Not authenticated")
  }

  try {
    const { data, error } = await supabase
      .from("users")
      .select("platform_role, email")
      .eq("id", user.id)
      .single()

    if (error) throw new Error("Authorization check failed")
    if (!data || data.platform_role !== "superadmin") {
      throw new Error("Forbidden: Super admin access required")
    }

    return { id: user.id, email: data.email, platformRole: data.platform_role }
  } catch (error) {
    if (error instanceof Error && (error.message.includes("Forbidden") || error.message.includes("Authorization"))) throw error
    console.error("[Security] Unexpected error in requireSuperAdmin:", error)
    throw new Error("Authorization check failed")
  }
}

export async function isSuperAdmin(): Promise<boolean> {
  try { await requireSuperAdmin(); return true } catch { return false }
}

export async function requireSubscriptionAdmin(context: SubscriptionContext): Promise<AuthorizedUser> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) throw new Error("Unauthorized: Not authenticated")
  // BROKERAGE IS THE ONLY ANCHOR. The team_id / agent_id arms were removed —
  // see the tombstone on SubscriptionContext in lib/security/types.ts:451.
  // ai_subscription_tier is written per BROKERAGE and nothing else, so those
  // arms could only ever widen the filter into rows that do not exist.
  if (!context.brokerageId) {
    throw new Error("Authorization context required: must provide brokerageId")
  }

  try {
    const { data: subscription, error: subError } = await supabase
      .from("ai_subscription_tier")
      .select("admin_user_id, tier_name")
      .eq("brokerage_id", context.brokerageId)
      .eq("is_active", true)
      .single()

    if (subError || !subscription) throw new Error("No active subscription found for this context")
    if (subscription.admin_user_id !== user.id) throw new Error("Forbidden: Subscription admin access required")

    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("email, platform_role")
      .eq("id", user.id)
      .single()

    if (userError || !userData) throw new Error("Authorization check failed")

    return { id: user.id, email: userData.email, platformRole: userData.platform_role || "user" }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Forbidden") ||
        error.message.includes("Authorization") ||
        error.message.includes("No active subscription"))
    ) throw error
    console.error("[Security] Unexpected error in requireSubscriptionAdmin:", error)
    throw new Error("Authorization check failed")
  }
}

export async function isSubscriptionAdmin(context: SubscriptionContext): Promise<boolean> {
  try { await requireSubscriptionAdmin(context); return true } catch { return false }
}

export async function getSubscriptionAdmin(
  context: SubscriptionContext
): Promise<{ userId: string; email: string; tierName: string } | null> {
  if (!context.brokerageId) return null

  try {
    const supabase = await createClient()
    // Same single anchor as requireSubscriptionAdmin — lib/security/types.ts:451.
    const { data, error } = await supabase
      .from("ai_subscription_tier")
      .select("admin_user_id, tier_name, users:admin_user_id(email)")
      .eq("brokerage_id", context.brokerageId)
      .eq("is_active", true)
      .maybeSingle()

    if (error || !data?.admin_user_id) return null
    const userEmail = (data.users as any)?.email
    if (!userEmail) return null

    return { userId: data.admin_user_id, email: userEmail, tierName: data.tier_name }
  } catch (error) {
    console.error("[Security] Error fetching subscription admin:", error)
    return null
  }
}

export async function getCurrentUserSubscriptionContext(): Promise<SubscriptionContext | null> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return null

    // team_id / agent_id are no longer selected: nothing writes them, so they
    // were read out of every row as null and handed back as `undefined`
    // context that no filter could then use. lib/security/types.ts:451.
    const { data, error } = await supabase
      .from("ai_subscription_tier")
      .select("brokerage_id")
      .eq("admin_user_id", user.id)
      .eq("is_active", true)
      .maybeSingle()

    if (error || !data) return null

    return {
      brokerageId: data.brokerage_id || undefined,
    }
  } catch (error) {
    console.error("[Security] Error fetching user subscription context:", error)
    return null
  }
}
