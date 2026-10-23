// lib/kernel/immediate-operations.ts
// ─────────────────────────────────────────────────────────────────────────────
// IMMEDIATE EVENT-DRIVEN OPERATIONS (wave 141, lane 141B; owner ruling 2026-10-14):
//   REQUEST → validate → execute → IMMEDIATE post-condition check (re-read the rows the step
//   claims) → emit a kernel event (success AND failure, with evidence) → the REGISTERED owning
//   manager consumes it on the manager-signals tick → repair through the self-healing engine OR
//   notify a human. Cron / scheduled reconciliation is a SAFETY NET only. Never report success
//   when the post-condition already failed. Nobody waits a day/week for an error.
//
// AUDITED FIRST (LAW 1) — what already existed at HEAD and is REUSED here, never re-spelled:
//   · lib/kernel/emit.ts emitKernelEvent            — THE ONE emitter (audit-only rows with lineage, secrets redacted)
//   · lib/kernel/manager-signals.ts publishManagerSignal / consumeManagerSignals / SIGNAL_HANDLERS
//                                                     — THE bus + the tick (app/api/cron/manager-signals, every 30 min;
//                                                       a tenant with an OPEN signal is visited on the next tick)
//   · lib/kernel/tenant-readiness.ts evaluateTenantReadiness({ repair: true })
//                                                     — THE repair engine: each REPAIRABLE check's DECLARED playbook
//                                                       through lib/kernel/self-healing.ts runDeclaredPlaybook (hard gate,
//                                                       healing policy, owning executor, re-verify, self_heal_events +
//                                                       ledger + event); money / security / cross-tenant stay BLOCKED
//   · lib/kernel/os-health.ts HEALTH_DETECTORS tenant_readiness — the scheduled sweep that stays as the safety net
//   · lib/kernel/org-recipients.ts resolveOrgRecipients + lib/notifications/platform-staff.ts notifyPlatformStaff
//                                                     — THE human notification rails (tenant admins / platform staff)
// What was MISSING: a door's post-condition failure reached nobody but the caller's error string. The
// readiness sweep saw the GAP (if a readiness check covers it) on its own cadence; failures outside the
// contract (an invite email that never left, a credential write that did not verify, a provider
// connection that did not mark itself connected) surfaced nowhere. This module is that seam — ONE
// vocabulary of operations, ONE reporter, ONE consumer — composed from the survivors above.
//
// MANAGERS: only keys registered in lib/kernel/manager-registry.ts MANAGERS at HEAD (the owner's
// ruling: never invent one; the registered recruiting_manager IS usable for the recruiting door). An
// override that names an unregistered key is REFUSED with evidence and the declared owner is used —
// never a privileged default.
//
// PROVIDER VISIBILITY (owner): the signal's `message` and `payload` are rendered on the tenant's
// Command Center feed (loadRecentManagerTalk), so they carry only the TENANT-FACING sentence the door
// supplies; the raw error lives in the lifecycle_events evidence row (secrets redacted by the emitter)
// and in what platform staff are told. Nothing here ever says "platform-covered" to a tenant.
//
// Not server-only (the proof drives it end-to-end over an in-memory client); every survivor is
// resolved by dynamic import so this module's own graph stays a leaf.

import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import type { ReadinessKey, TenantReadinessReport } from "@/lib/kernel/tenant-readiness"
import type { LifecycleEventSource } from "@/lib/kernel/emit"
import type { ManagerSignal } from "@/lib/kernel/manager-signals"

type Svc = any

// ── 1. The vocabulary ─────────────────────────────────────────────────────────────────────────

/** @proofSeam the proof iterates the ten operations the owner named, asserting each has an owner, a label and a consumer */
export const IMMEDIATE_OPERATIONS = [
  "tenant_creation", "user_creation", "invitation", "seat_provisioning", "brokerage_transfer",
  "website_creation", "provider_connection", "billing_activation", "phone_a2p", "transaction_provider_connection",
] as const
export type ImmediateOperation = (typeof IMMEDIATE_OPERATIONS)[number]

/** The REGISTERED manager accountable for each operation's post-condition (the readiness contract's
 *  READINESS_OWNER answers for the keys it covers; the rest follow TABLE_MANAGER / the domain). */
