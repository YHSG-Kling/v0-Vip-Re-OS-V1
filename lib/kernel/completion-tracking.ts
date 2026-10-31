// lib/kernel/completion-tracking.ts
// ─────────────────────────────────────────────────────────────────────────────
// COMPLETION TRACKING — contract C14 (wave 147, lane 147G; owner rulings 13 + 14, 2026-10-31).
//
// OWNER: "the managers need to make sure that arbiter completes not relying on crons to do so"; "ai runs the show with
// autonomous"; "self healing should handle the os not just the connections"; "remember our app structure and kernel and
// orchestrators with managers running above the capabilities".
//
// WHAT THIS IS. Every arbiter / manager decision that promises an outcome OPENS a completion (manager_completions, m904):
// WHAT must happen, the registered manager that OWNS it, WHEN it is due, and WHICH evidence closes it. Evidence arrives on
// EVENTS — the inbound webhook that recorded the message, the arbiter's decision, the provider's status callback, a
// person acting on the draft, a ticket resolved — and is appended here (recordCompletionEvidence). A completion is closed
// ONLY by evidence, never by a clock.
//
// WHO WATCHES. The MANAGER SUPERVISION LOOP is event-driven:
//   event (inbound / decision / provider callback / a provider retry) → superviseCompletion (the owning manager's check:
//   re-read the survivor that holds the evidence) → closed, or still inside its window (re-scheduled on the DURABLE
//   TIMER — workflows/completion-watch-workflow.ts, Vercel Workflow `sleep` until due, then this same function), or
//   STALLED → a detection from COMPLETION_DETECTIONS → the remediation runs through the EXISTING self-healing engine
//   (lib/kernel/self-healing.ts runDeclaredPlaybook — hard gate, healing policy, attempt cap, declared playbook, verify,
//   self_heal_events row the Exception Center / exceptions-first os_health category reads, ledger, event) → recovered, or a
//   PERSON told in one neighbourly sentence with the evidence attached (explainStall).
//   The CRON NET (reconcileOpenCompletions, on the existing manager-signals tick — no new cron) only picks up what no event
//   and no timer reached, and says so: the completion row and the ledger carry recovered_by = "cron".
//
// THE BOUNDARY (ruling 13). A remediation may: re-read a survivor, re-run a decision the action ledger proves never left
// the building, wait once for a late provider report, and notify a person. It NEVER re-sends a message (an external action
// that could repeat is a hard stop), moves money, changes a permission, edits code or loosens a policy — those stay with the
// established approval controls (classifyForbidden + governedChangeVerdict in the engine).
//
// Not server-only, no static imports: the webhook routes, the cron tick and the proofs (scripts/completion-tracking-guard.ts,
// scripts/inbound-sms-arbiter-guard.ts) call it with an injected client; every survivor is a lazy import, so nothing here is
// reachable from a dashboard page (test:proxy-graph-budget — self-healing / os-health never import this module; the
// remediation executors are HANDED to the engine by this module).

type Svc = { from: (t: string) => any }

// ── 1. The vocabulary (mirrors of m904's CHECKs — one spelling, CLAUDE.md §6) ─────────────────────────────

export const COMPLETION_KINDS = ["inbound_response", "outbound_delivery", "follow_up", "human_handoff", "support_ticket"] as const
export type CompletionKind = (typeof COMPLETION_KINDS)[number]
export const COMPLETION_STAGES = ["awaiting_decision", "awaiting_delivery", "awaiting_human", "awaiting_resolution", "done"] as const
export type CompletionStage = (typeof COMPLETION_STAGES)[number]
export const COMPLETION_STATUSES = ["open", "stalled", "escalated", "closed", "cancelled"] as const
export type CompletionStatus = (typeof COMPLETION_STATUSES)[number]
export const COMPLETION_OPEN_STATUSES: ReadonlySet<CompletionStatus> = new Set<CompletionStatus>(["open", "stalled", "escalated"])
/** The statuses whose completion holds an Exception-Center row (closed by the same evidence that closes the completion). */
export const COMPLETION_EXCEPTION_STATUSES: ReadonlySet<CompletionStatus> = new Set<CompletionStatus>(["stalled", "escalated"])
export const COMPLETION_EVIDENCE_KINDS = ["decision", "delivery_outcome", "provider_ack", "human_action", "ticket_resolution", "remediation"] as const
export type CompletionEvidenceKind = (typeof COMPLETION_EVIDENCE_KINDS)[number]
/** Who closed or recovered it: the event itself, the provider's own retry, the durable timer, or the cron net. */
export const RECOVERY_SOURCES = ["event", "retry", "workflow", "cron"] as const
export type RecoverySource = (typeof RECOVERY_SOURCES)[number]
/** The 13 registered managers (lib/kernel/manager-registry.ts ManagerKey) — m904's owner CHECK spells the same set. */
export const COMPLETION_OWNERS = [
  "deal_coordinator", "cron_manager", "shopping_agent", "listing_concierge", "sphere_of_influence", "campaign_orchestrator",
  "asset_manager", "ads_manager", "ai_isa", "data_steward", "recruiting_manager", "compliance_officer", "finance_manager",
] as const
export type CompletionOwner = (typeof COMPLETION_OWNERS)[number]

/** The playbooks the self-healing engine declares for the `completions` domain (lib/kernel/self-healing.ts DOMAIN_PLAYBOOKS). */
export type CompletionPlaybook = "redrive_completion" | "close_on_evidence" | "notify_owner_manager"

export interface DetectionSpec {
  label: string
  /** What the supervisor watches for. */
  watches: string
  /** The accountable REGISTERED manager — DERIVED from the registry entry named in `ownerFrom` (the proof re-derives it). */
  owner: CompletionOwner
  ownerFrom: { registry: "MAINTENANCE_DOMAINS" | "TABLE_MANAGER"; key: string }
  /** The safe remediation inside delegated authority (a declared playbook). */
  playbook: CompletionPlaybook
  withinAuthority: string
  /** What is never done automatically — a person decides. */
  humanBoundary: string
}

/**
 * THE DETECTION CATALOGUE (ruling 13): stalled decision · missing provider ack · broken integration · unresolved ticket ·
 * failed delivery · incomplete follow-up — each with its owning manager from the registry and its remediation.
 * @proofSeam scripts/completion-tracking-guard.ts re-derives every owner from lib/kernel/manager-registry.ts
 */
