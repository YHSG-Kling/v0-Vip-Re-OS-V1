// lib/db/best-effort.ts
// ─────────────────────────────────────────────────────────────────────────────
// SAYING OUT LOUD THAT A WRITE IS ALLOWED TO FAIL.
//
// supabase-js RESOLVES a rejected write — a CHECK violation, an RLS refusal, a
// constraint breach all come back as `{ error }` rather than throwing. So this:
//
//     await svc.from("subscriptions").update(patch).eq("id", id)
//
// is indistinguishable, at the call site, from a write that succeeded. That one
// line is how a cancelled tenant kept paid access: Stripe's 'canceled' spelling
// was rejected by the column's CHECK, the error was dropped on the floor, and
// the row kept its stale 'active'.
//
// Plenty of writes SHOULD be allowed to fail — an audit log must not break the
// gate decision it is recording, and a ledger mirror must not fail the payout it
// mirrors. That is a legitimate engineering choice. The problem is that a
// deliberate best-effort write and an accidentally-silent one look EXACTLY the
// same in the source, so nobody can review the difference and no guard can
// check it.
//
// This makes the choice explicit and greppable. Wrapping a write says "I know
// this can fail, here is why that is acceptable" — and the failure still lands
// in the logs with its reason instead of vanishing. scripts/silent-write-guard.ts
// enforces that writes to consequential tables (money, access, compliance) do
// one or the other: check the error, or declare themselves here.
//
// ── NOT A DUPLICATE OF sentinelWrite. THE SPLIT IS A PRECONDITION, NOT TASTE ──
// (adjudicated 2026-08-26 against the LIVE database; CLAUDE.md §1/§6)
//
// lib/kernel/write-sentinel.ts:sentinelWrite is the same idea spelled a second
// way, and it looks strictly stronger: it reads the error AND ledgers every loss
// to self_heal_events, where this only console.warns. §6 would normally end the
// argument there — merge onto the stronger one, delete this. The usual objections
// to that merge did NOT survive measurement: zero of this function's 60 call
// sites read its `{ ok, error }` return, and its one unique idea — the `reason`
// string — has been MERGED ONTO the sentinel (SentinelWriteContext.reason), so
// nothing here is now inexpressible there.
//
// What keeps this file alive is the ledger's own RLS posture. `self_heal_events`
// has RLS on and exactly one policy: SELECT, for `authenticated`. No INSERT policy
// exists for any non-service role. sentinelWrite therefore only ledgers when it is
// handed a SERVICE-ROLE client; handed a cookie-session client it is refused, and
// recordSelfHeal swallows that refusal with `.then(() => {}, () => {})`. On a
// user-scoped path the "stronger" wrapper is WEAKER than this one — a greppable
// warning becomes silence. 17 of the 44 files calling bestEffort use a user-scoped
// client for at least some of their writes.
//
// SO THE RULE, and it is a rule rather than a preference:
//   · service-role client (createServiceClient / supabaseAdmin) → sentinelWrite.
//   · user-scoped client (createClient / createServerClient)    → bestEffort.
// A caller reaching for this function while holding a service client is choosing
// the weaker instrument and should switch. This file's remaining job is the
// narrow one no ledger can cover: the tolerated write made as the USER.

export interface BestEffortResult {
  ok: boolean
  error: string | null
}

/**
 * Await a supabase write whose failure is ACCEPTABLE, recording the reason.
 *
 * @param op     the supabase query builder (a thenable): a table insert/update
 *               chain, passed UN-awaited so this can await it and read `error`.
 *               (Deliberately not shown as a code example — the schema-drift
 *               guard reads a table name in a comment as a real reference.)
 * @param reason why failing here is tolerable. Written for the next person
 *               deciding whether to keep this behaviour, not for a log grep.
 */
export async function bestEffort(
  op: PromiseLike<{ error: { message: string } | null }>,
  reason: string,
): Promise<BestEffortResult> {
  try {
    const { error } = await op
    if (error) {
      console.warn(`[best-effort] write failed (tolerated: ${reason}):`, error.message)
      return { ok: false, error: error.message }
    }
    return { ok: true, error: null }
  } catch (e) {
    // A thrown error (network, client bug) is tolerated the same way — the
    // caller declared this write non-critical.
    const message = e instanceof Error ? e.message : String(e)
    console.warn(`[best-effort] write threw (tolerated: ${reason}):`, message)
    return { ok: false, error: message }
  }
}
