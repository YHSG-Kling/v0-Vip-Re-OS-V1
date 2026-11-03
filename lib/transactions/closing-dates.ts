// lib/transactions/closing-dates.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CLOSING-DATE MODEL (wave 148, lane 148I; owner ruling 21, 2026-11-01): "a closing date can also be worded as 'on or
// before' … lending/title/closing attorney (depends on state) would know best."
//
// THREE FACTS, NEVER ONE COLUMN (m927):
//   · CONTRACTUAL — the executed contract's closing deadline (contract_closing_date) and HOW it is worded
//     (contract_closing_terms: 'on' a day | 'on_or_before' a day; NULL = not yet read — unknown, never assumed). It comes
//     from the executed contract when the deal is created and changes ONLY by an EXECUTED amendment, with its reference.
//   · ANTICIPATED — when everyone currently expects to close (estimated_close_date, or the title/escrow appointment). A
//     proposed early (or late) closing moves THIS, and only this. A proposal is not an executed amendment.
//   · ACTUAL — the verified closing day (actual_close_date), stamped by the close itself.
// transactions.close_date stays the EFFECTIVE date its many readers use (unchanged writers, unchanged meaning).
//
// WHAT AN EARLIER CLOSING NEEDS (verified, not invented — see the notes in assessClosingDateChange). C33 (wave 149, lane
// 149G — owner ruling 17, 2026-11-03: "early closing needs no executed amendment unless state law requires it. Keep 'on or
// before'; track contractual vs anticipated vs actual"):
//   · the contract's own words: under "on or before", an earlier day is WITHIN the contract — NO executed amendment, unless
//     the deal's STATE carries a sourced rule requiring one (lib/state-forms/closing-participants.ts
//     StateClosingPolicy.earlierClosing — absent today for every state, so it is never assumed). Under "on" (a fixed day)
//     an earlier day changes a term the contract itself fixes → every party signs an amendment (contract modification:
//     mutual assent — .claude/skills/attorney-legal-practice). Any day AFTER the deadline needs an executed extension under
//     either wording. A wording NOT YET READ is "unknown" — read it off the executed contract; it is never defaulted to
//     "needs an amendment" (the wave-148 default, reversed) nor to "fine";
//   · the lender: a financed deal's Closing Disclosure must be RECEIVED ≥ 3 business days before consummation (TRID,
//     12 CFR 1026.19(f)(1)(ii) — .claude/skills/mortgage-broker-mortgage-lending; the gate already enforces it at CLOSED,
//     lib/transactions/stage-progression.ts step 10), clear-to-close and funding readiness;
//   · title / escrow / the closing attorney: who conducts the closing depends on the STATE (closingStateNote) and local
//     practice; funding may follow signing in some states (the deal's FUNDED status is separate from CLOSED);
//   · every party ready (walkthrough, possession, moving, the other side's purchase / sale).
// The OS explains and routes; the people who conduct the closing decide. Nothing here gives legal advice.
//
// Pure helpers + two best-effort writers + the governed change (ledgered). NO server imports (static or dynamic): the
// transaction's closing-dates panel imports the constants on the client; the server door hands the action ledger in.

import { OVERRIDE_REASON_MIN_CHARS } from "@/lib/kernel/status-override"
import { closingStateNote } from "@/lib/state-forms/closing-participants"
// TYPE-ONLY (see lib/kernel/status-override.ts LedgerFn): an `import type` is erased and ignored by scripts/client-server-only-guard.ts;
// a `typeof import()` is followed as a real edge and pulled the closing-dates panel into the server bundle.
import type { withActionLedger } from "@/lib/kernel/action-ledger"

type Svc = { from: (t: string) => any }

export const CLOSING_DATE_TERMS = ["on", "on_or_before"] as const
type ClosingDateTerms = (typeof CLOSING_DATE_TERMS)[number]
const CONTRACT_CLOSING_SOURCES = ["executed_contract", "executed_amendment"] as const
type ContractClosingSource = (typeof CONTRACT_CLOSING_SOURCES)[number]
export const CLOSING_DATE_TERMS_LABELS: Readonly<Record<ClosingDateTerms, string>> = Object.freeze({ on: "On", on_or_before: "On or before" })

const isClosingDateTerms = (v: unknown): v is ClosingDateTerms => typeof v === "string" && (CLOSING_DATE_TERMS as readonly string[]).includes(v)

