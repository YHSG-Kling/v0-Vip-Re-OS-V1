// lib/platform/staff-action-gate.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE gate + ONE audit writer for platform-staff server actions that operate on
// a TARGET tenant (white-glove migration, tenant provisioning, and friends).
//
// requirePlatformCapability already consolidates the PAGE gate. Actions need one
// more thing pages do not: the actor's email, because every cross-tenant
// operation is written to superadmin_audit_log with who did it, to whom, and
// what the honest counts were. tenant-import.ts grew its own private `gate()` +
// `audit()` for exactly that, and the CRM pull was about to grow a second copy.
// This is that pair, once, so a staff action cannot be written without an audit
// trail being the path of least resistance.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePlatformRole } from "./require-capability"
import { platformStaffCan, type PlatformCapability } from "./platform-staff-roster"
import { headers } from "next/headers"

export type StaffGate =
  | { ok: true; userId: string; email: string; role: string | null }
  | { ok: false; error: string }

/** Is the caller platform staff holding `capability`? Resolves the actor for audit. */
export async function gateStaffAction(capability: PlatformCapability): Promise<StaffGate> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: profile } = await supabase
    .from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = resolvePlatformRole(profile as any)
  if (!platformStaffCan(role, capability)) {
    return { ok: false, error: `Forbidden — requires platform '${capability}' capability` }
  }
  return { ok: true, userId: user.id, email: (profile as any)?.email ?? user.email ?? "", role }
}

/**
 * Record a staff action against a tenant. Never throws — an audit failure must
 * not swallow the operation's own result, but it is logged loudly.
 */
export async function auditStaffAction(
  gate: Extract<StaffGate, { ok: true }>,
  action: string,
  targetBrokerageId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: gate.userId,
      actor_email: gate.email,
      action,
      target_type: "brokerage",
      target_id: targetBrokerageId,
      details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error(`[staff-action-gate audit] ${action} failed:`, err)
  }
}
