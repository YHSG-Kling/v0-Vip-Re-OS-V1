"use server"

// app/actions/superadmin/tenant-setup.ts
// ─────────────────────────────────────────────────────────────────────────────
// STAFF-ASSISTED ONBOARDING — the staffer who enrolls a tenant can also SET THEM UP. createSubscriber only
// provisions the shell + emails the tenant to self-serve; this lets a superadmin/support user SEE a tenant's
// role-aware setup-readiness from the god console and work the checklist on their behalf (the staff-
// appropriate items — brand, providers, commission, invite team — already have god-console controls on the
// same tenant page). Reuses loadSetupReadiness, which already accepts an explicit tenant identity.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadSetupReadiness, normalizeSetupRole, type SetupReadiness } from "@/lib/onboarding/setup-readiness"

async function requireSuperadmin(): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const isStaff = ["superadmin", "support"].includes((data as any)?.user_type) || ["superadmin", "support"].includes((data as any)?.platform_role)
  return isStaff ? { ok: true } : { ok: false, error: "Forbidden — platform staff only" }
}

/**
 * Compute a TENANT's setup readiness for the god console. Resolves the brokerage's primary owner (broker/
 * admin) and runs the role-aware readiness against THAT tenant's identity (not the staffer's), so a superadmin
 * sees exactly what the tenant still needs to be operational.
 */
export async function getTenantSetupReadinessAction(brokerageId: string): Promise<
  | { ok: true; readiness: SetupReadiness; ownerName: string | null; ownerRole: string }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // Primary owner: a broker/admin on the tenant (else fall back to any active agent).
  const { data: owner } = await svc.from("users")
    .select("id, user_type, first_name, last_name")
    .eq("brokerage_id", brokerageId)
    .in("user_type", ["broker", "broker_owner", "admin"])
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1).maybeSingle()

  let ownerUserId = (owner as any)?.id ?? null
  let ownerType = (owner as any)?.user_type ?? "admin"
  let ownerName = owner ? [(owner as any).first_name, (owner as any).last_name].filter(Boolean).join(" ") || null : null
  let agentId: string | null = null

  if (!ownerUserId) {
    const { data: ag } = await svc.from("agents").select("id, user_id, users(first_name, last_name, user_type)").eq("brokerage_id", brokerageId).eq("is_active", true).limit(1).maybeSingle()
    if (ag) {
      agentId = (ag as any).id
      ownerUserId = (ag as any).user_id
      const u = Array.isArray((ag as any).users) ? (ag as any).users[0] : (ag as any).users
      ownerType = u?.user_type ?? "agent"
      ownerName = u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || null : null
    }
  }
  if (!ownerUserId) return { ok: false, error: "This tenant has no owner user yet — invite an admin first." }

  const role = normalizeSetupRole(ownerType)
  const readiness = await loadSetupReadiness({ userId: ownerUserId, role, brokerageId, agentId, client: svc })
  return { ok: true, readiness, ownerName, ownerRole: role }
}