export const OPERATION_OWNER: Readonly<Record<ImmediateOperation, ManagerKey>> = Object.freeze({
  tenant_creation:                 "data_steward",          // the provisioning record + the readiness contract (TABLE_MANAGER brokerages)
  user_creation:                   "data_steward",          // identity records (TABLE_MANAGER users / user_invitations)
  invitation:                      "data_steward",          // the invitation ledger (user_invitations)
  seat_provisioning:               "data_steward",          // the one provisioning brain's records; Finance owns the BAND (money) via readiness `seats`
  brokerage_transfer:              "data_steward",          // lane 141A's rail — membership + data migration through canonical services
  website_creation:                "campaign_orchestrator", // READINESS_OWNER.website
  provider_connection:             "data_steward",          // TABLE_MANAGER platform_credentials / brokerage_integrations
  billing_activation:              "finance_manager",       // READINESS_OWNER subscription / billing — money, never auto-corrected
  phone_a2p:                       "ai_isa",                // READINESS_OWNER.communications (the carrier loop's verdict)
  transaction_provider_connection: "deal_coordinator",      // transactions & closings — the tenant's own transaction / e-sign provider
})

/** Tenant-facing labels (the feed line and the bell title). Never a provider, a credential or a price. */
export const OPERATION_LABEL: Readonly<Record<ImmediateOperation, string>> = Object.freeze({
  tenant_creation: "Workspace setup", user_creation: "User setup", invitation: "Invitation delivery",
  seat_provisioning: "Seat provisioning", brokerage_transfer: "Brokerage transfer", website_creation: "Website creation",
  provider_connection: "Provider connection", billing_activation: "Billing activation", phone_a2p: "Phone number registration",
  // The tenant-facing name is the LEGAL-FORMS provider (owner, wave 142); the key is a stored vocabulary.
  transaction_provider_connection: "Legal-forms provider connection",
})

/** Which readiness checks the consumer RE-VERIFIES (with repair) for each operation. An empty list means
 *  no readiness check covers the post-condition (an email that never left) — the consumer hands it to a
 *  human with the evidence. providerState / requiredSecurityState are PLATFORM configuration: the
 *  tenant-creation verdict does not re-escalate them per tenant (the readiness report names them for staff). */
export const OPERATION_READINESS_KEYS: Readonly<Record<ImmediateOperation, readonly ReadinessKey[]>> = Object.freeze({
  tenant_creation:                 ["tenantCore", "subscription", "plan", "entitlements", "policies", "settings", "snapshot", "website", "adminUser", "seats", "managers"],
  user_creation:                   ["adminUser", "seats"],
  invitation:                      [],
  seat_provisioning:               ["seats", "adminUser"],
  brokerage_transfer:              ["tenantCore", "adminUser", "seats", "subscription", "billing"],
  website_creation:                ["website", "snapshot"],
  provider_connection:             ["providerState"],
  billing_activation:              ["subscription", "plan", "billing"],
  phone_a2p:                       ["communications"],
  transaction_provider_connection: ["providerState"],
})

/** The bus vocabulary: ONE signal type, published FROM the operations reporter TO the owning manager.
 *  "escalated" is deliberate — lib/kernel/coordination-kind.ts renders it as an escalation on the feed. */
export const OPERATION_SIGNAL_TYPE = "operation_failure_escalated"
/** The reporter: the Cron Manager owns operational health (the heartbeat, the bus's self-heal, the OS
 *  health supervisor) — the same identity os-health publishes under. Never an owner (a route needs two ends). */
export const OPERATION_REPORTER: ManagerKey = "cron_manager"
/** The lifecycle_events rows (free-form, audit-only — the bus routes; the reactor never fans these out). */
export const OPERATION_EVENT = Object.freeze({ succeeded: "operation.succeeded", failed: "operation.failed" })

/** Every registered consumer of OPERATION_SIGNAL_TYPE: the declared owners plus the recruiting door's
 *  manager (owner ruling 2026-10-14: the registered recruiting_manager routes recruiting-door events). */
/** @proofSeam the proof asserts each consumer is a registered manager, never the reporter, and has a SIGNAL_HANDLERS entry */
export const IMMEDIATE_OPERATION_CONSUMERS: readonly ManagerKey[] = Object.freeze(
  [...new Set<ManagerKey>([...Object.values(OPERATION_OWNER), "recruiting_manager"])],
)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── 2. The reporter (every door calls it right after its post-condition re-read) ──────────────

