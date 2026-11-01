// lib/kernel/status-override.ts
// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT C23 — STATUS OVERRIDE (wave 148, lane 148I; owner rulings 13 + 14, 2026-11-01).
//
// OWNER: "manual status picking is always a choice but human needs to provide proof or reason of the change";
// "if a status is offered the UI has to show it".
//
// WHAT THIS IS. The ONE decision every manual status door asks before it writes (listings board picker, the support desk
// picker, the open-house cancel, the transaction stage override, the listing stage override):
//   overrideStatus({ entity, from, to, reason, evidence?, actor }) →
//     · refused WITHOUT a reason (OVERRIDE_REASON_MIN_CHARS — the same floor requireOverrideActor has always held);
//     · refused WITHOUT evidence where the vocabulary demands proof (a listing marked sold, a deal closed by hand);
//     · refused for a GATED value — one only its gated door may write (compliance, signature, tenant authority, the
//       transaction's own gate, money). A status override NEVER bypasses those: the listing's activation gate, the
//       agreement's execution and compliance review, the commission ladder, the e-sign provider, the transaction's
//       compliance / TRID / CDA gate all stay where they are, and the refusal NAMES the door that does reach the value;
//     · refused while the entity's own gate reports a HARD blocker (the caller runs that gate and hands the blockers in);
//     · otherwise allowed — and LEDGERED with who, why, what proof, from → to (LAW 5).
// The decision is PURE. `overrideStatus` is the runtime for a door that has no ledger of its own yet; a door that
// already ledgers (updateListingStatus → listing.status.set, updateTicketStatus → support.ticket.status_change) asks
// decideStatusOverride and carries statusOverrideDetail(decision) on its OWN ledger row — one decision, one evidence shape.
//
// THE CENSUS. STATUS_ENTITIES is the registry of every status vocabulary a person is shown: its table / column, every
// value (the canonical constant — scripts/status-override-guard.ts proves it equals the live CHECK), a label for EVERY
// value (typed Record — a value cannot exist without a label), and per value whether a person may set it (manual) or
// only a gated door (gated, with the door named). statusOptionsFor() hands a picker EVERY value — gated ones disabled
// with the reason — so "if a status is offered the UI has to show it" holds by construction; the guard proves each
// authorized UI renders through it (or the canonical constant / StatusBadge).
//
// Not server-only and NO server imports at all (static or dynamic): client pickers import the registry; the runtime half is
// handed the action ledger by its server door.

import { LISTING_STATUSES, LISTING_STATUS_LABELS, type ListingStatus } from "@/lib/constants"
import { GATED_LISTING_STATUSES, isGatedStage, mappedStages } from "@/lib/listings/listing-status-sync"
import { TRANSACTION_STATUSES, type TransactionStatus } from "@/lib/transactions/transaction-status"
import type { TransactionStage } from "@/lib/transactions/transaction-stages"
import { TICKET_STATUSES, type TicketStatus } from "@/lib/support/ticket-constants"
import { ESIGN_PACKET_STATES, type EsignPacketState } from "@/lib/esign/packet-states"

// ── 1. The rule's constants ─────────────────────────────────────────────────────────────────────

/** The reason floor for EVERY manual status change and every override (requireOverrideActor reads this — one rule). */
export const OVERRIDE_REASON_MIN_CHARS = 10

/** What a person can offer as PROOF (any one satisfies a value that demands evidence). */
const STATUS_EVIDENCE_KINDS = ["document", "mls_record", "external_reference", "provider_record"] as const
export type StatusEvidenceKind = (typeof STATUS_EVIDENCE_KINDS)[number]
export const STATUS_EVIDENCE_LABELS: Readonly<Record<StatusEvidenceKind, string>> = Object.freeze({
  document: "A document on file (its id or file name)",
  mls_record: "The MLS record (MLS number)",
  external_reference: "A title / escrow / attorney reference (file or confirmation number)",
  provider_record: "A provider record (envelope, ticket or confirmation id)",
})
export interface StatusEvidence {
  kind: StatusEvidenceKind
  /** The reference itself — an id, a number, a file name. Never a body of text standing in for proof. */
  ref: string
  note?: string | null
}

