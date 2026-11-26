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

/**
 * Is a transaction's commission locked as final (immutable)?
 *
 * THE ONE READER OF THE LOCK (§6, wave 27). The waterfall's final persist step
 * used to ask the column itself — a second spelling of this question, which is
 * why the header above could claim the engine consulted this helper while
 * nothing did. That step now calls this.
 *
 * MERGED FROM THE READER IT REPLACED, before the swap: the error was discarded
 * here entirely, so a REFUSED read arrived as `false` — indistinguishable from
 * "not finalized", which is exactly the swallow the inline reader had already
 * been fixed for (lib/commission/waterfall/11-validate-persist.ts). Adopting a
 * survivor that is worse than the duplicate is not a merge.
 *
 * The RETURN on a refusal stays `false` deliberately, and that is the permissive
 * direction: an unreadable lock lets a first, authoritative calculation persist
 * rather than blocking a real close on a transient read failure. It is no longer
 * SILENT, which is the part that mattered — a refusal that reads as "not
 * finalized" is how a LOCKED commission gets a second summary row.
 */
export async function isCommissionFinalized(supabase: Db, transactionId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("transactions")
      .select("commission_finalized_at")
      .eq("id", transactionId)
      .maybeSingle()
    // supabase-js RESOLVES refusals (§3) — read the error rather than letting
    // "nobody could check" render as "checked, and not final".
    if (error) {
      console.error(
        `[commission-finalization] lock read REFUSED for transaction ${transactionId} — treating as NOT finalized: ${error.message}`,
      )
      return false
    }
    return !!(data as { commission_finalized_at?: string | null } | null)?.commission_finalized_at
  } catch {
    return false
  }
}
