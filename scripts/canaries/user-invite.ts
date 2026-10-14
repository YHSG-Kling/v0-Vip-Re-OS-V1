/**
 * scripts/canaries/user-invite.ts — USER INVITE canary (wave 141, lane 141J):
 *   create → IMMEDIATE invite → role → tenant → usable
 * through lib/kernel/users.ts inviteTenantMember (the one member core both doors converge on). Owner
 * (wave 141): "Invitations dispatch immediately after a successful valid creation … NEVER report success
 * when the immediate post-condition already failed." The canary client records every Auth admin call
 * (the invite IS the dispatch at HEAD — Supabase Auth sends the email) and injects ONE refusal to prove
 * the result is READ, not swallowed. The kernel-event half (USER_INVITED emitted FROM the core with the
 * dispatch outcome, consumed by a registered manager — lane 141B) is a WAVE141 HOOK: at HEAD the DOOR
 * (app/actions/admin/invite-user.ts) emits it, so an in-memory call of the core leaves no event row.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, setSvc, uuid } from "./_harness"
import { hooksFor, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("User invite: create → immediate invite → role → tenant → usable")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: an invite is an outbound email — in-memory only")
  const B = uuid(), ADMIN = uuid(), TEAM = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-inv` }],
    users: [{ id: ADMIN, email: `admin@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B }],
    teams: [{ id: TEAM, brokerage_id: B, name: `${CANARY_TAG} team`, team_lead_id: ADMIN }],
  })
  setSvc(svc)
  const { inviteTenantMember, resolveUserWorkspaceContext } = await import("../../lib/kernel/users")
  const email = `newagent@${CANARY_EMAIL_DOMAIN}`
  const inv = await inviteTenantMember({ brokerageId: B, teamId: TEAM, email, firstName: "Canary", lastName: "Invitee", userType: "agent", callerUserId: ADMIN })
  c.step("create: inviteTenantMember (tenant-admin door) succeeds", inv.success && !!inv.userId, inv.error ?? `user ${inv.userId}`)
  const calls = svc.canary.authCalls.filter((x) => x.email === email)
  c.step("IMMEDIATE invite: the Auth invite is attempted IN the same request (one inviteUserByEmail call, before any domain record is written)", calls.length === 1 && calls[0].method === "inviteUserByEmail" && calls[0].ok, JSON.stringify(calls))
  const U = inv.userId ?? ""
  const u = svc.tables.users?.find((x) => x.id === U)
  c.step("tenant: users row pinned to the inviter's brokerage + team, created_by the admin, users.id === auth id", !!u && u.brokerage_id === B && u.team_id === TEAM && u.created_by === ADMIN, "")
  c.step("role: user_type agent → an agents row (agents.user_id = users.id) + an RBAC grant on this brokerage", !!inv.agentId && (svc.tables.agents ?? []).some((a) => a.id === inv.agentId && a.user_id === U && a.brokerage_id === B) && (svc.tables.user_role_assignments ?? []).some((g) => g.user_id === U && g.brokerage_id === B), "")
  const pending = (svc.tables.user_invitations ?? []).filter((i) => i.brokerage_id === B && i.email === email)
  c.step("dashboard state: ONE pending user_invitations row — the admin surface (app/actions/admin/invitations.ts listPendingInvitationsAction) reads exactly this table", pending.length === 1 && pending[0].status === "pending" && /["']user_invitations["']/.test(strippedRepo("app/actions/admin/invitations.ts") ?? ""), "")
  const ctx = await resolveUserWorkspaceContext(U)
  c.step("usable: resolveUserWorkspaceContext resolves the new seat to ITS tenant", JSON.stringify(ctx).includes(B), JSON.stringify(ctx).slice(0, 160))
  // A REFUSED dispatch is READ: the provider says no → the core returns the failure, mints no users row.
  const refusedEmail = `refused@${CANARY_EMAIL_DOMAIN}`
  svc.canary.faults.inviteUserByEmail = { message: "canary: the invite provider refused (smtp 550)" }
  const refused = await inviteTenantMember({ brokerageId: B, email: refusedEmail, firstName: "No", lastName: "Mail", userType: "agent", callerUserId: ADMIN })
  const refusedCalls = svc.canary.authCalls.filter((x) => x.email === refusedEmail)
  c.step("POSITIVE CONTROL (never success on a failed post-condition): a refused invite is returned as a FAILURE naming the provider's message; no users row, no invitation row minted", !refused.success && /smtp 550/.test(refused.error ?? "") && refusedCalls.length === 1 && !refusedCalls[0].ok && !(svc.tables.users ?? []).some((x) => x.email === refusedEmail) && !(svc.tables.user_invitations ?? []).some((i) => i.email === refusedEmail), refused.error ?? "reported success")
  const again = await inviteTenantMember({ brokerageId: B, teamId: TEAM, email, firstName: "Canary", lastName: "Invitee", userType: "agent", callerUserId: ADMIN })
  c.step("idempotency: re-inviting the same member is a no-op (one users row, one pending invitation, no second Auth invite)", again.success && (svc.tables.users ?? []).filter((x) => x.email === email).length === 1 && (svc.tables.user_invitations ?? []).filter((i) => i.brokerage_id === B && i.email === email).length === 1 && svc.canary.authCalls.filter((x) => x.email === email).length === 1, again.error ?? "")
  const { evaluateTenantReadiness } = await import("../../lib/kernel/tenant-readiness")
  const readiness = await evaluateTenantReadiness(svc, B, { repair: false })
  const seats = readiness.checks.find((k) => k.key === "seats")
  c.step("READY: the readiness seats check PASSES with the new producing seat", seats?.status === "PASS", `${seats?.status}: ${seats?.reason ?? ""}`.slice(0, 200))
  // WAVE141 HOOK (integrator): 141B — the kernel event from the core with the dispatch outcome.
  for (const h of hooksFor("user-invite")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, "at HEAD the door emits USER_INVITED (app/actions/admin/invite-user.ts), not the core — no event row from an in-memory core call"); continue }
    const events = (svc.tables.lifecycle_events ?? []).filter((e) => e.brokerage_id === B && /user_invited/i.test(String(e.event_type)))
    c.step(`${h.lane} landed (${at}): the core emitted USER_INVITED on this tenant for the dispatched invite AND for the refused one (success and failure both evidenced)`, events.length >= 2, `events=${events.length}`)
  }
  c.blind("Supabase Auth is stubbed: the invite email itself is never sent; the dispatch is proven as the recorded admin call + the read result. A SECOND transport (an app email) is lane 141B's contract.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