/** The gates a status override never bypasses (owner ruling 13). */
const STATUS_GATE_KINDS = ["compliance", "signature", "authority", "transaction", "money", "system"] as const
type StatusGateKind = (typeof STATUS_GATE_KINDS)[number]

export interface StatusValuePolicy {
  /** manual = a person may pick it (reason, + proof where `evidence` is set); gated = only `gate.door` writes it. */
  door: "manual" | "gated"
  gate?: { kind: StatusGateKind; door: string; why: string }
  /** Proof required (any one kind). */
  evidence?: readonly StatusEvidenceKind[]
  evidenceHint?: string
}

// ── 2. The vocabularies this registry introduces (each proven equal to its live CHECK by the guard) ─────

/** open_house_events.status — the live CHECK (open_house_events_status_check). The old OPEN_HOUSE_STATUSES list was
 *  deleted for spelling `in_progress` (lib/constants/index.ts tombstone); this mirror is CHECK-equal and guarded. */
export const OPEN_HOUSE_EVENT_STATUSES = ["draft", "scheduled", "marketing", "active", "completed", "cancelled"] as const
export type OpenHouseEventStatus = (typeof OPEN_HOUSE_EVENT_STATUSES)[number]

/** agent_commissions.status — the live CHECK (and the keys of lib/kernel/financial.ts COMMISSION_STATUS_TRANSITIONS). */
const COMMISSION_PAYMENT_STATUSES = ["pending", "approved", "paid", "disputed"] as const
type CommissionPaymentStatus = (typeof COMMISSION_PAYMENT_STATUSES)[number]

// ── 3. The registry ─────────────────────────────────────────────────────────────────────────────

interface StatusEntityPolicy<V extends string = string> {
  label: string
  table: string
  column: string
  values: readonly V[]
  labels: Readonly<Record<V, string>>
  policy: Readonly<Record<V, StatusValuePolicy>>
  /** The server door that applies a manual change (file + function), or null when no value is manual. */
  manualDoor: string | null
}

const TRANSACTION_STATUS_LABELS: Readonly<Record<TransactionStatus, string>> = Object.freeze({
  lead: "Lead", qualifying: "Qualifying", active: "Active (pre-contract)", under_contract: "Under Contract", pending: "Pending",
  clear_to_close: "Clear to Close", closed: "Closed", funded: "Funded", lost: "Lost", archived: "Archived",
})
const TICKET_STATUS_LABELS: Readonly<Record<TicketStatus, string>> = Object.freeze({ open: "Open", in_progress: "In Progress", resolved: "Resolved", closed: "Closed" })
const EVENT_STATUS_LABELS: Readonly<Record<OpenHouseEventStatus, string>> = Object.freeze({ draft: "Draft", scheduled: "Scheduled", marketing: "Marketing", active: "Live now", completed: "Completed", cancelled: "Cancelled" })
const ESIGN_LABELS: Readonly<Record<EsignPacketState, string>> = Object.freeze({
  pending: "Not sent", sent: "Awaiting signatures", partially_signed: "Partially signed", fully_signed: "Fully signed",
  compliance_pending: "In compliance review", correction_required: "Correction required", compliance_approved: "Compliance approved",
  fully_executed: "Fully executed", declined: "Declined", voided: "Voided", expired: "Expired",
})
const COMMISSION_LABELS: Readonly<Record<CommissionPaymentStatus, string>> = Object.freeze({ pending: "Pending", approved: "Approved", paid: "Paid", disputed: "Disputed" })

const LISTING_GATE: Readonly<Record<string, NonNullable<StatusValuePolicy["gate"]>>> = Object.freeze({
  listing_signed: { kind: "signature", door: "the listing agreement's execution (lib/kernel/lifecycle.ts transitionLifecycle → LISTING_AGREEMENT_SIGNED)", why: "Listing Signed is the moment every party signed the listing agreement — the signature itself sets it." },
  coming_soon: { kind: "compliance", door: "the listing-agreement compliance gate (lib/listings/listing-activation-gate.ts → COMING_SOON_PREP)", why: "Coming Soon follows compliance approving the executed agreement." },
  active: { kind: "compliance", door: "the MLS-live event behind the activation gate (lib/listings/mls-live-verification.ts verifyAndRecordMlsLive, or the launch door)", why: "Active means live on the MLS — the feed or the launch door sets it, after the activation gate." },
})