export interface OperationOutcomeInput {
  operation: ImmediateOperation
  brokerageId: string
  /** The post-condition verdict the DOOR just measured (a re-read, never the write's own resolve). */
  ok: boolean
  subjectType: string
  subjectId: string | null
  /** What was re-read and what it said — lands in lifecycle_events.metadata (secrets redacted by the emitter). */
  evidence: Record<string, unknown>
  error?: string | null
  actorUserId?: string | null
  /** lifecycle_events.source (CHECK ui|webhook|system|cron); default system. */
  source?: LifecycleEventSource
  /** A REGISTERED manager to route to instead of the declared owner (the recruiting door → recruiting_manager).
   *  An unregistered key is refused with evidence; the declared owner is used — never a privileged default. */
  owner?: ManagerKey | string | null
  /** The one sentence the TENANT may see (feed + bell). Null = a generic sentence; never a credential or a price. */
  tenantFacing?: string | null
  /** Platform-managed subject (tenant creation, billing, platform providers): staff are told the full detail. */
  platformVisible?: boolean
}

export interface OperationOutcomeResult {
  ok: boolean
  /** The evidence row landed (lifecycle_events). */
  evented: boolean
  lifecycleEventId: string | null
  /** The failure was routed to its owning manager (an open signal, deduped per subject). */
  signalId: string | null
  routedTo: ManagerKey | null
  error: string | null
}

export function isImmediateOperation(v: unknown): v is ImmediateOperation {
  return typeof v === "string" && (IMMEDIATE_OPERATIONS as readonly string[]).includes(v)
}

/** PURE — the owner for a report: the override when it is a registered manager other than the reporter,
 *  else the declared owner. Returns the refusal reason beside the pick so it is EVIDENCED, never silent. */
/** @proofSeam the proof drives a registered override, an unregistered override and the reporter itself */
export function resolveOperationOwner(operation: ImmediateOperation, override: string | null | undefined): { owner: ManagerKey; refusedOverride: string | null } {
  const declared = OPERATION_OWNER[operation]
  if (!override) return { owner: declared, refusedOverride: null }
  if (!(override in MANAGERS)) return { owner: declared, refusedOverride: `"${String(override).slice(0, 40)}" is not a registered manager — routed to the declared owner ${declared}` }
  if (override === OPERATION_REPORTER) return { owner: declared, refusedOverride: `${override} is the reporter, not an owner — routed to the declared owner ${declared}` }
  return { owner: override as ManagerKey, refusedOverride: null }
}

function tenantSentence(operation: ImmediateOperation, ok: boolean, tenantFacing: string | null | undefined): string {
  const label = OPERATION_LABEL[operation]
  if (ok) return `${label} completed and verified.`
  const detail = (tenantFacing ?? "").trim()
  return detail ? `${label} did not verify — ${detail}`.slice(0, 480) : `${label} did not verify; the OS is checking and repairing it, and will tell you if it needs you.`
}

/**
 * Record an operation's post-condition verdict: ONE lifecycle_events evidence row (success and failure),
 * and on failure ONE open signal to the owning manager (deduped per subject while open). Never throws —
 * the door already holds its own verdict; a reporter that cannot write says so in the result.
 */
export async function reportOperationOutcome(svc: Svc, input: OperationOutcomeInput): Promise<OperationOutcomeResult> {
  const out: OperationOutcomeResult = { ok: input.ok, evented: false, lifecycleEventId: null, signalId: null, routedTo: null, error: null }
  if (!isImmediateOperation(input.operation)) { out.error = `unknown operation "${String(input.operation).slice(0, 40)}"`; return out }
  if (!UUID_RE.test(String(input.brokerageId ?? ""))) { out.error = "no tenant id — refused"; return out }
  const { owner, refusedOverride } = resolveOperationOwner(input.operation, input.owner ?? null)
  const entityId = input.subjectId ?? input.brokerageId
  const sentence = tenantSentence(input.operation, input.ok, input.tenantFacing)
  const readinessKeys = OPERATION_READINESS_KEYS[input.operation]

  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    const ev = await emitKernelEvent({
      event: input.ok ? OPERATION_EVENT.succeeded : OPERATION_EVENT.failed,
      brokerageId: input.brokerageId, entityType: input.subjectType, entityId,
      actorUserId: input.actorUserId ?? null, source: input.source ?? "system", auditOnly: true, client: svc,
      metadata: {
        operation: input.operation, ok: input.ok, subject_type: input.subjectType, subject_id: input.subjectId,
        owner, refused_override: refusedOverride, readiness_keys: readinessKeys, platform_visible: !!input.platformVisible,
        tenant_facing: sentence, error: input.error ? String(input.error).slice(0, 500) : null, evidence: input.evidence ?? {},
      },
    })
    out.evented = ev.inserted; out.lifecycleEventId = ev.lifecycleEventId
    if (ev.error) out.error = `evidence row refused: ${ev.error}`
  } catch (e) {
    out.error = `evidence row failed: ${e instanceof Error ? e.message : String(e)}`
  }

  if (input.ok) return out
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const r = await publishManagerSignal({
      brokerageId: input.brokerageId, fromManager: OPERATION_REPORTER, toManager: owner,
      signalType: OPERATION_SIGNAL_TYPE, message: sentence,
      entityType: input.subjectType, entityId,
      payload: {
        operation: input.operation, subject_type: input.subjectType, subject_id: input.subjectId,
        lifecycle_event_id: out.lifecycleEventId, readiness_keys: readinessKeys,
        tenant_facing: sentence, platform_visible: !!input.platformVisible, actor_user_id: input.actorUserId ?? null,
      },
    }, svc)
    if (r.ok) { out.signalId = r.signalId ?? null; out.routedTo = owner }
    else out.error = [out.error, `route refused: ${r.reason}`].filter(Boolean).join("; ")
  } catch (e) {
    out.error = [out.error, `route failed: ${e instanceof Error ? e.message : String(e)}`].filter(Boolean).join("; ")
  }
  return out
}

