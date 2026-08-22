"use server"

// app/actions/superadmin/tenant-users.ts
// ─────────────────────────────────────────────────────────────────────────────
// Cross-tenant USER management for the god console. The superadmin brokerage-detail roster was view-only and
// the existing per-user actions were brokerage-scoped (a superadmin whose own brokerage_id differed couldn't
// act on another tenant's users/invites). These actions let a superadmin manage ANY tenant's users +
// invitations in-context: list with status + last-login, activate/suspend a user, and resend/revoke an
// invitation across tenants. Every mutation is superadmin-gated and audited (IP/UA).

import { createServiceClient } from "@/lib/supabase/service"
import { inviteTenantMember, type UserDomainRole } from "@/lib/kernel/users"
// `roleConsumesSeat` and `SEAT_ROLES` were imported here to count seats inline.
// This file now calls the shared `seatGate`, which does that counting itself, so
// both became DEAD IMPORTS — a reader with no writer, in the census's category 2.
// Dropped rather than kept "in case": an import that nothing uses is a standing
// invitation to re-derive the seat rule locally, which is exactly the third
// spelling that let the admin meter disagree with the invite gate. Neither
// export is orphaned by this — `roleConsumesSeat` has 8 other references and
// `SEAT_ROLES` has 37, both still in lib/kernel/tier-role-matrix.ts.
import { tierAllowsRole, roleRefusalReason, seatableUserTypes } from "@/lib/kernel/tier-role-matrix"
import { CHECK_VOCABULARIES } from "@/scripts/check-vocabularies"
import { requireSuperadmin } from "@/lib/auth/platform-guard"
import { seatGate } from "@/lib/kernel/seat-usage"
import { requirePlatformCapability, resolvePlatformRole } from "@/lib/platform/require-capability"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "user", target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[tenant-users audit] failed:", err) }
}

export interface TenantUserRow {
  id: string; email: string | null; name: string; role: string; status: string | null
  /** auth.users.last_sign_in_at (the engagement radar's source, via the auth
   *  admin API) — null when Auth has no record, rendered as an honest "—". */
  lastLoginAt: string | null
}
export interface TenantInviteRow { id: string; email: string; role: string; status: string; expiresAt: string | null; createdAt: string }
export interface TenantTeamRow { id: string; name: string; leadName: string | null; memberCount: number }

/** auth.users.last_sign_in_at for a set of user ids — SAME source as the
 *  engagement radar (svc.auth.admin.listUsers, paged); early-exits once every
 *  requested id is resolved. Best-effort: failure → empty map (honest "—"). */
async function lastSignInsFor(svc: ReturnType<typeof createServiceClient>, ids: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.size === 0) return out
  try {
    let remaining = ids.size
    for (let page = 1; page <= 20 && remaining > 0; page++) {
      const { data: authPage, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 })
      if (error) break
      for (const u of authPage.users) {
        if (ids.has(u.id)) {
          remaining -= 1
          if (u.last_sign_in_at) out.set(u.id, u.last_sign_in_at)
        }
      }
      if (authPage.users.length < 1000) break
    }
  } catch { /* best-effort — the roster renders "—" for unknowns */ }
  return out
}

/**
 * The tenant's user roster, for the god console.
 *
 * READ-ONLY, gated on the platform 'tenants' capability rather than on
 * superadmin. Owner ruling: "platform needs to see all tenants and THEIR USERS"
 * — that names the platform staff roster (superadmin/admin/marketing/support),
 * not the superadmin alone. This panel is rendered by
 * /dashboard/superadmin/brokerages/[id], whose own gate is
 * requirePlatformCapability("tenants"); a support operator could therefore open
 * the page and be handed "Forbidden" by the panel inside it, which is one gate
 * disagreeing with another about the same question.
 *
 * It grants no data the roster could not already reach: searchUsersByEmailAction
 * below returns the same identity fields for the same capability, cross-tenant,
 * and has done since it was written. Every MUTATION in this file
 * (create/suspend/resend/revoke) remains superadmin-only.
 */