// TOMBSTONE (wave 149, lane 149G — CLAUDE.md §1 / §6, one state survivor): `ATTORNEY_CLOSING_REPORTED` (two secondary-
// sourced state lists — "commonly" CT DE GA MA SC VT WV, "reported" AL DC KS KY LA MD ME MS NC NH NY) and the private
// `closingStateNote` lived here: a SECOND state table beside the sourced one. Merged onto the survivor,
// lib/state-forms/closing-participants.ts closingStateNote — the sourced policies first (with their source), the published
// regional convention second (labelled a convention, never law) — which is also the ONE place a state's early-closing rule
// lives (StateClosingPolicy.earlierClosing).

interface ClosingDateFacts {
  contract_closing_date?: string | null
  contract_closing_terms?: string | null
  contract_closing_source?: string | null
  contract_closing_amendment_ref?: string | null
  estimated_close_date?: string | null
  actual_close_date?: string | null
  close_date?: string | null
  status?: string | null
  property_state?: string | null
  financing_type?: string | null
  /** The title / escrow appointment, when one is on file (transaction_title_escrow / the closing appointment). */
  scheduled_closing_date?: string | null
}

export interface ClosingDates {
  /** The deal is closed / funded — the actual day is the record (only `actual_confirmation` may change it). */
  closed: boolean
  contractual: { date: string; terms: ClosingDateTerms | null; source: ContractClosingSource | "legacy_close_date"; amendmentRef: string | null } | null
  anticipated: { date: string; basis: "title_schedule" | "estimated_close_date" | "contract" } | null
  actual: { date: string; source: "actual_close_date" | "legacy_close_date" } | null
  effective: string | null
  wording: string
  /**
   * C33 — may this deal close EARLIER than the contract's date without an executed amendment? `true` under "on or
   * before" (unless the state carries a sourced rule), `false` under a fixed "on" day (the contract fixes it), "unknown"
   * while the wording is unread. `note` says it in words — "closing may occur earlier" when it may.
   */
  earlierClosing: { allowed: boolean | "unknown"; requiresExecutedAmendment: boolean | "unknown"; basis: AmendmentBasis; note: string } | null
  stateNote: ReturnType<typeof closingStateNote>
  notes: string[]
}

/** WHY an executed amendment is (or is not) needed — the contract's own term, the state's sourced rule, or nothing. */
type AmendmentBasis = "none" | "contract_fixed_day" | "contract_deadline_passed" | "state_rule" | "wording_unread"

/**
 * PURE — the early-closing verdict for an "earlier than the contract's date" day, from the contract's wording and the
 * state's SOURCED rule only (owner ruling 17). Never defaults to "needs an amendment"; an unread wording is "unknown".
 */
function earlierClosingVerdict(terms: ClosingDateTerms | null, date: string, state: ReturnType<typeof closingStateNote>): NonNullable<ClosingDates["earlierClosing"]> {
  if (terms === "on_or_before") {
    if (state.earlierClosing) return { allowed: true, requiresExecutedAmendment: true, basis: "state_rule", note: `The contract says "on or before ${date}", so closing may occur earlier — but this state requires an executed amendment first: ${state.earlierClosing.summary} (${state.earlierClosing.source.title}).` }
    return { allowed: true, requiresExecutedAmendment: false, basis: "none", note: `The contract says "on or before ${date}": closing may occur earlier than that day with no executed amendment — the lender, the closing ${state.conductedBy.startsWith("attorney") ? "attorney" : "title / escrow company"} and every party still have to be ready.` }
  }
  if (terms === "on") return { allowed: false, requiresExecutedAmendment: true, basis: "contract_fixed_day", note: `The contract fixes the day ("on ${date}"); closing earlier changes that term, so every party signs an amendment.` }
  return { allowed: "unknown", requiresExecutedAmendment: "unknown", basis: "wording_unread", note: `Whether closing may occur earlier depends on how the contract words its date — read it off the executed contract: under "on or before" no amendment is needed; under a fixed "on" day every party signs one.` }
}

const day = (v: string | null | undefined): string | null => {
  const s = typeof v === "string" ? v.trim().slice(0, 10) : ""
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}
const CLOSED_STATUSES = new Set(["closed", "funded"])

/** PURE — the three closing facts of one deal, each with where it came from. */
/** The state table the model reads — the sourced survivor by default; a proof hands in a fixture (a state WITH a rule). */
type StateTable = Parameters<typeof closingStateNote>[1]

