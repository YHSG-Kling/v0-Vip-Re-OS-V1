// lib/auth/platform-guard.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE centralized platform-staff authorization gate. The god-console actions had each
// copy-pasted their own requireSuperadmin/requireStaff with inconsistent rules (some
// read platform_role, some didn't; some admitted 'support', some didn't). These two
// helpers are the single source of truth:
//   • requireSuperadmin   — superadmin only (destructive platform configuration)
//   • requirePlatformStaff — superadmin OR support (read / assist)
// Both read BOTH identity columns (user_type AND platform_role) so the dual-source can
// never drift a decision. Authorization always reflects the REAL signed-in actor — an
// impersonating staff member is still staff here (the impersonation grant governs which
// TENANT they act on, never whether they are staff).

import { createClient } from "@/lib/supabase/server"
import { isPlatformStaffRole } from "@/lib/platform/platform-staff-roster"

export type PlatformGuardResult =
  | { ok: true; userId: string; email: string; role: string }
  | { ok: false; error: string }

async function loadCaller(): Promise<{ userId: string; email: string; userType: string | null; platformRole: string | null } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from("users")
    .select("user_type, platform_role, email")
    .eq("id", user.id)
    .maybeSingle()
  return {
    userId: user.id,
    email: (data as any)?.email ?? user.email ?? "",
    userType: (data as any)?.user_type ?? null,
    platformRole: (data as any)?.platform_role ?? null,
  }
}

/**
 * ANY platform staff role — the FULL 4-role roster (superadmin/admin/
 * marketing/support), matching the capability map the pages gate on.
 *
 * ROUND-19 PARITY FIX: this used to accept only superadmin+support, which
 * bounced platform 'admin' and 'marketing' out of the god console BEFORE any
 * capability check ran — two documented staff roles were unreachable.
 *
 * IDENTITY-CLASS RULE: 'admin' is ALSO a tenant user_type, so the roster is
 * matched ONLY against platform_role. user_type participates solely through
 * the legacy 'superadmin' marker — a tenant admin can never become platform
 * staff here.
 */
export async function requirePlatformStaff(): Promise<PlatformGuardResult> {
  const c = await loadCaller()
  if (!c) return { ok: false, error: "Unauthenticated" }
  const legacySuperadmin = c.userType === "superadmin"
  const rosterRole = isPlatformStaffRole(c.platformRole) ? c.platformRole : null
  if (!legacySuperadmin && !rosterRole) {
    return { ok: false, error: "Forbidden — platform staff only" }
  }
  return { ok: true, userId: c.userId, email: c.email, role: rosterRole ?? "superadmin" }
}

/** superadmin ONLY — destructive platform configuration. */
export async function requireSuperadmin(): Promise<PlatformGuardResult> {
  const c = await loadCaller()
  if (!c) return { ok: false, error: "Unauthenticated" }
  if (c.userType !== "superadmin" && c.platformRole !== "superadmin") {
    return { ok: false, error: "Forbidden — superadmin only" }
  }
  return { ok: true, userId: c.userId, email: c.email, role: "superadmin" }
}