export const COMPLETION_DETECTIONS = {
  stalled_decision: {
    label: "Stalled decision", watches: "a completion still awaiting its decision after its due time (the arbiter never answered)",
    owner: "ai_isa", ownerFrom: { registry: "MAINTENANCE_DOMAINS", key: "inbound_communication" }, playbook: "redrive_completion",
    withinAuthority: "re-run the owning decision once when the action ledger proves nothing left the building (no responder row, or a failed / skipped one) — the decision itself is at-most-once per inbound",
    humanBoundary: "a decision whose ledger row is still in flight ('proposed') may already have sent — never re-run blind; a person decides",
  },
  missing_provider_ack: {
    label: "Missing provider acknowledgement", watches: "a sent reply whose provider has not reported delivery inside its window (outcome_reconciliations still pending)",
    owner: "compliance_officer", ownerFrom: { registry: "TABLE_MANAGER", key: "outcome_reconciliations" }, playbook: "close_on_evidence",
    withinAuthority: "re-read the provider truth (outcome_reconciliations) and close on it; wait once more for a late report",
    humanBoundary: "never re-send to 'make sure' — a second text is a second touch the person did not ask for",
  },
  broken_integration: {
    label: "Broken integration", watches: "a decision that could not act because the tenant's provider / connection refused (not connected, credential, account)",
    owner: "data_steward", ownerFrom: { registry: "TABLE_MANAGER", key: "platform_credentials" }, playbook: "notify_owner_manager",
    withinAuthority: "route around through the capability router (routeCapability) only where the capability has a healthy alternate; otherwise tell the account owner what to reconnect",
    humanBoundary: "never write a credential, never change a provider configuration or a permission — the account owner reconnects",
  },
  unresolved_ticket: {
    label: "Unresolved support ticket", watches: "a support ticket past its SLA (lib/support/support-sla.ts evaluateTicketSla) with no resolution — READ ONLY",
    owner: "data_steward", ownerFrom: { registry: "TABLE_MANAGER", key: "support_tickets" }, playbook: "notify_owner_manager",
    withinAuthority: "hand the stall to the ticket's owner manager's humans with the evidence (lane 147H owns the ticket loop)",
    humanBoundary: "never close, reassign or answer a ticket from here",
  },
  failed_delivery: {
    label: "Failed delivery", watches: "the provider CONTRADICTED the send (undelivered / failed / bounced)",
    owner: "ai_isa", ownerFrom: { registry: "MAINTENANCE_DOMAINS", key: "inbound_communication" }, playbook: "notify_owner_manager",
    withinAuthority: "tell the thread's agent at once, with the provider's own words, so a person reaches them another way",
    humanBoundary: "never re-send or switch channel unasked — consent and channel are the person's",
  },
  incomplete_follow_up: {
    label: "Incomplete follow-up", watches: "a reply or task handed to a person that nobody acted on by its due time",
    owner: "ai_isa", ownerFrom: { registry: "MAINTENANCE_DOMAINS", key: "followup_arbiter" }, playbook: "notify_owner_manager",
    withinAuthority: "remind the person it was handed to, once; a second stall goes to the brokerage's admins",
    humanBoundary: "the AI never answers in the person's place once it was handed to them",
  },
} as const satisfies Record<string, DetectionSpec>
export type CompletionDetection = keyof typeof COMPLETION_DETECTIONS
export const COMPLETION_DETECTION_KEYS = Object.keys(COMPLETION_DETECTIONS) as CompletionDetection[]

/**
 * Supervision windows — WHEN the owning manager checks (never when to follow up with a person: that stays the arbiter's
 * judgment). A text is answered in minutes; a public comment can wait a day. The caller may pass its own due time.
 */
export const DECISION_DUE_MINUTES: Readonly<Record<string, number>> = Object.freeze({
  sms: 15, whatsapp: 15, social_dm: 60, portal: 60, voice: 60, email: 240, social_comment: 1440, social_mention: 1440, ad_interaction: 1440,
})
/** A person who was handed a reply / task: when the manager checks that someone acted. */
export const HUMAN_DUE_MINUTES = 240
/** A responder ledger row still 'proposed' this long after it was claimed is no longer "in flight" — it is a stall. */
export const STALE_IN_FLIGHT_MINUTES = 10
/** The supervisor's own bound per completion (beyond the engine's per-incident policy cap): then a person. */
export const SUPERVISION_ATTEMPT_CAP = 3

export interface CompletionEvidence {
  kind: CompletionEvidenceKind
  at: string
  /** The survivor that holds it (table / ledger action) and its id or key. */
  source: string
  ref?: string | null
  outcome?: string | null
  detail?: Record<string, unknown> | null
  recoveredBy?: RecoverySource | null
}

export interface CompletionRow {
  id: string
  brokerage_id: string
  kind: CompletionKind
  owner_manager: CompletionOwner
  subject_type: string
  subject_id: string | null
  subject_ref: string | null
  source_ref: string
  idempotency_key: string
  what: string
  stage: CompletionStage
  expected_evidence: string[]
  evidence: CompletionEvidence[]
  status: CompletionStatus
  due_at: string
  attempts: number
  last_attempt_at: string | null
  detection: CompletionDetection | null
  recovered_by: RecoverySource | null
  decision_ledger_key: string | null
  provider_ref: string | null
  context: Record<string, unknown>
  closed_at: string | null
  closed_by: string | null
  created_at: string
  updated_at: string
}

const COLS = "id, brokerage_id, kind, owner_manager, subject_type, subject_id, subject_ref, source_ref, idempotency_key, what, stage, expected_evidence, evidence, status, due_at, attempts, last_attempt_at, detection, recovered_by, decision_ledger_key, provider_ref, context, closed_at, closed_by, created_at, updated_at"

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString())
const isKind = (v: unknown): v is CompletionKind => typeof v === "string" && (COMPLETION_KINDS as readonly string[]).includes(v)
const isOwner = (v: unknown): v is CompletionOwner => typeof v === "string" && (COMPLETION_OWNERS as readonly string[]).includes(v)
const isStage = (v: unknown): v is CompletionStage => typeof v === "string" && (COMPLETION_STAGES as readonly string[]).includes(v)
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ── 2. Open ─────────────────────────────────────────────────────────────────────────────────────────

export interface OpenCompletionInput {
  /** The VERIFIED tenant (the door's / the session's / the anchored row's) — never a request body. */
  brokerageId: string
  kind: CompletionKind
  ownerManager: CompletionOwner
  subject: { type: string; id?: string | null; ref?: string | null }
  /** What the obligation answers (e.g. `inbound:<messages.id>`, `ticket:<support_tickets.id>`). One completion per source. */
  sourceRef: string
  what: string
  stage: CompletionStage
  expectedEvidence: CompletionEvidenceKind[]
  dueAt: Date | string
  /** Ids and channel keys a re-drive needs — NEVER a message body or contact PII. */
  context?: Record<string, unknown>
  providerRef?: string | null
  /** Wave 147 (147Z): evidence the opener already holds (trackManagerDecision's decision) — so a lost second write never reads as "no decision". */
  seedEvidence?: CompletionEvidence[]
}

export type CompletionResult = { ok: true; completion: CompletionRow; duplicate?: boolean } | { ok: false; reason: string; completion?: CompletionRow }

export interface CompletionDeps {
  /** The durable timer (default: workflows/completion-watch-workflow.ts through Vercel Workflow `start`). */
  schedule?: (c: { brokerageId: string; completionId: string; checkAt: string }) => Promise<{ scheduled: boolean; reason?: string }>
  now?: () => Date
}

/** Idempotent per (tenant, kind, source): a provider retry or a second caller gets the SAME completion. Never throws. */
export async function openCompletion(svc: Svc, input: OpenCompletionInput, deps: CompletionDeps = {}): Promise<CompletionResult> {
  try {
    if (!input.brokerageId) return { ok: false, reason: "no tenant — a completion is never opened untenanted" }
    if (!isKind(input.kind)) return { ok: false, reason: `unknown completion kind: ${String(input.kind)}` }
    if (!isOwner(input.ownerManager)) return { ok: false, reason: `owner is not a registered manager: ${String(input.ownerManager)}` }
    if (!isStage(input.stage) || input.stage === "done") return { ok: false, reason: `a completion opens at a waiting stage, not ${String(input.stage)}` }
    if (!input.sourceRef?.trim() || !input.what?.trim()) return { ok: false, reason: "a completion names its source and what must happen" }
    const due = new Date(input.dueAt)
    if (Number.isNaN(due.getTime())) return { ok: false, reason: "a completion needs a due time" }
    const key = `completion:${input.brokerageId}:${input.kind}:${input.sourceRef.trim()}`
    const { data: prior, error: priorErr } = await svc.from("manager_completions").select(COLS).eq("idempotency_key", key).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (priorErr) return { ok: false, reason: `completion read refused: ${priorErr.message}` }
    if (prior) return { ok: true, completion: prior as CompletionRow, duplicate: true }
    const now = (deps.now ?? (() => new Date()))()
    const { data, error } = await svc.from("manager_completions").insert({
      brokerage_id: input.brokerageId, kind: input.kind, owner_manager: input.ownerManager,
      subject_type: input.subject.type, subject_id: input.subject.id ?? null, subject_ref: input.subject.ref ?? null,
      source_ref: input.sourceRef.trim(), idempotency_key: key, what: input.what.trim().slice(0, 500), stage: input.stage,
      expected_evidence: [...new Set(input.expectedEvidence)], evidence: input.seedEvidence ?? [], status: "open", due_at: due.toISOString(), attempts: 0,
      provider_ref: input.providerRef ?? null, context: input.context ?? {}, created_at: now.toISOString(), updated_at: now.toISOString(),
    }).select(COLS).single()
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        const { data: winner } = await svc.from("manager_completions").select(COLS).eq("idempotency_key", key).eq("brokerage_id", input.brokerageId).maybeSingle()
        if (winner) return { ok: true, completion: winner as CompletionRow, duplicate: true }
      }
      return { ok: false, reason: `completion insert refused: ${error.message}` }
    }
    const row = data as CompletionRow
    await scheduleCheck(row, deps)
    return { ok: true, completion: row }
  } catch (e) {
    return { ok: false, reason: `threw: ${errMsg(e)}` }
  }
}

