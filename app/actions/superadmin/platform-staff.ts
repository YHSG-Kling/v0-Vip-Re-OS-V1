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
import {
  validateStaffInput, isPlatformStaffRole, PLATFORM_STAFF_ROLES,
  PLATFORM_CAPABILITIES, OVERRIDABLE_PLATFORM_ROLES, type CapabilityOverride,
} from "@/lib/platform/platform-staff-roster"
import { resolvePlatformRole } from "@/lib/platform/require-capability"

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
    // The user_type half is the LEGACY 'superadmin' MARKER ONLY. It used to read
    // `user_type.in.(superadmin,support)`, which listed every TENANT user carrying
    // user_type='support' — a legal tenant role with no platform employment — as a
    // member of platform staff on the staff-management console, where a superadmin
    // could then change their "platform role". platform_role is the roster column;
    // user_type participates solely through the legacy marker, exactly as
    // isPlatformStaffIdentity() and public.is_platform_staff() define it.
    .or(`user_type.eq.superadmin,platform_role.in.(${PLATFORM_STAFF_ROLES.join(",")})`)
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

// ─── STAFF HR PROFILES (round 20) ────────────────────────────────────────────
// One platform_staff_profiles row per staff member (user_id pk → users):
// title, start date, employment agreement text, the staff member's OWN
// acknowledgment timestamp, and private notes. Service-role only table;
// superadmin writes are audited; acknowledgment is strictly self-row.

export interface StaffProfile {
  user_id: string
  title: string | null
  start_date: string | null
  employment_agreement_text: string | null
  agreement_acknowledged_at: string | null
  notes: string | null
  updated_at: string | null
}

const PROFILE_COLS = "user_id, title, start_date, employment_agreement_text, agreement_acknowledged_at, notes, updated_at"

export async function getStaffProfilesAction(): Promise<{ ok: true; profiles: Record<string, StaffProfile> } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc.from("platform_staff_profiles").select(PROFILE_COLS)
  if (error) return { ok: false, error: error.message }
  const profiles: Record<string, StaffProfile> = {}
  for (const row of (data ?? []) as StaffProfile[]) profiles[row.user_id] = row
  return { ok: true, profiles }
}

export async function upsertStaffProfileAction(input: {
  userId: string
  title?: string
  startDate?: string
  employmentAgreementText?: string
  notes?: string
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (!input.userId?.trim()) return { ok: false, error: "userId is required" }

  const startDate = (input.startDate ?? "").trim()
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return { ok: false, error: "Start date must be YYYY-MM-DD" }
  }

  const svc = createServiceClient()
  // The target must actually be platform staff (profiles are HR records for
  // the people who run the platform, not tenant users).
  const { data: target, error: targetErr } = await svc.from("users").select("id, user_type, platform_role").eq("id", input.userId).maybeSingle()
  if (targetErr) return { ok: false, error: targetErr.message }
  const targetRole = resolvePlatformRole(target as any)
  if (!target || !isPlatformStaffRole(targetRole)) return { ok: false, error: "Target user is not platform staff" }

  const { data: existing, error: exErr } = await svc.from("platform_staff_profiles").select(PROFILE_COLS).eq("user_id", input.userId).maybeSingle()
  if (exErr) return { ok: false, error: exErr.message }
  const before = (existing ?? null) as StaffProfile | null

  const agreement = (input.employmentAgreementText ?? "").trim() || null
  const agreementChanged = agreement !== (before?.employment_agreement_text ?? null)
  const now = new Date().toISOString()
  const payload: Record<string, unknown> = {
    user_id: input.userId,
    title: (input.title ?? "").trim() || null,
    start_date: startDate || null,
    employment_agreement_text: agreement,
    notes: (input.notes ?? "").trim() || null,
    updated_at: now,
    // A CHANGED agreement invalidates any prior acknowledgment — the staff
    // member must acknowledge the text they were actually shown.
    ...(agreementChanged ? { agreement_acknowledged_at: null } : {}),
    ...(before ? {} : { created_by: auth.userId }),
  }
  const { error } = await svc.from("platform_staff_profiles").upsert(payload, { onConflict: "user_id" })
  if (error) return { ok: false, error: error.message }

  // Audit the change WITHOUT dumping agreement/notes bodies into the ledger.
  await audit(auth.userId, auth.email, "staff.profile_updated", input.userId, {
    before: before ? { title: before.title, start_date: before.start_date, agreement_chars: before.employment_agreement_text?.length ?? 0, notes_chars: before.notes?.length ?? 0 } : null,
    after: { title: payload.title, start_date: payload.start_date, agreement_chars: agreement?.length ?? 0, notes_chars: (payload.notes as string | null)?.length ?? 0 },
    agreement_changed: agreementChanged,
    ...(agreementChanged && before?.agreement_acknowledged_at ? { acknowledgment_reset: true } : {}),
  })
  revalidatePath("/dashboard/superadmin/staff")
  revalidatePath("/dashboard/superadmin/home")
  return { ok: true }
}

