// lib/commission/ledger-sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO COMMISSION LEDGERS, KEPT IN LOCKSTEP.
//
// OWNER RULING. Both ledgers stay. They are not duplicates — they answer two
// different questions and one of them is a legal record:
//
//   transaction_commissions  the STAMP on the deal. Every recipient of this
//                            transaction's commission (agent, brokerage, and in
//                            time referral/vendor), what they were owed and what
//                            was actually disbursed. Real-estate record retention
//                            is SEVEN YEARS, so this is the row an audit reads
//                            long after the agent has left the brokerage.
//   agent_commissions        the agent's PAYABLE ledger. Splits, caps, fees,
//                            net-to-agent, disputes, QuickBooks export.
//
// "Whatever gets stamped on the transaction commission needs to be synced to the
// agent commission." That is the rule this module implements — and it implements
// the reverse too, because a stamp that says `pending` while the agent has
// already been paid is a false record, and a false record is worse than no
// record when the retention period is seven years.
//
// WHY THIS WAS BROKEN. Two surfaces marked commissions paid and neither knew
// about the other:
//
//   PayoutButton → lib/kernel/financial.ts   → agent_commissions.status = paid
//   transaction detail → lib/application/…   → transaction_commissions.status = paid
//
// Marking paid in one did not mark it paid in the other. Both tables were empty,
// so nothing had diverged yet — this closes the gap before it can.
//
// ID CLASSES, verified against the live schema (this is the trap this codebase
// keeps falling into, so it is written down):
//
//   agent_commissions.agent_id            → agents(id)          [FK]
//   transaction_commissions.recipient_id  → agents(id) in practice, NO FK
//   transactions.agent_id                 → agents(id)          [FK]
//   agent_commission_profiles.agent_id    → agents(id)          [FK]
//
// recipient_id is polymorphic and unconstrained: for `recipient_type = 'agent'`
// it carries an agents.id (written from the same params.agentId the profile
// lookup uses), for `'brokerage'` it carries a brokerages.id. The sync therefore
// acts ONLY on the agent row — matching on a brokerage id would silently pair
// two unrelated records.
//
// COLUMN SHAPES differ and the conversion is not optional:
//   transaction_commissions.paid_date  date          (day precision)
//   agent_commissions.paid_at          timestamptz   (instant)

/** Accepts either the RLS-scoped server client or the service client. */
type AnyClient = { from: (table: string) => any }

/**
 * The status vocabulary. Verified live: BOTH tables carry the identical CHECK
 *
 *   CHECK (status = ANY (ARRAY['pending','approved','paid','disputed']))
 *
 * which is what makes a straight status mirror correct rather than a mapping.
 */
export const COMMISSION_LEDGER_STATUSES = ["pending", "approved", "paid", "disputed"] as const
export type CommissionLedgerStatus = (typeof COMMISSION_LEDGER_STATUSES)[number]

// ─── THE SEVEN PAYMENT STATES, DERIVED (wave 142, lane 142C) ────────────────────────────────────
// Owner verbatim (2026-10-18): "Track: expected · preliminary · approved/final · payment_initiated ·
// payment_recorded · payment_received/verified · reconciled/settled." The four-value status above is
// MIRRORED onto commission_splits and the seven-year stamp (transaction_commissions) by the kernel and
// read by every finance proof, so the owner's states are NOT a fifth status column: they are DERIVED
// from status + the timestamps the row carries (deposit_received_at, paid_at) + the m787 stamps
// (payment_initiated_at, payment_received_at, reconciled_at) + the CDA's preliminary statement. One
// vocabulary (CLAUDE.md §6), one derivation, read by the finance page badge and the agent's panel.
export const COMMISSION_PAYMENT_STATES = ["expected", "preliminary", "approved_final", "payment_initiated", "payment_recorded", "payment_received", "reconciled"] as const
export type CommissionPaymentState = (typeof COMMISSION_PAYMENT_STATES)[number]

export interface CommissionPaymentStateInput {
  status: string | null | undefined
  deposit_received_at?: string | null
  /** The title company's preliminary settlement statement is on file (closing_disclosure_agreement.preliminary_cd_uploaded_at). */
  preliminary_statement_at?: string | null
  payment_initiated_at?: string | null
  paid_at?: string | null
  payment_received_at?: string | null
  reconciled_at?: string | null
}

