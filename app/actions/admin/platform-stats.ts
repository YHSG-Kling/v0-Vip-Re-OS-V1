"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

/**
 * Platform-wide aggregate stats — cross-tenant counts of brokerages, users,
 * integrations, and unresolved automation errors. Consumed by the Platform
 * Owner OS dashboard. Previously unauthenticated, leaking platform metrics
 * to anyone with the RPC bundle. Now: requires platform_admin role.
 */

async function requirePlatformAdmin(): Promise<
  | { ok: true; userId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: role } = await svc
    .from("user_role_assignments")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle()
  if (role?.role !== "platform_admin") return { ok: false, error: "Forbidden" }

  return { ok: true, userId: user.id }
}

export async function getAdminStats() {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) {
    return {
      brokerageCount: 0,
      userCount: 0,
      integrationCount: 0,
      unresolvledErrorCount: 0,
      recentErrors: [],
      error: auth.error,
    }
  }

  const service = createServiceClient()

  const [
    { count: brokerageCount },
    { count: userCount },
    { count: integrationCount },
    { data: recentErrors },
  ] = await Promise.all([
    service.from("brokerages").select("id", { count: "exact", head: true }),
    service.from("users").select("id", { count: "exact", head: true }),
    service.from("brokerage_integrations").select("id", { count: "exact", head: true }),
    service
      .from("automation_errors")
      .select("*")
      .eq("resolved", false)
      .order("created_at", { ascending: false })
      .limit(5),
  ])

  return {
    brokerageCount: brokerageCount || 0,
    userCount: userCount || 0,
    integrationCount: integrationCount || 0,
    unresolvledErrorCount: recentErrors?.length || 0,
    recentErrors: recentErrors || [],
  }
}

export async function getPlatformAdminStats() {
  return getAdminStats()
}