function listingPolicy(): Record<ListingStatus, StatusValuePolicy> {
  const out = {} as Record<ListingStatus, StatusValuePolicy>
  for (const s of LISTING_STATUSES) {
    if ((GATED_LISTING_STATUSES as readonly string[]).includes(s)) out[s] = { door: "gated", gate: LISTING_GATE[s] ?? { kind: "system", door: "its gated door", why: "set by its gate" } }
    else if (s === "sold") out[s] = { door: "manual", evidence: ["document", "mls_record", "external_reference"], evidenceHint: "the settlement statement, the recorded deed or the MLS sold record" }
    else out[s] = { door: "manual" }
  }
  return out
}

/**
 * transactions.status. The deal's status follows its STAGE (STAGE_TO_STATUS_MAP); a person moves it through the stage
 * override (app/actions/transaction-stage-machine.ts advanceTransactionStage), which still runs the transaction's own gate
 * and refuses its HARD blockers (classifyTransactionStageBlocker). A deal is CREATED under contract only by the executed,
 * compliance-passed offer (lib/transactions/transaction-creation-gate.ts); FUNDED is the money moving (the funding
 * confirmation on the commission / disbursement rail); pre-contract states are set where the deal is opened.
 */
const TRANSACTION_POLICY: Readonly<Record<TransactionStatus, StatusValuePolicy>> = Object.freeze({
  lead: { door: "gated", gate: { kind: "system", door: "the deal's creation (createTransaction)", why: "a pre-contract state is set when the deal is opened" } },
  qualifying: { door: "gated", gate: { kind: "system", door: "the deal's creation (createTransaction)", why: "a pre-contract state is set when the deal is opened" } },
  active: { door: "gated", gate: { kind: "system", door: "the deal's creation (createTransaction)", why: "a pre-contract state is set when the deal is opened" } },
  under_contract: { door: "gated", gate: { kind: "signature", door: "the transaction creation gate (lib/transactions/transaction-creation-gate.ts — the executed, compliance-passed offer)", why: "a deal is under contract only once the offer is executed and compliance passed it" } },
  pending: { door: "manual" },
  clear_to_close: { door: "manual" },
  closed: { door: "manual", evidence: ["document", "external_reference", "provider_record"], evidenceHint: "the settlement statement / closing confirmation from title, escrow or the closing attorney" },
  funded: { door: "gated", gate: { kind: "money", door: "the funding confirmation on the disbursement rail (lib/kernel/financial.ts)", why: "funded means the money moved — a person never declares it" } },
  lost: { door: "manual" },
  archived: { door: "gated", gate: { kind: "system", door: "the archive door (lib/services/transaction-management.service.ts)", why: "archiving retires the record; it is not a deal state a picker sets" } },
})

const EVENT_POLICY: Readonly<Record<OpenHouseEventStatus, StatusValuePolicy>> = Object.freeze({
  draft: { door: "gated", gate: { kind: "system", door: "the event's creation (a dateless event is a draft — open_house_events_dateless_only_when_draft)", why: "set when the event is created without a date" } },
  scheduled: { door: "gated", gate: { kind: "system", door: "scheduling the event (app/actions/open-house.ts createOpenHouse / the producers)", why: "set when the event is scheduled" } },
  marketing: { door: "gated", gate: { kind: "system", door: "launching the event's marketing (app/actions/open-house.ts)", why: "set when invitations / marketing go out" } },
  active: { door: "gated", gate: { kind: "system", door: "the event-day check-in opening (lib/kernel/open-house.ts)", why: "set when the event is live" } },
  completed: { door: "gated", gate: { kind: "system", door: "the event-day completion (app/actions/seller-open-house.ts / open-house-automation.ts)", why: "set when the event ends" } },
  cancelled: { door: "manual" },
})