export async function listTenantUsersAction(brokerageId: string): Promise<
  | { ok: true; users: TenantUserRow[]; invites: TenantInviteRow[]; teams: TenantTeamRow[]; planTier: string | null }
  | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const svc = createServiceClient()
  const [{ data: users }, { data: invites }, { data: teams }, { data: brk }] = await Promise.all([
    svc.from("users").select("id, email, first_name, last_name, user_type, status, team_id").eq("brokerage_id", brokerageId).is("deleted_at", null).limit(500),
    svc.from("user_invitations").select("id, email, user_type, status, expires_at, created_at").eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(200),
    svc.from("teams").select("id, name, team_lead_id").eq("brokerage_id", brokerageId).is("deleted_at", null).order("name").limit(100),
    svc.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle(),
  ])

  const userRows = (users ?? []) as any[]
  const lastSignIn = await lastSignInsFor(svc, new Set(userRows.map((u) => u.id as string)))

  // Team structure: member counts from the roster's team_id; lead name resolved
  // from the same roster (team_lead_id is a users.id).
  const nameById = new Map<string, string>()
  for (const u of userRows) nameById.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || (u.email ?? "—"))
  const membersByTeam = new Map<string, number>()
  for (const u of userRows) {
    if (u.team_id) membersByTeam.set(u.team_id, (membersByTeam.get(u.team_id) ?? 0) + 1)
  }
  const teamRows: TenantTeamRow[] = ((teams ?? []) as any[]).map((t) => ({
    id: t.id,
    name: t.name ?? "(unnamed team)",
    leadName: t.team_lead_id ? (nameById.get(t.team_lead_id) ?? null) : null,
    memberCount: membersByTeam.get(t.id) ?? 0,
  }))

  return {
    ok: true,
    users: userRows.map((u) => ({
      id: u.id, email: u.email,
      name: [u.first_name, u.last_name].filter(Boolean).join(" ") || "—",
      role: u.user_type, status: u.status,
      lastLoginAt: lastSignIn.get(u.id) ?? null,
    })),
    invites: ((invites ?? []) as any[]).map((i) => ({ id: i.id, email: i.email, role: i.user_type, status: i.status, expiresAt: i.expires_at, createdAt: i.created_at })),
    teams: teamRows,
    planTier: ((brk as any)?.plan_tier as string | null) ?? null,
  }
}

// ── CROSS-TENANT USER SEARCH ─────────────────────────────────────────────────

export interface CrossTenantUserHit {
  id: string; email: string | null; name: string; role: string; status: string | null
  brokerageId: string | null; brokerageName: string | null
}

/** Find users by email ACROSS every tenant — "which brokerage is this person
 *  in?" without opening tenants one by one. Read-only; gated on the platform
 *  'tenants' capability (every staff role oversees subscribers). */
export async function searchUsersByEmailAction(query: string): Promise<
  | { ok: true; hits: CrossTenantUserHit[] }
  | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const q = (query ?? "").trim().toLowerCase()
  if (q.length < 3) return { ok: false, error: "Enter at least 3 characters of the email" }

  const svc = createServiceClient()
  const pattern = `%${q.replace(/[%_]/g, "\\$&")}%`
  const { data, error } = await svc
    .from("users")
    .select("id, email, first_name, last_name, user_type, status, brokerage_id")
    .ilike("email", pattern)
    .is("deleted_at", null)
    .limit(20)
  if (error) return { ok: false, error: error.message }

  const rows = (data ?? []) as any[]
  const brokerageIds = [...new Set(rows.map((u) => u.brokerage_id).filter(Boolean))] as string[]
  const brokerageNameById = new Map<string, string>()
  if (brokerageIds.length > 0) {
    const { data: brks } = await svc.from("brokerages").select("id, name").in("id", brokerageIds)
    for (const b of (brks ?? []) as any[]) brokerageNameById.set(b.id, b.name ?? "(unnamed)")
  }

  return {
    ok: true,
    hits: rows.map((u) => ({
      id: u.id, email: u.email,
      name: [u.first_name, u.last_name].filter(Boolean).join(" ") || "—",
      role: u.user_type, status: u.status,
      brokerageId: u.brokerage_id ?? null,
      brokerageName: u.brokerage_id ? (brokerageNameById.get(u.brokerage_id) ?? null) : null,
    })),
  }
}

// Roles a superadmin can create INTO a tenant from the god console. (superadmin is
// deliberately excluded — platform staff are provisioned through their own path.)
const TENANT_CREATABLE_ROLES = new Set<string>([
  "admin", "broker", "agent", "team_lead", "tc", "isa", "compliance_officer", "lender", "vendor",
])