/**
 * ONE CALL PER MANAGER DECISION (wave 147, lane 147Z — closes lane 147G's "Still open 2"; owner ruling 13, contract C14). A
 * decision site that already DECIDED (speed-to-lead's first touch, a life-change response, a promised deliverable, a consented
 * intake hand-off) opens its completion AND records that decision as the first evidence here, so it can never open one and
 * forget the other:
 *   · the decision ACTED and a provider reference came back → `awaiting_delivery` (the provider's status callback closes it;
 *     a contradiction is a failed delivery the agent hears about);
 *   · it HANDED the person to a human (an agent task) → `awaiting_human` (the agent's completed task closes it; a stall bells
 *     them once, then the admins);
 *   · it decided NOT to act now (a wait, a hold, a hard stop) or acted with no trackable reference → CLOSED on the decision
 *     itself — the next follow-up is a NEW decision with its own completion, never this one held open on a clock.
 * Idempotent per (tenant, follow_up, sourceRef) through openCompletion. Never throws, never blocks the decision: a refusal
 * comes back for the caller to log as a blind spot.
 */
interface ManagerDecisionInput {
  brokerageId: string
  ownerManager: CompletionOwner
  subject: { type: string; id?: string | null; ref?: string | null }
  /** One completion per decision (e.g. `speed_to_lead:contact:<id>:<day>`, `life_change:<contact>:<type>:<day>`). */
  sourceRef: string
  what: string
  decision: { outcome: string; source: string; ledgerRef?: string | null }
  next:
    | { kind: "delivery"; providerRef: string; channel: string; dueMinutes?: number }
    | { kind: "human"; contactId: string; agentUserId?: string | null; dueMinutes?: number }
    | { kind: "none" }
  /** Ids only — never a body or PII. */
  context?: Record<string, unknown>
}

export async function trackManagerDecision(svc: Svc, input: ManagerDecisionInput, deps: CompletionDeps = {}): Promise<CompletionResult & { closed?: boolean }> {
  try {
    const now = (deps.now ?? (() => new Date()))()
    const evidence: CompletionEvidence = { kind: "decision", at: now.toISOString(), source: input.decision.source, ref: input.decision.ledgerRef ?? null, outcome: input.decision.outcome.slice(0, 300) }
    const n = input.next
    const context: Record<string, unknown> = {
      ...(input.context ?? {}),
      ...(n.kind === "human" ? { contact_id: n.contactId, ...(n.agentUserId ? { agent_user_id: n.agentUserId } : {}) } : {}),
      ...(n.kind === "delivery" ? { channel: n.channel } : {}),
    }
    const opened = await openCompletion(svc, {
      brokerageId: input.brokerageId, kind: "follow_up", ownerManager: input.ownerManager, subject: input.subject, sourceRef: input.sourceRef,
      what: input.what, stage: "awaiting_decision", expectedEvidence: ["decision"], dueAt: new Date(now.getTime() + 15 * 60_000), context,
      seedEvidence: [evidence],
    }, { ...deps, schedule: deps.schedule ?? (async () => ({ scheduled: false, reason: "the decision is recorded in the same call" })) })
    if (!opened.ok) return opened
    if (opened.duplicate && !COMPLETION_OPEN_STATUSES.has(opened.completion.status)) return { ...opened, closed: true }
    if (opened.duplicate && opened.completion.stage !== "awaiting_decision") return opened
    const due = (m: number | undefined, d: number) => new Date(now.getTime() + (m ?? d) * 60_000)
    return await recordCompletionEvidence(svc, {
      brokerageId: input.brokerageId, completionId: opened.completion.id, evidence,
      advanceTo: n.kind === "delivery" ? { stage: "awaiting_delivery", expected: ["delivery_outcome"], dueAt: due(n.dueMinutes, DECISION_DUE_MINUTES[n.channel] ?? 240), providerRef: n.providerRef }
        : n.kind === "human" ? { stage: "awaiting_human", expected: ["human_action"], dueAt: due(n.dueMinutes, HUMAN_DUE_MINUTES) }
        : null,
      terminal: n.kind === "none",
    }, deps)
  } catch (e) {
    return { ok: false, reason: `threw: ${errMsg(e)}` }
  }
}

/** Find the completion one source opened (tenant-pinned). */
export async function completionForSource(svc: Svc, brokerageId: string, kind: CompletionKind, sourceRef: string): Promise<{ row: CompletionRow | null; error: string | null }> {
  const key = `completion:${brokerageId}:${kind}:${sourceRef}`
  const { data, error } = await svc.from("manager_completions").select(COLS).eq("idempotency_key", key).eq("brokerage_id", brokerageId).maybeSingle()
  return { row: (data as CompletionRow | null) ?? null, error: error ? error.message : null }
}

async function getCompletion(svc: Svc, brokerageId: string, id: string): Promise<{ row: CompletionRow | null; error: string | null }> {
  const { data, error } = await svc.from("manager_completions").select(COLS).eq("id", id).eq("brokerage_id", brokerageId).maybeSingle()
  return { row: (data as CompletionRow | null) ?? null, error: error ? error.message : null }
}

// ── 3. Evidence ─────────────────────────────────────────────────────────────────────────────────────

export interface EvidenceInput {
  brokerageId: string
  /** The completion by id, or by its source, or (delivery truth) by the provider's reference. */
  completionId?: string | null
  source?: { kind: CompletionKind; sourceRef: string } | null
  providerRef?: string | null
  evidence: CompletionEvidence
  /** The next stage this evidence moves it to (default: closes when nothing else is expected). */
  advanceTo?: { stage: CompletionStage; expected: CompletionEvidenceKind[]; dueAt: Date | string; providerRef?: string | null } | null
  /** Evidence that ENDS the obligation regardless of what else was expected (a "no response" decision, a contradiction handled). */
  terminal?: boolean
}

/**
 * Append evidence; close when it satisfies the obligation, or move it to its next waiting stage (re-scheduling the timer).
 * The update is guarded on the status read and COUNTED (an update that matched nothing resolves too, CLAUDE.md §3).
 */
