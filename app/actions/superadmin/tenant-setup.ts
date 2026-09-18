"use server"

// app/actions/superadmin/tenant-setup.ts
// ─────────────────────────────────────────────────────────────────────────────
// STAFF-ASSISTED ONBOARDING — the staffer who enrolls a tenant can also SET THEM UP. createSubscriber only
// provisions the shell + emails the tenant to self-serve; this lets a superadmin/support user SEE a tenant's
// role-aware setup-readiness from the god console and work the checklist on their behalf (the staff-
// appropriate items — brand, providers, commission, invite team — already have god-console controls on the
// same tenant page). Reuses loadSetupReadiness, which already accepts an explicit tenant identity.

import { createServiceClient } from "@/lib/supabase/service"
import { loadSetupReadiness, normalizeSetupRole, type SetupReadiness } from "@/lib/onboarding/setup-readiness"
import { requirePlatformCapability } from "@/lib/platform/require-capability"

// ─────────────────────────────────────────────────────────────────────────────
// THIS GATE WAS NOT DEAD — IT WAS TOO WIDE, IN THE OTHER DIRECTION
// ─────────────────────────────────────────────────────────────────────────────
//
// Unlike the sibling god-console actions audited this round, the local gate here
// did admit the live platform superadmin: it also read platform_role. But its
// user_type half was
//
//     ["superadmin", "support"].includes(users.user_type)
//
// and 'support' is a legal TENANT user_type (users_user_type_check admits it),
// not a mark of platform employment. Any tenant user stored as user_type
// 'support' — no platform_role, no platform job — could therefore read ANY
// brokerage's setup readiness cross-tenant, because this action resolves the
// target tenant from a caller-supplied brokerageId. That is the exact
// identity-class confusion platform-staff.ts documents removing from its own
// roster query: 'admin' and 'support' are BOTH tenant user_types, which is why
// the roster is carried on platform_role and only the legacy 'superadmin'
// marker is honoured on user_type. Live census: zero rows currently carry
// user_type='support', so the hole is latent, not open — it is closed here
// before someone creates one.
//
// WHICH CAPABILITY: 'support' — {superadmin, admin, support} by platform_role,
// which is the same INTENT the old list had ("a superadmin/support staffer works
// a tenant's checklist on their behalf", per this file's header) sourced from the
// roster instead of from a column that means two different things. Marketing is
// excluded, which is correct: this exposes a named tenant's onboarding posture.
// The action is READ-ONLY — it computes readiness and writes nothing.
//
// THE NET MOVE, STATED PLAINLY, because one role is gained and one is lost:
//   LOST    any tenant user with user_type='support' and no platform_role —
//           they had cross-tenant read here and should never have had it.
//   GAINED  platform 'admin' (platform_role='admin'), which the capability map
//           grants 'support' by design ("admin = operate the platform"). That is
//           a genuine widening by one PLATFORM-EMPLOYEE role on a read-only
//           action, taken from the roster's own answer rather than invented here.
//           Flagged for the owner: if tenant onboarding assistance is meant to be
//           superadmin/support only, this line becomes requireSuperadmin plus an
//           explicit support check, and the map is what should change.

async function requireStaffSupport(): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("support")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden — platform staff only" }
  return { ok: true }
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
  const auth = await requireStaffSupport()
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