// ── 3. Post-condition helpers the doors share (re-read, tenant pinned, counted) ───────────────

/** The users row the member door claims: present ON THIS TENANT with the type it wrote. */
export async function verifyUserRow(svc: Svc, p: { userId: string; brokerageId: string; userType: string }): Promise<{ ok: boolean; evidence: Record<string, unknown>; error: string | null }> {
  const { data, error } = await svc.from("users").select("id, brokerage_id, user_type").eq("id", p.userId).eq("brokerage_id", p.brokerageId).maybeSingle()
  if (error) return { ok: false, evidence: { userId: p.userId }, error: `users re-read refused: ${error.message}` }
  const row = data as { id: string; brokerage_id: string | null; user_type: string | null } | null
  if (!row) return { ok: false, evidence: { userId: p.userId, onTenant: false }, error: "no users row for this id on this tenant after the write" }
  if (row.user_type !== p.userType) return { ok: false, evidence: { userId: p.userId, onTenant: true, userType: row.user_type, expected: p.userType }, error: `users.user_type is "${row.user_type ?? "null"}", expected "${p.userType}"` }
  return { ok: true, evidence: { userId: p.userId, onTenant: true, userType: row.user_type }, error: null }
}

/** The credential row a connection door claims: present on THIS TENANT for that platform and active.
 *  (Literal table + literal column list on purpose — a parameterised `.from()` / `.select()` blinds the
 *  column census, wave 140 sweep lesson.) */
export async function verifyCredentialRow(svc: Svc, p: { brokerageId: string; platform: string }): Promise<{ ok: boolean; evidence: Record<string, unknown>; error: string | null }> {
  const { data, error } = await svc.from("platform_credentials").select("id, is_active").eq("brokerage_id", p.brokerageId).eq("platform", p.platform).limit(1)
  if (error) return { ok: false, evidence: { platform: p.platform }, error: `platform_credentials re-read refused: ${error.message}` }
  const row = ((data ?? []) as Array<{ id: string; is_active: boolean | null }>)[0] ?? null
  if (!row) return { ok: false, evidence: { platform: p.platform, onTenant: false }, error: "no platform_credentials row on this tenant after the write" }
  if (row.is_active !== true) return { ok: false, evidence: { platform: p.platform, onTenant: true, is_active: row.is_active }, error: `platform_credentials.is_active is ${JSON.stringify(row.is_active)} after the write` }
  return { ok: true, evidence: { platform: p.platform, onTenant: true, is_active: true, rowId: row.id }, error: null }
}

/** The integration row an OAuth connect claims: present on THIS TENANT for that provider and marked connected. */
export async function verifyIntegrationRow(svc: Svc, p: { brokerageId: string; providerName: string }): Promise<{ ok: boolean; evidence: Record<string, unknown>; error: string | null }> {
  const { data, error } = await svc.from("brokerage_integrations").select("id, status").eq("brokerage_id", p.brokerageId).eq("provider_name", p.providerName).limit(1)
  if (error) return { ok: false, evidence: { provider: p.providerName }, error: `brokerage_integrations re-read refused: ${error.message}` }
  const row = ((data ?? []) as Array<{ id: string; status: string | null }>)[0] ?? null
  if (!row) return { ok: false, evidence: { provider: p.providerName, onTenant: false }, error: "no brokerage_integrations row on this tenant after the connect" }
  if (row.status !== "connected") return { ok: false, evidence: { provider: p.providerName, onTenant: true, status: row.status }, error: `brokerage_integrations.status is "${row.status ?? "null"}" after the connect` }
  return { ok: true, evidence: { provider: p.providerName, onTenant: true, status: "connected", rowId: row.id }, error: null }
}