const ESIGN_POLICY: Readonly<Record<EsignPacketState, StatusValuePolicy>> = Object.freeze(Object.fromEntries(ESIGN_PACKET_STATES.map((s) => [s, {
  door: "gated" as const,
  gate: s.startsWith("compliance") || s === "correction_required" || s === "fully_executed"
    ? { kind: "compliance" as const, door: "compliance review of the signed packet (lib/esign/packet-states.ts ladder)", why: "the compliance reviewer moves a signed packet" }
    : { kind: "signature" as const, door: "the e-sign provider's own report (the envelope webhooks)", why: "only the signers and their provider move an envelope" },
}])) as Record<EsignPacketState, StatusValuePolicy>)

const COMMISSION_POLICY: Readonly<Record<CommissionPaymentStatus, StatusValuePolicy>> = Object.freeze(Object.fromEntries(COMMISSION_PAYMENT_STATUSES.map((s) => [s, {
  door: "gated" as const,
  gate: { kind: "money" as const, door: "the commission ladder (lib/kernel/financial.ts COMMISSION_STATUS_TRANSITIONS — approve, pay, dispute)", why: "a commission moves only through its finance-admin money doors" },
}])) as Record<CommissionPaymentStatus, StatusValuePolicy>)

/** @proofSeam scripts/status-override-guard.ts — every entity's values equal its live CHECK; every value has a label + policy. */
export const STATUS_ENTITIES = {
  listing: { label: "Listing", table: "listings", column: "status", values: LISTING_STATUSES, labels: LISTING_STATUS_LABELS, policy: listingPolicy(), manualDoor: "app/actions/listings-kernel.ts updateListingStatus" } as StatusEntityPolicy<ListingStatus>,
  transaction: { label: "Transaction", table: "transactions", column: "status", values: TRANSACTION_STATUSES, labels: TRANSACTION_STATUS_LABELS, policy: TRANSACTION_POLICY, manualDoor: "app/actions/transaction-stage-machine.ts advanceTransactionStage" } as StatusEntityPolicy<TransactionStatus>,
  support_ticket: { label: "Support ticket", table: "support_tickets", column: "status", values: TICKET_STATUSES, labels: TICKET_STATUS_LABELS, policy: Object.fromEntries(TICKET_STATUSES.map((s) => [s, { door: "manual" }])) as Record<TicketStatus, StatusValuePolicy>, manualDoor: "app/actions/support.ts updateTicketStatus" } as StatusEntityPolicy<TicketStatus>,
  open_house_event: { label: "Event", table: "open_house_events", column: "status", values: OPEN_HOUSE_EVENT_STATUSES, labels: EVENT_STATUS_LABELS, policy: EVENT_POLICY, manualDoor: "app/actions/open-house.ts cancelOpenHouse" } as StatusEntityPolicy<OpenHouseEventStatus>,
  offer_esign: { label: "Offer signatures", table: "offers", column: "esign_status", values: ESIGN_PACKET_STATES, labels: ESIGN_LABELS, policy: ESIGN_POLICY, manualDoor: null } as StatusEntityPolicy<EsignPacketState>,
  commission_payment: { label: "Commission payment", table: "agent_commissions", column: "status", values: COMMISSION_PAYMENT_STATUSES, labels: COMMISSION_LABELS, policy: COMMISSION_POLICY, manualDoor: null } as StatusEntityPolicy<CommissionPaymentStatus>,
} as const
export type StatusEntity = keyof typeof STATUS_ENTITIES


const entityOf = (e: string): StatusEntityPolicy | null => (Object.prototype.hasOwnProperty.call(STATUS_ENTITIES, e) ? (STATUS_ENTITIES as Record<string, StatusEntityPolicy>)[e] : null)

/** PURE — the display label of any registered status value (an unknown value is shown as itself, never hidden). */
export function statusLabel(entity: StatusEntity, value: string | null | undefined): string {
  const e = entityOf(entity)
  if (!value) return "—"
  return (e?.labels as Record<string, string> | undefined)?.[value] ?? value.replace(/_/g, " ")
}