/** SELF-ROW ONLY: any platform staff member acknowledges THEIR OWN employment
 *  agreement. The targeted row is always the caller's (auth uid) — there is no
 *  userId parameter by design. Idempotent; audited. */
export async function acknowledgeMyAgreementAction(): Promise<{ ok: boolean; acknowledgedAt?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: me } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = resolvePlatformRole(me as any)
  if (!isPlatformStaffRole(role)) return { ok: false, error: "Forbidden — platform staff only" }

  const svc = createServiceClient()
  const { data: row, error: rowErr } = await svc.from("platform_staff_profiles").select("employment_agreement_text, agreement_acknowledged_at").eq("user_id", user.id).maybeSingle()
  if (rowErr) return { ok: false, error: rowErr.message }
  if (!row?.employment_agreement_text) return { ok: false, error: "No employment agreement on file to acknowledge" }
  if (row.agreement_acknowledged_at) return { ok: true, acknowledgedAt: row.agreement_acknowledged_at }

  const now = new Date().toISOString()
  const { error } = await svc.from("platform_staff_profiles")
    .update({ agreement_acknowledged_at: now, updated_at: now })
    .eq("user_id", user.id)
    .is("agreement_acknowledged_at", null)
  if (error) return { ok: false, error: error.message }

  await audit(user.id, (me as any)?.email ?? user.email ?? "", "staff.agreement_acknowledged", user.id, {
    agreement_chars: row.employment_agreement_text.length,
  })
  revalidatePath("/dashboard/superadmin/home")
  revalidatePath("/dashboard/superadmin/staff")
  return { ok: true, acknowledgedAt: now }
}

// ─── CAPABILITY MATRIX OVERRIDES (round 20) ──────────────────────────────────
// platform_role_capability_overrides: the code map (CAPS) is the DEFAULT; a row
// grants/revokes/downgrades one role×capability. Clearing back to default
// DELETES the row. superadmin is NEVER overridable (hard rule + table CHECK).
// Merge semantics live in lib/platform/capability-overrides.ts (mergeCapability).

export async function listCapabilityOverridesAction(): Promise<{ ok: true; overrides: CapabilityOverride[] } | { ok: false; error: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc.from("platform_role_capability_overrides").select("role, capability, allowed, access")
  if (error) return { ok: false, error: error.message }
  return { ok: true, overrides: (data ?? []) as CapabilityOverride[] }
}

export async function setCapabilityOverrideAction(input: {
  role: string
  capability: string
  /** null = clear back to the code-map default (DELETES the row). */
  override: { allowed: boolean; access: "read" | "write" } | null
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (input.role === "superadmin") return { ok: false, error: "superadmin is never overridable" }
  if (!(OVERRIDABLE_PLATFORM_ROLES as readonly string[]).includes(input.role)) {
    return { ok: false, error: `Role must be one of: ${OVERRIDABLE_PLATFORM_ROLES.join(", ")}` }
  }
  if (!(PLATFORM_CAPABILITIES as readonly string[]).includes(input.capability)) {
    return { ok: false, error: `Unknown capability '${input.capability}'` }
  }

  const svc = createServiceClient()
  const { data: existing, error: exErr } = await svc.from("platform_role_capability_overrides")
    .select("id, allowed, access").eq("role", input.role).eq("capability", input.capability).maybeSingle()
  if (exErr) return { ok: false, error: exErr.message }
  const before = existing ? { allowed: (existing as any).allowed, access: (existing as any).access } : null

  let rowId: string | null = (existing as any)?.id ?? null
  if (input.override === null) {
    if (!existing) return { ok: true } // already at default — nothing to clear
    const { error } = await svc.from("platform_role_capability_overrides").delete().eq("id", (existing as any).id)
    if (error) return { ok: false, error: error.message }
  } else {
    const after = {
      allowed: input.override.allowed,
      // access only means something on a grant; a revoke row stores the default 'write'.
      access: input.override.allowed && input.override.access === "read" ? "read" : "write",
    }
    const { data: upserted, error } = await svc.from("platform_role_capability_overrides")
      .upsert({ role: input.role, capability: input.capability, ...after, updated_by: auth.userId, updated_at: new Date().toISOString() }, { onConflict: "role,capability" })
      .select("id").maybeSingle()
    if (error) return { ok: false, error: error.message }
    rowId = (upserted as any)?.id ?? rowId
  }

  await audit(auth.userId, auth.email, "staff.capability_override", rowId ?? auth.userId, {
    role: input.role,
    capability: input.capability,
    before,
    after: input.override === null ? null : { allowed: input.override.allowed, access: input.override.allowed && input.override.access === "read" ? "read" : "write" },
  })
  revalidatePath("/dashboard/superadmin/staff")
  return { ok: true }
}