export async function recordCompletionEvidence(svc: Svc, input: EvidenceInput, deps: CompletionDeps = {}): Promise<CompletionResult & { closed?: boolean }> {
  try {
    if (!input.brokerageId) return { ok: false, reason: "no tenant" }
    let row: CompletionRow | null = null
    if (input.completionId) row = (await getCompletion(svc, input.brokerageId, input.completionId)).row
    else if (input.source) row = (await completionForSource(svc, input.brokerageId, input.source.kind, input.source.sourceRef)).row
    else if (input.providerRef) {
      const { data, error } = await svc.from("manager_completions").select(COLS).eq("brokerage_id", input.brokerageId).eq("provider_ref", input.providerRef).in("status", ["open", "stalled", "escalated"]).limit(1).maybeSingle()
      if (error) return { ok: false, reason: `completion read refused: ${error.message}` }
      row = (data as CompletionRow | null) ?? null
    }
    if (!row) return { ok: false, reason: "no open completion for this evidence" }
    if (!COMPLETION_OPEN_STATUSES.has(row.status)) return { ok: true, completion: row, closed: true, duplicate: true }
    const now = (deps.now ?? (() => new Date()))()
    const held = Array.isArray(row.evidence) ? row.evidence : []
    const last = held[held.length - 1]
    // The opener's seeded copy of this SAME evidence (trackManagerDecision) is not appended twice.
    const same = !!last && last.kind === input.evidence.kind && last.source === input.evidence.source && (last.ref ?? null) === (input.evidence.ref ?? null) && (last.outcome ?? null) === (input.evidence.outcome ?? null)
    const evidence = (same ? held : [...held, { ...input.evidence, at: input.evidence.at || now.toISOString() }]).slice(-40)
    const expectedLeft = (row.expected_evidence ?? []).filter((k) => k !== input.evidence.kind)
    const close = input.terminal === true || (!input.advanceTo && expectedLeft.length === 0)
    const patch: Record<string, unknown> = { evidence, updated_at: now.toISOString() }
    if (close) {
      Object.assign(patch, { status: "closed", stage: "done", expected_evidence: [], closed_at: now.toISOString(), closed_by: input.evidence.kind, ...(input.evidence.recoveredBy && input.evidence.recoveredBy !== "event" ? { recovered_by: input.evidence.recoveredBy } : {}) })
    } else if (input.advanceTo) {
      Object.assign(patch, { stage: input.advanceTo.stage, expected_evidence: [...new Set(input.advanceTo.expected)], due_at: iso(input.advanceTo.dueAt), status: "open", detection: null, ...(input.advanceTo.providerRef !== undefined ? { provider_ref: input.advanceTo.providerRef } : {}), ...(input.evidence.recoveredBy && input.evidence.recoveredBy !== "event" ? { recovered_by: input.evidence.recoveredBy } : {}) })
    } else {
      patch.expected_evidence = expectedLeft
    }
    if (input.evidence.kind === "decision" && typeof input.evidence.ref === "string") patch.decision_ledger_key = input.evidence.ref
    const { data: moved, error } = await svc.from("manager_completions").update(patch).eq("id", row.id).eq("brokerage_id", input.brokerageId).eq("status", row.status).select(COLS)
    if (error) return { ok: false, reason: `evidence write refused: ${error.message}`, completion: row }
    if (!Array.isArray(moved) || moved.length !== 1) return { ok: false, reason: "evidence write matched no row (the completion moved under us)", completion: row }
    const next = moved[0] as CompletionRow
    // An exception the Exception Center holds for this completion is CLOSED by the same evidence (append-only closure).
    if (close && COMPLETION_EXCEPTION_STATUSES.has(row.status)) await closeException(svc, next, `closed by ${input.evidence.kind}`)
    if (!close) await scheduleCheck(next, deps)
    return { ok: true, completion: next, closed: close }
  } catch (e) {
    return { ok: false, reason: `threw: ${errMsg(e)}` }
  }
}

/** The subject the self-healing engine writes for this completion's incident (lib/kernel/self-healing.ts engineTools). */
const completionIncidentSubject = (id: string) => `os_health:stalled_completions:completion:${id}`

async function closeException(svc: Svc, c: CompletionRow, why: string): Promise<void> {
  const { error } = await svc.from("self_heal_events").insert({
    brokerage_id: c.brokerage_id, domain: "data_flow", subject: completionIncidentSubject(c.id), action: "completion_closed_by_evidence", outcome: "resolved",
    detail: { flow: "os_health_stalled_completions", completion_id: c.id, kind: c.kind, owner: c.owner_manager, reason: why, recovered_by: c.recovered_by },
  })
  if (error) console.error(`[completion-tracking] exception closer refused for ${c.id}: ${error.message}`)
}

async function scheduleCheck(c: CompletionRow, deps: CompletionDeps): Promise<void> {
  if (!COMPLETION_OPEN_STATUSES.has(c.status)) return
  const schedule = deps.schedule ?? defaultSchedule
  try {
    const r = await schedule({ brokerageId: c.brokerage_id, completionId: c.id, checkAt: c.due_at })
    // An unscheduled check is not a lost completion: the row's due_at is the cron net's to reconcile (stamped "cron").
    if (!r.scheduled) console.warn(`[completion-tracking] durable check not scheduled for ${c.id} (${r.reason ?? "no reason"}) — the cron net reconciles it`)
  } catch (e) {
    console.warn(`[completion-tracking] durable check threw for ${c.id} (${errMsg(e)}) — the cron net reconciles it`)
  }
}

/** The durable timer: one Workflow DevKit run per completion stage (sleep until due → superviseCompletion → repeat). */
async function defaultSchedule(c: { brokerageId: string; completionId: string; checkAt: string }): Promise<{ scheduled: boolean; reason?: string }> {
  // The durable timer runs on Vercel's Workflow world (the deployed app). Anywhere else (a script, a proof, a local shell)
  // nothing is started — the row's due_at stays the cron net's to reconcile (a presence check only; no value is read).
  if (!process.env.VERCEL) return { scheduled: false, reason: "no Vercel Workflow runtime in this process — the cron net reconciles this completion" }
  const [{ start }, { completionWatchWorkflow }] = await Promise.all([import("workflow/api"), import("@/workflows/completion-watch-workflow")])
  await start(completionWatchWorkflow, [{ brokerageId: c.brokerageId, completionId: c.completionId, firstCheckAt: c.checkAt }])
  return { scheduled: true }
}

// ── 4. The evidence each stage waits for, re-read from its survivor ─────────────────────────────────────

type Verdict =
  | { found: true; evidence: CompletionEvidence; advanceTo?: EvidenceInput["advanceTo"]; terminal?: boolean }
  | { found: false; detection: CompletionDetection | null; hardStop?: "external_duplicate" | null; detail: string }

/** The redrivers the CALLER hands in per kind (the inbound chain hands lib/communications/inbound-record.ts redriveInboundResponse). */
export type Redriver = (svc: Svc, c: CompletionRow, trigger: RecoverySource) => Promise<{ action: string; reason: string }>

export interface SupervisionDeps extends CompletionDeps {
  redrivers?: Partial<Record<CompletionKind, Redriver>>
  /** The self-healing engine (default: lib/kernel/self-healing.ts runDeclaredPlaybook) and its seams. */
  runPlaybook?: (svc: Svc, incident: Record<string, unknown>, sel: { playbook: CompletionPlaybook; params?: Record<string, unknown> }, ctx: { playbookAttempts24h: number; cycle: string; attempt: number }, deps: Record<string, unknown>) => Promise<{ kind: string; ok?: boolean; outcome?: string; reason?: string; costUsd?: number }>
  /** The engine's own seams passed straight through (policy, ledger, emit, propose). */
  engine?: Record<string, unknown>
  /** Bell a person (default: the thread's agent, else the brokerage's admins via org recipients). */
  notify?: (svc: Svc, c: CompletionRow, sentence: string) => Promise<{ notified: number }>
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
}

/**
 * PURE-ish: re-read the survivor that holds the evidence this stage waits for. Never writes.
 * (scripts/completion-tracking-guard.ts drives every stage's found / not-found branch through superviseCompletion.)
 */