interface StatusOption { value: string; label: string; selectable: boolean; why: string | null; needsEvidence: boolean }

/**
 * PURE — EVERY value of the vocabulary for a picker, in vocabulary order. A gated value is SHOWN (disabled) with the door
 * that reaches it; the current value is always shown as itself. "If a status is offered the UI has to show it."
 */
export function statusOptionsFor(entity: StatusEntity, current?: string | null): StatusOption[] {
  const e = entityOf(entity)
  if (!e) return []
  return e.values.map((value) => {
    const p = (e.policy as Record<string, StatusValuePolicy>)[value]
    const gated = p?.door !== "manual"
    return { value, label: (e.labels as Record<string, string>)[value] ?? value, selectable: !gated && value !== current, why: gated ? `${p?.gate?.why ?? "set by its gate"} (${p?.gate?.door ?? "its gated door"})` : null, needsEvidence: !!p?.evidence?.length }
  })
}

// ── 4. The decision ─────────────────────────────────────────────────────────────────────────────

interface StatusOverrideInput {
  entity: StatusEntity
  from: string | null
  to: string
  reason: string | null | undefined
  evidence?: StatusEvidence | null
  actor: { userId: string | null; userType?: string | null }
  /** The entity's OWN gate's hard blockers (the caller ran it). Any → refused, named. */
  hardBlockers?: readonly string[]
  /** Soft (process) blockers the override is consciously passing — recorded on the evidence, never hidden. */
  softBlockers?: readonly string[]
  /** A finer state UNDER the status (the transaction's stage): the no-change test reads it, and a stage move that keeps the
   *  status (INSPECTION → APPRAISAL, both under contract) is not a pick of that status's gated door. */
  stage?: { from: string | null; to: string } | null
}

type StatusOverrideRefusal = "unknown_entity" | "not_a_value" | "no_change" | "gated_value" | "reason_required" | "evidence_required" | "hard_gate" | "no_actor"
type StatusOverrideDecision =
  | { ok: true; entity: StatusEntity; from: string | null; to: string; reason: string; evidence: StatusEvidence | null; softBlockers: readonly string[]; stage: { from: string | null; to: string } | null }
  | { ok: false; code: StatusOverrideRefusal; message: string }

const validEvidence = (e: StatusEvidence | null | undefined, kinds: readonly StatusEvidenceKind[]): e is StatusEvidence =>
  !!e && (STATUS_EVIDENCE_KINDS as readonly string[]).includes(e.kind) && kinds.includes(e.kind) && typeof e.ref === "string" && e.ref.trim().length >= 3

/** PURE — C23. Refuses without a reason / required proof / on a gated value / while the entity's own gate is hard-blocked. */
export function decideStatusOverride(input: StatusOverrideInput): StatusOverrideDecision {
  const e = entityOf(input.entity)
  if (!e) return { ok: false, code: "unknown_entity", message: `"${String(input.entity)}" is not a registered status entity` }
  if (!input.actor?.userId) return { ok: false, code: "no_actor", message: "a status change needs the person making it (the session), never an anonymous call" }
  if (!(e.values as readonly string[]).includes(input.to)) return { ok: false, code: "not_a_value", message: `'${input.to}' is not a ${e.label.toLowerCase()} status. Valid: ${e.values.join(", ")}` }
  const statusUnchanged = input.from === input.to
  const stageMove = !!input.stage && input.stage.from !== input.stage.to
  if (input.stage ? !stageMove : statusUnchanged) return { ok: false, code: "no_change", message: `the ${e.label.toLowerCase()} is already ${input.stage ? input.stage.to : statusLabel(input.entity, input.to)}` }
  const p = (e.policy as Record<string, StatusValuePolicy>)[input.to]
  if (!(statusUnchanged && stageMove) && (!p || p.door !== "manual")) {
    return { ok: false, code: "gated_value", message: `${statusLabel(input.entity, input.to)} is never set by a status override — ${p?.gate?.why ?? "it is set by its gate"} Reached through: ${p?.gate?.door ?? "its gated door"}.` }
  }
  const reason = (input.reason ?? "").trim()
  if (reason.length < OVERRIDE_REASON_MIN_CHARS) return { ok: false, code: "reason_required", message: `Tell us why (at least ${OVERRIDE_REASON_MIN_CHARS} characters) — a manual status change is always recorded with its reason.` }
  if (p?.evidence?.length && !validEvidence(input.evidence, p.evidence)) {
    return { ok: false, code: "evidence_required", message: `${statusLabel(input.entity, input.to)} needs proof: ${p.evidenceHint ?? p.evidence.map((k) => STATUS_EVIDENCE_LABELS[k]).join(" or ")} (${p.evidence.join(" / ")}).` }
  }
  const hard = (input.hardBlockers ?? []).filter((b) => typeof b === "string" && b.trim())
  if (hard.length > 0) return { ok: false, code: "hard_gate", message: `An override never passes these gates — clear them first: ${hard.join("; ")}` }
  return { ok: true, entity: input.entity, from: input.from, to: input.to, reason, evidence: input.evidence ? { kind: input.evidence.kind, ref: input.evidence.ref.trim().slice(0, 200), note: input.evidence.note?.trim().slice(0, 500) ?? null } : null, softBlockers: input.softBlockers ?? [], stage: input.stage ?? null }
}