export function resolveClosingDates(f: ClosingDateFacts, opts?: { statePolicies?: StateTable }): ClosingDates {
  const notes: string[] = []
  const closed = CLOSED_STATUSES.has(String(f.status ?? ""))
  const terms = isClosingDateTerms(f.contract_closing_terms) ? f.contract_closing_terms : null
  let contractual: ClosingDates["contractual"] = null
  const cd = day(f.contract_closing_date)
  if (cd) {
    const source = (CONTRACT_CLOSING_SOURCES as readonly string[]).includes(String(f.contract_closing_source)) ? f.contract_closing_source as ContractClosingSource : "executed_contract"
    contractual = { date: cd, terms, source, amendmentRef: f.contract_closing_amendment_ref ?? null }
  } else if (!closed && day(f.close_date)) {
    // A deal created before m927: close_date still holds the contract's date (nothing has closed it yet).
    contractual = { date: day(f.close_date)!, terms, source: "legacy_close_date", amendmentRef: null }
    notes.push("The contract's closing date is read from the legacy close_date (recorded before the closing-date model) — confirm it against the executed contract.")
  }
  // Owner ruling 17 (wave 149, lane 149G): an unread wording is UNKNOWN — the wave-148 note here defaulted it to "treated
  // as needing an executed amendment", which demanded an amendment the contract may not require. It now asks for the reading.
  if (contractual && !contractual.terms) notes.push("How the contract words its closing date (on, or on or before) has not been read yet — record it from the executed contract; whether an earlier closing needs an amendment depends on it.")
  const actualDay = day(f.actual_close_date) ?? (closed ? day(f.close_date) : null)
  const actual: ClosingDates["actual"] = actualDay ? { date: actualDay, source: day(f.actual_close_date) ? "actual_close_date" : "legacy_close_date" } : null
  const anticipated: ClosingDates["anticipated"] = day(f.scheduled_closing_date)
    ? { date: day(f.scheduled_closing_date)!, basis: "title_schedule" }
    : day(f.estimated_close_date) ? { date: day(f.estimated_close_date)!, basis: "estimated_close_date" }
    : contractual ? { date: contractual.date, basis: "contract" } : null
  const wording = contractual
    ? `${contractual.terms === "on_or_before" ? "On or before" : contractual.terms === "on" ? "On" : "Closing date (wording not yet read):"} ${contractual.date}`
    : "No contractual closing date on file"
  const stateNote = closingStateNote(f.property_state, opts?.statePolicies)
  return {
    closed, contractual, anticipated: closed ? null : anticipated, actual, effective: actual?.date ?? anticipated?.date ?? contractual?.date ?? day(f.close_date), wording,
    earlierClosing: contractual && !closed ? earlierClosingVerdict(contractual.terms, contractual.date, stateNote) : null,
    stateNote, notes,
  }
}

/**
 * PURE — THE DAY CLOSING READINESS IS MEASURED AGAINST (wave 149, lane 149G — C33 coordination). Under "on or before" a
 * deal may close before the contract's date, so the lender's clear-to-close, the walkthrough, the wire instructions and
 * the CDA must be ready for the EARLIEST credible closing day: the title / escrow appointment, the anticipated day or the
 * contract's date, whichever comes first. Never later than the contract (a later anticipated day is not a deadline until
 * an executed extension moves the contract). Pure; the readiness detectors and the CDA deadline read it.
 */
export function readinessClosingDay(f: Pick<ClosingDateFacts, "contract_closing_date" | "close_date" | "estimated_close_date" | "scheduled_closing_date" | "status">): { date: string; basis: "title_schedule" | "anticipated" | "contract" } | null {
  if (CLOSED_STATUSES.has(String(f.status ?? ""))) return null
  const contract = day(f.contract_closing_date) ?? day(f.close_date)
  const candidates: Array<{ date: string; basis: "title_schedule" | "anticipated" | "contract" }> = []
  const sched = day(f.scheduled_closing_date), est = day(f.estimated_close_date)
  if (sched) candidates.push({ date: sched, basis: "title_schedule" })
  if (est && (!contract || est <= contract)) candidates.push({ date: est, basis: "anticipated" })
  if (contract) candidates.push({ date: contract, basis: "contract" })
  if (candidates.length === 0) return null
  // earliest wins; on a tie the more specific basis (title schedule, then anticipated) is named
  return candidates.reduce((a, b) => (b.date < a.date ? b : a))
}

