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
  // Wave 141B: a refused dispatch leaves ONE user_invitations row in status 'failed' (m779) so the admin SEES it and can
  // resend — never a pending row that pretends the email left, and never a users row.
  const failedRow = (svc.tables.user_invitations ?? []).filter((i) => i.brokerage_id === B && i.email === refusedEmail)
  c.step("POSITIVE CONTROL (never success on a failed post-condition): a refused invite is returned as a FAILURE naming the provider's message; no users row is minted; the admin can SEE it — ONE user_invitations row in status 'failed' (resendable), never a pending one", !refused.success && /smtp 550/.test(refused.error ?? "") && refusedCalls.length === 1 && !refusedCalls[0].ok && !(svc.tables.users ?? []).some((x) => x.email === refusedEmail) && failedRow.length === 1 && failedRow[0].status === "failed", refused.error ?? "reported success")
  const again = await inviteTenantMember({ brokerageId: B, teamId: TEAM, email, firstName: "Canary", lastName: "Invitee", userType: "agent", callerUserId: ADMIN })
  c.step("idempotency: re-inviting the same member is a no-op (one users row, one pending invitation, no second Auth invite)", again.success && (svc.tables.users ?? []).filter((x) => x.email === email).length === 1 && (svc.tables.user_invitations ?? []).filter((i) => i.brokerage_id === B && i.email === email).length === 1 && svc.canary.authCalls.filter((x) => x.email === email).length === 1, again.error ?? "")
  const { evaluateTenantReadiness } = await import("../../lib/kernel/tenant-readiness")
  const readiness = await evaluateTenantReadiness(svc, B, { repair: false })
  const seats = readiness.checks.find((k) => k.key === "seats")
  c.step("READY: the readiness seats check PASSES with the new producing seat", seats?.status === "PASS", `${seats?.status}: ${seats?.reason ?? ""}`.slice(0, 200))
  // WAVE141 HOOK (integrator): 141B — wired 141K. The core reports every door's post-condition through
  // lib/kernel/immediate-operations.ts reportOperationOutcome: an evidence row for success AND failure, and on failure
  // ONE routed signal the registered owning manager consumes (handleOperationFailureEscalated on the manager-signals tick).
  for (const h of hooksFor("user-invite")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, "at HEAD the door emits USER_INVITED (app/actions/admin/invite-user.ts), not the core — no event row from an in-memory core call"); continue }
    type OpMeta = { operation?: string; error?: string | null; subject_id?: string | null }
    const ops = (svc.tables.lifecycle_events ?? []).filter((e) => e.brokerage_id === B && /^operation\.(succeeded|failed)$/.test(String(e.event_type)))
    const opOf = (e: { metadata?: unknown }) => (e.metadata as OpMeta | undefined)?.operation
    const okOps = ops.filter((e) => e.event_type === "operation.succeeded").map(opOf)
    c.step(`${h.lane} landed (${at}): the dispatched invite left SUCCESS evidence from the core — operation.succeeded rows for invitation, user_creation (the users row RE-READ on this tenant) and seat_provisioning`, ["invitation", "user_creation", "seat_provisioning"].every((o) => okOps.includes(o)), okOps.join(","))
    const failed = ops.filter((e) => e.event_type === "operation.failed")
    const failedMeta = (failed[0]?.metadata ?? {}) as OpMeta
    c.step("141B failure evidence: the refused dispatch left ONE operation.failed row (operation invitation) carrying the provider's raw error and the failed invitation row as its subject — the raw error lives here, not on the tenant feed", failed.length === 1 && opOf(failed[0]) === "invitation" && /smtp 550/.test(String(failedMeta.error)) && failedMeta.subject_id === failedRow[0]?.id, `${failed.length} failed row(s)`)
    const signals = (svc.tables.manager_signals ?? []).filter((s) => s.brokerage_id === B && s.signal_type === "operation_failure_escalated")
    const sig = signals[0]
    const sigPayload = (sig?.payload ?? {}) as { lifecycle_event_id?: string | null }
    c.step("141B routed in-request: ONE operation_failure_escalated signal from the reporter (cron_manager) to the REGISTERED owner (data_steward) for the failed invitation; its tenant-facing message names the resend door and never the provider's raw error; the payload links the evidence row", signals.length === 1 && sig.from_manager === "cron_manager" && sig.to_manager === "data_steward" && sig.entity_id === failedRow[0]?.id && /resend/i.test(String(sig.message)) && !/smtp/i.test(String(sig.message)) && sigPayload.lifecycle_event_id === failed[0]?.id, String(sig?.message).slice(0, 160))
    // The live column DEFAULT (manager_signals.status = 'open') is not modelled by the in-memory client — stamped here as
    // the fixture it is (published blind spot) so the tick can find the row the bus would find live.
    for (const s of signals) if (s.status === undefined) s.status = "open"
    const { consumeManagerSignals, SIGNAL_HANDLERS } = await import("../../lib/kernel/manager-signals")
    const { IMMEDIATE_OPERATION_CONSUMERS, OPERATION_SIGNAL_TYPE } = await import("../../lib/kernel/immediate-operations")
    c.step("141B the consumer is REGISTERED: every declared owner (recruiting_manager included) has a `<owner>:operation_failure_escalated` inbox in SIGNAL_HANDLERS, derived from one map — never hand-listed, never an invented manager", IMMEDIATE_OPERATION_CONSUMERS.every((m) => typeof SIGNAL_HANDLERS[`${m}:${OPERATION_SIGNAL_TYPE}`] === "function") && IMMEDIATE_OPERATION_CONSUMERS.includes("data_steward") && IMMEDIATE_OPERATION_CONSUMERS.includes("recruiting_manager"), IMMEDIATE_OPERATION_CONSUMERS.join(","))
    const tick = await consumeManagerSignals({ brokerageId: B, toManager: "data_steward" }, svc)
    const consumedSig = (svc.tables.manager_signals ?? []).find((s) => s.id === sig?.id)
    const bell = (svc.tables.notifications ?? []).filter((n) => n.brokerage_id === B && n.type === "operation_failure_escalation")
    c.step("141B consumed on the tick: the owner's handler took the signal — no readiness check covers an email that never left, so it was handed to a HUMAN on this tenant (a bell with the tenant sentence, never the raw error) and the signal was marked consumed with the action recorded", tick.consumed >= 1 && consumedSig?.status === "consumed" && /escalated to a human/.test(String(consumedSig?.consumed_action)) && bell.length >= 1 && bell.every((n) => n.brokerage_id === B && !/smtp/i.test(String(n.body))), JSON.stringify({ consumed: tick.consumed, status: consumedSig?.status, bells: bell.map((n) => (n.user_id === ADMIN ? "ADMIN" : "other-user")), action: String(consumedSig?.consumed_action).slice(0, 120) }))
    // OUTSIDE-LANE FINDING (lane 141K, reported in the notes, not fixed here): lib/kernel/org-recipients.ts:15 ORG_STAFF_ROLES
    // retypes a role list ("broker", "broker_admin", "admin", "compliance_officer") instead of spreading
    // TENANT_ADMIN_USER_TYPES (CLAUDE.md §4) — a brokerage whose only admin seat is the broker_owner has NO org recipient,
    // and the fallback rings an ACTIVE AGENT (here: the invitee of the successful invite), who has no Users › Invitations
    // door to act on. The human told must be one who can act: a tenant admin.
    const { TENANT_ADMIN_USER_TYPES } = await import("../../lib/auth/resolve-user-role")
    const bellTypes = bell.map((n) => String((svc.tables.users ?? []).find((u) => u.id === n.user_id)?.user_type ?? "?"))
    c.step("141B the human told can ACT: the escalation bell reaches a tenant ADMIN seat (TENANT_ADMIN_USER_TYPES — here the broker_owner), not an agent with no invitations door", bell.some((n) => n.user_id === ADMIN) && bellTypes.every((t) => TENANT_ADMIN_USER_TYPES.has(t)), `bells rang for user_type(s): ${bellTypes.join(",")} — lib/kernel/org-recipients.ts:15 ORG_STAFF_ROLES omits broker_owner (and team_lead); the fallback picked an active agent`)
  }
  c.blind("Supabase Auth is stubbed: the invite email itself is never sent; the dispatch is proven as the recorded admin call + the read result. The in-memory client has no column DEFAULTs: manager_signals.status='open' is stamped by the canary before the tick (the live default). The tick itself is app/api/cron/manager-signals (every 30 min) — driven here directly through consumeManagerSignals.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