/**
 * PURE — the later state wins; a disputed row is HELD at the state its evidence reached (held: true).
 *   expected          — the waterfall's expected figures, nothing received yet
 *   preliminary       — the preliminary statement is on file and/or the brokerage received the deposit
 *   approved_final    — the brokerage authorized the amount (status approved; CDA broker-signed or the
 *                       no-CDA close auto-approval)
 *   payment_initiated — the payout instruction was issued (check cut / direct deposit submitted) but the
 *                       ledger has not posted the payment
 *   payment_recorded  — the ledger posted the payment (status paid, paid_at)
 *   payment_received  — the agent attested the money arrived
 *   reconciled        — reconciled against the actual connected accounting integration or a statement
 */
export function deriveCommissionPaymentState(row: CommissionPaymentStateInput): { state: CommissionPaymentState; held: boolean; basis: string } {
  const status = (row.status ?? "").toLowerCase()
  const held = status === "disputed"
  if (row.reconciled_at) return { state: "reconciled", held, basis: "reconciled_at" }
  if (row.payment_received_at) return { state: "payment_received", held, basis: "payment_received_at" }
  if (status === "paid" || row.paid_at) return { state: "payment_recorded", held, basis: status === "paid" ? "status paid" : "paid_at" }
  if (row.payment_initiated_at) return { state: "payment_initiated", held, basis: "payment_initiated_at" }
  if (status === "approved") return { state: "approved_final", held, basis: "status approved" }
  if (row.deposit_received_at || row.preliminary_statement_at) {
    return { state: "preliminary", held, basis: row.deposit_received_at ? "deposit_received_at" : "preliminary statement on file" }
  }
  return { state: "expected", held, basis: held ? "disputed before any evidence" : "no evidence yet" }
}

// ─── THE FUNDS-RECEIVED GATE (wave 143, lane 143C) ───────────────────────────────────────────────
// Owner (2026-10-23), the no-CDA flow: "title pays the brokerage; waterfall applied; RECEIPT VERIFIED; disbursement
// authorized; agent/team paid by check or direct deposit". At HEAD nothing checked the middle step: a no-CDA close
// auto-approves the commission (finalizeCommissionAtClose) and initiateCommissionPayout / markCommissionPaid then paid
// the agent whether or not the brokerage had received a dollar (deposit_received_at is stamped by
// recordCommissionDepositReceived — a state the UI badge showed but no payout step required). The gate is FAIL
// CLOSED: no recorded receipt → refuse by name. An ADVANCE (paying before the funds land — a brokerage's own choice,
// not the platform's) is allowed only when a finance admin states why, and the reason is recorded as evidence.
export const PAYOUT_ADVANCE_REASON_MIN = 5

export function payoutFundsGate(
  row: { deposit_received_at?: string | null },
  advanceReason?: string | null,
): { ok: true; advance: boolean; reason: string | null } | { ok: false; error: string } {
  if (row.deposit_received_at) return { ok: true, advance: false, reason: null }
  const reason = (advanceReason ?? "").trim()
  if (reason.length >= PAYOUT_ADVANCE_REASON_MIN) return { ok: true, advance: true, reason }
  return {
    ok: false,
    error:
      "funds_not_received: the commission payment from the title company has not been recorded as received. " +
      "Record the deposit first (the transaction's Deposit received action), or — to pay ahead of the funds — state the reason " +
      `(at least ${PAYOUT_ADVANCE_REASON_MIN} characters) and it is kept on the record.`,
  }
}

/** The tenant-facing label of each derived state (one spelling for every surface). */
export const COMMISSION_PAYMENT_STATE_LABELS: Record<CommissionPaymentState, string> = {
  expected: "Expected",
  preliminary: "Preliminary",
  approved_final: "Approved — final",
  payment_initiated: "Payment initiated",
  payment_recorded: "Payment recorded",
  payment_received: "Payment received",
  reconciled: "Reconciled",
}

/** The only recipient_type whose row corresponds to an agent_commissions row. */
export const AGENT_RECIPIENT_TYPE = "agent"

export function isCommissionLedgerStatus(v: string | null | undefined): v is CommissionLedgerStatus {
  return !!v && (COMMISSION_LEDGER_STATUSES as readonly string[]).includes(v)
}