export interface ClosingDateChangeAssessment {
  kind: "anticipated" | "executed_amendment"
  direction: "earlier" | "later" | "same" | "no_contract_date"
  /** May the deal close on the proposed day under the contract AS EXECUTED? */
  withinContract: boolean | "unknown"
  /**
   * Does closing on the proposed day need an EXECUTED amendment / extension? `false` for an earlier day under "on or
   * before" (owner ruling 17) unless the state's sourced rule says otherwise; `true` for a fixed "on" day moved, any day
   * past the deadline, or a sourced state rule; "unknown" while the contract's wording is unread — never a default `true`.
   */
  requiresExecutedAmendment: boolean | "unknown"
  amendmentBasis: AmendmentBasis
  coordinate: string[]
  stateNote: string
  explanation: string
}

const isFinanced = (t: string | null | undefined) => !!t && !/^(cash|all_cash)$/i.test(String(t))

/**
 * PURE — what a proposed closing day means against the contract (C33). A proposal moves the ANTICIPATED day only; it is
 * never an executed amendment. An earlier day under "on or before" is inside the contract and needs NO amendment unless
 * the deal's state carries a SOURCED rule (closing-participants.ts earlierClosing); a fixed "on" day moved or any day
 * past the deadline needs every party's signed amendment / extension; an unread wording is "unknown" (read it first).
 * Exported for the title portal's appointment door (app/actions/title/closing-appointment.ts), which may now propose an
 * earlier day the contract allows.
 */
export function assessClosingDateChange(facts: ClosingDateFacts, proposed: { date: string; kind: "anticipated" | "executed_amendment" }, opts?: { statePolicies?: StateTable }): ClosingDateChangeAssessment {
  const r = resolveClosingDates(facts, opts)
  const p = day(proposed.date)
  const state = r.stateNote.note
  const coordinate = [
    ...(isFinanced(facts.financing_type) ? ["the lender — clear-to-close, funding, and the Closing Disclosure received at least 3 business days before signing (TRID)"] : []),
    r.stateNote.conductedBy.startsWith("attorney") ? "the closing attorney (who conducts this closing in this state)" : "title / escrow (who conducts this closing)",
    "every party — walkthrough, possession and moving, and any linked purchase or sale",
    "the CDA — the commission disbursement authorization must reach title before the earlier day",
  ]
  if (!p) return { kind: proposed.kind, direction: "no_contract_date", withinContract: "unknown", requiresExecutedAmendment: "unknown", amendmentBasis: "none", coordinate, stateNote: state, explanation: "That is not a calendar date (YYYY-MM-DD)." }
  if (!r.contractual) return { kind: proposed.kind, direction: "no_contract_date", withinContract: "unknown", requiresExecutedAmendment: proposed.kind === "executed_amendment" ? true : "unknown", amendmentBasis: "none", coordinate, stateNote: state, explanation: "No contractual closing date is on file — record the executed contract's date first; the proposed day is an expectation only." }
  const direction = p < r.contractual.date ? "earlier" : p > r.contractual.date ? "later" : "same"
  let withinContract: boolean | "unknown"
  let requiresExecutedAmendment: boolean | "unknown"
  let amendmentBasis: AmendmentBasis
  let why: string
  if (direction === "same") {
    withinContract = true; requiresExecutedAmendment = false; amendmentBasis = "none"; why = "the proposed day is the contract's day"
  } else if (direction === "later") {
    withinContract = false; requiresExecutedAmendment = true; amendmentBasis = "contract_deadline_passed"
    why = `closing after the contract's ${r.contractual.terms === "on_or_before" ? "on-or-before " : ""}deadline (${r.contractual.date}) needs an extension every party signs`
  } else {
    const v = earlierClosingVerdict(r.contractual.terms, r.contractual.date, r.stateNote)
    withinContract = v.allowed; requiresExecutedAmendment = v.requiresExecutedAmendment; amendmentBasis = v.basis
    why = v.basis === "none" ? `"on or before ${r.contractual.date}" already allows an earlier day — no amendment, but the people below must all be ready` : v.note.replace(/\.$/, "")
  }
  return {
    kind: proposed.kind, direction, withinContract, requiresExecutedAmendment, amendmentBasis, coordinate, stateNote: state,
    explanation: `${proposed.kind === "anticipated" ? "A proposed closing day moves the anticipated date only — it is not an executed amendment. " : ""}${why}.`,
  }
}

// ── Writers (best-effort, separate statements — a not-yet-applied m927 column refuses only these, never the caller's write) ──

