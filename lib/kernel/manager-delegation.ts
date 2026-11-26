/**
 * MANAGER DELEGATION — one manager asks another for a CAPABILITY, structured (wave 105, lane 105A).
 * Owner: "managers never chat indefinitely — request → accept → work → return / reject / dissent /
 * escalate; observable". ONE kernel service over `manager_delegations` + append-only
 * `manager_delegation_events` (m712), inside the mission runtime (lib/kernel/missions.ts).
 *
 * SURVIVORS EVALUATED (none replaced — the m712 header carries the measurement):
 *   · manager-dissent.ts — THE survivor for "a manager disagrees and says WHY": EXTENDED with
 *     reviewDelegation (same ReviewVerdict vocabulary); the dissent path here records its verdict
 *     through it. It never carried a request lifecycle.
 *   · deliberation.ts — an argued debate on a collaboration domain, persisted on the referral row.
 *   · manager_signals + signal-registry / routing / coordination-kind — the BUS a delegation is
 *     ANNOUNCED on (delegation_handoff_requested / delegation_escalated); a signal has no objective,
 *     output, authority, budget, deadline, result or accept/return vocabulary.
 *   · voice-delegation.ts — a HUMAN's spoken instruction on the rails; not manager-to-manager.
 *   · missions.participating_managers — WHO is on a mission, not what one asked another for.
 *   · the capability catalogue — APP_CAPABILITY_REGISTRY keys with CAPABILITY_MANAGER naming the
 *     accountable manager (lib/agentic-os/capability-ownership.ts): ONE vocabulary (§6) — a
 *     delegation names a catalogue key, and only its OWNER may be assigned it (LAW 3: agents request
 *     capabilities, not vendors — the owning manager routes to the provider).
 *
 * INTEGRATION (wave 104 rule): tenant from the caller's VERIFIED context (session / event / cron /
 * the anchored row) and pinned on every read and write — a foreign id reads not_found; entitlement
 * mayUseAndAfford on the capability's paid lanes (paidCapabilitiesFor); authority ≤ the mission's
 * ceiling AND the assigned manager's ladder rung (resolveAgentAuthorityLevel); budget ≤ the mission's
 * remaining (usage/cost vocabulary: cost_usd + tokens) and a return that exhausts the delegation's
 * budget ESCALATES; every transition = a manager_delegation_events row + an agent_action_ledger row
 * (withActionLedger, reason_code MISSION_LIFECYCLE, detail.delegation_id — the mission runtime's one
 * WHY) + emitKernelEvent (auditOnly); the mission's evidence gets the delegation ref (attachEvidence)
 * and a RETURNED result is charged to the mission as an action (attachAction). Escalation goes
 * through escalateMission (owner manager + human). Memory: the request/return rows ARE the shared
 * record other managers read (pendingDelegationsFor — the Missions card, the context compiler).
 *
 * No `import "server-only"`: the proof (scripts/manager-delegation-guard.ts) drives the machine
 * through an in-memory client, as missions.ts allows.
 *
 * WIRED (every door has its real caller):
 *   · requestDelegation / acceptDelegation / startDelegationWork ← the listing-appt-prep chain's
 *     trigger (fireListingAppointmentSetForBooking, `delegate`), called by the AI ISA's booking paths
 *     with requestingManager ai_isa — the owner's example AI ISA → PREPARE_SELLER_APPOINTMENT
 *     (listing_appointment_prep) → Listing Concierge.
 *   · settleDelegationForRun ← the workflow engine (run completed → returnDelegationResult; run
 *     failed → escalateDelegation) and the stale-run reaper (a reaped run → escalateDelegation).
 *   · sweepDelegationDeadlines ← the ONE stale-run reaper tick (no second reaper).
 *   · rejectDelegation / dissentDelegation / cancelDelegation / escalateDelegation ← the human door
 *     app/actions/missions.ts decideDelegationAction (Missions card), beside the machine paths.
 *   · pendingDelegationsFor ← app/actions/missions.ts listMissionsAction (Missions card, per mission).
 */
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { currentCausation } from "@/lib/kernel/causation"
import { KernelEvent } from "@/lib/kernel/events"
import type { AuthorityLevel } from "@/lib/ai-isa/persona-tool-policy"
import type { DeadlineSource } from "@/lib/kernel/action-ledger"
import { CAPABILITY_MANAGER } from "@/lib/agentic-os/capability-ownership"
import { APP_CAPABILITY_REGISTRY, type AppCapability } from "@/lib/agentic-os/app-capability-registry"
import { reviewDelegation, REVIEW_MARK, type ReviewVerdict } from "@/lib/kernel/manager-dissent"
import {
  getMission, attachAction, attachEvidence, escalateMission, budgetExhausted,
  MISSION_LIFECYCLE_REASON, MISSION_TERMINAL_STATES, type MissionDeps, type MissionBudget, type MissionRow,
} from "@/lib/kernel/missions"

// ─── vocabularies (mirrors of the m712 CHECKs — one spelling, CLAUDE.md §6) ───────────────────
export const DELEGATION_STATUSES = ["REQUESTED", "ACCEPTED", "WORKING", "RETURNED", "REJECTED", "DISSENTED", "ESCALATED", "CANCELLED"] as const
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number]
export const DELEGATION_TERMINAL_STATUSES: ReadonlySet<DelegationStatus> = new Set(["RETURNED", "REJECTED", "CANCELLED"])
/** The statuses a human / the requesting manager must look at. */
export const DELEGATION_ATTENTION_STATUSES: ReadonlySet<DelegationStatus> = new Set(["DISSENTED", "ESCALATED"])
/** The manager signal types (catalogued in lib/kernel/signal-registry.ts). */
export const DELEGATION_REQUESTED_SIGNAL = "delegation_handoff_requested"
export const DELEGATION_ESCALATED_SIGNAL = "delegation_escalated"
/** The owner's spelling of the example, mapped onto the ONE catalogue key. */
export const PREPARE_SELLER_APPOINTMENT_CAPABILITY: AppCapability = "listing_appointment_prep"

/**
 * THE STATE MACHINE. A transition not listed here is refused (recorded as a `refused` event row,
 * never thrown). Terminal statuses have no exits.
 * @proofSeam the proof asserts every edge and every refusal directly
 */
export const DELEGATION_TRANSITIONS: Readonly<Record<DelegationStatus, readonly DelegationStatus[]>> = {
  REQUESTED: ["ACCEPTED", "REJECTED", "DISSENTED", "ESCALATED", "CANCELLED"],
  ACCEPTED:  ["WORKING", "REJECTED", "DISSENTED", "ESCALATED", "CANCELLED"],
  WORKING:   ["RETURNED", "DISSENTED", "ESCALATED", "CANCELLED"],
  DISSENTED: ["ACCEPTED", "REJECTED", "ESCALATED", "CANCELLED"],
  ESCALATED: ["ACCEPTED", "WORKING", "REJECTED", "CANCELLED"],
  RETURNED:  [],
  REJECTED:  [],
  CANCELLED: [],
}
/**
 * WAVE 153 (lane 153O, owner B8 — "only listing, contact and subject listed under manager delegation. missed transaction, lead"):
 * the FIRST-CLASS subjects a delegation may be about and the `input_entities` key each rides (no DB CHECK constrains the jsonb, and
 * missions.subject_type has none either — measured on scripts/check-vocabularies.ts, so no migration). Read most-specific first; the
 * snake_case spellings older callers wrote (listing-appt-prep, media-intelligence) are READ as the same subject (§6 — one subject,
 * whatever the spelling), and requestDelegation stamps the canonical `subject_type` / `subject_id` so containment and the subject
 * reader match on one key.
 */
export const DELEGATION_SUBJECT_KEYS = Object.freeze({ transaction: "transactionId", listing: "listingId", lead: "leadId", contact: "contactId" } as const)
export type DelegationSubjectType = keyof typeof DELEGATION_SUBJECT_KEYS
const LEGACY_SUBJECT_KEYS: Readonly<Record<DelegationSubjectType, string>> = { transaction: "transaction_id", listing: "listing_id", lead: "lead_id", contact: "contact_id" }
/** The subjects whose row is verified to sit in the delegation's tenant before anything is written (fail closed). Every
 *  DelegationSubjectType is anchored (wave 153, lane 153T — lane 153O outside-lane 3): lib/kernel/domain-api.ts forwards a
 *  request body's inputEntities here, so an unanchored contact / listing id was a cross-tenant subject. Each table is keyed on
 *  its PRIMARY key `id` (contacts.id, never the secondary contacts.contact_id — CLAUDE.md §3). */
export const TENANT_ANCHORED_SUBJECTS: Readonly<Record<DelegationSubjectType, string>> = Object.freeze({ lead: "leads", transaction: "transactions", contact: "contacts", listing: "listings" })