async function verifyCompletionEvidence(svc: Svc, c: CompletionRow, now: Date): Promise<Verdict> {
  const ctx = (c.context ?? {}) as Record<string, unknown>
  const recordId = typeof ctx.record_id === "string" ? ctx.record_id : null
  if (c.stage === "awaiting_decision") {
    // Wave 147 (147Z): a manager decision tracked by trackManagerDecision HOLDS its decision from the open — if the move to its
    // next stage was lost, the decision still closes it (never a false "stalled decision" for a decision that was made).
    const heldDecision = c.kind === "follow_up" ? (Array.isArray(c.evidence) ? c.evidence : []).find((e) => e?.kind === "decision") : undefined
    if (heldDecision) return { found: true, evidence: { ...heldDecision, at: now.toISOString() }, terminal: true }
    if (!recordId) return { found: false, detection: "stalled_decision", detail: "no inbound record id on the completion" }
    const { data, error } = await svc.from("agent_action_ledger").select("id, status, outcome, idempotency_key, created_at, updated_at")
      .eq("brokerage_id", c.brokerage_id).eq("action", "inbound.message.respond").eq("detail->>record_id", recordId).limit(1).maybeSingle()
    if (error) return { found: false, detection: null, detail: `decision ledger unreadable (${error.message}) — not counted as missing` }
    const led = data as { id: string; status: string; outcome: string | null; idempotency_key: string | null; updated_at?: string | null; created_at?: string | null } | null
    if (led && (led.status === "executed" || led.status === "skipped")) {
      return { found: true, evidence: { kind: "decision", at: now.toISOString(), source: "agent_action_ledger:inbound.message.respond", ref: led.idempotency_key ?? led.id, outcome: led.outcome } }
    }
    if (led && (led.status === "proposed" || led.status === "unknown")) {
      const since = Date.parse(led.updated_at ?? led.created_at ?? "")
      const stale = !Number.isFinite(since) || now.getTime() - since > STALE_IN_FLIGHT_MINUTES * 60_000
      if (!stale) return { found: false, detection: null, detail: "the decision is in flight right now" }
      return { found: false, detection: "stalled_decision", hardStop: "external_duplicate", detail: `the responder's ledger row is '${led.status}' since ${led.updated_at ?? led.created_at} — it may already have sent; never re-run blind` }
    }
    return { found: false, detection: "stalled_decision", detail: led ? `the decision ${led.status} (${led.outcome ?? "no outcome"}) — nothing left the building` : "no decision was ever recorded for this inbound" }
  }
  if (c.stage === "awaiting_delivery") {
    const channel = typeof ctx.channel === "string" ? ctx.channel : "sms"
    if (!c.provider_ref) return { found: false, detection: "missing_provider_ack", detail: "the send returned no provider reference — its delivery can never be proven" }
    const { data, error } = await svc.from("outcome_reconciliations").select("id, verdict, provider_status, provider_detail, provider_reported_at")
      .eq("brokerage_id", c.brokerage_id).eq("channel", channel).eq("provider_ref", c.provider_ref).maybeSingle()
    if (error) return { found: false, detection: null, detail: `provider truth unreadable (${error.message}) — not counted as missing` }
    const r = data as { id: string; verdict: string; provider_status: string | null; provider_detail: Record<string, unknown> | null } | null
    if (r?.verdict === "confirmed") return { found: true, evidence: { kind: "delivery_outcome", at: now.toISOString(), source: "outcome_reconciliations", ref: r.id, outcome: r.provider_status ?? "delivered" } }
    if (r?.verdict === "unverifiable") return { found: true, evidence: { kind: "delivery_outcome", at: now.toISOString(), source: "outcome_reconciliations", ref: r.id, outcome: "unverifiable — this lane has no provider truth source (said, never read as delivered)" } }
    if (r?.verdict === "contradicted") return { found: false, detection: "failed_delivery", detail: `the provider said ${r.provider_status ?? "not delivered"}${r.provider_detail ? ` (${JSON.stringify(r.provider_detail).slice(0, 120)})` : ""}` }
    return { found: false, detection: "missing_provider_ack", detail: r ? "the provider has not reported yet (pending)" : "no delivery claim was opened for this send" }
  }
  if (c.stage === "awaiting_human") {
    if (recordId) {
      const { data: drafts, error } = await svc.from("ai_message_drafts").select("id, status, acted_at").eq("brokerage_id", c.brokerage_id).eq("source_message_id", recordId).limit(5)
      if (!error) {
        const acted = ((drafts ?? []) as Array<{ id: string; status: string; acted_at: string | null }>).find((d) => d.status !== "pending")
        if (acted) return { found: true, evidence: { kind: "human_action", at: now.toISOString(), source: "ai_message_drafts", ref: acted.id, outcome: acted.status } }
      }
    }
    // A proposal card (a public comment's reply, a DM a person approves) acted on — accepted or dismissed — is a person's answer.
    if (recordId) {
      const { data: cards, error } = await svc.from("smart_assistant_suggestions").select("id, status").eq("brokerage_id", c.brokerage_id).eq("action_payload_json->>message_id", recordId).neq("status", "pending").limit(1)
      const acted = !error && Array.isArray(cards) ? (cards[0] as { id: string; status: string | null } | undefined) : undefined
      if (acted) return { found: true, evidence: { kind: "human_action", at: now.toISOString(), source: "smart_assistant_suggestions", ref: acted.id, outcome: acted.status } }
    }
    // The agent's task (the arbiter's routeToAgent writes activities followup_moment_due) completed after the obligation opened.
    const contactId = typeof ctx.contact_id === "string" ? ctx.contact_id : null
    if (contactId) {
      const { data: tasks, error } = await svc.from("activities").select("id, completed_at").eq("brokerage_id", c.brokerage_id).eq("contact_id", contactId).eq("activity_type", "followup_moment_due").gte("created_at", c.created_at).not("completed_at", "is", null).limit(1)
      const done = !error && Array.isArray(tasks) ? (tasks[0] as { id: string; completed_at: string | null } | undefined) : undefined
      if (done) return { found: true, evidence: { kind: "human_action", at: now.toISOString(), source: "activities", ref: done.id, outcome: `completed ${done.completed_at}` } }
    }
    // Wave 147 (147Z — lane 147G Outside-lane 3): a STAGED VIDEO waiting on its assigned approver (lib/video/video-staging.ts) —
    // the approver's decision on the asset itself (approval_status) is the person's answer.
    const videoId = typeof ctx.video_id === "string" ? ctx.video_id : null
    if (videoId) {
      const { data: v, error: vErr } = await svc.from("ai_video_projects").select("id, approval_status").eq("id", videoId).eq("brokerage_id", c.brokerage_id).maybeSingle()
      if (vErr) return { found: false, detection: null, detail: `staged video unreadable (${vErr.message}) — not counted as missing` }
      const st = (v as { approval_status?: string | null } | null)?.approval_status ?? null
      if (!v) return { found: true, evidence: { kind: "human_action", at: now.toISOString(), source: "ai_video_projects", ref: videoId, outcome: "the video no longer exists in this tenant" }, terminal: true }
      if (st === "approved" || st === "published" || st === "rejected") return { found: true, evidence: { kind: "human_action", at: now.toISOString(), source: "ai_video_projects.approval_status", ref: videoId, outcome: st } }
      return { found: false, detection: "incomplete_follow_up", detail: `the staged video is still ${st ?? "unreviewed"} — the assigned approver has not acted` }
    }
    const conversationId = typeof ctx.conversation_id === "string" ? ctx.conversation_id : null
    if (conversationId) {
      const { data: out, error } = await svc.from("messages").select("id, created_at").eq("brokerage_id", c.brokerage_id).eq("conversation_id", conversationId).eq("direction", "outbound").gte("created_at", c.created_at).limit(1)
      if (!error && Array.isArray(out) && out.length > 0) return { found: true, evidence: { kind: "human_action", at: now.toISOString(), source: "messages(outbound)", ref: (out[0] as { id: string }).id, outcome: "answered in the thread" } }
    }
    return { found: false, detection: "incomplete_follow_up", detail: "nobody has acted on the reply / task handed to a person" }
  }
  if (c.stage === "awaiting_resolution" && c.kind === "support_ticket" && c.subject_id) {
    const { data, error } = await svc.from("support_tickets").select("id, status, priority, created_at, first_response_at, resolved_at").eq("id", c.subject_id).eq("brokerage_id", c.brokerage_id).maybeSingle()
    if (error) return { found: false, detection: null, detail: `ticket unreadable (${error.message}) — not counted as missing` }
    const t = data as { id: string; status: string } | null
    if (!t) return { found: true, evidence: { kind: "ticket_resolution", at: now.toISOString(), source: "support_tickets", ref: c.subject_id, outcome: "the ticket no longer exists in this tenant" }, terminal: true }
    if (t.status === "resolved" || t.status === "closed") return { found: true, evidence: { kind: "ticket_resolution", at: now.toISOString(), source: "support_tickets", ref: t.id, outcome: t.status } }
    return { found: false, detection: "unresolved_ticket", detail: `ticket is ${t.status} past its SLA` }
  }
  return { found: false, detection: null, detail: `no verifier for ${c.kind} at ${c.stage}` }
}