/** The offer bridge seeds the contract's deadline (and its wording when the executed offer recorded one). */
export async function seedContractClosing(svc: Svc, p: { brokerageId: string; transactionId: string; date: string | null; terms?: string | null }): Promise<{ ok: boolean; error?: string }> {
  const d = day(p.date)
  if (!d) return { ok: false, error: "no contractual closing date on the executed offer" }
  const { data, error } = await svc.from("transactions")
    .update({ contract_closing_date: d, contract_closing_source: "executed_contract", ...(isClosingDateTerms(p.terms) ? { contract_closing_terms: p.terms } : {}) })
    .eq("id", p.transactionId).eq("brokerage_id", p.brokerageId).is("contract_closing_date", null).select("id")
  if (error) return { ok: false, error: error.message }
  return { ok: true, ...(Array.isArray(data) && data.length === 0 ? { error: "already seeded (nothing changed)" } : {}) }
}

/** The verified close stamps the ACTUAL day (never overwrites one already stamped). */
export async function recordActualClosing(svc: Svc, p: { brokerageId: string; transactionId: string; closedOn: Date | string; source: "stage_machine" | "close_command" | "stage_override" }): Promise<{ ok: boolean; error?: string }> {
  const d = day(p.closedOn instanceof Date ? p.closedOn.toISOString() : p.closedOn)
  if (!d) return { ok: false, error: "no closing day" }
  const { data, error } = await svc.from("transactions").update({ actual_close_date: d }).eq("id", p.transactionId).eq("brokerage_id", p.brokerageId).is("actual_close_date", null).select("id")
  if (error) return { ok: false, error: `${error.message} (source ${p.source})` }
  return { ok: true, ...(Array.isArray(data) && data.length === 0 ? { error: "already stamped" } : {}) }
}

// ── The governed change (the action calls it after the session gate) ───────────────────────────

interface ClosingDateChangeInput {
  brokerageId: string
  transactionId: string
  actorUserId: string
  kind: ClosingDateChangeKind
  date?: string | null
  terms?: string | null
  reason: string
  /** Required for an executed amendment, the contract's wording and an actual-closing confirmation: the document that proves it. */
  evidenceRef?: string | null
}

/**
 * The four governed closing-date records. `actual_confirmation` (wave 149, lane 149G — C33 "actual tracked separately"):
 * on a CLOSED deal, the settlement statement / closing file / recorded deed confirms (or corrects) the day it actually
 * closed — the stamp the close writes is the day someone pressed close, which can trail the settlement day.
 */
export const CLOSING_DATE_CHANGE_KINDS = ["anticipated", "executed_amendment", "contract_wording", "actual_confirmation"] as const
export type ClosingDateChangeKind = (typeof CLOSING_DATE_CHANGE_KINDS)[number]

type ClosingDateChangeResult = { ok: true; assessment: ClosingDateChangeAssessment | null; dates: ClosingDates } | { ok: false; error: string; assessment?: ClosingDateChangeAssessment }

const FACT_COLS = "id, status, close_date, estimated_close_date, contract_closing_date, contract_closing_terms, contract_closing_source, contract_closing_amendment_ref, actual_close_date, property_state, financing_type, updated_at"

/**
 * Record a closing-date change under its rule, inside the action ledger (LAW 5):
 *   anticipated         → estimated_close_date only (the contract is untouched; the assessment says what it would need);
 *   executed_amendment  → contract_closing_date (+ wording) with the amendment's reference — PROOF required;
 *   contract_wording    → contract_closing_terms read off the executed contract — PROOF required;
 *   actual_confirmation → actual_close_date (+ the effective close_date) on a CLOSED deal, from the settlement statement /
 *                         closing file / recorded deed — PROOF required; never a future day; the contract is untouched.
 * Reason ≥ 10 characters always (the C23 floor). Never throws.
 */