/** PURE. The delegation's subject (explicit subject_type/subject_id first, then the keyed ids most-specific first), or null. */
export function delegationSubjectOf(e: Record<string, unknown> | null | undefined): { type: DelegationSubjectType; id: string } | null {
  if (!e) return null
  const t = e.subject_type, id = e.subject_id
  if (typeof t === "string" && t in DELEGATION_SUBJECT_KEYS && typeof id === "string" && id) return { type: t as DelegationSubjectType, id }
  for (const k of Object.keys(DELEGATION_SUBJECT_KEYS) as DelegationSubjectType[]) {
    const v = e[DELEGATION_SUBJECT_KEYS[k]] ?? e[LEGACY_SUBJECT_KEYS[k]]
    if (typeof v === "string" && v) return { type: k, id: v }
  }
  return null
}

export function isDelegationStatus(v: unknown): v is DelegationStatus { return typeof v === "string" && (DELEGATION_STATUSES as readonly string[]).includes(v) }
export function canDelegationTransition(from: DelegationStatus, to: DelegationStatus): boolean { return DELEGATION_TRANSITIONS[from]?.includes(to) ?? false }

// ─── shapes ───────────────────────────────────────────────────────────────────────────────────
export interface DelegationActor { type: "manager" | "user" | "agent" | "system"; id?: string | null }
export interface DelegationBudget { usd?: number | null; tokens?: number | null }