// ── 4. The consumer (SIGNAL_HANDLERS `<owner>:operation_failure_escalated`, on the manager-signals tick) ──

export interface OperationHandlerDeps {
  /** lib/kernel/tenant-readiness.ts evaluateTenantReadiness — the proof injects a deterministic engine. */
  readiness?: (svc: Svc, brokerageId: string, opts: { repair: true }) => Promise<Pick<TenantReadinessReport, "checks" | "ready" | "blockers" | "repairs">>
  /** The human rails (notifications to org recipients; platform staff when the subject is platform-visible). */
  notifyOrg?: (svc: Svc, brokerageId: string, n: { title: string; body: string; entityType: string; entityId: string | null }) => Promise<number>
  notifyStaff?: (svc: Svc, n: { title: string; body: string; entityType: string; entityId: string | null }) => Promise<number>
  /** Wave 142G — the TICKET FLOW: an escalation that reaches a human also opens (or reuses) the ONE support ticket
   *  that tracks it, so it carries an SLA clock and a thread, not only a bell (lib/support/ticket-triage.ts
   *  ensureOperationTicket). Default = that survivor; the proof injects a spy. */
  openTicket?: (svc: Svc, p: { brokerageId: string; operation: string; tenantFacing: string; platformVisible: boolean; actorUserId?: string | null; lifecycleEventId?: string | null }) => Promise<{ ticketId: string | null; created: boolean; error: string | null }>
}

interface OperationSignalPayload {
  operation: string
  subject_type?: string | null
  subject_id?: string | null
  lifecycle_event_id?: string | null
  readiness_keys?: string[]
  tenant_facing?: string | null
  platform_visible?: boolean
  actor_user_id?: string | null
}

const defaultOpenTicket: NonNullable<OperationHandlerDeps["openTicket"]> = async (svc, p) => {
  const { ensureOperationTicket } = await import("@/lib/support/ticket-triage")
  return ensureOperationTicket(svc, p)
}

const defaultNotifyOrg: NonNullable<OperationHandlerDeps["notifyOrg"]> = async (svc, brokerageId, n) => {
  const { resolveOrgRecipients } = await import("@/lib/kernel/org-recipients")
  const recipients = await resolveOrgRecipients(svc, brokerageId, { limit: 3 })
  if (recipients.length === 0) return 0
  const { error } = await svc.from("notifications").insert(recipients.map((user_id: string) => ({
    user_id, brokerage_id: brokerageId, type: "operation_failure_escalation",
    title: n.title.slice(0, 200), body: n.body.slice(0, 480),
    entity_type: n.entityType, entity_id: n.entityId, priority: "high", is_read: false,
  })))
  if (error) { console.error(`[immediate-operations] tenant bell refused: ${error.message}`); return 0 }
  return recipients.length
}

const defaultNotifyStaff: NonNullable<OperationHandlerDeps["notifyStaff"]> = async (svc, n) => {
  const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
  return notifyPlatformStaff(svc, { type: "operation_failure_escalation", title: n.title, body: n.body, entityType: n.entityType, entityId: n.entityId, priority: "high" })
}

/**
 * THE CONSUMER. Reads the routed failure, RE-VERIFIES the operation's readiness keys with repair (the
 * self-healing engine runs each REPAIRABLE check's declared playbook and re-runs the check), and either
 * confirms the post-condition now holds, or hands it to a human with the evidence. Returns the action
 * string the bus records on the consumed signal; a malformed payload is still consumed — by a human.
 */
