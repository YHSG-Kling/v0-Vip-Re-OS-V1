// lib/platform/impersonation.ts
//
// STAFF "ACT AS TENANT" — the accountable impersonation core. Platform staff
// (superadmin/support) may enter any tenant and operate the app AS that tenant while
// keeping their own auth identity. An active session record repoints the resolved
// workspace context (getAgentContext) to the target brokerage; every action stays
// stamped with the real staff actor (impersonatorUserId) for a complete audit trail.
//
// Pure isSessionActive is unit-tested; the loader/start/end run on the service client
// (RLS-bypassing) so they can resolve the target's identity that the staff user's own
// RLS scope could never read.

import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaffRole } from "@/lib/platform/platform-staff-roster"

/** Impersonation auto-expires — a forgotten session must not become a standing backdoor. */
export const IMPERSONATION_TTL_MINUTES = 30

export type ImpersonationMode = "read_only" | "full"

export interface ImpersonationSession {
  id: string
  actorUserId: string
  targetBrokerageId: string
  targetUserId: string | null
  mode: ImpersonationMode
  startedAt: string
  expiresAt: string
  endedAt: string | null
}

/** The effective, impersonation-resolved workspace context getAgentContext spreads. */
export interface EffectiveImpersonation {
  sessionId: string
  impersonatorUserId: string     // the REAL staff actor (for audit/attribution)
  mode: ImpersonationMode
  brokerageId: string
  /** userId to act as: the target user if named, else the staff id (tenant-admin view). */
  userId: string
  userType: string
  agentId: string | null
}

/** PURE: is a session currently active (not ended, not past its expiry)? */
export function isSessionActive(
  s: { ended_at: string | null; expires_at: string },
  now: Date = new Date(),
): boolean {
  if (s.ended_at) return false
  const exp = Date.parse(s.expires_at)
  return Number.isFinite(exp) && exp > now.getTime()
}

type Svc = ReturnType<typeof createServiceClient>

/**
 * Resolve the active impersonation for an authenticated user. Returns null unless the
 * user is genuinely platform staff AND holds an active, non-expired session — a defence
 * in depth so a stale/tampered row can never elevate a non-staff user. When the target
 * names a specific user we resolve their role + agents.id; otherwise we present a
 * tenant-ADMIN view of the target brokerage.
 */
export async function resolveActiveImpersonation(
  authUserId: string,
  staffRole: string,
  client?: Svc,
  now: Date = new Date(),
): Promise<EffectiveImpersonation | null> {
  // Full 4-role roster (round-19 parity — admin/marketing hold the impersonate cap too;
  // capability enforcement happens at grant time, this is the defence-in-depth identity check).
  if (!isPlatformStaffRole(staffRole)) return null
  const svc = client ?? createServiceClient()

  const { data: s } = await svc
    .from("platform_impersonation_sessions")
    .select("id, actor_user_id, target_brokerage_id, target_user_id, mode, expires_at, ended_at")
    .eq("actor_user_id", authUserId)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!s || !isSessionActive(s as any, now)) return null

  const targetUserId: string | null = (s as any).target_user_id
  let userId = authUserId
  let userType = "admin"
  let agentId: string | null = null

  if (targetUserId) {
    const [{ data: tu }, { data: ag }] = await Promise.all([
      svc.from("users").select("user_type").eq("id", targetUserId).maybeSingle(),
      svc.from("agents").select("id").eq("user_id", targetUserId).maybeSingle(),
    ])
    userId = targetUserId
    userType = (tu as any)?.user_type ?? "agent"
    agentId = (ag as any)?.id ?? null
  }

  return {
    sessionId: (s as any).id,
    impersonatorUserId: authUserId,
    mode: (s as any).mode as ImpersonationMode,
    brokerageId: (s as any).target_brokerage_id,
    userId,
    userType,
    agentId,
  }
}

/** Load the caller's active session (for banner/state), or null. */
export async function loadActiveImpersonation(authUserId: string, client?: Svc): Promise<ImpersonationSession | null> {
  const svc = client ?? createServiceClient()
  const { data: s } = await svc
    .from("platform_impersonation_sessions")
    .select("id, actor_user_id, target_brokerage_id, target_user_id, mode, started_at, expires_at, ended_at")
    .eq("actor_user_id", authUserId)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!s || !isSessionActive(s as any)) return null
  return {
    id: (s as any).id,
    actorUserId: (s as any).actor_user_id,
    targetBrokerageId: (s as any).target_brokerage_id,
    targetUserId: (s as any).target_user_id,
    mode: (s as any).mode,
    startedAt: (s as any).started_at,
    expiresAt: (s as any).expires_at,
    endedAt: (s as any).ended_at,
  }
}

/** Begin an impersonation session (ends any prior active one first — one active per actor). */
export async function startImpersonation(params: {
  actorUserId: string
  actorEmail: string | null
  targetBrokerageId: string
  targetUserId?: string | null
  mode?: ImpersonationMode
  reason?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  client?: Svc
}): Promise<{ ok: true; sessionId: string; expiresAt: string } | { ok: false; error: string }> {
  const svc = params.client ?? createServiceClient()
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MINUTES * 60_000).toISOString()

  // End any dangling active session so the partial-unique index never blocks re-entry.
  await svc.from("platform_impersonation_sessions")
    .update({ ended_at: new Date().toISOString() })
    .eq("actor_user_id", params.actorUserId).is("ended_at", null)

  const { data, error } = await svc.from("platform_impersonation_sessions").insert({
    actor_user_id:       params.actorUserId,
    actor_email:         params.actorEmail,
    target_brokerage_id: params.targetBrokerageId,
    target_user_id:      params.targetUserId ?? null,
    mode:                params.mode ?? "full",
    reason:              params.reason ?? null,
    ip_address:          params.ipAddress ?? null,
    user_agent:          params.userAgent ?? null,
    expires_at:          expiresAt,
  }).select("id").single()

  if (error || !data) return { ok: false, error: error?.message ?? "Failed to start impersonation" }
  return { ok: true, sessionId: (data as any).id, expiresAt }
}

/** End the caller's active session(s). Idempotent. */
export async function endImpersonation(actorUserId: string, client?: Svc): Promise<{ ok: boolean; endedSessionId: string | null }> {
  const svc = client ?? createServiceClient()
  const { data } = await svc.from("platform_impersonation_sessions")
    .update({ ended_at: new Date().toISOString() })
    .eq("actor_user_id", actorUserId).is("ended_at", null)
    .select("id")
  const ended = (data as any[]) ?? []
  return { ok: true, endedSessionId: ended[0]?.id ?? null }
}
