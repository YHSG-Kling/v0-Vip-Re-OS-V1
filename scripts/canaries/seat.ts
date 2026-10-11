/**
 * scripts/canaries/seat.ts — SEAT canary:
 *   add user → role → tenant → permissions → READY
 * through lib/kernel/users.ts inviteTenantMember (the one member path) →
 * assignUserRoleAndEntitlements → resolveUserWorkspaceContext, Auth stubbed.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, setSvc, uuid } from "./_harness"

export async function run() {
  const c = canary("Seat: add user → role → tenant → permissions → READY")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: a seat invite is an outbound email — in-memory only")
  const B = uuid(), B2 = uuid(), ADMIN = uuid(), ADMIN2 = uuid(), TEAM = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-b1` }, { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-b2` }],
    users: [
      { id: ADMIN, email: `admin@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B },
      { id: ADMIN2, email: `admin2@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B2 },
    ],
    teams: [{ id: TEAM, brokerage_id: B, name: `${CANARY_TAG} team`, team_lead_id: ADMIN }],
  })
  setSvc(svc)
  const { inviteTenantMember, assignUserRoleAndEntitlements, resolveUserWorkspaceContext } = await import("../../lib/kernel/users")
  const email = `agent@${CANARY_EMAIL_DOMAIN}`
  const inv = await inviteTenantMember({ brokerageId: B, teamId: TEAM, email, firstName: "Canary", lastName: "Agent", userType: "agent", callerUserId: ADMIN })
  c.step("add user: inviteTenantMember (tenant admin door) succeeds", inv.success && !!inv.userId, inv.error ?? `user ${inv.userId} agent ${inv.agentId}`)
  const U = inv.userId ?? ""
  const u = svc.tables.users?.find((x) => x.id === U)
  c.step("tenant: users row pinned to the inviter's brokerage + team, created_by the admin", !!u && u.brokerage_id === B && u.team_id === TEAM && u.created_by === ADMIN, "")
  c.step("role: user_type agent → an agents row (agents.user_id = users.id, the id classes crossed correctly)", !!inv.agentId && !!svc.tables.agents?.some((a) => a.id === inv.agentId && a.user_id === U && a.brokerage_id === B), "")
  c.step("role: RBAC grant row for (user, agent) on this brokerage", !!svc.tables.user_role_assignments?.some((g) => g.user_id === U && g.brokerage_id === B), "")
  c.step("evidence: the invitation is tracked (user_invitations pending, one per brokerage+email)", (svc.tables.user_invitations ?? []).filter((i) => i.brokerage_id === B && i.email === email).length === 1, "")
  const role = await assignUserRoleAndEntitlements({ userId: U, newRole: "team_lead", brokerageId: B, teamId: TEAM, agentId: inv.agentId, callerUserId: ADMIN })
  c.step("role change: assignUserRoleAndEntitlements agent → team_lead (users.user_type + grant agree)", role.success && svc.tables.users?.find((x) => x.id === U)?.user_type === "team_lead" && !!svc.tables.user_role_assignments?.some((g) => g.user_id === U && g.role === "team_lead"), role.error ?? "")
  const ctx = await resolveUserWorkspaceContext(U)
  c.step("permissions: resolveUserWorkspaceContext resolves the seat to ITS tenant", JSON.stringify(ctx).includes(B), JSON.stringify(ctx).slice(0, 180))
  const again = await inviteTenantMember({ brokerageId: B, teamId: TEAM, email, firstName: "Canary", lastName: "Agent", userType: "agent", callerUserId: ADMIN })
  c.step("idempotency: re-inviting the same member is a no-op (one users row, one pending invitation)", again.success && (svc.tables.users ?? []).filter((x) => x.email === email).length === 1 && (svc.tables.user_invitations ?? []).filter((i) => i.brokerage_id === B && i.email === email).length === 1, again.error ?? "")
  const steal = await inviteTenantMember({ brokerageId: B2, email, userType: "agent", callerUserId: ADMIN2 })
  c.step("POSITIVE CONTROL (tenant boundary): another brokerage's admin inviting this email is REFUSED, the row stays home", !steal.success && svc.tables.users?.find((x) => x.id === U)?.brokerage_id === B, steal.error ?? "captured")
  // READINESS HOOK (integrator): seats check — evaluateTenantReadiness(svc, B).checks.find(k => k.key === "seats")
  c.step("READY (pre-contract proxy): seat → user → tenant → role → agent record → team → grant all PASS", c.allOk(), "replaced by the seats ReadinessCheck at merge")
  c.blind("Auth invite stubbed (no email); entitlement SEAT CAP is seat-cap-simulator's proof, not re-run here.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  const { cleanup: c2, residual: r2 } = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual + r2 === 0, [...cleanup, ...c2].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...cleanup, ...c2], residual + r2)
}
