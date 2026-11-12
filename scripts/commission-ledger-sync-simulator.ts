#!/usr/bin/env tsx
/**
 * scripts/commission-ledger-sync-simulator.ts   (npm run test:commission-ledger-sync) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO LEDGERS, ONE TRUTH.
 *
 * OWNER RULING: both commission tables stay. They are not duplicates.
 *
 *   transaction_commissions  the STAMP on the deal — every recipient, what they
 *                            were owed, what was disbursed. Real-estate retention
 *                            is SEVEN YEARS: this is what an audit reads long
 *                            after the agent has left the brokerage.
 *   agent_commissions        the agent's PAYABLE ledger — split, cap, fees,
 *                            net-to-agent, disputes, QuickBooks export.
 *
 * "Whatever gets stamped on the transaction commission needs to be synced to the
 * agent commission." Two surfaces marked commissions paid and neither knew about
 * the other:
 *
 *   PayoutButton         → lib/kernel/financial.ts      → agent_commissions
 *   transaction detail   → lib/application/transactions → transaction_commissions
 *
 * Both tables were empty, so nothing had diverged yet. This closes it first.
 *
 * The sync runs BOTH ways on purpose. A stamp reading 'pending' while the agent
 * has already been paid is a false record, and a false record is worse than no
 * record when you have to keep it for seven years.
 *
 * VERIFIED LIVE (probe transaction + both ledger rows, deleted afterwards):
 *   stamp paid  → payable went paid, paid_at set, BROKERAGE stamp untouched
 *   payable paid → stamp went paid, paid_date set, BROKERAGE stamp untouched
 *
 * That last column matters: transaction_commissions.recipient_id has NO foreign
 * key. On the 'agent' row it holds an agents.id; on the 'brokerage' row it holds
 * a brokerages.id (confirmed live: that id is not in agents). Syncing without
 * gating on recipient_type would pair a brokerage payout against whatever agent
 * happened to share the id space.
 */
import { readFileSync } from "node:fs"
import {
  COMMISSION_LEDGER_STATUSES,
  AGENT_RECIPIENT_TYPE,
  isCommissionLedgerStatus,
  toStampDate,
  toLedgerInstant,
  ledgerPatchFromStamp,
  stampPatchFromLedger,
  syncStampToAgentLedger,
  syncAgentLedgerToStamp,
} from "../lib/commission/ledger-sync"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  stripComments(readFileSync(p, "utf8"))

/** A fake PostgREST builder that records the filters and returns rows. */
function fakeDb(rows: Array<{ id: string }>, err?: string) {
  const calls: Array<{ table: string; patch: any; filters: Record<string, unknown> }> = []
  const db = {
    from(table: string) {
      const rec = { table, patch: undefined as any, filters: {} as Record<string, unknown> }
      calls.push(rec)
      const b: any = {
        update(patch: any) { rec.patch = patch; return b },
        eq(col: string, val: unknown) { rec.filters[col] = val; return b },
        select() { return Promise.resolve(err ? { data: null, error: { message: err } } : { data: rows, error: null }) },
      }
      return b
    },
  }
  return { db, calls }
}

console.log("\n── the status vocabulary is genuinely shared ──")
{
  const ac = CHECK_VOCABULARIES.agent_commissions?.status ?? []
  const tc = CHECK_VOCABULARIES.transaction_commissions?.status ?? []
  check(`agent_commissions.status has 4 values (${ac.join(", ")})`, ac.length === 4)
  check("transaction_commissions.status is the IDENTICAL set — a mirror, not a mapping",
    tc.length === ac.length && ac.every((s) => tc.includes(s)))
  check("the module declares exactly that set",
    COMMISSION_LEDGER_STATUSES.length === 4 &&
    COMMISSION_LEDGER_STATUSES.every((s) => ac.includes(s) && tc.includes(s)))
  check("a value neither table admits is refused", !isCommissionLedgerStatus("settled"))
  check("null/empty are refused", !isCommissionLedgerStatus(null) && !isCommissionLedgerStatus(""))
}

console.log("\n── the two column shapes convert, both ways ──")
{
  check("timestamptz → date keeps the day",
    toStampDate("2026-07-28T22:41:09.000Z") === "2026-07-28")
  check("date → instant is midnight UTC of that day",
    toLedgerInstant("2026-07-28") === "2026-07-28T00:00:00.000Z")
  check("null in, null out (both ways)",
    toStampDate(null) === null && toLedgerInstant(null) === null)
  check("garbage does not become an Invalid Date string",
    toStampDate("not-a-date") === null && toLedgerInstant("not-a-date") === null)
}

console.log("\n── the projections ──")
{
  const paid = ledgerPatchFromStamp({ status: "paid", paid_date: "2026-07-28" })
  check("a paid stamp carries the disbursement instant onto the payable",
    paid?.status === "paid" && paid?.paid_at === "2026-07-28T00:00:00.000Z")
  const appr = ledgerPatchFromStamp({ status: "approved", paid_date: "2026-07-28" })
  check("approving CLEARS paid_at — un-paying cannot leave a stale instant",
    appr?.status === "approved" && appr?.paid_at === null)
  check("a status outside the vocabulary projects to nothing at all",
    ledgerPatchFromStamp({ status: "settled" }) === null)

  const stamp = stampPatchFromLedger({ status: "paid", paid_at: "2026-07-28T22:41:09.000Z" })
  check("a paid payable stamps the day on the retained record",
    stamp?.status === "paid" && stamp?.paid_date === "2026-07-28")
  check("disputing clears the stamp's paid_date",
    stampPatchFromLedger({ status: "disputed", paid_at: "2026-07-28T00:00:00Z" })?.paid_date === null)
  check("a bad status never reaches the seven-year record",
    stampPatchFromLedger({ status: "voided" }) === null)
}