/** The ONE evidence shape every manual status change carries on its ledger row (LAW 5). */
export function statusOverrideDetail(d: Extract<StatusOverrideDecision, { ok: true }>, actor: StatusOverrideInput["actor"]): Record<string, unknown> {
  return { status_override: { contract: "C23", entity: d.entity, from: d.from, to: d.to, stage: d.stage, reason: d.reason, evidence: d.evidence, soft_blockers_passed: d.softBlockers, actor_user_id: actor.userId, actor_user_type: actor.userType ?? null } }
}

// ── 5. The gates a stage override never passes ───────────────────────────────────────────────────

/**
 * PURE — is this blocker from the transaction's own gate (lib/transactions/stage-progression.ts canAdvanceStage, incl.
 * app/actions/transaction-compliance.ts canProceedToClosingPrep) a HARD gate or a SOFT process prerequisite?
 *   HARD (never overridden): compliance (compliance_passed_at, a failed / pending / needs-review blocking check, a
 *   deal-breaker flag — a compliance approver WAIVES a check in transaction_compliance_log, that is its door), the federal
 *   TRID Closing Disclosure clock, the brokerage's CDA (commission routing — money), and any gate that could not run.
 *   SOFT: the contract date not yet keyed, a contingency-deadline milestone not yet marked, the stage ladder's order.
 * UNKNOWN text is HARD (fail closed, CLAUDE.md §4) — scripts/status-override-guard.ts classifies every blocker literal in
 * the gate's source so a new one cannot silently become overridable.
 */
function classifyTransactionStageBlocker(blocker: string): "hard" | "soft" {
  const b = String(blocker ?? "").trim()
  if (/^contract_date must be set/.test(b)) return "soft"
  if (/^Cannot transition from \S+ to \S+\. Not an allowed transition\./.test(b)) return "soft"
  const m = /^Critical milestone "([a-z_]+)" (?:not found|must be completed)$/.exec(b)
  if (m && m[1] !== "cda_delivered") return "soft"
  return "hard"
}

export function partitionStageBlockers(blockers: readonly string[]): { hard: string[]; soft: string[] } {
  const hard: string[] = [], soft: string[] = []
  for (const b of blockers) (classifyTransactionStageBlocker(b) === "hard" ? hard : soft).push(b)
  return { hard, soft }
}

/** The stages a stage override may never target (each has a gated door). */
export const GATED_TRANSACTION_STAGES: Readonly<Partial<Record<TransactionStage, string>>> = Object.freeze({
  UNDER_CONTRACT: "a deal enters UNDER_CONTRACT only through the transaction creation gate (the executed, compliance-passed offer)",
})

/**
 * PURE — may a listing STAGE override target this stage? A stage whose status is gated (Listing Signed, Coming Soon,
 * Active) or a gated stage (COMING_SOON_PREP — the compliance gate) is reached only through its gated door.
 */