/**
 * Create (invite) a user INTO any tenant — superadmin-down manual provisioning. Uses the
 * canonical inviteTenantMember path, so the new user is auth-linked (users.id === auth.id)
 * and gets their role-specific domain records (agents/onboarding/role) exactly like a
 * tenant-initiated invite. A team_lead can be dropped onto an existing team via teamId.
 *
 * TIER MATRIX: the TARGET tenant's plan_tier bounds which roles may be seated
 * (lib/kernel/tier-role-matrix.ts) — the god console honors tenant tiers by
 * default, exactly like the tenant-side invite surface. `superadminOverride`
 * is the ONLY sanctioned bypass in the whole app (platform staff may place any
 * role anywhere); every use is written to the superadmin audit ledger.
 */
export async function createTenantUserAction(params: {
  brokerageId: string
  email: string
  firstName?: string
  lastName?: string
  userType: string
  teamId?: string | null
  /** Platform-staff escape hatch: seat a role OUTSIDE the target tenant's tier
   *  matrix. Default false. When it actually bypasses a matrix rejection, the
   *  override is logged to superadmin_audit_log ("user.tier_matrix_override"). */
  superadminOverride?: boolean
}): Promise<{ ok: boolean; userId?: string; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const email = params.email?.trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Valid email required" }
  if (!params.brokerageId) return { ok: false, error: "Target brokerage required" }
  if (!TENANT_CREATABLE_ROLES.has(params.userType)) return { ok: false, error: `Role not allowed: ${params.userType}` }

  const svc = createServiceClient()
  const { data: brk, error: brkErr } = await svc.from("brokerages").select("id, plan_tier, billing_metadata").eq("id", params.brokerageId).maybeSingle()
  if (brkErr) return { ok: false, error: brkErr.message }
  if (!brk) return { ok: false, error: "Brokerage not found" }

  // Tier-aware role matrix by the TARGET tenant's tier.
  const targetTier: string | null = (brk as { plan_tier?: string | null }).plan_tier ?? null
  const roleOutsideTier = !tierAllowsRole(targetTier, params.userType as UserDomainRole)
  if (roleOutsideTier && !params.superadminOverride) {
    // Not a PLAN refusal any more (owner's ruling: the tier sells seats, not a
    // role menu). These are the values that are not workspace seats on any tier.
    return {
      ok: false,
      error: `${roleRefusalReason(params.userType) ?? `'${params.userType}' cannot be seated.`} Pass superadminOverride to force it.`,
    }
  }

  // The CHECK constraint is the last word (CLAUDE.md §3). This one is NOT
  // overridable — superadminOverride waives PRODUCT rules, and no override makes
  // Postgres accept a value users_user_type_check forbids; forcing it would just
  // trade a clear refusal for a constraint violation mid-provision.
  if (!seatableUserTypes(targetTier, CHECK_VOCABULARIES.users?.user_type).includes(params.userType as UserDomainRole)) {
    return {
      ok: false,
      error: `'${params.userType}' is not a user type this database can store yet (users_user_type_check). No user was created.`,
    }
  }

  // SEATS (owner model: Solo 2 · Team 5 · Brokerage/Multi unlimited — a seat is
  // a working staff user; partners never consume one). The same override that
  // bypasses the role matrix bypasses the seat cap, with the same audit trail.
  // ONE GATE with the tenant-side invite, the role-change path, the reactivation
  // path and the recruiting provisioner (lib/kernel/seat-usage.ts `seatGate`):
  // one seat resolver (both role sources), the limit from the PLAN CATALOGUE
  // (subscription_tiers.max_agents) with the staff override on top, and FAIL
  // CLOSED on an unreadable tenant / count / catalogue.
  let seatOverLimit = false
  {
    const verdict = await seatGate(svc, params.brokerageId, params.userType)
    seatOverLimit = !verdict.allowed
    if (seatOverLimit && !params.superadminOverride) {
      // The tenant-facing sentence names the UPGRADE (owner's ruling: solo → team,
      // team → brokerage). Platform staff get that sentence PLUS the two levers
      // only they hold, so a refusal is never a dead end on this console either.
      return {
        ok: false,
        error: `${verdict.message ?? "Seat check refused this add."} Staff: raise this tenant's seat override, or pass superadminOverride.`,
      }
    }
  }

  const res = await inviteTenantMember({
    brokerageId:  params.brokerageId,
    teamId:       params.teamId ?? null,
    email,
    firstName:    params.firstName ?? "",
    lastName:     params.lastName ?? "",
    userType:     params.userType as UserDomainRole,
    callerUserId: auth.userId,
    redirectTo:   `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/dashboard/onboarding`,
  })
  if (!res.success || !res.userId) return { ok: false, error: res.error ?? "Failed to create user" }

  // The override actually bypassed the matrix or the seat cap → ledger entry
  // (accountability for the one sanctioned bypass).
  if ((roleOutsideTier || seatOverLimit) && params.superadminOverride) {
    await audit(auth.userId, auth.email, "user.tier_matrix_override", res.userId, {
      brokerage_id: params.brokerageId, role: params.userType, tenant_tier: targetTier, email,
      bypassed: { role_matrix: roleOutsideTier, seat_cap: seatOverLimit },
    })
  }
  await audit(auth.userId, auth.email, "user.created", res.userId, { brokerage_id: params.brokerageId, role: params.userType, email })
  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  return { ok: true, userId: res.userId }
}

