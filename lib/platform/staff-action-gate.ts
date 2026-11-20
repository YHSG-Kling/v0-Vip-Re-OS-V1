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
  | {
      ok: true
      userId: string
      email: string
      /** The EFFECTIVE staff role (resolvePlatformRole: platform_role wins; the legacy
       *  user_type='superadmin' marker still resolves). */
      role: string | null
      /** The RAW users.platform_role column (wave 141, lane 141D). `role` above can be non-null
       *  while this is null — exactly when the caller was admitted by the legacy
       *  user_type='superadmin' marker (0 live rows; platform staff live in platform_role,
       *  CLAUDE.md §4). An operation the owner ruled "platform_role, never superadmin user_type"
       *  (inbound CRM import) refuses on this being null without re-reading the users row. */
      platformRole: string | null
    }
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
  return {
    ok: true, userId: user.id, email: (profile as any)?.email ?? user.email ?? "", role,
    platformRole: ((profile as { platform_role?: string | null } | null)?.platform_role ?? null) || null,
  }
}

/**
 * THE PLATFORM'S EVIDENCE DOOR FOR AN ACT WITH NO TENANT (wave 155, lane 155R23 — LAW 5). agent_action_ledger.brokerage_id is
 * NOT NULL, so a platform act that belongs to no brokerage (a platform topic, a platform screenshot, a platform-wide safety
 * finding, a pre-account terms acceptance, a hand-raise on the platform's own funnel, a dev seed) cannot hold a ledger row —
 * and a tenant is NEVER invented to make one fit. Its record is ONE superadmin_audit_log row: who (a staff user id, or null with
 * `actor_email` naming the public / system door), what (`action`), on what (`target_type` + `target_id`, a uuid or null — the
 * column is uuid: a non-uuid id goes into details.target_ref, never into target_id, where it would be refused), the facts.
 * THE INSERT IS READ (CLAUDE.md §3: supabase-js RESOLVES a refusal): a refused row comes back `{ ok: false }` and is logged —
 * never swallowed. Never throws. The act it records has already happened; the caller decides what a refused record means.
 * @proofSeam scripts/ledger-receipts-round5-guard.ts
 */
export async function recordPlatformEvidence(
  entry: { actorUserId: string | null; actorEmail: string | null; action: string; targetType: string; targetId: string | null; details: Record<string, unknown> },
  opts?: { client?: { from: (table: string) => any } },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const targetIsUuid = !!entry.targetId && UUID.test(entry.targetId)
  try {
    const svc = opts?.client ?? createServiceClient()
    let ip: string | null = null, ua: string | null = null
    try { const h = await headers(); ip = h.get("x-forwarded-for") ?? h.get("x-real-ip"); ua = h.get("user-agent") } catch { /* no request scope (a script / a test) */ }
    const { error } = await svc.from("superadmin_audit_log").insert({
      actor_user_id: entry.actorUserId && UUID.test(entry.actorUserId) ? entry.actorUserId : null,
      actor_email: entry.actorEmail ?? null,
      action: entry.action,
      target_type: entry.targetType,
      target_id: targetIsUuid ? entry.targetId : null,
      details: targetIsUuid || !entry.targetId ? entry.details : { ...entry.details, target_ref: entry.targetId },
      ip_address: ip, user_agent: ua,
    })
    if (error) { console.error(`[platform evidence] ${entry.action} REFUSED:`, error.message); return { ok: false, error: error.message } }
    return { ok: true }
  } catch (err) {
    console.error(`[platform evidence] ${entry.action} failed:`, err)
    return { ok: false, error: (err as Error)?.message ?? "platform evidence insert threw" }
  }
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