export function listingStageOverrideRefusal(stage: string): string | null {
  const mapped = mappedStages().find((m) => m.stage === stage)
  if (isGatedStage(stage)) return `${stage} is reached only when the listing-agreement compliance gate passes — never by an override`
  if (mapped && (GATED_LISTING_STATUSES as readonly string[]).includes(mapped.status)) {
    const g = LISTING_GATE[mapped.status]
    return `${stage} sets the listing ${statusLabel("listing", mapped.status)} — ${g?.why ?? "set by its gate"} Reached through: ${g?.door ?? "its gated door"}.`
  }
  return null
}

// ── 6. The runtime for a door without a ledger of its own ─────────────────────────────────────────

type LedgerFn = typeof import("@/lib/kernel/action-ledger").withActionLedger

interface OverrideStatusRun<T> {
  brokerageId: string
  subject: { type: string; id: string }
  /** Default `status.<entity>.override` (domain.entity.action). */
  action?: string
  /** The row version the door read (updated_at) — the same click twice replays; a later change is a new action. */
  rowVersion?: string | null
  systemSource: string
  apply: () => Promise<{ ok: true; result?: T } | { ok: false; error: string }>
}

type OverrideStatusResult<T> =
  | { ok: true; decision: Extract<StatusOverrideDecision, { ok: true }>; result?: T }
  | { ok: false; code: StatusOverrideRefusal | "write_refused" | "ledger_refused" | "replayed"; message: string }

/**
 * C23 runtime — decide, then apply the door's own write INSIDE the action ledger (who, why, what proof, from → to). A
 * refusal writes nothing; a refused ledger claim writes nothing (fail closed); a replay reports the change already made.
 */
export async function overrideStatus<T = unknown>(input: StatusOverrideInput, run: OverrideStatusRun<T>, deps: { ledger: LedgerFn; client?: unknown }): Promise<OverrideStatusResult<T>> {
  const d = decideStatusOverride(input)
  if (!d.ok) return d
  // The ledger is HANDED IN by the server door (this module is imported by client pickers — it never reaches for a server
  // module itself, so no client bundle can pull the ledger / service client in).
  const ledger = deps.ledger
  const action = run.action ?? `status.${input.entity}.override`
  type R = { ok: true; result?: T } | { ok: false; error: string; code?: "write_refused" | "ledger_refused" | "replayed" }
  const r = await ledger<R>(
    {
      brokerageId: run.brokerageId, action, actor: { type: "user", userId: input.actor.userId },
      subject: run.subject, reasonCode: "HUMAN_REQUESTED", reasonDetail: `${d.from ?? "none"} → ${d.to}: ${d.reason}`.slice(0, 500),
      idempotencyKey: `status_override:${input.entity}:${run.subject.id}:${d.stage ? `${d.stage.from ?? "none"}->${d.stage.to}` : `${d.from ?? "none"}->${d.to}`}:${run.rowVersion ?? "v0"}`,
      riskClass: "LOW_RISK_WRITE", systemSource: run.systemSource, detail: statusOverrideDetail(d, input.actor),
    },
    async () => {
      const w = await run.apply()
      return w.ok ? w : { ok: false, error: w.error, code: "write_refused" }
    },
    {
      settle: (x) => (x.ok ? { status: "executed", outcome: `status:${d.to}` } : { status: "failed", outcome: "not_changed", error: x.error }),
      replay: (claim) => claim.kind === "refused"
        ? { ok: false, error: `The change could not be recorded, so nothing was changed (${claim.error}).`, code: "ledger_refused" }
        : claim.kind === "replay" ? { ok: false, error: "This status change was already recorded.", code: "replayed" }
        : { ok: false, error: "This status change is already being recorded — refresh in a moment.", code: "replayed" },
    },
    deps.client ? { client: deps.client as never } : undefined,
  )
  if (r.ok) return { ok: true, decision: d, result: r.result }
  return { ok: false, code: (r as { code?: "write_refused" | "ledger_refused" | "replayed" }).code ?? "write_refused", message: r.error }
}
