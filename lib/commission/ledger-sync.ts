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
