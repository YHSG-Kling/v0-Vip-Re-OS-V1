// lib/commission/finalization.ts
// ─────────────────────────────────────────────────────────────────────────────
// COMMISSION FINALIZATION LOCK (owner rule: "the transaction commission isn't final
// until the final CDA is signed by a broker or final CD uploaded to the transaction").
// A transaction's commission is an ESTIMATE until one of those two events; from then
// it is immutable. These helpers stamp / read transactions.commission_finalized_at
// (+ commission_final_source). The waterfall engine consults isCommissionFinalized
// before re-persisting, so a finalized commission is never recomputed or duplicated.

export type CommissionFinalSource = "cda_signed" | "cd_uploaded"

type Db = { from: (t: string) => any }

/**
 * Lock a transaction's commission as FINAL. FIRST-WRITER-WINS + idempotent: it only
 * stamps when commission_finalized_at is still null, so the EARLIER of (broker-signed
 * CDA, uploaded final CD) is recorded and any later event is a no-op. Best-effort —
 * never throws into the caller (finalization must never break a sign / upload flow).
 */
export async function finalizeTransactionCommission(
  supabase: Db,
  transactionId: string,
  source: CommissionFinalSource,
): Promise<{ ok: boolean; alreadyFinal: boolean }> {
  try {
    const { data, error } = await supabase
      .from("transactions")
      .update({ commission_finalized_at: new Date().toISOString(), commission_final_source: source })
      .eq("id", transactionId)
      .is("commission_finalized_at", null) // only the first event stamps it
      .select("id")
    if (error) return { ok: false, alreadyFinal: false }
    // Zero rows updated ⇒ it was already finalized by the earlier event.
    return { ok: true, alreadyFinal: (data ?? []).length === 0 }
  } catch {
    return { ok: false, alreadyFinal: false }
  }
}

/** Is a transaction's commission locked as final (immutable)? Fails closed to false. */
export async function isCommissionFinalized(supabase: Db, transactionId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("transactions")
      .select("commission_finalized_at")
      .eq("id", transactionId)
      .maybeSingle()
    return !!(data as { commission_finalized_at?: string | null } | null)?.commission_finalized_at
  } catch {
    return false
  }
}