/** PURE — timestamptz → the `date` the stamp stores. Null stays null. */
export function toStampDate(paidAt: string | null | undefined): string | null {
  if (!paidAt) return null
  const d = new Date(paidAt)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** PURE — the stamp's `date` → an instant the payable ledger can store. */
export function toLedgerInstant(paidDate: string | null | undefined): string | null {
  if (!paidDate) return null
  const d = new Date(`${paidDate}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * PURE — what the agent's payable ledger should read, given the stamp.
 * Returns null when the stamp carries a status neither table admits, so a bad
 * value is refused rather than written into the second table as well.
 */
export function ledgerPatchFromStamp(stamp: {
  status: string
  paid_date?: string | null
}): { status: CommissionLedgerStatus; paid_at: string | null } | null {
  if (!isCommissionLedgerStatus(stamp.status)) return null
  return {
    status: stamp.status,
    // Only a paid stamp carries a disbursement instant; anything else clears it,
    // so un-paying a row cannot leave a stale paid_at behind.
    paid_at: stamp.status === "paid" ? toLedgerInstant(stamp.paid_date) : null,
  }
}

/** PURE — what the stamp should read, given the agent's payable ledger. */
export function stampPatchFromLedger(ledger: {
  status: string
  paid_at?: string | null
}): { status: CommissionLedgerStatus; paid_date: string | null } | null {
  if (!isCommissionLedgerStatus(ledger.status)) return null
  return {
    status: ledger.status,
    paid_date: ledger.status === "paid" ? toStampDate(ledger.paid_at) : null,
  }
}

export interface LedgerSyncResult {
  /** Rows updated in the other ledger. 0 is normal — the pair may not exist yet. */
  synced: number
  skipped?: string
  error?: string
}

/**
 * STAMP → PAYABLE. Call after writing a transaction_commissions row's status.
 * No-ops for any recipient_type other than 'agent': a brokerage stamp has no
 * agent_commissions counterpart and recipient_id would be a brokerages.id.
 *
 * Best-effort by contract — never throws into the caller. A payout must not fail
 * because the mirror did.
 */
export async function syncStampToAgentLedger(
  db: AnyClient,
  stamp: {
    transaction_id: string
    recipient_type: string
    recipient_id?: string | null
    status: string
    paid_date?: string | null
  },
): Promise<LedgerSyncResult> {
  try {
    if (stamp.recipient_type !== AGENT_RECIPIENT_TYPE) {
      return { synced: 0, skipped: `recipient_type=${stamp.recipient_type}` }
    }
    if (!stamp.recipient_id) return { synced: 0, skipped: "no recipient_id" }

    const patch = ledgerPatchFromStamp(stamp)
    if (!patch) return { synced: 0, skipped: `status=${stamp.status} not in vocabulary` }

    const { data, error } = await db
      .from("agent_commissions")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("transaction_id", stamp.transaction_id)
      .eq("agent_id", stamp.recipient_id)
      .select("id")

    if (error) return { synced: 0, error: error.message }
    return { synced: (data ?? []).length }
  } catch (e) {
    return { synced: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * PAYABLE → STAMP. Call after writing an agent_commissions row's status, so the
 * seven-year record reflects the disbursement that actually happened.
 *
 * Best-effort by contract — never throws into the caller.
 */
export async function syncAgentLedgerToStamp(
  db: AnyClient,
  ledger: {
    transaction_id: string | null
    agent_id: string
    status: string
    paid_at?: string | null
  },
): Promise<LedgerSyncResult> {
  try {
    if (!ledger.transaction_id) return { synced: 0, skipped: "commission has no transaction" }

    const patch = stampPatchFromLedger(ledger)
    if (!patch) return { synced: 0, skipped: `status=${ledger.status} not in vocabulary` }

    const { data, error } = await db
      .from("transaction_commissions")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("transaction_id", ledger.transaction_id)
      .eq("recipient_type", AGENT_RECIPIENT_TYPE)
      .eq("recipient_id", ledger.agent_id)
      .select("id")

    if (error) return { synced: 0, error: error.message }
    return { synced: (data ?? []).length }
  } catch (e) {
    return { synced: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