export async function applyClosingDateChange(svc: Svc, input: ClosingDateChangeInput, deps: { ledger: typeof withActionLedger }): Promise<ClosingDateChangeResult> {
  try {
    if (!(CLOSING_DATE_CHANGE_KINDS as readonly string[]).includes(String(input.kind))) return { ok: false, error: `Unknown closing-date record '${String(input.kind)}'.` }
    if ((input.reason ?? "").trim().length < OVERRIDE_REASON_MIN_CHARS) return { ok: false, error: `Tell us why (at least ${OVERRIDE_REASON_MIN_CHARS} characters) — a closing-date change is recorded with its reason.` }
    const needsProof = input.kind !== "anticipated"
    if (needsProof && (input.evidenceRef ?? "").trim().length < 3) return { ok: false, error: input.kind === "executed_amendment" ? "An amended closing deadline needs the EXECUTED amendment's reference (signed by every party) — a proposal is recorded as the anticipated date instead." : input.kind === "actual_confirmation" ? "Confirming the actual closing day needs the settlement statement, closing file or recorded deed it comes from." : "Recording how the contract words its closing date needs the executed contract's reference." }
    if (input.kind === "contract_wording" && !isClosingDateTerms(input.terms)) return { ok: false, error: "The wording is 'on' or 'on_or_before'." }
    if (input.kind !== "contract_wording" && !day(input.date)) return { ok: false, error: "A closing date is a calendar day (YYYY-MM-DD)." }
    if (input.kind === "actual_confirmation" && day(input.date)! > new Date().toISOString().slice(0, 10)) return { ok: false, error: "The actual closing day cannot be in the future — record an expected day instead." }
    const { data: row, error } = await svc.from("transactions").select(FACT_COLS).eq("id", input.transactionId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (error) return { ok: false, error: `the deal could not be read: ${error.message}` }
    if (!row) return { ok: false, error: "Transaction not found in your brokerage" }
    const facts = row as ClosingDateFacts & { updated_at?: string | null }
    const closed = CLOSED_STATUSES.has(String(facts.status ?? ""))
    if (closed && input.kind !== "actual_confirmation") return { ok: false, error: "This deal has closed — its actual closing day is the record now (confirm or correct it from the settlement statement)." }
    if (!closed && input.kind === "actual_confirmation") return { ok: false, error: "This deal has not closed — the actual day is stamped when it closes (the gated close); record an expected day instead." }
    const assessment = input.kind === "contract_wording" || input.kind === "actual_confirmation" ? null : assessClosingDateChange(facts, { date: input.date!, kind: input.kind })
    const patch: Record<string, unknown> =
      input.kind === "anticipated" ? { estimated_close_date: day(input.date) }
      : input.kind === "executed_amendment" ? { contract_closing_date: day(input.date), contract_closing_source: "executed_amendment", contract_closing_amendment_ref: input.evidenceRef!.trim().slice(0, 200), ...(isClosingDateTerms(input.terms) ? { contract_closing_terms: input.terms } : {}), close_date: day(input.date), estimated_close_date: day(input.date) }
      : input.kind === "actual_confirmation" ? { actual_close_date: day(input.date), close_date: day(input.date) }
      : { contract_closing_terms: input.terms }
    const ledger = deps.ledger
    type W ={ ok: true } | { ok: false; error: string }
    const w = await ledger<W>(
      {
        brokerageId: input.brokerageId, action: "transaction.closing_date.record", actor: { type: "user", userId: input.actorUserId },
        subject: { type: "transaction", id: input.transactionId }, reasonCode: "HUMAN_REQUESTED",
        reasonDetail: `${input.kind}: ${input.reason.trim()}`.slice(0, 500),
        idempotencyKey: `closing_date:${input.transactionId}:${input.kind}:${input.date ?? input.terms ?? ""}:${facts.updated_at ?? "v0"}`,
        riskClass: input.kind === "anticipated" ? "LOW_RISK_WRITE" : "LEGAL", systemSource: "closing-dates",
        detail: { kind: input.kind, date: input.date ?? null, terms: input.terms ?? null, evidence_ref: input.evidenceRef ?? null, assessment, before: { contract: facts.contract_closing_date ?? null, terms: facts.contract_closing_terms ?? null, anticipated: facts.estimated_close_date ?? null, actual: facts.actual_close_date ?? null } },
      },
      async () => {
        const { data: moved, error: wErr } = await svc.from("transactions").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", input.transactionId).eq("brokerage_id", input.brokerageId).select("id")
        if (wErr) return { ok: false, error: wErr.message }
        if ((moved?.length ?? 0) !== 1) return { ok: false, error: "the deal did not change (not found in your brokerage)" }
        return { ok: true }
      },
      {
        settle: (x) => (x.ok ? { status: "executed", outcome: `closing_date:${input.kind}` } : { status: "failed", outcome: "not_changed", error: x.error }),
        replay: (claim) => ({ ok: false, error: claim.kind === "refused" ? `not recorded, nothing changed (${claim.error})` : "this change was already recorded" }),
      },
      { client: svc as never },
    )
    if (!w.ok) return { ok: false, error: w.error, ...(assessment ? { assessment } : {}) }
    return { ok: true, assessment, dates: resolveClosingDates({ ...facts, ...patch } as ClosingDateFacts) }
  } catch (e) {
    return { ok: false, error: `threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}