// ── 5. The neighbourly sentence ────────────────────────────────────────────────────────────────────────

/** ONE sentence a person can act on: what stalled, for whom, since when, and what the managers already tried. */
function explainStall(c: Pick<CompletionRow, "what" | "due_at" | "attempts" | "kind">, detection: CompletionDetection, detail: string, now: Date = new Date()): string {
  const late = Math.max(0, Math.round((now.getTime() - Date.parse(c.due_at)) / 60_000))
  const lateText = late >= 120 ? `${Math.round(late / 60)} hours` : `${late} minutes`
  const tried = c.attempts > 0 ? `; we already tried ${c.attempts} time${c.attempts === 1 ? "" : "s"}` : ""
  const ask: Record<CompletionDetection, string> = {
    stalled_decision: "could you take a look and answer them?",
    missing_provider_ack: "it may not have reached them — worth a quick call?",
    broken_integration: "the connection behind it needs reconnecting in Settings.",
    unresolved_ticket: "it is waiting on its owner.",
    failed_delivery: "it did not reach them — could you try them another way?",
    incomplete_follow_up: "it is still waiting for someone to pick it up.",
  }
  return `Heads up — "${c.what}" is ${lateText} past due (${detail})${tried}; ${ask[detection]}`.slice(0, 600)
}

// ── 6. The supervision loop (event-driven; the timer and the cron net call the same function) ───────────

export interface SupervisionResult {
  verdict: "closed" | "advanced" | "waiting" | "remediated" | "escalated" | "refused"
  completion: CompletionRow | null
  nextCheckAt?: string | null
  detection?: CompletionDetection | null
  reason: string
}

/**
 * The owning manager's check of ONE completion. Re-reads the survivor: evidence → close / advance; inside the window →
 * waiting (the durable timer re-checks at due); past due → a detection → its declared playbook through the self-healing
 * engine (ledgered `completion.stall.remediate`, recovered_by = the trigger) → re-verified → recovered, or a person told.
 * Never throws.
 */
export async function superviseCompletion(svc: Svc, input: { brokerageId: string; completionId: string; trigger: RecoverySource; now?: Date }, deps: SupervisionDeps = {}): Promise<SupervisionResult> {
  const now = input.now ?? (deps.now ?? (() => new Date()))()
  try {
    const { row, error } = await getCompletion(svc, input.brokerageId, input.completionId)
    if (error) return { verdict: "refused", completion: null, reason: `completion read refused: ${error}` }
    if (!row) return { verdict: "refused", completion: null, reason: "no such completion in this tenant" }
    if (!COMPLETION_OPEN_STATUSES.has(row.status)) return { verdict: "closed", completion: row, reason: `already ${row.status}` }

    const v = await verifyCompletionEvidence(svc, row, now)
    if (v.found) {
      const recoveredBy: RecoverySource | null = input.trigger === "event" ? null : input.trigger
      const write = () => recordCompletionEvidence(svc, { brokerageId: row.brokerage_id, completionId: row.id, evidence: { ...v.evidence, recoveredBy }, advanceTo: v.advanceTo ?? null, terminal: v.terminal }, deps)
      // The cron net SAYS what it recovered — in the ledger as well as on the row.
      const r = input.trigger === "cron" ? await ledgered(svc, deps, row, "completion.evidence.reconcile", `cron:${row.stage}`, { recovered_by: "cron", evidence: v.evidence }, write, (x) => ({ ok: x.ok, note: x.ok ? `evidence found by the cron net: ${v.evidence.source}` : (x as { reason: string }).reason })) : await write()
      if (!r || !r.ok) return { verdict: "refused", completion: row, reason: r && !r.ok ? r.reason : "evidence write replayed" }
      return { verdict: r.closed ? "closed" : "advanced", completion: r.completion, nextCheckAt: r.closed ? null : r.completion.due_at, reason: `evidence: ${v.evidence.source}${v.evidence.outcome ? ` (${v.evidence.outcome})` : ""}` }
    }

    const overdue = now.getTime() >= Date.parse(row.due_at)
    // A contradiction or a stale in-flight decision is a stall NOW, whatever the clock says.
    const immediate = v.detection === "failed_delivery" || v.hardStop === "external_duplicate"
    if (!v.detection || (!overdue && !immediate)) return { verdict: "waiting", completion: row, nextCheckAt: row.due_at, detection: null, reason: v.detail }

    return await remediate(svc, row, v.detection, v.detail, v.hardStop ?? null, input.trigger, now, deps)
  } catch (e) {
    return { verdict: "refused", completion: null, reason: `threw: ${errMsg(e)}` }
  }
}

