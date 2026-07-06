"use server"

// app/actions/superadmin/platform-staff.ts
// ─────────────────────────────────────────────────────────────────────────────
// Superadmin CRUD for PLATFORM EMPLOYEES (support / superadmin). Create a staff
// account (auth invite + users row, user_type + platform_role set, NO brokerage —
// they sit above every tenant), change a staff member's role, or revoke platform
// access. Every write is audited to superadmin_audit_log.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { validateStaffInput, isPlatformStaffRole, PLATFORM_STAFF_ROLES } from "@/lib/platform/platform-staff-roster"

// Map a platform role → the (user_type, platform_role) columns coherently. platform_role
// carries the platform role for all staff; user_type is the CHECK-valid base type
// ('marketing' isn't a user_type, so marketing staff are user_type 'system').
function roleColumns(role: string): { user_type: string; platform_role: string } {
  switch (role) {
    case "superadmin": return { user_type: "superadmin", platform_role: "superadmin" }
    case "admin":      return { user_type: "admin", platform_role: "admin" }
    case "support":    return { user_type: "support", platform_role: "support" }
    default:           return { user_type: "system", platform_role: "marketing" } // marketing
  }
}

async function requireSuperadmin(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const isSuper = (data as any)?.user_type === "superadmin" || (data as any)?.platform_role === "superadmin"
  if (!isSuper) return { ok: false, error: "Forbidden — superadmin only" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "" }
}

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "platform_staff", target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[platform-staff audit] failed:", err) }
}

export async function listPlatformStaffAction(): Promise<{ ok: true; staff: any[] } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("users")
    .select("id, email, first_name, last_name, user_type, platform_role, status, created_at")
    .or(`user_type.in.(superadmin,support),platform_role.in.(${PLATFORM_STAFF_ROLES.join(",")})`)
    .order("created_at", { ascending: false })
  if (error) return { ok: false, error: error.message }
  return { ok: true, staff: data ?? [] }
}

export async function createPlatformStaffAction(input: { email: string; firstName: string; lastName?: string; role: string }):
  Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const v = validateStaffInput(input)
  if (!v.ok) return { ok: false, error: v.error }

  const svc = createServiceClient()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const cols = roleColumns(v.value.role)

  // Invite the auth user (best-effort — if email/SMTP isn't set the row is still
  // created and the person can be sent a magic link later).
  let userId: string | null = null
  try {
    const { data: inv } = await svc.auth.admin.inviteUserByEmail(v.value.email, {
      data: { first_name: v.value.firstName, last_name: v.value.lastName, ...cols },
      redirectTo: `${appUrl}/auth/callback`,
    })
    userId = (inv as any)?.user?.id ?? null
  } catch (err) {
    console.warn("[createPlatformStaff] invite failed (continuing):", (err as any)?.message)
  }

  // Upsert the users row — platform employee, NO brokerage.
  if (userId) {
    await svc.from("users").upsert({
      id: userId, email: v.value.email, first_name: v.value.firstName, last_name: v.value.lastName,
      ...cols, brokerage_id: null, is_contact: false, status: "active", updated_at: new Date().toISOString(),
    }, { onConflict: "id" })
  } else {
    // No auth user (invite unavailable) — promote an existing account by email.
    const { data: existing } = await svc.from("users").select("id").eq("email", v.value.email).maybeSingle()
    if (existing?.id) {
      userId = existing.id
      await svc.from("users").update({ ...cols, brokerage_id: null, status: "active", updated_at: new Date().toISOString() }).eq("id", userId)
    } else {
      return { ok: false, error: "Could not invite the staff member (email delivery not configured) and no existing account to promote." }
    }
  }

  await audit(auth.userId, auth.email, "platform_staff.created", userId!, { email: v.value.email, role: v.value.role })
  revalidatePath("/dashboard/superadmin/staff")
  return { ok: true, userId: userId! }
}

export async function updatePlatformStaffRoleAction(input: { userId: string; role: string }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!isPlatformStaffRole(input.role)) return { ok: false, error: `Role must be one of: ${PLATFORM_STAFF_ROLES.join(", ")}` }
  // A superadmin cannot demote themselves (avoid locking the platform out of superadmin).
  if (input.userId === auth.userId && input.role !== "superadmin") return { ok: false, error: "You cannot remove your own superadmin role" }

  const svc = createServiceClient()
  const { error } = await svc.from("users").update({ ...roleColumns(input.role), updated_at: new Date().toISOString() }).eq("id", input.userId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "platform_staff.role_changed", input.userId, { role: input.role })
  revalidatePath("/dashboard/superadmin/staff")
  return { ok: true }
}

export async function revokePlatformStaffAction(userId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (userId === auth.userId) return { ok: false, error: "You cannot revoke your own access" }

  const svc = createServiceClient()
  // Revoke ALL platform access: the requireStaff gates accept user_type∈{superadmin,
  // support} OR platform_role='superadmin', so revoke must break every one. Downgrade
  // to a non-staff user_type + clear platform_role + deactivate. Row kept for audit.
  const { error } = await svc.from("users").update({ user_type: "contact", platform_role: null, status: "inactive", updated_at: new Date().toISOString() }).eq("id", userId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "platform_staff.revoked", userId, {})
  revalidatePath("/dashboard/superadmin/staff")
  return { ok: true }
}