export interface DelegationRow {
  id: string
  mission_id: string | null
  brokerage_id: string
  requesting_manager: ManagerKey
  assigned_manager: ManagerKey
  requested_capability: AppCapability
  objective: string
  input_entities: Record<string, unknown>
  required_output: Record<string, unknown>
  authority: AuthorityLevel
  budget: DelegationBudget
  spent_usd: number
  spent_tokens: number
  deadline: string | null
  status: DelegationStatus
  result: Record<string, unknown> | null
  evidence: Array<Record<string, unknown>>
  state_changed_at: string
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type DelegationResult = { ok: true; delegation: DelegationRow; duplicate?: boolean } | { ok: false; reason: string; delegation?: DelegationRow }

type Client = { from: (table: string) => any }

/** The literal column list (one read shape — a column-list variable hides columns from the census). */
const DELEGATION_COLS = "id, mission_id, brokerage_id, requesting_manager, assigned_manager, requested_capability, objective, input_entities, required_output, authority, budget, spent_usd, spent_tokens, deadline, status, result, evidence, state_changed_at, completed_at, created_at, updated_at"

/**
 * Test seams — every default is THE survivor (lazy imports keep this module off the proxy graph).
 * A proof swaps one to observe the evidence it writes; production never passes `deps`.
 */
export interface DelegationDeps {
  now?: () => Date
  afford?: (brokerageId: string, capability: string, est: { estCostUsd?: number; estTokens?: number }, client: Client) => Promise<{ allowed: boolean; reason: string }>
  authority?: (brokerageId: string, manager: ManagerKey, client: Client) => Promise<AuthorityLevel>
  ledger?: (ctx: LedgerCtx, client: Client) => Promise<string | null>
  emit?: (input: EmitCtx, client: Client) => Promise<void>
  signal?: (input: SignalCtx, client: Client) => Promise<void>
  /** Seams handed to the mission service for the calls this one makes into it. */
  mission?: MissionDeps
}
interface LedgerCtx {
  brokerageId: string; action: string; actor: DelegationActor; delegation: Pick<DelegationRow, "id" | "mission_id" | "requested_capability" | "requesting_manager" | "assigned_manager"> & { input_entities?: Record<string, unknown> | null; deadline?: string | null }; from: DelegationStatus | null; to: DelegationStatus; reason: string; causationId: string | null; correlationId: string | null; costUsd?: number | null
  /** WAVE 153 (153H, directive H3): the decision facts this transition persists on detail.governance (lib/kernel/action-ledger.ts governanceRecord). */
  governance?: { objective?: string | null; deadline?: string | null; deadlineSource?: DeadlineSource | null; conflicts?: string[]; evidenceRefs?: string[]; resourceConstraints?: string[]; policyConstraints?: string[] }
}
interface EmitCtx { brokerageId: string; event: string; delegationId: string; metadata: Record<string, unknown>; actorUserId: string | null; causationId: string | null; correlationId: string | null }
interface SignalCtx { brokerageId: string; fromManager: ManagerKey; toManager: ManagerKey; signalType: string; message: string; delegationId: string; payload: Record<string, unknown> }

const defaultDeps: Required<Omit<DelegationDeps, "mission">> & { mission: MissionDeps } = {
  now: () => new Date(),
  afford: async (brokerageId, capability, est, client) => {
    const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
    const d = await mayUseAndAfford({ brokerageId, capability, estCostUsd: est.estCostUsd, estTokens: est.estTokens, client })
    return { allowed: d.allowed, reason: d.reason }
  },
  authority: async (brokerageId, manager, client) => {
    const { resolveAgentAuthorityLevel } = await import("@/lib/managers/autonomy-gate")
    return resolveAgentAuthorityLevel(brokerageId, manager, client as any)
  },
  ledger: async (ctx, client) => {
    const { withActionLedger, governanceRecord } = await import("@/lib/kernel/action-ledger")
    // B8 (153O): the subject the ask is about (a Lead, a Transaction, a Contact, a Listing) rides every transition's evidence.
    const about = delegationSubjectOf(ctx.delegation.input_entities ?? null)
    // H3: the transition IS a governance decision (REQUESTED = DELEGATE, ESCALATED = ESCALATE, REJECTED = DENY, …) — the
    // facts ride detail.governance on the row the flight recorder already reads; the status pair is the version decided on.
    const governance = governanceRecord({
      plane: "delegation", verdict: ctx.to, scope: { brokerageId: ctx.brokerageId }, actor: { type: ctx.actor.type, id: ctx.actor.id ?? null },
      missionId: ctx.delegation.mission_id, causationId: ctx.causationId, correlationId: ctx.correlationId,
      entity: { type: "manager_delegation", id: ctx.delegation.id, version: ctx.from ?? "new" },
      objective: ctx.governance?.objective ?? null, candidates: [ctx.delegation.assigned_manager],
      deadline: ctx.governance?.deadline ?? null, deadlineSource: ctx.governance?.deadlineSource ?? null,
      policyConstraints: ctx.governance?.policyConstraints, resourceConstraints: ctx.governance?.resourceConstraints,
      conflicts: ctx.governance?.conflicts, rationale: ctx.reason, evidenceRefs: [...(ctx.governance?.evidenceRefs ?? []), ...(about ? [`${about.type}:${about.id}`] : [])],
      // WAVE 155 (155B3, directive §B3): the contract's facts — a manager / the system acting is first-party, a person at the
      // Missions door an authorized human; the review (reviewDelegation) permitted it; the delegation's deadline is the decision's
      // expiry; what happens next follows the status (the assignee acts · a person decides · nothing).
      trustClass: ctx.actor.type === "user" ? "authorized_human" : "verified_first_party", approvalBasis: "policy_permitted",
      dependencies: about ? [{ type: about.type, id: about.id, version: null }] : null,
      expiresAt: ctx.delegation.deadline ?? null,
      nextTrigger: ctx.to === "DISSENTED" || ctx.to === "ESCALATED" ? { kind: "human", detail: "the mission's owner or a person decides" }
        : ctx.to === "REJECTED" || ctx.to === "CANCELLED" ? { kind: "none" }
        : ctx.to === "RETURNED" ? null : { kind: "event", event: "manager_delegation.state_changed", detail: "the assignee accepts, works or returns" },
    })
    await withActionLedger(
      {
        brokerageId: ctx.brokerageId, action: ctx.action,
        actor: { type: ctx.actor.type, userId: ctx.actor.type === "user" ? ctx.actor.id ?? null : null, agentId: ctx.actor.type === "agent" ? ctx.actor.id ?? null : null, managerKey: ctx.actor.type === "manager" ? ctx.actor.id ?? null : null },
        subject: { type: "manager_delegation", id: ctx.delegation.id },
        reasonCode: MISSION_LIFECYCLE_REASON, reasonDetail: `delegation ${ctx.delegation.requested_capability} ${ctx.delegation.requesting_manager}→${ctx.delegation.assigned_manager}: ${ctx.reason}`,
        causationId: ctx.causationId, correlationId: ctx.correlationId,
        riskClass: "LOW_RISK_WRITE", systemSource: "manager-delegation",
        detail: { delegation_id: ctx.delegation.id, mission_id: ctx.delegation.mission_id, capability: ctx.delegation.requested_capability, requesting_manager: ctx.delegation.requesting_manager, assigned_manager: ctx.delegation.assigned_manager, from_status: ctx.from, to_status: ctx.to, governance, ...(about ? { subject_type: about.type, subject_id: about.id } : {}) },
      },
      async () => ({ status: "executed" as const, outcome: `${ctx.from ?? "∅"}→${ctx.to}` }),
      { settle: (r) => ({ status: r.status, outcome: r.outcome, costUsd: ctx.costUsd ?? null }), replay: () => ({ status: "executed" as const, outcome: "replay" }) },
      { client },
    )
    const { data } = await client.from("agent_action_ledger").select("id").eq("subject_type", "manager_delegation").eq("subject_id", ctx.delegation.id).order("created_at", { ascending: false }).limit(1).maybeSingle()
    return (data as { id?: string } | null)?.id ?? null
  },
  emit: async (input, client) => {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    await emitKernelEvent({
      event: input.event, brokerageId: input.brokerageId, entityType: "manager_delegation", entityId: input.delegationId,
      metadata: input.metadata, actorUserId: input.actorUserId, causationId: input.causationId, correlationId: input.correlationId,
      auditOnly: true, client,
    })
  },
  signal: async (input, client) => {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const r = await publishManagerSignal({
      brokerageId: input.brokerageId, fromManager: input.fromManager, toManager: input.toManager, signalType: input.signalType,
      message: input.message, entityType: "manager_delegation", entityId: input.delegationId, payload: input.payload,
    }, client as any)
    if (!r.ok) console.error(`[manager-delegation] signal ${input.signalType} not published: ${r.reason}`)
  },
  mission: {},
}

async function svcOf(client?: Client): Promise<Client> {
  if (client) return client
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient() as unknown as Client
}
function isManagerKey(v: unknown): v is ManagerKey { return typeof v === "string" && v in MANAGERS }
function isAppCapability(v: unknown): v is AppCapability { return typeof v === "string" && v in APP_CAPABILITY_REGISTRY }

/** PURE: the paid lanes a delegation's budget meters against (mayUseAndAfford vocabulary): the app
 *  itself always; `ai.generate` when tokens are budgeted; `comms.send` (the vendor-spend meter) when
 *  USD is budgeted on a send. @proofSeam the proof asserts the rule directly */
export function paidCapabilitiesFor(capability: AppCapability, budget: DelegationBudget): Array<{ capability: string; estCostUsd?: number; estTokens?: number }> {
  const out: Array<{ capability: string; estCostUsd?: number; estTokens?: number }> = [{ capability: "app.access" }]
  if (typeof budget.tokens === "number" && budget.tokens > 0) out.push({ capability: "ai.generate", estTokens: budget.tokens })
  const def = APP_CAPABILITY_REGISTRY[capability]
  if (typeof budget.usd === "number" && budget.usd > 0 && def && (def.domain === "marketing" || def.domain === "communications" || def.domain === "gifting")) out.push({ capability: "comms.send", estCostUsd: budget.usd })
  return out
}

/** PURE: what a mission has left (null = unmetered on that axis). @proofSeam the proof asserts the rule directly */
export function missionRemaining(m: Pick<MissionRow, "budget" | "spent_usd" | "spent_tokens"> | null): { usd: number | null; tokens: number | null } {
  if (!m) return { usd: null, tokens: null }
  const b: MissionBudget = m.budget ?? {}
  return {
    usd: typeof b.usd === "number" ? Math.max(0, b.usd - Number(m.spent_usd ?? 0)) : null,
    tokens: typeof b.tokens === "number" ? Math.max(0, b.tokens - Number(m.spent_tokens ?? 0)) : null,
  }
}

// ─── WAVE 153 (lane 153H) — FAILURE CONTAINMENT ON THE DELEGATION MACHINE (directive H5, canary 7) ────────────────
// Measured at 34124d98: (1) nothing refused an ask that CLOSED a wait-for cycle (A waits on B, B asks A for work A can only
// do after B returns — a lock cycle neither side can break); (2) a REJECTED ask could be re-filed against the same owner
// forever (ping-pong); (3) nothing bounded how many open asks one manager could be handed in one tenant; (4) a REJECTED
// delegation is terminal and drops out of pendingDelegationsFor, while the mission it served stayed ACTIVE with nobody told —
// a lost mission. Each rule below is deterministic; none asks a model.

/** A manager rejected the same capability on the same mission this many times → the next ask is refused and the mission
 *  goes to a human (bounded attempts, no ping-pong reassignment). */
const DELEGATION_MAX_REJECTED_ASKS = 2
/** Open (non-terminal) asks one manager may hold for ONE capability in ONE tenant. Counted per tenant, so a large tenant
 *  can never starve another tenant's capacity; a full queue is a refusal the mission's human sees, never a silent drop. */
const DELEGATION_OPEN_CAPACITY = 25

/**
 * PURE. The wait-for path a new ask `from → to` would CLOSE, or null. An open delegation is the edge
 * requesting → assigned ("requesting waits on assigned"); the new edge closes a cycle iff `to` already waits — directly or
 * through others — on `from`. Returned as [from, to, …, from] for the refusal's reason. Self-edges (a mission owner's work
 * order) never wait on anyone else and are ignored.
 */
function delegationWaitCycle(open: ReadonlyArray<{ requesting_manager: string; assigned_manager: string }>, from: string, to: string): string[] | null {
  if (from === to) return null
  const next = new Map<string, Set<string>>()
  for (const e of open) {
    if (e.requesting_manager === e.assigned_manager) continue
    if (!next.has(e.requesting_manager)) next.set(e.requesting_manager, new Set())
    next.get(e.requesting_manager)!.add(e.assigned_manager)
  }
  const prev = new Map<string, string>()
  const seen = new Set<string>([to])
  const queue = [to]
  while (queue.length) {
    const cur = queue.shift()!
    if (cur === from) {
      const path: string[] = [from]
      let p = from
      while (p !== to) { p = prev.get(p)!; path.unshift(p) }
      return [from, ...path]
    }
    for (const n of next.get(cur) ?? []) if (!seen.has(n)) { seen.add(n); prev.set(n, cur); queue.push(n) }
  }
  return null
}

// ─── reads ────────────────────────────────────────────────────────────────────────────────────
export async function getDelegation(brokerageId: string, delegationId: string, client?: Client): Promise<DelegationRow | null> {
  const svc = await svcOf(client)
  const { data, error } = await svc.from("manager_delegations").select(DELEGATION_COLS).eq("brokerage_id", brokerageId).eq("id", delegationId).maybeSingle()
  if (error) { console.error(`[manager-delegation] read refused: ${error.message}`); return null }
  return (data as DelegationRow | null) ?? null
}

export interface PendingDelegations { pending: DelegationRow[]; attention: DelegationRow[]; byMission: Record<string, DelegationRow[]>; readRefused: string | null }

/** Every non-terminal delegation of the tenant (optionally one mission's / one assignee's), the attention
 *  set (DISSENTED / ESCALATED) pulled out, grouped per mission. A refused read is PUBLISHED. */
export async function pendingDelegationsFor(brokerageId: string, opts: { missionId?: string | null; assignedManager?: ManagerKey | null; limit?: number; subject?: { type: DelegationSubjectType; id: string } | null } = {}, client?: Client): Promise<PendingDelegations> {
  const out: PendingDelegations = { pending: [], attention: [], byMission: {}, readRefused: null }
  if (!brokerageId) { out.readRefused = "no tenant"; return out }
  const svc = await svcOf(client)
  let q = svc.from("manager_delegations").select(DELEGATION_COLS).eq("brokerage_id", brokerageId)
    .in("status", DELEGATION_STATUSES.filter((s) => !DELEGATION_TERMINAL_STATUSES.has(s)))
  if (opts.missionId) q = q.eq("mission_id", opts.missionId)
  if (opts.assignedManager) q = q.eq("assigned_manager", opts.assignedManager)
  // WAVE 153 (153O, B8): one subject's open asks — a Lead's or a Transaction's (or a Contact's / Listing's) — on the stamped key.
  if (opts.subject) q = q.eq("input_entities->>subject_type", opts.subject.type).eq("input_entities->>subject_id", opts.subject.id)
  const { data, error } = await q.order("deadline", { ascending: true, nullsFirst: false }).limit(opts.limit ?? 200)
  if (error) { out.readRefused = error.message; return out }
  for (const d of (data ?? []) as DelegationRow[]) {
    out.pending.push(d)
    if (DELEGATION_ATTENTION_STATUSES.has(d.status)) out.attention.push(d)
    if (d.mission_id) (out.byMission[d.mission_id] ??= []).push(d)
  }
  return out
}

// ─── evidence (append-only) ───────────────────────────────────────────────────────────────────
async function appendEvent(svc: Client, d: Pick<DelegationRow, "id" | "brokerage_id">, e: {
  kind: "requested" | "transition" | "refused" | "review" | "evidence"
  from?: DelegationStatus | null; to?: DelegationStatus | null; reason?: string | null
  actor: DelegationActor; evidence?: Record<string, unknown>; ledgerEntryId?: string | null
}): Promise<void> {
  const c = currentCausation()
  const { error } = await svc.from("manager_delegation_events").insert({
    delegation_id: d.id, brokerage_id: d.brokerage_id, event_kind: e.kind,
    from_status: e.from ?? null, to_status: e.to ?? null, reason_code: MISSION_LIFECYCLE_REASON, reason: e.reason ?? null,
    actor_type: e.actor.type, actor_id: e.actor.id ?? null, evidence: e.evidence ?? {},
    ledger_entry_id: e.ledgerEntryId ?? null, causation_id: c.causationId, correlation_id: c.correlationId,
  })
  if (error) console.error(`[manager-delegation] manager_delegation_events append refused (${e.kind}): ${error.message}`)
}

/** The mission's evidence gets the delegation ref — through the mission service, never a raw write. Best-effort. */
async function noteOnMission(svc: Client, d: DelegationRow, kind: string, actor: DelegationActor, extra: Record<string, unknown>, deps: MissionDeps): Promise<void> {
  if (!d.mission_id) return
  const r = await attachEvidence({ brokerageId: d.brokerage_id, missionId: d.mission_id, evidence: { kind, ref: d.id, delegation_id: d.id, capability: d.requested_capability, requesting_manager: d.requesting_manager, assigned_manager: d.assigned_manager, status: d.status, ...extra }, actor }, svc, deps)
  if (!r.ok) console.error(`[manager-delegation] mission ${d.mission_id} evidence NOT recorded (${kind}): ${r.reason}`)
}

/** The ceiling an ask may not exceed and the mission's remaining budget — ONE resolution for request + dissent. */
async function reviewContextFor(brokerageId: string, assigned: ManagerKey, mission: MissionRow | null, d: Required<Pick<DelegationDeps, "authority" | "now">>, svc: Client) {
  const rung = await d.authority(brokerageId, assigned, svc)
  const ceiling = (mission ? Math.min(mission.authority_ceiling, rung) : rung) as AuthorityLevel
  const remaining = missionRemaining(mission)
  return { ceiling, remaining, now: d.now() }
}

// ─── request ──────────────────────────────────────────────────────────────────────────────────
export interface RequestDelegationInput {
  /** VERIFIED tenant (session / event / cron / the anchored row) — never a request body. */
  brokerageId: string
  missionId?: string | null
  requestingManager: ManagerKey
  assignedManager: ManagerKey
  capability: AppCapability
  objective: string
  inputEntities?: Record<string, unknown>
  requiredOutput?: Record<string, unknown>
  authority?: AuthorityLevel
  budget?: DelegationBudget
  deadline?: string | null
  /** WAVE 153 (153H, H3): where `deadline` came from (contractual / human_requested / consumer_reply / provider_deadline /
   *  campaign_opportunity). Unstated = `none` on the governance record — the deadline column is kept, never re-labelled. */
  deadlineSource?: DeadlineSource | null
  actor?: DelegationActor
  /** Wave 108: the mission OWNER's own step, as a work order to itself — admitted only for a capability
   *  with a worker (DELEGATION_WORKERS) on a mission that manager owns. Anything else stays self_delegation. */
  ownerWorkOrder?: boolean
}

export async function requestDelegation(input: RequestDelegationInput, client?: Client, deps: DelegationDeps = {}): Promise<DelegationResult> {
  const d = { ...defaultDeps, ...deps, mission: deps.mission ?? defaultDeps.mission }
  const svc = await svcOf(client)
  if (!input.brokerageId) return { ok: false, reason: "no_tenant" }
  if (!input.objective?.trim()) return { ok: false, reason: "objective_required" }
  if (!isManagerKey(input.requestingManager)) return { ok: false, reason: `unknown_requesting_manager:${String(input.requestingManager)}` }
  if (!isManagerKey(input.assignedManager)) return { ok: false, reason: `unknown_assigned_manager:${String(input.assignedManager)}` }
  // A manager never asks ITSELF — except a MISSION OWNER's WORK ORDER (wave 108): the mission owner's own
  // strategy step whose capability has a worker on its survivor (DELEGATION_WORKERS) rides the same
  // machine so it is accepted by a human and leaves the same evidence. Checked against the mission below.
  const workOrder = input.requestingManager === input.assignedManager && input.ownerWorkOrder === true && !!input.missionId && isAppCapability(input.capability) && !!DELEGATION_WORKERS[input.capability]
  if (input.requestingManager === input.assignedManager && !workOrder) return { ok: false, reason: "self_delegation" }
  // ONE capability vocabulary: a catalogue key, owned by the assignee per the registry (LAW 3).
  if (!isAppCapability(input.capability)) return { ok: false, reason: `unknown_capability:${String(input.capability)}` }
  const owner = CAPABILITY_MANAGER[input.capability]
  if (owner !== input.assignedManager) return { ok: false, reason: `capability_not_owned:${input.capability}:${owner}` }

  // WAVE 153 (153O, B8): the subject, first-class — the canonical subject_type / subject_id are stamped beside the caller's own keys,
  // and a LEAD or TRANSACTION must be a row of THIS tenant before anything is written (a foreign or invented id refuses, naming
  // nothing of the other tenant; a refused read refuses — fail closed). Text in the objective / entities is DATA: nothing here reads
  // it to pick the assignee, the capability, the authority or the tenant (those come from the typed fields and the registry).
  const subject = delegationSubjectOf(input.inputEntities)
  const entities: Record<string, unknown> = { ...(input.inputEntities ?? {}), ...(subject ? { subject_type: subject.type, subject_id: subject.id, [DELEGATION_SUBJECT_KEYS[subject.type]]: subject.id } : {}) }
  const anchorTable = subject ? TENANT_ANCHORED_SUBJECTS[subject.type] : undefined
  if (subject && anchorTable) {
    const { data: anchored, error: anchorErr } = await svc.from(anchorTable).select("id").eq("brokerage_id", input.brokerageId).eq("id", subject.id).maybeSingle()
    if (anchorErr) return { ok: false, reason: `read_refused:${anchorErr.message}` }
    if (!anchored) return { ok: false, reason: `subject_not_found:${subject.type}` }
  }

  // IDEMPOTENT per (capability, workflow run): the chain trigger re-fires on a deduped booking.
  const runId = typeof input.inputEntities?.workflow_run_id === "string" ? input.inputEntities.workflow_run_id : null
  if (runId) {
    const { data: prior, error: priorErr } = await svc.from("manager_delegations").select(DELEGATION_COLS)
      .eq("brokerage_id", input.brokerageId).eq("requested_capability", input.capability).eq("input_entities->>workflow_run_id", runId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (priorErr) return { ok: false, reason: `read_refused:${priorErr.message}` }
    if (prior) return { ok: true, delegation: prior as DelegationRow, duplicate: true }
  }

  let mission: MissionRow | null = null
  if (input.missionId) {
    mission = await getMission(input.brokerageId, input.missionId, svc)
    if (!mission) return { ok: false, reason: "mission_not_found" }
    if (MISSION_TERMINAL_STATES.has(mission.state)) return { ok: false, reason: `mission_terminal:${mission.state}` }
  }
  if (workOrder && mission?.owner_manager !== input.assignedManager) return { ok: false, reason: "self_delegation" }

  // WAVE 153 (153H): a POLICY refusal of a mission's step never strands the mission — it goes to its owner manager + a
  // human (APPROVAL_REQUIRED, an attention state on the Missions card) with the reason. Bounded: an already-escalated
  // mission refuses the second transition (invalid_transition), so N refused steps raise ONE escalation, not N.
  const policyRefusal = async (reason: string): Promise<DelegationResult> => {
    if (mission && !MISSION_TERMINAL_STATES.has(mission.state)) {
      const e = await escalateMission({ brokerageId: input.brokerageId, missionId: mission.id, reason: `step ${input.capability} (${MANAGERS[input.requestingManager].label} → ${MANAGERS[input.assignedManager].label}) refused: ${reason}`, actor: input.actor ?? { type: "manager", id: input.requestingManager }, needsHuman: true }, svc, d.mission)
      if (!e.ok && !e.reason.startsWith("invalid_transition")) console.error(`[manager-delegation] mission ${mission.id} NOT escalated after a refused step: ${e.reason}`)
    }
    return { ok: false, reason }
  }

  // H5 CONTAINMENT — read from the tenant's own rows; a refused read refuses (fail closed, never "nobody checked").
  if (!workOrder) {
    const openStatuses = DELEGATION_STATUSES.filter((s) => !DELEGATION_TERMINAL_STATUSES.has(s))
    // B8: containment is per SUBJECT on the one stamped key (contact / lead / listing / transaction, or a strategy's territory /
    // brokerage subject_id) — a Lead's or a Transaction's asks are bounded exactly like a Contact's.
    const subjectId = subject?.id ?? (typeof entities.subject_id === "string" && entities.subject_id ? entities.subject_id : null)
    if (mission || subjectId) {
      let q = svc.from("manager_delegations").select("id, requesting_manager, assigned_manager, requested_capability, status, state_changed_at, updated_at").eq("brokerage_id", input.brokerageId)
      q = mission ? q.eq("mission_id", mission.id) : q.is("mission_id", null).eq("input_entities->>subject_id", String(subjectId))
      const { data: peers, error: peerErr } = await q.limit(500)
      if (peerErr) return { ok: false, reason: `read_refused:${peerErr.message}` }
      const rows = (peers ?? []) as Array<Pick<DelegationRow, "id" | "requesting_manager" | "assigned_manager" | "requested_capability" | "status" | "state_changed_at" | "updated_at">>
      const cycle = delegationWaitCycle(rows.filter((r) => !DELEGATION_TERMINAL_STATUSES.has(r.status)), input.requestingManager, input.assignedManager)
      if (cycle) return policyRefusal(`circular_delegation:${cycle.join("→")} — ${MANAGERS[input.assignedManager].label} is already waiting on ${MANAGERS[input.requestingManager].label} here; asking back would deadlock both`)
      let rejectedRows = rows.filter((r) => r.status === "REJECTED" && r.requested_capability === input.capability && r.assigned_manager === input.assignedManager)
      // WAVE 154 (lane 154A2, canary P8): "a person decides instead of a third ask" — and once a PERSON has decided (resumed the
      // escalated mission: APPROVAL_REQUIRED → ACTIVE by a user), the refusals before that decision are not held against the
      // resumed work. Before this the bound counted every refusal forever, so the human's resume could never recover the step
      // (each new ask was refused attempts_exhausted and re-escalated the mission). A manager-initiated resume does not reset it.
      if (mission && rejectedRows.length >= DELEGATION_MAX_REJECTED_ASKS) {
        const { data: resumes, error: resumeErr } = await svc.from("mission_events").select("created_at").eq("brokerage_id", input.brokerageId).eq("mission_id", mission.id)
          .eq("event_kind", "transition").eq("from_state", "APPROVAL_REQUIRED").eq("to_state", "ACTIVE").eq("actor_type", "user").order("created_at", { ascending: false }).limit(1)
        if (resumeErr) return { ok: false, reason: `read_refused:${resumeErr.message}` }
        const resumedAt = ((resumes ?? []) as Array<{ created_at: string | null }>)[0]?.created_at ?? null
        if (resumedAt) rejectedRows = rejectedRows.filter((r) => (r.state_changed_at ?? r.updated_at ?? "") > resumedAt)
      }
      const rejected = rejectedRows.length
      if (rejected >= DELEGATION_MAX_REJECTED_ASKS) return policyRefusal(`attempts_exhausted:${input.capability} was rejected ${rejected} time(s) by ${MANAGERS[input.assignedManager].label} here — a person decides instead of a third ask`)
    }
    const { data: queue, error: queueErr } = await svc.from("manager_delegations").select("id").eq("brokerage_id", input.brokerageId)
      .eq("assigned_manager", input.assignedManager).eq("requested_capability", input.capability).in("status", openStatuses).limit(DELEGATION_OPEN_CAPACITY + 1)
    if (queueErr) return { ok: false, reason: `read_refused:${queueErr.message}` }
    if ((queue ?? []).length >= DELEGATION_OPEN_CAPACITY) return policyRefusal(`overloaded:${MANAGERS[input.assignedManager].label} already holds ${DELEGATION_OPEN_CAPACITY} open ${input.capability} asks in this account`)
  }

  // AUTHORITY ≤ ceiling (mission + ladder) and BUDGET ≤ remaining — the ONE evaluator (manager-dissent).
  const authority = (input.authority ?? 0) as AuthorityLevel
  const budget: DelegationBudget = input.budget ?? {}
  const ctx = await reviewContextFor(input.brokerageId, input.assignedManager, mission, d, svc)
  const review = reviewDelegation(
    { requestingManager: input.requestingManager, assignedManager: input.assignedManager, capability: input.capability, objective: input.objective, authority, budget, deadline: input.deadline ?? null },
    { capabilityOwner: owner, authorityCeiling: ctx.ceiling, remainingUsd: ctx.remaining.usd, remainingTokens: ctx.remaining.tokens, now: ctx.now },
  )
  if (review.verdict !== "pass") return policyRefusal(`${review.codes[0]}:${review.objections[0]}`)

  // ENTITLEMENT — the capability's paid lanes (fail closed: a refused answer is a refusal).
  for (const lane of paidCapabilitiesFor(input.capability, budget)) {
    const afford = await d.afford(input.brokerageId, lane.capability, { estCostUsd: lane.estCostUsd, estTokens: lane.estTokens }, svc)
    if (!afford.allowed) return policyRefusal(`entitlement:${lane.capability}:${afford.reason}`)
  }

  const actor: DelegationActor = input.actor ?? { type: "manager", id: input.requestingManager }
  const { data, error } = await svc.from("manager_delegations").insert({
    mission_id: mission?.id ?? null, brokerage_id: input.brokerageId,
    requesting_manager: input.requestingManager, assigned_manager: input.assignedManager, requested_capability: input.capability,
    objective: input.objective.trim(), input_entities: entities, required_output: input.requiredOutput ?? {},
    authority, budget, deadline: input.deadline ?? null, status: "REQUESTED",
  }).select(DELEGATION_COLS).single()
  if (error || !data) return { ok: false, reason: `insert_refused:${error?.message ?? "no row"}` }
  const row = data as DelegationRow

  const c = currentCausation()
  const ledgerId = await d.ledger({ brokerageId: row.brokerage_id, action: "delegation.request.create", actor, delegation: row, from: null, to: "REQUESTED", reason: `requested: ${row.objective}`, causationId: c.causationId, correlationId: c.correlationId,
    governance: { objective: row.objective, deadline: row.deadline, deadlineSource: input.deadlineSource ?? null, policyConstraints: [`authority ${authority} ≤ ceiling ${ctx.ceiling}`, `capability owner ${owner}`], resourceConstraints: [`budget ${JSON.stringify(budget)}`, `mission remaining ${JSON.stringify(ctx.remaining)}`], evidenceRefs: mission ? [`mission:${mission.id}`] : [] } }, svc)
  await appendEvent(svc, row, { kind: "requested", to: "REQUESTED", reason: "requested", actor, ledgerEntryId: ledgerId, evidence: { capability: row.requested_capability, authority, authority_ceiling: ctx.ceiling, budget, mission_remaining: ctx.remaining, deadline: row.deadline, input_entities: row.input_entities } })
  await d.emit({ brokerageId: row.brokerage_id, event: KernelEvent.MANAGER_DELEGATION_REQUESTED, delegationId: row.id, metadata: { delegation_id: row.id, mission_id: row.mission_id, capability: row.requested_capability, requesting_manager: row.requesting_manager, assigned_manager: row.assigned_manager, status: "REQUESTED" }, actorUserId: actor.type === "user" ? actor.id ?? null : null, causationId: c.causationId, correlationId: c.correlationId }, svc)
  await d.signal({ brokerageId: row.brokerage_id, fromManager: row.requesting_manager, toManager: row.assigned_manager, signalType: DELEGATION_REQUESTED_SIGNAL, message: `${MANAGERS[row.requesting_manager].label} asks ${MANAGERS[row.assigned_manager].label} for ${row.requested_capability}: ${row.objective}`, delegationId: row.id, payload: { capability: row.requested_capability, authority, budget, deadline: row.deadline, mission_id: row.mission_id } }, svc)
  await noteOnMission(svc, row, "delegation_requested", actor, { authority, budget, deadline: row.deadline }, d.mission)
  return { ok: true, delegation: row }
}

// ─── transition (the one writer of `status`) ──────────────────────────────────────────────────
interface TransitionInput { brokerageId: string; delegationId: string; to: DelegationStatus; reason: string; actor?: DelegationActor; evidence?: Record<string, unknown>; patch?: Record<string, unknown>; costUsd?: number | null }

async function transitionDelegation(input: TransitionInput, svc: Client, d: typeof defaultDeps): Promise<DelegationResult & { ledgerEntryId?: string | null }> {
  const actor = input.actor ?? { type: "system" }
  const row = await getDelegation(input.brokerageId, input.delegationId, svc)
  if (!row) return { ok: false, reason: "not_found" }
  const from: DelegationStatus = row.status
  if (!isDelegationStatus(input.to)) return { ok: false, reason: `unknown_status:${String(input.to)}`, delegation: row }
  if (!canDelegationTransition(from, input.to)) {
    await appendEvent(svc, row, { kind: "refused", from, to: input.to, reason: `refused: ${from} → ${input.to} is not a transition (${input.reason})`, actor, evidence: input.evidence })
    return { ok: false, reason: `invalid_transition:${from}->${input.to}`, delegation: row }
  }
  const now = d.now().toISOString()
  const patch: Record<string, unknown> = { ...(input.patch ?? {}), status: input.to, state_changed_at: now, updated_at: now }
  if (DELEGATION_TERMINAL_STATUSES.has(input.to)) patch.completed_at = now
  const { data: updated, error } = await svc.from("manager_delegations").update(patch).eq("brokerage_id", input.brokerageId).eq("id", row.id).eq("status", from).select(DELEGATION_COLS)
  if (error) return { ok: false, reason: `update_refused:${error.message}`, delegation: row }
  if (!Array.isArray(updated) || updated.length !== 1) {
    // WAVE 155 (lane 155B3, directive §B3 — "a later write on a changed entity is a conflict"): the compare-and-set on the version
    // this transition READ (status `from`) picked ONE writer. The loser used to return `raced` and leave nothing; its refusal is now
    // a typed record on the delegation's evidence — the accountable decider (the assigned manager, the subject's owner for this
    // capability), the winning version, and this proposal HELD with a fresh re-evaluation as its next trigger. No second resolver.
    const about = delegationSubjectOf(row.input_entities ?? null)
    const { governanceArbitration } = await import("@/lib/kernel/action-ledger")
    const arbitration = governanceArbitration({
      // A listing / unanchored ask is a version conflict outside the four named classes: its class reads null (said, never guessed).
      conflictClass: about?.type === "transaction" ? "same_transaction_terms" : "entity_version", // 156M: a race on a delegation ABOUT a contact is not a touch (same_contact's one decider is the AI ISA)
      decider: row.assigned_manager, survivor: "lib/kernel/manager-delegation.ts transitionDelegation (compare-and-set on the status read)",
      winner: { manager: null, ref: `a concurrent transition moved ${from} first` },
      loser: { manager: actor.type === "manager" ? actor.id ?? null : null, ref: `${from}→${input.to}`, outcome: "HOLD", nextTrigger: { kind: "re_evaluate", detail: "re-read the delegation and decide on its current version" } },
      secondWriter: true,
    })
    await appendEvent(svc, row, { kind: "refused", from, to: input.to, reason: `refused: the delegation moved from ${from} under this transition (${input.reason})`, actor, evidence: { ...(input.evidence ?? {}), arbitration, ...(about ? { subject_type: about.type, subject_id: about.id } : {}) } })
    return { ok: false, reason: "raced:status_moved_under_us", delegation: row }
  }
  const next = updated[0] as DelegationRow

  const c = currentCausation()
  const ledgerId = await d.ledger({ brokerageId: row.brokerage_id, action: "delegation.status.transition", actor, delegation: row, from, to: input.to, reason: input.reason, causationId: c.causationId, correlationId: c.correlationId, costUsd: input.costUsd ?? null,
    governance: { objective: row.objective, evidenceRefs: row.mission_id ? [`mission:${row.mission_id}`] : [] } }, svc)
  await appendEvent(svc, row, { kind: "transition", from, to: input.to, reason: input.reason, actor, ledgerEntryId: ledgerId, evidence: input.evidence })
  await d.emit({ brokerageId: row.brokerage_id, event: KernelEvent.MANAGER_DELEGATION_STATE_CHANGED, delegationId: row.id, metadata: { delegation_id: row.id, mission_id: row.mission_id, capability: row.requested_capability, from_status: from, to_status: input.to, reason: input.reason, requesting_manager: row.requesting_manager, assigned_manager: row.assigned_manager }, actorUserId: actor.type === "user" ? actor.id ?? null : null, causationId: c.causationId, correlationId: c.correlationId }, svc)
  return { ok: true, delegation: next, ledgerEntryId: ledgerId }
}

function withDeps(deps: DelegationDeps) { return { ...defaultDeps, ...deps, mission: deps.mission ?? defaultDeps.mission } }
type Door = { brokerageId: string; delegationId: string; reason?: string; actor?: DelegationActor }

/** The assigned manager takes the ask (REQUESTED / DISSENTED / ESCALATED → ACCEPTED). */
export async function acceptDelegation(p: Door, client?: Client, deps: DelegationDeps = {}): Promise<DelegationResult> {
  const d = withDeps(deps); const svc = await svcOf(client)
  const r = await transitionDelegation({ brokerageId: p.brokerageId, delegationId: p.delegationId, to: "ACCEPTED", reason: p.reason ?? "accepted", actor: p.actor }, svc, d)
  if (r.ok) await noteOnMission(svc, r.delegation, "delegation_accepted", p.actor ?? { type: "manager", id: r.delegation.assigned_manager }, {}, d.mission)
  return r
}

/** The assigned manager starts (ACCEPTED / ESCALATED → WORKING). */
export async function startDelegationWork(p: Door, client?: Client, deps: DelegationDeps = {}): Promise<DelegationResult> {
  const d = withDeps(deps); const svc = await svcOf(client)
  return transitionDelegation({ brokerageId: p.brokerageId, delegationId: p.delegationId, to: "WORKING", reason: p.reason ?? "work started", actor: p.actor }, svc, d)
}

/**
 * The assigned manager returns the result (WORKING → RETURNED). The spend is recorded in the usage/
 * cost vocabulary; a return that EXHAUSTS the delegation's budget lands as ESCALATED instead (the
 * result is kept — the overspend is what needs a decision). The mission is charged through
 * attachAction (its own budget / ceiling rules apply) and its evidence gets the ref.
 */
export async function returnDelegationResult(p: Door & { result: Record<string, unknown>; costUsd?: number | null; tokens?: number | null }, client?: Client, deps: DelegationDeps = {}): Promise<DelegationResult & { escalated?: boolean }> {
  const d = withDeps(deps); const svc = await svcOf(client)
  const row = await getDelegation(p.brokerageId, p.delegationId, svc)
  if (!row) return { ok: false, reason: "not_found" }
  const spentUsd = Number(row.spent_usd ?? 0) + Math.max(0, p.costUsd ?? 0)
  const spentTokens = Number(row.spent_tokens ?? 0) + Math.max(0, p.tokens ?? 0)
  const exhausted = budgetExhausted(row.budget ?? {}, spentUsd, spentTokens)
  const actor = p.actor ?? { type: "manager", id: row.assigned_manager }
  const patch = { result: p.result, spent_usd: spentUsd, spent_tokens: spentTokens }
  const evidence = { result: p.result, cost_usd: p.costUsd ?? 0, tokens: p.tokens ?? 0, spent_usd: spentUsd, spent_tokens: spentTokens, budget: row.budget }
  const r = exhausted
    ? await transitionDelegation({ brokerageId: p.brokerageId, delegationId: row.id, to: "ESCALATED", reason: `budget exhausted on return: $${spentUsd.toFixed(2)} / ${spentTokens} tokens against ${JSON.stringify(row.budget ?? {})} — ${p.reason ?? "result returned"}`, actor, evidence, patch, costUsd: p.costUsd ?? null }, svc, d)
    : await transitionDelegation({ brokerageId: p.brokerageId, delegationId: row.id, to: "RETURNED", reason: p.reason ?? "result returned", actor, evidence, patch, costUsd: p.costUsd ?? null }, svc, d)
  if (!r.ok) return r
  if (exhausted) {
    await raiseEscalation(svc, r.delegation, actor, r.delegation.status === "ESCALATED" ? "budget exhausted on return" : "", d)
  }
  if (row.mission_id && r.ledgerEntryId) {
    const a = await attachAction({ brokerageId: p.brokerageId, missionId: row.mission_id, ledgerEntryId: r.ledgerEntryId, costUsd: p.costUsd ?? null, tokens: p.tokens ?? null, actor, detail: { delegation_id: row.id, capability: row.requested_capability } }, svc, d.mission)
    if (!a.ok) console.error(`[manager-delegation] mission ${row.mission_id} NOT charged for delegation ${row.id}: ${a.reason}`)
  }
  await noteOnMission(svc, r.delegation, exhausted ? "delegation_escalated" : "delegation_returned", actor, { cost_usd: p.costUsd ?? 0, tokens: p.tokens ?? 0, result_keys: Object.keys(p.result ?? {}) }, d.mission)
  return { ...r, escalated: exhausted }
}

/** The assigned manager declines the ask with a reason (→ REJECTED, terminal). */
export async function rejectDelegation(p: Door & { reason: string }, client?: Client, deps: DelegationDeps = {}): Promise<DelegationResult> {
  const d = withDeps(deps); const svc = await svcOf(client)
  if (!p.reason?.trim()) return { ok: false, reason: "reason_required" }
  const r = await transitionDelegation({ brokerageId: p.brokerageId, delegationId: p.delegationId, to: "REJECTED", reason: p.reason.trim(), actor: p.actor }, svc, d)
  if (r.ok) {
    const actor = p.actor ?? { type: "manager" as const, id: r.delegation.assigned_manager }
    await noteOnMission(svc, r.delegation, "delegation_rejected", actor, { reason: p.reason.trim() }, d.mission)
    // WAVE 153 (153H): REJECTED is terminal and leaves pendingDelegationsFor — so the refusal is RAISED, never stranded. The
    // capability has ONE registered owner (CAPABILITY_MANAGER), so there is no lawful second manager to reroute to: the safe
    // reroute IS the escalation — the requester (or the mission's owner) and a human decide, with the rejection's reason.
    await raiseEscalation(svc, r.delegation, actor, `rejected by ${MANAGERS[r.delegation.assigned_manager].label}: ${p.reason.trim()}`, d, "rejected")
  }
  return r
}

/**
 * DISSENT — the assigned manager disagrees and says WHY, through the dissent survivor
 * (reviewDelegation): the verdict + objections are recorded as a `review` event row and on the
 * delegation's evidence (REVIEW_MARK), the status moves to DISSENTED and the requester / a human
 * decides (re-accept, reject, escalate, cancel). A review with nothing to object to is refused.
 */
export async function dissentDelegation(p: Door & { objections: string[] }, client?: Client, deps: DelegationDeps = {}): Promise<DelegationResult & { review?: ReviewVerdict }> {
  const d = withDeps(deps); const svc = await svcOf(client)
  const row = await getDelegation(p.brokerageId, p.delegationId, svc)
  if (!row) return { ok: false, reason: "not_found" }
  const mission = row.mission_id ? await getMission(p.brokerageId, row.mission_id, svc) : null
  const ctx = await reviewContextFor(p.brokerageId, row.assigned_manager, mission, d, svc)
  const review = reviewDelegation(
    { requestingManager: row.requesting_manager, assignedManager: row.assigned_manager, capability: row.requested_capability, objective: row.objective, authority: row.authority, budget: row.budget ?? {}, deadline: row.deadline },
    { capabilityOwner: CAPABILITY_MANAGER[row.requested_capability] ?? null, authorityCeiling: ctx.ceiling, remainingUsd: ctx.remaining.usd, remainingTokens: ctx.remaining.tokens, now: ctx.now, objections: p.objections },
  )
  if (review.verdict === "pass") return { ok: false, reason: "nothing_to_dissent", delegation: row, review }
  const actor = p.actor ?? { type: "manager", id: row.assigned_manager }
  const reviewRow = { kind: "review", mark: REVIEW_MARK, reviewer: row.assigned_manager, verdict: review.verdict, objections: review.objections, codes: review.codes, at: d.now().toISOString() }
  await appendEvent(svc, row, { kind: "review", actor, reason: `${REVIEW_MARK} ${MANAGERS[row.assigned_manager].label} ${review.verdict === "veto" ? "VETOES" : "DISSENTS"}: ${review.objections.join("; ")}`, evidence: reviewRow })
  const r = await transitionDelegation({ brokerageId: p.brokerageId, delegationId: row.id, to: "DISSENTED", reason: `${review.verdict}: ${review.objections.join("; ")}`, actor, evidence: reviewRow, patch: { evidence: [...(row.evidence ?? []), reviewRow] } }, svc, d)
  if (r.ok) await noteOnMission(svc, r.delegation, "delegation_dissented", actor, { verdict: review.verdict, objections: review.objections }, d.mission)
  return { ...r, review }
}

/** The escalation fan-out: the signal to whoever can act, and the mission (owner manager + human). */
async function raiseEscalation(svc: Client, row: DelegationRow, actor: DelegationActor, reason: string, d: typeof defaultDeps, kind: "escalated" | "rejected" = "escalated"): Promise<void> {
  const mission = row.mission_id ? await getMission(row.brokerage_id, row.mission_id, svc) : null
  const fromMgr: ManagerKey = actor.type === "manager" && isManagerKey(actor.id) ? actor.id : "cron_manager"
  const toMgr: ManagerKey = mission && mission.owner_manager !== fromMgr ? mission.owner_manager : row.requesting_manager !== fromMgr ? row.requesting_manager : row.assigned_manager
  await d.signal({ brokerageId: row.brokerage_id, fromManager: fromMgr, toManager: toMgr, signalType: DELEGATION_ESCALATED_SIGNAL, message: `Delegation ${row.requested_capability} (${MANAGERS[row.requesting_manager].label} → ${MANAGERS[row.assigned_manager].label}) is ${kind === "rejected" ? "REJECTED — the step needs a decision" : "ESCALATED"}: ${reason}`, delegationId: row.id, payload: { reason, kind, deadline: row.deadline, mission_id: row.mission_id, capability: row.requested_capability } }, svc)
  if (mission && !MISSION_TERMINAL_STATES.has(mission.state)) {
    const e = await escalateMission({ brokerageId: row.brokerage_id, missionId: mission.id, reason: `delegation ${row.requested_capability} ${kind}: ${reason}`, actor, needsHuman: true }, svc, d.mission)
    if (!e.ok && !e.reason.startsWith("invalid_transition")) console.error(`[manager-delegation] mission ${mission.id} NOT escalated for delegation ${row.id}: ${e.reason}`)
  }
}

/** → ESCALATED: the signal goes to the mission's owner (or the requester) and the mission is escalated to its owner manager + the human. */
export async function escalateDelegation(p: Door & { reason: string }, client?: Client, deps: DelegationDeps = {}): Promise<DelegationResult> {
  const d = withDeps(deps); const svc = await svcOf(client)
  const r = await transitionDelegation({ brokerageId: p.brokerageId, delegationId: p.delegationId, to: "ESCALATED", reason: p.reason, actor: p.actor }, svc, d)
  if (!r.ok) return r
  const actor = p.actor ?? { type: "system" }
  await raiseEscalation(svc, r.delegation, actor, p.reason, d)
  await noteOnMission(svc, r.delegation, "delegation_escalated", actor, { reason: p.reason }, d.mission)
  return r
}

/** → CANCELLED (terminal): the requester or a human withdraws the ask. */
export async function cancelDelegation(p: Door & { reason: string }, client?: Client, deps: DelegationDeps = {}): Promise<DelegationResult> {
  const d = withDeps(deps); const svc = await svcOf(client)
  const r = await transitionDelegation({ brokerageId: p.brokerageId, delegationId: p.delegationId, to: "CANCELLED", reason: p.reason, actor: p.actor }, svc, d)
  if (r.ok) await noteOnMission(svc, r.delegation, "delegation_cancelled", p.actor ?? { type: "system" }, { reason: p.reason }, d.mission)
  return r
}

// ─── WAVE 108 — capability WORKERS on their survivors ─────────────────────────────────────────
// The three catalogue capabilities the owner approved (the 107E strategy library's named gaps) are
// WORKED here once an ACCEPTED delegation reaches them: ACCEPTED → WORKING → the survivor → RETURNED
// (or ESCALATED with the survivor's own reason). Each worker is a lazy import of the survivor that
// already owns the write — this module adds no second recruiting / ads / lender path. The human who
// accepted on the Missions card is the acting user (entitlement + created_by for the ads draft).
type WorkerOutcome = { ok: true; result: Record<string, unknown>; costUsd?: number | null } | { ok: false; reason: string }
type DelegationWorker = (svc: Client, row: DelegationRow, actor: { userId: string | null }) => Promise<WorkerOutcome>

export const DELEGATION_WORKERS: Readonly<Partial<Record<AppCapability, DelegationWorker>>> = Object.freeze({
  recruit_outreach: async (svc, row) => {
    const { recruitOutreachCapability } = await import("@/lib/agents/recruit-outreach-producer")
    const r = await recruitOutreachCapability(row.brokerage_id, { recruitIds: row.input_entities?.recruitIds, staleDays: row.input_entities?.staleDays }, svc as any)
    return r.ok ? { ok: true, result: { proposed: r.proposed, scanned: r.scanned, skipped: r.skipped, via: "lib/agents/recruit-outreach-producer.ts" } } : { ok: false, reason: r.reason }
  },
  ad_campaign_launch: async (_svc, row, actor) => {
    if (!actor.userId) return { ok: false, reason: "an ad campaign draft needs the accepting human as its creator — accept it on the Missions card" }
    const { adCampaignLaunchCapability } = await import("@/lib/kernel/ads")
    const r = await adCampaignLaunchCapability({ brokerageId: row.brokerage_id, userId: actor.userId, delegationInput: row.input_entities ?? {}, budgetUsd: row.budget?.usd ?? null, objective: row.objective })
    return r.ok ? { ok: true, result: { campaignId: r.campaignId, status: "draft", locations: r.locations, lifetimeBudget: r.lifetimeBudget, via: "lib/kernel/ads.ts createAdCampaign" } } : { ok: false, reason: r.reason }
  },
  lender_preapproval_handoff: async (svc, row, actor) => {
    const contactId = typeof row.input_entities?.contactId === "string" ? row.input_entities.contactId : null
    if (!contactId) return { ok: false, reason: "no buyer contact on the delegation (input_entities.contactId)" }
    const { lenderPreapprovalHandoff } = await import("@/lib/kernel/lender-linkage")
    const lenderVendorId = typeof row.input_entities?.lenderVendorId === "string" ? row.input_entities.lenderVendorId : null
    const r = await lenderPreapprovalHandoff(svc, { brokerageId: row.brokerage_id, contactId, lenderVendorId, actorUserId: actor.userId })
    if (r.ok) return { ok: true, result: { contactId: r.contactId, lenderVendorId: r.lenderVendorId, lenderName: r.lenderName, via: "lib/kernel/lender-linkage.ts recordLenderReferral" } }
    return { ok: false, reason: r.needsChoice ? `${r.reason}: ${r.needsChoice.map((v) => v.name ?? v.id).join(", ")}` : r.reason }
  },
  // Wave 138C — the 137E strategy library's two named gaps, each worked on its survivor.
  // compliance_review: READ-ONLY — the compliance engine (lib/compliance-rules/compliance-engine.ts, which loads the
  // tenant's state rules from the law-rule registry's rows) returns a verdict; nothing is edited, sent or approved.
  compliance_review: async (_svc, row) => {
    const content = typeof row.input_entities?.content === "string" ? row.input_entities.content.trim() : ""
    if (!content) return { ok: false, reason: "no content to review (input_entities.content)" }
    const { evaluateContentCompliance } = await import("@/lib/compliance-rules/compliance-engine")
    const v = await evaluateContentCompliance({
      content_type: typeof row.input_entities?.contentType === "string" ? row.input_entities.contentType : "marketing_copy",
      channel_intent: typeof row.input_entities?.channel === "string" ? row.input_entities.channel : "unspecified",
      raw_content: content.slice(0, 20_000),
      brokerage_id: row.brokerage_id,
    })
    return { ok: true, result: { verdict: v.compliance_status, violations: v.violations.map((x) => ({ rule: x.rule_name, severity: x.severity, reference: x.regulation_reference ?? null, excerpt: x.offending_excerpt ?? null, fix: x.suggested_fix ?? null })), highest_severity: v.summary.highest_severity, required_actions: v.required_actions, via: "lib/compliance-rules/compliance-engine.ts evaluateContentCompliance" } }
  },
  // agent_coaching_assign: ONE adaptive development cycle (lib/education/skill-freshness-radar.ts) for an agent of
  // THIS tenant — the agent row is read with the delegation's brokerage_id, never trusted from the ask.
  agent_coaching_assign: async (svc, row) => {
    const agentId = typeof row.input_entities?.agentId === "string" ? row.input_entities.agentId : null
    if (!agentId) return { ok: false, reason: "no agent on the delegation (input_entities.agentId)" }
    const { data: agent, error } = await svc.from("agents").select("id, user_id, brokerage_id").eq("brokerage_id", row.brokerage_id).eq("id", agentId).maybeSingle()
    if (error) return { ok: false, reason: `agents read refused: ${error.message}` }
    if (!agent) return { ok: false, reason: "agent not found in this brokerage" }
    const { runAdaptiveDevelopmentCycle } = await import("@/lib/education/skill-freshness-radar")
    const r = await runAdaptiveDevelopmentCycle(svc as any, agent as { id: string; user_id: string | null; brokerage_id: string })
    return { ok: true, result: { agentId: r.agentId, weakest: r.weakest.map((w) => w.skill), assigned: r.recommended.filter((x) => x.assigned).map((x) => ({ skill: x.skill, moduleId: x.moduleId, title: x.title })), assessments: r.assessments.length, refusedRails: r.refusedRails, replayed: r.replayed, via: "lib/education/skill-freshness-radar.ts runAdaptiveDevelopmentCycle" } }
  },
})

/**
 * Work an ACCEPTED delegation whose capability has a worker. Not ACCEPTED, or no worker → nothing
 * happens (`worked: false`, said why). A survivor refusal ESCALATES the delegation with that reason —
 * never a silent stall, never a RETURNED that did nothing.
 */
export async function workDelegation(p: Door & { userId: string | null }, client?: Client, deps: DelegationDeps = {}): Promise<{ worked: boolean; reason?: string; result?: DelegationResult }> {
  const svc = await svcOf(client)
  const row = await getDelegation(p.brokerageId, p.delegationId, svc)
  if (!row) return { worked: false, reason: "not_found" }
  const worker = DELEGATION_WORKERS[row.requested_capability]
  if (!worker) return { worked: false, reason: `no worker for ${row.requested_capability} — the assigned manager works it on its own rail` }
  if (row.status !== "ACCEPTED") return { worked: false, reason: `status ${row.status} — only an ACCEPTED delegation is worked` }
  const actor = p.actor ?? { type: "manager" as const, id: row.assigned_manager }
  const started = await startDelegationWork({ brokerageId: p.brokerageId, delegationId: row.id, reason: `worker ${row.requested_capability} started`, actor }, svc, deps)
  if (!started.ok) return { worked: false, reason: started.reason, result: started }
  let out: WorkerOutcome
  try { out = await worker(svc, row, { userId: p.userId }) } catch (e) { out = { ok: false, reason: `worker threw: ${e instanceof Error ? e.message : String(e)}` } }
  const result = out.ok
    ? await returnDelegationResult({ brokerageId: p.brokerageId, delegationId: row.id, result: out.result, costUsd: out.costUsd ?? null, reason: `${row.requested_capability} done`, actor }, svc, deps)
    : await escalateDelegation({ brokerageId: p.brokerageId, delegationId: row.id, reason: `${row.requested_capability}: ${out.reason}`, actor }, svc, deps)
  return { worked: out.ok, reason: out.ok ? undefined : out.reason, result }
}

// ─── the reaper pass (called from the ONE stale-run reaper) ───────────────────────────────────
export interface DelegationSweepResult { scanned: number; escalated: number; readRefused: string | null }

/** A non-terminal delegation past its deadline (not already ESCALATED) is ESCALATED on the reaper tick. Idempotent. */
export async function sweepDelegationDeadlines(brokerageId: string, client?: Client, opts: { now?: Date; limit?: number } = {}, deps: DelegationDeps = {}): Promise<DelegationSweepResult> {
  const now = opts.now ?? new Date()
  const result: DelegationSweepResult = { scanned: 0, escalated: 0, readRefused: null }
  if (!brokerageId) return result
  const svc = await svcOf(client)
  const { data, error } = await svc.from("manager_delegations").select("id, status, deadline, requested_capability")
    .eq("brokerage_id", brokerageId)
    .in("status", DELEGATION_STATUSES.filter((s) => !DELEGATION_TERMINAL_STATUSES.has(s) && s !== "ESCALATED"))
    .limit(opts.limit ?? 200)
  if (error) { result.readRefused = error.message; return result }
  const sweepDeps = { ...deps, now: () => now }
  for (const d of (data ?? []) as Array<Pick<DelegationRow, "id" | "status" | "deadline" | "requested_capability">>) {
    result.scanned++
    if (!d.deadline || new Date(d.deadline).getTime() >= now.getTime()) continue
    const r = await escalateDelegation({ brokerageId, delegationId: d.id, reason: `deadline ${d.deadline} passed in ${d.status} with no return (reaped)`, actor: { type: "manager", id: "cron_manager" } }, svc, sweepDeps)
    if (r.ok) result.escalated++
  }
  return result
}

// ─── the workflow seam (the engine + the reaper) ──────────────────────────────────────────────
/**
 * A chain run that SERVED a delegation (input_entities.workflow_run_id) settles it: completed →
 * the step outputs come back through returnDelegationResult (accepting / starting first if the
 * trigger never got to); failed / stalled → escalateDelegation. Tenant from the RUN ROW, never an
 * argument. Best-effort, never throws; `null` when no delegation rode this run.
 */
export async function settleDelegationForRun(input: { runId: string; outcome: "completed" | "failed" | "stalled"; detail?: string | null; actor?: DelegationActor }, client?: Client, deps: DelegationDeps = {}): Promise<DelegationResult | null> {
  try {
    const svc = await svcOf(client)
    const { data: run, error: runErr } = await svc.from("workflow_runs").select("id, brokerage_id, chain_key, step_outputs").eq("id", input.runId).maybeSingle()
    if (runErr || !run) return null
    const r = run as { id: string; brokerage_id: string; chain_key: string | null; step_outputs: Record<string, unknown> | null }
    const { data: rows, error } = await svc.from("manager_delegations").select(DELEGATION_COLS)
      .eq("brokerage_id", r.brokerage_id).eq("input_entities->>workflow_run_id", r.id)
      .in("status", DELEGATION_STATUSES.filter((s) => !DELEGATION_TERMINAL_STATUSES.has(s))).limit(1)
    if (error || !rows?.length) return null
    const d = rows[0] as DelegationRow
    const actor = input.actor ?? { type: "manager", id: d.assigned_manager }
    if (input.outcome !== "completed") {
      return escalateDelegation({ brokerageId: d.brokerage_id, delegationId: d.id, reason: `workflow run ${r.id} (${r.chain_key ?? "automation"}) ${input.outcome}${input.detail ? `: ${input.detail}` : ""}`, actor }, svc, deps)
    }
    if (d.status === "REQUESTED" || d.status === "DISSENTED" || d.status === "ESCALATED") await acceptDelegation({ brokerageId: d.brokerage_id, delegationId: d.id, reason: `run ${r.id} completed — accepted on settlement`, actor }, svc, deps)
    const cur = await getDelegation(d.brokerage_id, d.id, svc)
    if (cur && cur.status !== "WORKING") await startDelegationWork({ brokerageId: d.brokerage_id, delegationId: d.id, reason: `run ${r.id} completed — work recorded on settlement`, actor }, svc, deps)
    const outputs = r.step_outputs ?? {}
    return returnDelegationResult({ brokerageId: d.brokerage_id, delegationId: d.id, reason: `workflow run ${r.id} (${r.chain_key ?? "automation"}) completed`, result: { workflow_run_id: r.id, chain_key: r.chain_key, steps: Object.keys(outputs), outputs }, actor }, svc, deps)
  } catch (e) {
    console.error(`[manager-delegation] settlement for run ${input.runId} failed: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