/** The remediation: the detection's declared playbook through the engine; the supervisor's own bound beats every loop. */
async function remediate(svc: Svc, row: CompletionRow, detection: CompletionDetection, detail: string, hardStop: "external_duplicate" | null, trigger: RecoverySource, now: Date, deps: SupervisionDeps): Promise<SupervisionResult> {
  const spec = COMPLETION_DETECTIONS[detection]
  const attempt = (row.attempts ?? 0) + 1
  const exhausted = attempt > SUPERVISION_ATTEMPT_CAP
  // The playbook: the detection's own, unless the decision is in flight (never re-run blind) or the bound is spent → a person.
  const playbook: CompletionPlaybook = hardStop || exhausted ? "notify_owner_manager" : spec.playbook
  const sentence = explainStall(row, detection, detail, now)
  const claimed = await svc.from("manager_completions").update({ status: "stalled", detection, attempts: attempt, last_attempt_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", row.id).eq("brokerage_id", row.brokerage_id).eq("attempts", row.attempts ?? 0).select("id")
  if (claimed.error) return { verdict: "refused", completion: row, detection, reason: `stall claim refused: ${claimed.error.message}` }
  if (!Array.isArray(claimed.data) || claimed.data.length !== 1) return { verdict: "waiting", completion: row, detection, nextCheckAt: row.due_at, reason: "another supervisor took this attempt" }
  const stalled: CompletionRow = { ...row, status: "stalled", detection, attempts: attempt, last_attempt_at: now.toISOString() }

  const incident = {
    detector: "stalled_completions", class: "transient", brokerageId: row.brokerage_id, subjectKey: `completion:${row.id}`, subjectId: row.id, subjectType: "manager_completion",
    summary: `${spec.label}: ${row.what}`.slice(0, 280), idempotent: true,
    retryOwner: "lib/kernel/completion-tracking.ts superviseCompletion",
    evidence: { completion_id: row.id, kind: row.kind, stage: row.stage, owner_manager: row.owner_manager, detection, detail: detail.slice(0, 300), attempt, recovered_by: trigger, hard_stop: hardStop, sentence },
  }
  const runPlaybook = deps.runPlaybook ?? (async (s, i, sel, c, d) => (await import("@/lib/kernel/self-healing")).runDeclaredPlaybook(s, i as never, sel, c, d as never) as never)
  const notify = deps.notify ?? defaultNotify
  const executors = completionExecutors(stalled, deps, trigger)
  const engineDeps = { ...(deps.engine ?? {}), executors: { ...((deps.engine?.executors as Record<string, unknown> | undefined) ?? {}), ...executors }, notify: async (s: Svc) => { await notify(s, stalled, sentence) } }
  const params: Record<string, unknown> = playbook === "notify_owner_manager" ? { message: sentence.slice(0, 280) } : {}

  const result = await ledgered(svc, deps, stalled, "completion.stall.remediate", `attempt:${attempt}`, { detection, playbook, recovered_by: trigger, hard_stop: hardStop, owner_manager: row.owner_manager, detection_owner: spec.owner, sentence },
    () => runPlaybook(svc, incident, { playbook, params }, { playbookAttempts24h: Math.min(attempt - 1, SUPERVISION_ATTEMPT_CAP), cycle: `completion:${row.id}`, attempt }, engineDeps),
    (x) => ({ ok: !!x && x.kind === "playbook" && !!x.ok, note: x ? `${x.kind}${x.outcome ? `: ${x.outcome}` : x.reason ? `: ${x.reason}` : ""}` : "replayed", costUsd: x?.costUsd ?? 0 }))

  // Re-verify on the survivor (the engine's executor already did for an acting playbook): evidence closes it.
  const after = await getCompletion(svc, row.brokerage_id, row.id)
  if (after.row && !COMPLETION_OPEN_STATUSES.has(after.row.status)) return { verdict: "remediated", completion: after.row, detection, reason: `recovered by ${playbook} (${trigger})` }
  if (after.row && after.row.stage !== row.stage) return { verdict: "remediated", completion: after.row, detection, nextCheckAt: after.row.due_at, reason: `${playbook} moved it to ${after.row.stage} (${trigger})` }
  const recheck = after.row ? await verifyCompletionEvidence(svc, after.row, now) : null
  if (recheck?.found && after.row) {
    const r = await recordCompletionEvidence(svc, { brokerageId: row.brokerage_id, completionId: row.id, evidence: { ...recheck.evidence, recoveredBy: trigger === "event" ? null : trigger }, advanceTo: recheck.advanceTo ?? null, terminal: recheck.terminal }, deps)
    if (r.ok) return { verdict: "remediated", completion: r.completion, detection, nextCheckAt: r.closed ? null : r.completion.due_at, reason: `recovered by ${playbook} (${trigger})` }
  }
  // The engine REFUSED to run anything (hard gate, policy unreadable / exhausted, a refused selection, a hard stop): the
  // person is still told and the Exception Center still holds it — "nobody checked" never reads as "handled".
  if (!result || result.kind !== "playbook") {
    await notify(svc, stalled, sentence)
    const { error: exErr } = await svc.from("self_heal_events").insert({
      brokerage_id: row.brokerage_id, domain: "data_flow", subject: completionIncidentSubject(row.id), action: `os_health_playbook:${playbook}`, outcome: "escalated",
      detail: { flow: "os_health_stalled_completions", completion_id: row.id, kind: row.kind, detection, owner: row.owner_manager, detection_owner: spec.owner, reason: (result?.reason ?? "the remediation replayed").slice(0, 400), sentence, recovered_by: trigger, attempt },
    })
    if (exErr) console.error(`[completion-tracking] exception row refused for ${row.id}: ${exErr.message}`)
  }
  // A person now owns it: escalated (the Exception-Center row is written); the timer stops, the cron net watches.
  const handedOff = playbook === "notify_owner_manager" || !result || result.kind !== "playbook"
  const retryLater = !handedOff && !exhausted
  const nextDue = new Date(now.getTime() + (detection === "missing_provider_ack" ? 60 : 30) * 60_000).toISOString()
  const { data: moved } = await svc.from("manager_completions").update(retryLater ? { status: "stalled", due_at: nextDue, updated_at: now.toISOString() } : { status: "escalated", updated_at: now.toISOString() })
    .eq("id", row.id).eq("brokerage_id", row.brokerage_id).eq("status", "stalled").select(COLS)
  const final = (Array.isArray(moved) && moved[0] ? moved[0] : stalled) as CompletionRow
  if (retryLater) { await scheduleCheck(final, deps); return { verdict: "waiting", completion: final, detection, nextCheckAt: nextDue, reason: `${playbook} did not recover it yet — re-checked at ${nextDue}` } }
  return { verdict: "escalated", completion: final, detection, reason: `${handedOff ? "a person was told" : "the remediation did not recover it"}: ${sentence}` }
}

/** The completion-domain executors this module HANDS to the engine (self-healing never imports this module). */
function completionExecutors(c: CompletionRow, deps: SupervisionDeps, trigger: RecoverySource) {
  const stamp = trigger === "event" ? null : trigger
  return {
    redrive_completion: async (svc: Svc) => {
      const v = await verifyCompletionEvidence(svc, c, new Date())
      if (v.found) return { ok: true, outcome: "the evidence already exists — nothing to re-run", verification: { verified: true, detail: v.evidence.source } }
      if (v.hardStop) return { ok: false, outcome: v.detail, hardStop: "external_duplicate" as const }
      // The redriver is HANDED IN by the composition root (cron net, workflow step, provider-truth webhook — each passes
      // lib/communications/inbound-record.ts inboundCompletionRedrivers()). This module no longer defaults to importing the
      // inbound chain (wave 147, integrator — proxy-graph budget: that default pulled 21 modules into every page reaching the
      // manager-signals hub). A missing redriver is said out loud, never silently skipped.
      const redrive = deps.redrivers?.[c.kind] ?? null
      if (!redrive) return { ok: false, outcome: `no redriver handed in for ${c.kind} — the composition root must pass deps.redrivers.${c.kind}` }
      const r = await redrive(svc, c, trigger)
      const after = await getCompletion(svc, c.brokerage_id, c.id)
      const moved = !!after.row && (after.row.stage !== c.stage || !COMPLETION_OPEN_STATUSES.has(after.row.status))
      const rv = after.row && !moved ? await verifyCompletionEvidence(svc, after.row, new Date()) : null
      return { ok: moved || !!rv?.found, outcome: `re-ran the decision → ${r.action}: ${r.reason}`.slice(0, 400), verification: { verified: moved || !!rv?.found, detail: moved ? `completion moved to ${after.row!.stage}/${after.row!.status}` : rv?.found ? `evidence: ${rv.evidence.source}` : "no decision evidence after the re-run" } }
    },
    close_on_evidence: async (svc: Svc) => {
      const v = await verifyCompletionEvidence(svc, c, new Date())
      if (!v.found) return { ok: false, outcome: v.detail, verification: { verified: false, detail: v.detail } }
      const r = await recordCompletionEvidence(svc, { brokerageId: c.brokerage_id, completionId: c.id, evidence: { ...v.evidence, recoveredBy: stamp }, advanceTo: v.advanceTo ?? null, terminal: v.terminal }, deps)
      return { ok: r.ok, outcome: r.ok ? `closed on ${v.evidence.source}` : (r as { reason: string }).reason, verification: { verified: r.ok, detail: v.evidence.source } }
    },
  }
}

// TOMBSTONE (wave 147, integrator): `inboundRedriverWith` — the default that imported lib/communications/inbound-record.ts
// from here — MOVED to lib/communications/inbound-record.ts `inboundCompletionRedrivers(deps)`, which every composition root
// (app/api/cron/manager-signals/route.ts, workflows/completion-watch-workflow.ts, app/api/webhooks/twilio-sms-status/route.ts)
// hands in through SupervisionDeps.redrivers. Same behaviour, one direction of dependency: the chain knows the supervisor, the
// supervisor never knows the chain.

/** withActionLedger around a supervisor step (LAW 5): who (the owner manager), why, what evidence, which policy, cost. */
async function ledgered<T>(svc: Svc, deps: SupervisionDeps, c: CompletionRow, action: string, cycle: string, detail: Record<string, unknown>, run: () => Promise<T>, settle: (r: T) => { ok: boolean; note: string; costUsd?: number }): Promise<T | null> {
  const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
  return ledger<T | null>(
    {
      brokerageId: c.brokerage_id, action, actor: { type: "manager", managerKey: c.owner_manager },
      subject: { type: "manager_completion", id: c.id, ref: c.source_ref }, reasonCode: "OS_HEALTH_RECOVERY",
      reasonDetail: `${c.what}`.slice(0, 300), cycle: `completion:${c.id}:${cycle}`, riskClass: "LOW_RISK_WRITE", systemSource: "completion_supervisor",
      policyKey: "self_healing", detail: { completion_id: c.id, kind: c.kind, stage: c.stage, ...detail },
    },
    run,
    { settle: (r) => { const s = settle(r as T); return { status: s.ok ? "executed" : "failed", outcome: s.note.slice(0, 300), error: s.ok ? null : s.note.slice(0, 300), costUsd: s.costUsd ?? 0 } }, replay: (claim) => { if (claim.kind === "refused") console.error(`[completion-tracking] ${action} not run — the action ledger refused: ${claim.error}`); return null } },
    { client: svc as never },
  )
}

/** Bell the person the obligation is waiting on: the thread's agent (context.agent_user_id), else the brokerage's admins. */
async function defaultNotify(svc: Svc, c: CompletionRow, sentence: string): Promise<{ notified: number }> {
  let recipients: string[] = []
  const agentUserId = typeof c.context?.agent_user_id === "string" ? (c.context.agent_user_id as string) : null
  if (agentUserId && (c.attempts ?? 0) <= 1) recipients = [agentUserId]
  else {
    const { resolveOrgRecipients } = await import("@/lib/kernel/org-recipients")
    recipients = await resolveOrgRecipients(svc as never, c.brokerage_id, { limit: 3 })
  }
  if (recipients.length === 0) return { notified: 0 }
  const { error } = await svc.from("notifications").insert(recipients.map((user_id) => ({
    user_id, brokerage_id: c.brokerage_id, type: "completion_stalled", title: `Needs you: ${c.what}`.slice(0, 200), body: sentence,
    entity_type: c.subject_type, entity_id: c.subject_id, priority: "high", channel: "in_app", is_read: false,
  })))
  if (error) { console.error(`[completion-tracking] stall bell refused for ${c.id}: ${error.message}`); return { notified: 0 } }
  return { notified: recipients.length }
}

/**
 * THE PROVIDER'S EVENT (the Twilio status callback, after lib/outcomes/reconciliation-ledger.ts ingestProviderTruth): the
 * completion waiting on this reference is supervised NOW — a confirmed delivery closes it; a contradiction is a failed
 * delivery the agent hears about at once (never a re-send); an in-flight status changes nothing. Tenant from the
 * reconciliation row (the webhook never trusts the provider for it). Never throws.
 */
export async function onProviderTruth(svc: Svc, input: { brokerageId: string; providerRef: string; verdict: string | null }, deps: SupervisionDeps = {}): Promise<SupervisionResult | null> {
  try {
    if (!input.brokerageId || !input.providerRef || !input.verdict || input.verdict === "pending") return null
    const { data, error } = await svc.from("manager_completions").select("id").eq("brokerage_id", input.brokerageId).eq("provider_ref", input.providerRef).in("status", ["open", "stalled", "escalated"]).limit(1).maybeSingle()
    if (error || !data) return null
    return await superviseCompletion(svc, { brokerageId: input.brokerageId, completionId: (data as { id: string }).id, trigger: "event" }, deps)
  } catch (e) {
    console.error(`[completion-tracking] provider truth not applied to a completion: ${errMsg(e)}`)
    return null
  }
}

// ── 7. The cron net — reconciliation only, stamped ──────────────────────────────────────────────────────

export interface ReconcileReport { brokerageId: string; scanned: number; recovered: number; escalated: number; waiting: number; refused: number; errors: string[] }

/**
 * What events and the durable timer missed: open / stalled completions past due whose last check is older than the
 * timer's grace. Each goes through the SAME superviseCompletion with trigger "cron" — a closure or recovery it makes is
 * stamped recovered_by = "cron" on the row and in the ledger. Bounded per tenant per tick.
 */
export async function reconcileOpenCompletions(svc: Svc, brokerageId: string, opts: { now?: Date; limit?: number } = {}, deps: SupervisionDeps = {}): Promise<ReconcileReport> {
  const now = opts.now ?? new Date()
  const report: ReconcileReport = { brokerageId, scanned: 0, recovered: 0, escalated: 0, waiting: 0, refused: 0, errors: [] }
  const graceIso = new Date(now.getTime() - 5 * 60_000).toISOString()
  const { data, error } = await svc.from("manager_completions").select("id, last_attempt_at, due_at, status")
    .eq("brokerage_id", brokerageId).in("status", ["open", "stalled"]).lte("due_at", graceIso).order("due_at", { ascending: true }).limit(opts.limit ?? 50)
  if (error) { report.errors.push(`completions unreadable: ${error.message}`); return report }
  for (const r of (data ?? []) as Array<{ id: string }>) {
    report.scanned++
    const s = await superviseCompletion(svc, { brokerageId, completionId: r.id, trigger: "cron", now }, deps)
    if (s.verdict === "closed" || s.verdict === "advanced" || s.verdict === "remediated") report.recovered++
    else if (s.verdict === "escalated") report.escalated++
    else if (s.verdict === "waiting") report.waiting++
    else { report.refused++; report.errors.push(`${r.id}: ${s.reason}`.slice(0, 200)) }
  }
  return report
}

// ── 8. Support tickets (READ ONLY — lane 147H owns the loop) ───────────────────────────────────────────

/**
 * A ticket past its SLA with no completion yet → open one (owner: the manager lane 147H names; data_steward until then —
 * TABLE_MANAGER support_tickets) so the supervisor hands the stall to its owner. Reads support_tickets; never writes it.
 */
export async function watchUnresolvedTickets(svc: Svc, brokerageId: string, opts: { now?: Date; ownerFor?: (t: { lane: string | null; category: string | null }) => CompletionOwner } = {}, deps: CompletionDeps = {}): Promise<{ opened: number; error: string | null }> {
  const now = opts.now ?? new Date()
  const { data, error } = await svc.from("support_tickets").select("id, brokerage_id, priority, status, created_at, first_response_at, resolved_at, lane, category, subject")
    .eq("brokerage_id", brokerageId).in("status", ["open", "in_progress"]).limit(500)
  if (error) return { opened: 0, error: `support_tickets unreadable: ${error.message}` }
  const { evaluateTicketSla, supportTicketCompletion } = await import("@/lib/support/support-sla")
  // WAVE 147 (lane 147Z — lane 147H Outside-lane 2): the per-ticket OWNER MANAGER is lane H's triage owner by category
  // (lib/support/ticket-triage.ts TRIAGE_OWNER_BY_CATEGORY — billing → finance_manager, compliance → compliance_officer, the
  // rest → data_steward), through H's own completion spec (lib/support/support-sla.ts supportTicketCompletion — what, due,
  // the evidence that closes it, and the STALL RULE: page the answering side once, second tier at 2×). An unknown category
  // reads as general (never a guess); an explicit ownerFor still wins.
  const { TRIAGE_OWNER_BY_CATEGORY } = await import("@/lib/support/ticket-triage")
  let opened = 0
  for (const t of (data ?? []) as Array<{ id: string; priority: string | null; status: string; created_at: string; first_response_at: string | null; resolved_at: string | null; lane: string | null; category: string | null; subject: string | null }>) {
    const sla = evaluateTicketSla(t as never, now)
    if (sla.breaches.length === 0) continue
    const plan = supportTicketCompletion(t as never, TRIAGE_OWNER_BY_CATEGORY, now)
    const owner: CompletionOwner = opts.ownerFor ? opts.ownerFor(t) : isOwner(plan?.ownerManager) ? plan!.ownerManager as CompletionOwner : "data_steward"
    const r = await openCompletion(svc, {
      brokerageId, kind: "support_ticket", ownerManager: owner,
      subject: { type: "support_ticket", id: t.id }, sourceRef: `ticket:${t.id}`, what: `Resolve support ticket "${(t.subject ?? "untitled").slice(0, 80)}"`,
      stage: "awaiting_resolution", expectedEvidence: ["ticket_resolution"], dueAt: sla.resolutionDueAt,
      context: { ticket_id: t.id, breaches: sla.breaches, owed: plan?.what ?? null, evidence_expected: plan?.evidenceExpected ?? [], stall_rule: plan?.stallRule ?? null },
    }, deps)
    if (r.ok && !r.duplicate) opened++
  }
  return { opened, error: null }
}