export async function handleOperationFailureEscalated(
  signal: Pick<ManagerSignal, "id" | "payload" | "entityType" | "entityId">,
  ctx: { brokerageId: string; supabase: Svc },
  deps: OperationHandlerDeps = {},
): Promise<string | null> {
  const svc = ctx.supabase
  const p = (signal.payload ?? {}) as Partial<OperationSignalPayload>
  const notifyOrg = deps.notifyOrg ?? defaultNotifyOrg
  const notifyStaff = deps.notifyStaff ?? defaultNotifyStaff
  const openTicket = deps.openTicket ?? defaultOpenTicket
  const entityType = signal.entityType ?? p.subject_type ?? "operation"
  const entityId = signal.entityId ?? p.subject_id ?? null

  // The bell carries the tenant-facing body; the consumed action (the bus record) carries the detail —
  // readiness reasons, the playbook that ran, the engine's own refusal — so the feed says WHY.
  // Wave 142G: the escalation ALSO lands in the ticket flow (one tracked ticket per operation while open) — a
  // subject that is itself a support ticket (the triage's safe-repair path) is not re-ticketed; it is the ticket.
  const escalate = async (title: string, body: string, staffDetail: string | null): Promise<string> => {
    const org = await notifyOrg(svc, ctx.brokerageId, { title, body, entityType, entityId })
    const staff = p.platform_visible ? await notifyStaff(svc, { title, body: staffDetail ?? body, entityType, entityId }) : 0
    let ticketNote = ""
    if (entityType === "support_ticket" && entityId) ticketNote = `; tracked on support ticket ${entityId}`
    else if (isImmediateOperation(p.operation)) {
      try {
        const t = await openTicket(svc, { brokerageId: ctx.brokerageId, operation: p.operation, tenantFacing: body, platformVisible: !!p.platform_visible, actorUserId: p.actor_user_id ?? null, lifecycleEventId: p.lifecycle_event_id ?? null })
        ticketNote = t.ticketId ? `; ${t.created ? "opened" : "already tracked on"} support ticket ${t.ticketId}` : `; no ticket opened (${t.error ?? "refused"})`
      } catch (e) { ticketNote = `; no ticket opened (${e instanceof Error ? e.message : String(e)})` }
    }
    return `escalated to a human (${org} tenant admin(s)${p.platform_visible ? `, ${staff} platform staff` : ""}${ticketNote}) — ${staffDetail ?? body}`.slice(0, 600)
  }

  if (!isImmediateOperation(p.operation)) {
    return escalate("An operation needs a human", `A routed failure named an unrecognised operation ("${String(p.operation ?? "").slice(0, 40)}") — nothing automated may act on it.`, `signal ${signal.id}: unrecognised operation payload`)
  }
  const operation = p.operation
  const label = OPERATION_LABEL[operation]
  const keys = OPERATION_READINESS_KEYS[operation]
  const tenantFacing = (p.tenant_facing ?? "").trim() || `${label} did not verify.`

  if (keys.length === 0) {
    return escalate(`${label} needs you`, tenantFacing, `${label}: no readiness check covers this post-condition — evidence row ${p.lifecycle_event_id ?? "(none)"}`)
  }

  let report: Pick<TenantReadinessReport, "checks" | "ready" | "blockers" | "repairs">
  try {
    const evaluate = deps.readiness ?? (async (s: Svc, b: string, o: { repair: true }) => (await import("@/lib/kernel/tenant-readiness")).evaluateTenantReadiness(s, b, o))
    report = await evaluate(svc, ctx.brokerageId, { repair: true })
  } catch (e) {
    // The engine could not run — that is not "verified" (fail closed): a human gets it with the reason.
    return escalate(`${label} needs you`, tenantFacing, `${label}: the readiness engine threw while re-verifying: ${e instanceof Error ? e.message : String(e)}`)
  }
  const relevant = report.checks.filter((c) => (keys as readonly string[]).includes(c.key))
  const open = relevant.filter((c) => c.required && c.status !== "PASS" && c.status !== "NOT_APPLICABLE")
  const repairs = (report.repairs ?? []).filter((r) => (keys as readonly string[]).includes(r.key))
  const repairLine = repairs.length ? `repairs: ${repairs.map((r) => `${r.key}→${r.playbook} ${r.ran ? (r.ok ? "ok" : "refused") : "not run"}${r.escalated ? " (escalated)" : ""}`).join("; ")}` : "no repair needed"
  if (open.length === 0) {
    return `${label}: post-condition re-verified through the readiness contract — ${keys.join(", ")} ${relevant.length ? "PASS / N/A" : "(no check evaluated)"}; ${repairLine}`.slice(0, 600)
  }
  const openLine = open.map((c) => `${c.key} ${c.status} — ${c.reason}`).join("; ")
  return escalate(`${label} needs you`, `${tenantFacing} Still open after the OS tried: ${openLine}`.slice(0, 480), `${label}: ${openLine}; ${repairLine}; evidence row ${p.lifecycle_event_id ?? "(none)"}`)
}