/** Activate / suspend any tenant's user (cross-tenant). */
export async function setTenantUserStatusAction(params: { userId: string; status: "active" | "suspended" }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (params.status !== "active" && params.status !== "suspended") return { ok: false, error: "Invalid status" }
  const svc = createServiceClient()
  const { data: target } = await svc.from("users").select("brokerage_id, user_type, platform_role").eq("id", params.userId).maybeSingle()
  if (!target) return { ok: false, error: "User not found" }
  // SELF-PROTECTION THAT NEVER FIRED. This read only target.user_type ===
  // 'superadmin' — a value no live row carries, because the platform superadmin
  // is platform_role='superadmin' with user_type='admin'. So the one account the
  // check exists to protect was the one account it could not recognise, and
  // suspending it — locking the platform out of its own console — was permitted.
  // resolvePlatformRole is the canonical reader of that dual-source identity.
  if (resolvePlatformRole(target as any) === "superadmin") {
    return { ok: false, error: "Refusing to change a superadmin's status" }
  }

  // REACTIVATION IS A SEAT ADD. resolveSeatUsage excludes suspended users, so
  // suspending frees a seat and un-suspending takes one back — a tenant at their
  // cap with three suspended agents could walk straight past it here, on the one
  // add path nobody thought of as an add. Same gate as every other path; the
  // staff lever named in the refusal is the seat override, since this action
  // carries no superadminOverride flag.
  if (params.status === "active" && (target as any).brokerage_id) {
    const verdict = await seatGate(svc, (target as any).brokerage_id as string, (target as any).user_type ?? "")
    if (!verdict.allowed) {
      return { ok: false, error: `${verdict.message ?? "Seat check refused this reactivation."} Staff: raise this tenant's seat override to reactivate without an upgrade.` }
    }
  }

  const { error } = await svc.from("users").update({ status: params.status, updated_at: new Date().toISOString() }).eq("id", params.userId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, params.status === "suspended" ? "user.suspended" : "user.reactivated", params.userId, { brokerage_id: (target as any).brokerage_id, status: params.status })
  if ((target as any).brokerage_id) revalidatePath(`/dashboard/superadmin/brokerages/${(target as any).brokerage_id}`)
  return { ok: true }
}

/** Resend a pending/expired invitation (cross-tenant) — re-arms the 7-day window. */
export async function resendTenantInviteAction(invitationId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: inv } = await svc.from("user_invitations").select("brokerage_id, status").eq("id", invitationId).maybeSingle()
  if (!inv) return { ok: false, error: "Invitation not found" }
  if ((inv as any).status === "accepted") return { ok: false, error: "Already accepted" }
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString()
  const { error } = await svc.from("user_invitations").update({ status: "pending", expires_at: expires, updated_at: new Date().toISOString() }).eq("id", invitationId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "invitation.resent", invitationId, { brokerage_id: (inv as any).brokerage_id, expires_at: expires })
  if ((inv as any).brokerage_id) revalidatePath(`/dashboard/superadmin/brokerages/${(inv as any).brokerage_id}`)
  return { ok: true }
}

/** Revoke a pending invitation (cross-tenant). */
export async function revokeTenantInviteAction(invitationId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: inv } = await svc.from("user_invitations").select("brokerage_id, status").eq("id", invitationId).maybeSingle()
  if (!inv) return { ok: false, error: "Invitation not found" }
  if ((inv as any).status === "accepted") return { ok: false, error: "Cannot revoke an accepted invitation" }
  const { error } = await svc.from("user_invitations").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("id", invitationId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "invitation.revoked", invitationId, { brokerage_id: (inv as any).brokerage_id })
  if ((inv as any).brokerage_id) revalidatePath(`/dashboard/superadmin/brokerages/${(inv as any).brokerage_id}`)
  return { ok: true }
}