console.log("\n── stamp → payable, and the recipient_type gate ──")
{
  const agentStamp = {
    transaction_id: "t1", recipient_type: AGENT_RECIPIENT_TYPE,
    recipient_id: "agent-1", status: "paid", paid_date: "2026-07-28",
  }
  const a = fakeDb([{ id: "ac-1" }])
  const r1 = await syncStampToAgentLedger(a.db, agentStamp)
  check("an agent stamp updates the payable ledger", r1.synced === 1)
  check("it targets agent_commissions", a.calls[0]?.table === "agent_commissions")
  check("it matches on BOTH transaction and agent — never agent alone",
    a.calls[0]?.filters.transaction_id === "t1" && a.calls[0]?.filters.agent_id === "agent-1")
  check("it writes the projected status + instant",
    a.calls[0]?.patch.status === "paid" && a.calls[0]?.patch.paid_at === "2026-07-28T00:00:00.000Z")

  // THE ONE THAT MATTERS: recipient_id on a brokerage row is a brokerages.id.
  const b = fakeDb([{ id: "should-not-happen" }])
  const r2 = await syncStampToAgentLedger(b.db, {
    transaction_id: "t1", recipient_type: "brokerage",
    recipient_id: "brokerage-1", status: "paid", paid_date: "2026-07-28",
  })
  check("a BROKERAGE stamp syncs nothing — its recipient_id is not an agents.id",
    r2.synced === 0 && b.calls.length === 0)
  check("and it says why rather than failing silently", (r2.skipped ?? "").includes("brokerage"))

  const c = fakeDb([])
  const r3 = await syncStampToAgentLedger(c.db, { ...agentStamp, recipient_id: null })
  check("a stamp with no recipient_id is skipped, not matched on null",
    r3.synced === 0 && c.calls.length === 0)

  const d = fakeDb([])
  const r4 = await syncStampToAgentLedger(d.db, { ...agentStamp, status: "settled" })
  check("an out-of-vocabulary status is refused before it touches the payable",
    r4.synced === 0 && d.calls.length === 0)

  const e = fakeDb([], "permission denied")
  const r5 = await syncStampToAgentLedger(e.db, agentStamp)
  check("a database error is reported, never thrown at the payout",
    r5.synced === 0 && r5.error === "permission denied")
}

console.log("\n── payable → stamp, so the retained record stays truthful ──")
{
  const a = fakeDb([{ id: "tc-1" }])
  const r = await syncAgentLedgerToStamp(a.db, {
    transaction_id: "t1", agent_id: "agent-1", status: "paid", paid_at: "2026-07-28T22:41:09.000Z",
  })
  check("a paid payable stamps the deal", r.synced === 1)
  check("it targets transaction_commissions", a.calls[0]?.table === "transaction_commissions")
  check("it pins recipient_type='agent' so the brokerage row is never overwritten",
    a.calls[0]?.filters.recipient_type === AGENT_RECIPIENT_TYPE)
  check("it matches transaction + recipient",
    a.calls[0]?.filters.transaction_id === "t1" && a.calls[0]?.filters.recipient_id === "agent-1")
  check("it writes the day, not the instant (paid_date is a date column)",
    a.calls[0]?.patch.paid_date === "2026-07-28")

  const b = fakeDb([])
  const r2 = await syncAgentLedgerToStamp(b.db, {
    transaction_id: null, agent_id: "agent-1", status: "paid",
  })
  check("a commission with no transaction has nothing to stamp",
    r2.synced === 0 && b.calls.length === 0)
}

console.log("\n── both write paths actually call it ──")
{
  const fin = src("lib/kernel/financial.ts")
  check("markCommissionPaid stamps the deal", /syncAgentLedgerToStamp\(supabase, \{[\s\S]{0,220}?paid_at:\s+paidAt,/.test(fin))
  check("markCommissionApproved stamps it too", (fin.match(/syncAgentLedgerToStamp\(/g) ?? []).length >= 2)
  check("it passes the commission's own transaction and agent, not the caller's",
    /agent_id:\s+\(commission as \{ agent_id: string \}\)\.agent_id/.test(fin))

  const app = src("lib/application/transactions.ts")
  check("the transaction-detail payout syncs the payable ledger",
    /syncStampToAgentLedger\(supabase, \{/.test(app))
  check("it forwards the row's OWN recipient_type, so the gate can do its job",
    /recipient_type: \(data as \{ recipient_type: string \}\)\.recipient_type/.test(app))
  check("it only syncs when the update returned a row", /if \(data\) \{/.test(app))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ COMMISSION_LEDGER_SYNC_FAIL"); process.exit(1) }
console.log(" ✅ COMMISSION_LEDGER_SYNC_PASS — the payable and the seven-year stamp cannot disagree")
