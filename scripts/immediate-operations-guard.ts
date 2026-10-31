#!/usr/bin/env tsx
/**
 * scripts/immediate-operations-guard.ts   (npm run test:immediate-operations) — wave 141, lane 141B
 * ─────────────────────────────────────────────────────────────────────────────
 * IMMEDIATE EVENT-DRIVEN OPERATIONS (owner 2026-10-14): REQUEST → validate → execute → IMMEDIATE
 * post-condition check → emit event (success AND failure, evidence) → the REGISTERED owning manager
 * consumes it on the manager-signals tick → repair through the self-healing engine OR notify a human.
 * Never report success when the post-condition failed. Invitations dispatch in the creating request.
 *
 * In memory (scripts/in-memory-supabase.ts — writers return the matched rows, refusals RESOLVE):
 *  A. the registry — ten operations, each with a REGISTERED owner (never the reporter), a label, readiness
 *     keys inside the contract; every consumer has a SIGNAL_HANDLERS inbox; the signal is catalogued with
 *     the same consumers and the feed kind the live classifier renders; MAINTENANCE_DOMAINS + package.json
 *  B. the reporter — success: ONE evidence row, no signal; failure: the evidence row (raw error, secrets
 *     redacted) + ONE open signal to the owner whose message / payload carry only the tenant-facing
 *     sentence; deduped per subject; a registered override routes (recruiting_manager), an unregistered
 *     override is REFUSED with evidence; a non-uuid tenant is refused
 *  C. the consumer (the REAL handler) — re-verified after repair (no bell); still open → escalated to the
 *     tenant admins (+ staff when platform-visible); no readiness check covers it → a human; a malformed
 *     payload → a human; the DEFAULT engine is the real evaluateTenantReadiness (fail closed: BLOCKED →
 *     escalated); an engine that throws → escalated; the whole bus: publish → consumeManagerSignals →
 *     consumed WITH the action
 *  D. the invite door — the REAL inviteTenantMember over the fake: a refused dispatch returns NO success,
 *     leaves a user_invitations row the admin can see (status failed), an evidence row and an open signal;
 *     the recruiting door routes to recruiting_manager; a retry adopts the failed row (never doubled);
 *     verifyUserRow refuses a wrong-tenant / wrong-type row (positive control: the right row passes)
 *  E. the doors (stripped source, positive control) — every named door calls the reporter with its
 *     operation literal; the member door refuses on a failed verify; every inviteUserByEmail reads `error`
 *  F. ROLE SAFETY — no `?? "admin"` / `|| "superadmin"`-style authority default in lib/ app/ (stripped
 *     source; positive control), no `user_type: "superadmin"` write, and requireBrokerageAdmin REFUSES a
 *     row with no user_type (used to read it as admin)
 * BLIND SPOTS (published): the handler's repair path is proven with an injected engine (the real engine's
 * repairs are test:tenant-readiness's subject); the consumer runs on the 30-minute tick, not in-request;
 * brokerage_transfer's door is lane 141A's rail; custom domains stay on lib/platform/custom-domains.ts.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { walkTs } from "./runtime-roots"
import { memSupabase } from "./in-memory-supabase"
import {
  IMMEDIATE_OPERATIONS, OPERATION_OWNER, OPERATION_LABEL, OPERATION_READINESS_KEYS, OPERATION_SIGNAL_TYPE, OPERATION_REPORTER,
  OPERATION_EVENT, IMMEDIATE_OPERATION_CONSUMERS, resolveOperationOwner, reportOperationOutcome, handleOperationFailureEscalated,
  verifyUserRow, verifyCredentialRow, verifyIntegrationRow,
} from "../lib/kernel/immediate-operations"
import { MANAGERS, MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { SIGNAL_HANDLERS, validSignalRoute, consumeManagerSignals } from "../lib/kernel/manager-signals"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { classifyCoordination } from "../lib/kernel/coordination-kind"
import { READINESS_KEYS, type ReadinessCheck } from "../lib/kernel/tenant-readiness"
import { inviteTenantMember } from "../lib/kernel/users"
import { requireBrokerageAdmin } from "../lib/auth/require-brokerage-admin"

let pass = 0, fail = 0
const ok = (c: unknown, m: string, extra?: string) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`) } }
const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

// ── fixtures ─────────────────────────────────────────────────────────────────
const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const ADMIN = "11111111-1111-4111-8111-111111111111", CALLER = "22222222-2222-4222-8222-222222222222", MEMBER = "33333333-3333-4333-8333-333333333333"
type Row = Record<string, any>
function client(seed: Record<string, Row[]> = {}) {
  const svc = memSupabase({ lifecycle_events: [], manager_signals: [], notifications: [], users: [], user_invitations: [], teams: [], agents: [], platform_credentials: [], brokerage_integrations: [], ...seed }, { uuidIds: true, stampCreatedAt: true })
  ;(svc as any).rpc = async () => ({ data: null, error: null })
  // The live manager_signals.status DEFAULT 'open' — the fake has no column defaults, and the bus's dedupe
  // (publishManagerSignal) and the tick (consumeManagerSignals) both filter `.eq("status", "open")`.
  const orig = svc.from.bind(svc)
  ;(svc as any).from = (table: string) => {
    const q: any = orig(table)
    if (table === "manager_signals") { const ins = q.insert.bind(q); q.insert = (p: any) => ins(Array.isArray(p) ? p.map((r: any) => ({ status: "open", ...r })) : { status: "open", ...p }) }
    return q
  }
  return svc
}
const open = (svc: ReturnType<typeof client>) => (svc.tables.manager_signals ?? []).filter((s) => s.status === "open" || s.status === undefined)
const events = (svc: ReturnType<typeof client>, type: string) => (svc.tables.lifecycle_events ?? []).filter((e) => e.event_type === type)
const checksAll = (status: ReadinessCheck["status"], except: Partial<Record<string, ReadinessCheck["status"]>> = {}): ReadinessCheck[] =>
  READINESS_KEYS.map((key) => ({ key, status: except[key] ?? status, required: true, reason: `${key} ${except[key] ?? status}`, evidence: {}, owner: "data_steward", lastChecked: "2026-10-14T00:00:00.000Z", remediation: null }))

console.log("\n━━━ A · the registry ━━━")
ok(IMMEDIATE_OPERATIONS.length === 10, `ten operations declared (${IMMEDIATE_OPERATIONS.join(", ")})`)
for (const op of IMMEDIATE_OPERATIONS) {
  const owner = OPERATION_OWNER[op]
  ok(owner in MANAGERS && owner !== OPERATION_REPORTER && validSignalRoute(OPERATION_REPORTER, owner), `${op} → owner ${owner} is a registered manager and a valid route from the reporter`)
  ok(!!OPERATION_LABEL[op] && !/platform.covered|credential|\$\d/i.test(OPERATION_LABEL[op]), `${op} has a tenant-safe label`)
  ok(OPERATION_READINESS_KEYS[op].every((k) => (READINESS_KEYS as readonly string[]).includes(k)), `${op} readiness keys are inside the contract`)
}
ok(IMMEDIATE_OPERATION_CONSUMERS.includes("recruiting_manager"), "the registered recruiting_manager is a consumer (owner 2026-10-14)")
for (const m of IMMEDIATE_OPERATION_CONSUMERS) ok(typeof SIGNAL_HANDLERS[`${m}:${OPERATION_SIGNAL_TYPE}`] === "function", `SIGNAL_HANDLERS has ${m}:${OPERATION_SIGNAL_TYPE}`)
const spec = SIGNAL_REGISTRY[OPERATION_SIGNAL_TYPE]
ok(!!spec && spec.disposition === "handled", "the signal is catalogued as handled")
ok(!!spec && [...spec.consumers].sort().join(",") === [...IMMEDIATE_OPERATION_CONSUMERS].sort().join(","), "the catalogue's consumer list IS the module's consumer list (one vocabulary)", spec?.consumers.join(","))
ok(!!spec && spec.kind === classifyCoordination(OPERATION_SIGNAL_TYPE), `the feed renders it as ${classifyCoordination(OPERATION_SIGNAL_TYPE)} (declared ${spec?.kind})`)
ok(MAINTENANCE_DOMAINS.immediate_operations?.proof === "test:immediate-operations" && (MAINTENANCE_DOMAINS.immediate_operations.coOwners ?? []).length === 2, "MAINTENANCE_DOMAINS.immediate_operations owned + co-owned")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  ok(/immediate-operations-guard\.ts/.test(pkg.scripts["test:immediate-operations"] ?? ""), "package.json registers test:immediate-operations")
  ok(new RegExp("npm run test:immediate-operations(\\s|&|$)").test(pkg.scripts.guard ?? ""), "the guard chain runs it (membership, not position)")
}
{
  const r1 = resolveOperationOwner("user_creation", "recruiting_manager")
  ok(r1.owner === "recruiting_manager" && r1.refusedOverride === null, "a registered override routes (recruiting_manager)")
  const r2 = resolveOperationOwner("user_creation", "growth_hacker")
  ok(r2.owner === "data_steward" && !!r2.refusedOverride, "an UNREGISTERED override is refused with evidence, the declared owner used — never invented")
  const r3 = resolveOperationOwner("provider_connection", OPERATION_REPORTER)
  ok(r3.owner === OPERATION_OWNER.provider_connection && !!r3.refusedOverride, "the reporter cannot be an owner (a route needs two ends)")
}

console.log("\n━━━ B · the reporter ━━━")
{
  const svc = client()
  const r1 = await reportOperationOutcome(svc, { operation: "user_creation", brokerageId: B, ok: true, subjectType: "user", subjectId: MEMBER, actorUserId: CALLER, evidence: { onTenant: true } })
  ok(r1.evented && !!r1.lifecycleEventId && events(svc, OPERATION_EVENT.succeeded).length === 1 && events(svc, OPERATION_EVENT.succeeded)[0].brokerage_id === B && events(svc, OPERATION_EVENT.succeeded)[0].metadata?.operation === "user_creation", "success → ONE evidence row (operation.succeeded) on the tenant", r1.error ?? undefined)
  ok(r1.signalId === null && open(svc).length === 0, "success routes nothing")
  const RAW = "row inactive after write (token tok_secret_9f8e7d6c5b4a3)"
  const r2 = await reportOperationOutcome(svc, { operation: "provider_connection", brokerageId: B, ok: false, subjectType: "platform_credentials", subjectId: MEMBER, actorUserId: CALLER, evidence: { platform: "mls", api_key: "sk_live_abcdef0123456789abcdef" }, error: RAW, tenantFacing: "re-enter it from Settings" })
  const failed = events(svc, OPERATION_EVENT.failed)
  ok(r2.evented && failed.length === 1 && failed[0].metadata?.ok === false && String(failed[0].metadata?.error ?? "").includes("row inactive"), "failure → the evidence row carries the raw error", r2.error ?? undefined)
  ok(failed.length === 1 && failed[0].metadata?.evidence?.api_key !== "sk_live_abcdef0123456789abcdef" && failed[0].metadata?.evidence?.platform === "mls", "secrets in the evidence are redacted by the emitter (positive control: a plain value survives)")
  const sig = open(svc)
  ok(r2.signalId !== null && r2.routedTo === OPERATION_OWNER.provider_connection && sig.length === 1 && sig[0].to_manager === OPERATION_OWNER.provider_connection && sig[0].from_manager === OPERATION_REPORTER && sig[0].signal_type === OPERATION_SIGNAL_TYPE, "failure → ONE open signal to the owning manager from the reporter", r2.error ?? undefined)
  ok(sig.length === 1 && !JSON.stringify(sig[0].payload).includes("row inactive") && !String(sig[0].message).includes("row inactive") && String(sig[0].message).includes("re-enter it") && sig[0].payload?.operation === "provider_connection" && Array.isArray(sig[0].payload?.readiness_keys), "the signal (tenant feed) carries only the tenant-facing sentence + the routing payload — never the raw error")
  const r3 = await reportOperationOutcome(svc, { operation: "provider_connection", brokerageId: B, ok: false, subjectType: "platform_credentials", subjectId: MEMBER, evidence: {}, error: RAW })
  ok(r3.signalId === r2.signalId && open(svc).length === 1 && events(svc, OPERATION_EVENT.failed).length === 2, "a second failure on the same subject is evidenced again but NOT a second open signal (deduped)")
  const r4 = await reportOperationOutcome(svc, { operation: "seat_provisioning", brokerageId: B, ok: false, subjectType: "user", subjectId: ADMIN, evidence: {}, owner: "recruiting_manager" })
  ok(r4.routedTo === "recruiting_manager" && open(svc).some((s) => s.to_manager === "recruiting_manager"), "a registered override (the recruiting door) routes to recruiting_manager")
  const r5 = await reportOperationOutcome(svc, { operation: "seat_provisioning", brokerageId: B, ok: false, subjectType: "user", subjectId: CALLER, evidence: {}, owner: "ghost_manager" })
  ok(r5.routedTo === "data_steward" && events(svc, OPERATION_EVENT.failed).some((e) => e.metadata?.refused_override && e.entity_id === CALLER), "an unregistered override is refused IN THE EVIDENCE and routed to the declared owner")
  const before = svc.tables.lifecycle_events.length
  const r6 = await reportOperationOutcome(svc, { operation: "tenant_creation", brokerageId: "not-a-uuid", ok: false, subjectType: "brokerage", subjectId: null, evidence: {} })
  ok(!r6.evented && r6.signalId === null && /no tenant id/.test(r6.error ?? "") && svc.tables.lifecycle_events.length === before, "a non-uuid tenant is refused — nothing written")
  const r7 = await reportOperationOutcome(svc, { operation: "not_an_operation" as never, brokerageId: B, ok: false, subjectType: "x", subjectId: null, evidence: {} })
  ok(!r7.evented && /unknown operation/.test(r7.error ?? ""), "an unknown operation is refused")
}

console.log("\n━━━ C · the consumer ━━━")
{
  const svc = client({ users: [{ id: ADMIN, brokerage_id: B, user_type: "admin", deleted_at: null }] })
  const belled: Array<{ title: string; body: string }> = [], staffed: Array<{ title: string; body: string }> = []
  const spies = { notifyOrg: async (_s: unknown, _b: string, n: { title: string; body: string }) => { belled.push(n); return 1 }, notifyStaff: async (_s: unknown, n: { title: string; body: string }) => { staffed.push(n); return 2 } }
  const sig = (operation: string, extra: Record<string, unknown> = {}) => ({ id: `sig-${operation}`, payload: { operation, readiness_keys: (OPERATION_READINESS_KEYS as Record<string, readonly string[]>)[operation] ?? [], tenant_facing: `${operation} did not verify`, platform_visible: false, ...extra }, entityType: "brokerage", entityId: B })
  const ctx = { brokerageId: B, supabase: svc }

  // C1 — repaired → re-verified, nobody belled
  const a1 = await handleOperationFailureEscalated(sig("website_creation"), ctx, { ...spies, readiness: async () => ({ ready: true, blockers: [], checks: checksAll("PASS"), repairs: [{ key: "website", playbook: "tenant_operating_baseline", ran: true, ok: true, after: "PASS", escalated: false, outcome: "slug minted" }] }) })
  ok(!!a1 && /re-verified/.test(a1) && /tenant_operating_baseline ok/.test(a1) && belled.length === 0 && staffed.length === 0, "REPAIRABLE → repaired through the engine → post-condition re-verified, no human bothered", a1 ?? "null")
  // C2 — still open (money) → escalated to the tenant admins + staff when platform-visible
  const a2 = await handleOperationFailureEscalated(sig("billing_activation", { platform_visible: true }), ctx, { ...spies, readiness: async () => ({ ready: false, blockers: ["billing"], checks: checksAll("PASS", { billing: "BLOCKED" }), repairs: [] }) })
  ok(!!a2 && /escalated to a human/.test(a2) && /billing BLOCKED/.test(a2) && belled.length === 1 && staffed.length === 1, "BLOCKED after the engine → escalated: tenant admins + platform staff (platform-visible)", a2 ?? "null")
  ok(!/sk_live|stripe/i.test(belled[0]?.body ?? "") && /Billing activation/.test(belled[0]?.title ?? ""), "the tenant's bell is the tenant-facing sentence")
  // C2b — platform_visible false → staff NOT told
  belled.length = 0; staffed.length = 0
  const a2b = await handleOperationFailureEscalated(sig("seat_provisioning"), ctx, { ...spies, readiness: async () => ({ ready: false, blockers: [], checks: checksAll("PASS", { seats: "REPAIRABLE" }), repairs: [{ key: "seats", playbook: "repair_user_records", ran: true, ok: false, after: "REPAIRABLE", escalated: false, outcome: "refused" }] }) })
  ok(!!a2b && /escalated/.test(a2b) && belled.length === 1 && staffed.length === 0 && /repair_user_records refused/.test(a2b), "a repair that ran and did not hold → escalated to the tenant only (not platform-visible), the repair named", a2b ?? "null")
  // C2c — NOT_APPLICABLE counts as satisfied
  belled.length = 0
  const a2c = await handleOperationFailureEscalated(sig("billing_activation"), ctx, { ...spies, readiness: async () => ({ ready: true, blockers: [], checks: checksAll("PASS", { billing: "NOT_APPLICABLE" }), repairs: [] }) })
  ok(!!a2c && /re-verified/.test(a2c) && belled.length === 0, "NOT_APPLICABLE (trial / staff-invoiced) satisfies the post-condition")
  // C3 — no readiness check covers it (invitation) → the DEFAULT human rail over the fake
  const a3 = await handleOperationFailureEscalated(sig("invitation", { lifecycle_event_id: "le-1" }), ctx)
  const bells = (svc.tables.notifications ?? []).filter((n) => n.type === "operation_failure_escalation")
  ok(!!a3 && /escalated to a human/.test(a3) && bells.length === 1 && bells[0].user_id === ADMIN && bells[0].brokerage_id === B && /Invitation delivery/.test(bells[0].title), "no readiness check covers it → handed to the tenant admin through the real notification rail", a3 ?? "null")
  // C4 — malformed payload → a human, still consumed
  belled.length = 0
  const a4 = await handleOperationFailureEscalated({ id: "sig-x", payload: { operation: "nonsense" }, entityType: null, entityId: null }, ctx, spies)
  ok(!!a4 && /unrecognised operation/.test(a4) && belled.length === 1, "a malformed payload is consumed by a HUMAN, never acted on")
  // C5 — the DEFAULT engine is the real evaluateTenantReadiness (a non-uuid tenant → every check BLOCKED → escalated, fail closed)
  belled.length = 0
  const a5 = await handleOperationFailureEscalated(sig("tenant_creation"), { brokerageId: "not-a-uuid", supabase: svc }, spies)
  ok(!!a5 && /escalated/.test(a5) && /BLOCKED/.test(a5) && belled.length === 1, "the default engine is the real readiness contract — a refused tenant is BLOCKED → escalated (fail closed)", a5 ?? "null")
  // C6 — an engine that throws is not "verified"
  belled.length = 0
  const a6 = await handleOperationFailureEscalated(sig("website_creation"), ctx, { ...spies, readiness: async () => { throw new Error("engine down") } })
  ok(!!a6 && /escalated/.test(a6) && /engine down/.test(staffed.concat(belled).map((b) => b.body).join(" ") + a6) && belled.length === 1, "an engine that throws → escalated with the reason (never 'verified')")
  // C7 — THE BUS end to end: publish (the reporter) → consumeManagerSignals (the tick) → consumed WITH the action
  const svc2 = client({ users: [{ id: ADMIN, brokerage_id: B, user_type: "admin", deleted_at: null }] })
  const pub = await reportOperationOutcome(svc2, { operation: "seat_provisioning", brokerageId: B, ok: false, subjectType: "user", subjectId: MEMBER, evidence: {}, error: "grant refused", tenantFacing: "records incomplete" })
  const consumed = await consumeManagerSignals({ brokerageId: B, toManager: OPERATION_OWNER.seat_provisioning }, svc2 as never)
  const row = (svc2.tables.manager_signals ?? []).find((s) => s.id === pub.signalId)
  ok(consumed.consumed === 1 && row?.status === "consumed" && /escalated|re-verified/.test(String(row?.consumed_action ?? "")), "publish → the registered inbox consumes it on the tick and records the action", JSON.stringify({ consumed, status: row?.status, action: row?.consumed_action }))
  ok((svc2.tables.notifications ?? []).some((n) => n.type === "operation_failure_escalation" && n.user_id === ADMIN), "…and (no brokerage row to verify against) the tenant admin was told through the real rail")
}

console.log("\n━━━ D · the invite door (REAL inviteTenantMember over the fake) ━━━")
{
  const svc = client()
  ;(svc as any).auth = { admin: {
    inviteUserByEmail: async () => ({ data: { user: null }, error: { message: "Error sending invite email (SMTP 550)" } }),
    getUserById: async () => ({ data: { user: null }, error: { message: "not found" } }),
    listUsers: async () => ({ data: { users: [] }, error: null }),
  } }
  const res = await inviteTenantMember({ brokerageId: B, email: "New.Agent@Wave141.test", firstName: "New", lastName: "Agent", userType: "agent", callerUserId: CALLER, client: svc as never })
  ok(!res.success && res.userId === null && /SMTP 550/.test(res.error ?? ""), "a refused dispatch is returned as the failure it is — never success", JSON.stringify(res))
  const inv = svc.tables.user_invitations ?? []
  ok(inv.length === 1 && inv[0].status === "failed" && inv[0].email === "new.agent@wave141.test" && inv[0].brokerage_id === B && inv[0].user_type === "agent", "the admin's invitations panel sees it: user_invitations status 'failed' on the tenant (m779)", JSON.stringify(inv))
  const ev = events(svc, OPERATION_EVENT.failed)
  ok(ev.length === 1 && ev[0].metadata?.operation === "invitation" && /SMTP 550/.test(String(ev[0].metadata?.error)) && ev[0].metadata?.evidence?.dispatched === false, "the evidence row names the invitation and the dispatch error")
  ok(open(svc).length === 1 && open(svc)[0].to_manager === OPERATION_OWNER.invitation && !/SMTP/.test(String(open(svc)[0].message)), "routed to the Data Steward with a tenant-facing message")
  ok((svc.tables.users ?? []).length === 0, "no users row was minted for an invite that never left")
  // retry adopts the failed row — never doubled
  const again = await inviteTenantMember({ brokerageId: B, email: "new.agent@wave141.test", userType: "agent", callerUserId: CALLER, client: svc as never })
  ok(!again.success && (svc.tables.user_invitations ?? []).length === 1 && open(svc).length === 1, "a retry re-stamps the one failed row and the one open signal (idempotent)")
  // the recruiting door → recruiting_manager
  const rec = await inviteTenantMember({ brokerageId: B, email: "recruit@wave141.test", userType: "agent", callerUserId: CALLER, door: "recruiting", client: svc as never })
  ok(!rec.success && open(svc).some((s) => s.to_manager === "recruiting_manager"), "the recruiting door's failure routes to the registered recruiting_manager")
  // verifyUserRow — the user_creation post-condition
  const svcV = client({ users: [{ id: MEMBER, brokerage_id: B, user_type: "agent" }, { id: ADMIN, brokerage_id: OTHER, user_type: "admin" }] })
  const v1 = await verifyUserRow(svcV, { userId: MEMBER, brokerageId: B, userType: "agent" })
  const v2 = await verifyUserRow(svcV, { userId: ADMIN, brokerageId: B, userType: "admin" })
  const v3 = await verifyUserRow(svcV, { userId: MEMBER, brokerageId: B, userType: "tc" })
  ok(v1.ok && !v2.ok && /no users row/.test(v2.error ?? "") && !v3.ok && /expected "tc"/.test(v3.error ?? ""), "verifyUserRow: the right row passes; a wrong-tenant row and a wrong-type row are refused")
  const svcC = client({ platform_credentials: [{ id: "c1", brokerage_id: B, platform: "mls", is_active: false }], brokerage_integrations: [{ id: "i1", brokerage_id: B, provider_name: "dotloop", status: "error" }] })
  const c1 = await verifyCredentialRow(svcC, { brokerageId: B, platform: "mls" }), c2 = await verifyCredentialRow(svcC, { brokerageId: OTHER, platform: "mls" })
  const i1 = await verifyIntegrationRow(svcC, { brokerageId: B, providerName: "dotloop" })
  ok(!c1.ok && /is_active is false/.test(c1.error ?? "") && !c2.ok && /no platform_credentials row/.test(c2.error ?? "") && !i1.ok && /status is "error"/.test(i1.error ?? ""), "verifyCredentialRow / verifyIntegrationRow refuse an inactive, wrong-tenant or errored row")
  const svcR = client({ platform_credentials: [], user_invitations: [] }, )
  ;(svcR as any).auth = (svc as any).auth
  ;(svcR as any).from = ((orig) => (t: string) => { if (t === "user_invitations") { const q = orig(t); const refused = { then: (res: any) => Promise.resolve({ data: null, error: { message: "new row violates check constraint user_invitations_status_check", code: "23514" } }).then(res) }; return new Proxy(q, { get: (target, p) => (p === "then" ? refused.then : (target as any)[p]) }) } return orig(t) })((svcR as any).from.bind(svcR))
  const res2 = await inviteTenantMember({ brokerageId: B, email: "x@wave141.test", userType: "agent", callerUserId: CALLER, client: svcR as never })
  ok(!res2.success && events(svcR, OPERATION_EVENT.failed).length === 1 && open(svcR).length === 1, "when the CHECK still refuses 'failed' (m779 not yet applied) the evidence row + the route still land and no success is reported")
}

console.log("\n━━━ E · the doors (stripped source) ━━━")
{
  const DOORS: Array<[string, string, RegExp]> = [
    ["lib/kernel/tenant-creation.ts", "tenant_creation", /deps\.reportOutcome|reportOperationOutcome/],
    ["lib/kernel/tenant-creation.ts", "website_creation", /deps\.reportOutcome|reportOperationOutcome/],
    ["lib/kernel/users.ts", "invitation", /reportOp\(/],
    ["lib/kernel/users.ts", "user_creation", /verifyUserRow\(/],
    ["lib/kernel/users.ts", "seat_provisioning", /reportOp\(/],
    ["app/actions/tenant-connections.ts", "provider_connection", /verifyCredentialRow\(/],
    ["app/actions/settings/integrations.ts", "provider_connection", /verifyCredentialRow\(/],
    ["app/api/integrations/oauth/[provider]/route.ts", "transaction_provider_connection", /verifyIntegrationRow\(/],
    ["app/api/billing/webhook/route.ts", "billing_activation", /reportOperationOutcome\(/],
    ["lib/voice/number-provisioning.ts", "phone_a2p", /reportOperationOutcome\(/],
  ]
  for (const [file, op, call] of DOORS) {
    const src = stripComments(read(file))
    ok(src.includes(`"${op}"`) && call.test(src), `${file} reports ${op} at its post-condition`)
  }
  ok(!stripComments(`// operation: "tenant_creation"\nconst x = 1 /* reportOperationOutcome( */`).includes(`"tenant_creation"`), "POSITIVE CONTROL: a tombstone / comment is never a door")
  const users = stripComments(read("lib/kernel/users.ts"))
  const afterVerify = users.slice(users.indexOf("const verified = await verifyUserRow("))
  ok(afterVerify.indexOf("return { success: false") > 0 && afterVerify.indexOf("return { success: false") < 1500, "the member door REFUSES when the users row does not verify (no success on a failed post-condition)")
  const dispatchReads = users.match(/const \{ data[^}]*error[^}]*\} = await service\.auth\.admin\.inviteUserByEmail\(/g) ?? []
  ok(dispatchReads.length >= 3, `every invite dispatch destructures its error (member, owner, resend) — ${dispatchReads.length} found`)
  ok(/export async function redispatchInvitation/.test(users) && /redispatchInvitation\(/.test(stripComments(read("app/actions/admin/invitations.ts"))) && /redispatchInvitation\(/.test(stripComments(read("app/actions/superadmin/tenant-users.ts"))), "both Resend doors call the ONE redispatch semantic (the email is re-attempted, not only the window)")
  ok(/case "failed"/.test(read("app/dashboard/admin/users/invitations/invitations-table.tsx")) && /"failed"/.test(read("app/actions/admin/invitations.ts")), "the admin dashboard renders the FAILED invite state with a Resend")
  const mig = "supabase/migrations/m779-user-invitations-failed-dispatch-status.sql"
  ok(existsSync(join(ROOT, mig)) && /user_invitations_status_check CHECK \(status IN \([^)]*'failed'/.test(read(mig)) && /^--[^\n]*(WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(read(mig)), "m779 widens user_invitations.status with 'failed' and carries a status header")
  ok(/door:\s*"recruiting"/.test(stripComments(read("app/api/recruiting/provision-agent/route.ts"))), "the recruiting door names itself (→ recruiting_manager)")
}

console.log("\n━━━ F · ROLE SAFETY — no authority default to a privileged role ━━━")
{
  const PRIV = /(\?\?|\|\|)\s*["'](admin|superadmin|broker|broker_owner|broker_admin|platform_admin)["']/g
  const WRITE = /user_type:\s*["']superadmin["']/g
  const files = [...walkTs(join(ROOT, "lib")), ...walkTs(join(ROOT, "app"))].filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts"))
  const defaults: string[] = [], writes: string[] = []
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"))
    const rel = f.replace(ROOT + "/", "")
    for (const line of src.split("\n")) {
      // signup_source is a provenance label, not an authority — published exclusion.
      if (PRIV.test(line) && !/signup_source/.test(line)) defaults.push(`${rel}: ${line.trim().slice(0, 100)}`)
      PRIV.lastIndex = 0
      if (WRITE.test(line)) writes.push(`${rel}: ${line.trim().slice(0, 100)}`)
      WRITE.lastIndex = 0
    }
  }
  ok(defaults.length === 0, `no \`?? "admin"\` / \`|| "superadmin"\`-style authority default in lib/ app/ (${files.length} files scanned; exclusion: signup_source)`, defaults.slice(0, 6).join(" | "))
  ok(writes.length === 0, "no code mints user_type='superadmin' (platform staff live in platform_role)", writes.slice(0, 4).join(" | "))
  const control = `const role = gate.role ?? "superadmin"\nconst t = (u.user_type as string | null) || 'admin'`
  ok((stripComments(control).match(PRIV) ?? []).length === 2, "POSITIVE CONTROL: the finder recognises both defaulting shapes")
  ok((stripComments(`// gate.role ?? "superadmin"`).match(PRIV) ?? []).length === 0, "POSITIVE CONTROL: a comment is not a default")
  // functional: a users row with NO user_type is REFUSED by the brokerage-admin gate (it used to read as admin)
  const svc = client({ users: [{ id: ADMIN, brokerage_id: B, user_type: null, platform_role: null }, { id: CALLER, brokerage_id: B, user_type: "admin", platform_role: null }] })
  let refused = false, reason = ""
  try { await requireBrokerageAdmin(svc as never, ADMIN) } catch (e) { refused = true; reason = (e as Error).message }
  ok(refused && /no user type/.test(reason), "requireBrokerageAdmin refuses a row with no user_type", reason)
  const admitted = await requireBrokerageAdmin(svc as never, CALLER)
  ok(admitted.brokerageId === B && admitted.userType === "admin", "POSITIVE CONTROL: a real admin row is admitted")
  const staff = stripComments(read("app/actions/superadmin/platform-staff.ts"))
  ok(/case "superadmin": return \{ user_type: "admin", platform_role: "superadmin" \}/.test(staff), "the platform-staff role map writes (admin, platform_role superadmin) — the live superadmin's shape")
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ IMMEDIATE_OPERATIONS_FAIL — a post-condition failure that reaches nobody is a success nobody earned"); process.exit(1) }
console.log(" ✅ IMMEDIATE_OPERATIONS_PASS — every operation re-reads, evidences, routes to its registered owner, and repairs or tells a human")
