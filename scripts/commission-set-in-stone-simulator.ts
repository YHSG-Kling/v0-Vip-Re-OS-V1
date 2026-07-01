#!/usr/bin/env tsx
/**
 * scripts/commission-set-in-stone-simulator.ts   (npm run test:commission-set-in-stone)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves commissions are SET IN STONE at close: once the deal is CLOSED (final CD provided +
 * brokerage deposit received), the APPROVED commission is finalized approved → paid (locked).
 * The full money spine is now: close → auto-calc → agent-sign → compliance → broker-sign
 * (→ approved) → CLOSED (→ paid, set in stone). Payout of the raw money is the only remaining
 * deliberate step; the RECORD is locked at close.
 *
 * SOURCE scan (the CLOSED transition is server-only): the finalizer only pays an APPROVED
 * commission (never force-pays a still-pending one), is idempotent, stamps paid_at, emits a
 * commission.paid lifecycle event, and is best-effort (never blocks the close).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function main() {
  const sp = src("lib/transactions/stage-progression.ts")
  // Isolate the CLOSED TRANSITION branch (params.targetStage === "CLOSED"), not the earlier TRID gate.
  const closedIdx = sp.indexOf('params.targetStage === "CLOSED"')
  const block = sp.slice(closedIdx, closedIdx + 3200)

  console.log("\n[the CLOSED transition finalizes the commission — set in stone]")
  check("CLOSED runs the FINAL commission calc first", /calculationMode:\s*'final'/.test(block))
  check("then finalizes agent_commissions to 'paid'", /agent_commissions[\s\S]*?status:\s*"paid"/.test(block))
  check("ONLY an APPROVED commission is paid (never force-pays a pending one)", /\.eq\("status",\s*"approved"\)/.test(block))
  check("idempotent — the update also filters status='approved' so an already-paid row is skipped", (block.match(/\.eq\("status",\s*"approved"\)/g) ?? []).length >= 2)
  check("stamps paid_at (audit + lock timestamp)", /paid_at:\s*paidAt/.test(block))
  check("emits a commission.paid lifecycle event", /event_type:\s*"commission\.paid"/.test(block))
  check("finalize is best-effort — wrapped in try/catch, never blocks the close", /try\s*{[\s\S]*?agent_commissions[\s\S]*?}\s*catch/.test(block))

  console.log("\n[the money spine is coherent — approved BEFORE close, paid AT close]")
  const portal = src("app/actions/cda-portal.ts")
  check("broker-sign approves the commission (the prerequisite state for paid)", /brokerSignCdaAction[\s\S]*?markCommissionApproved/.test(portal))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ COMMISSION_SET_IN_STONE_FAIL"); process.exit(1) }
  console.log(" ✅ COMMISSION_SET_IN_STONE_PASS — closing a deal locks the approved commission (approved → paid), never force-pays a pending one")
}
main()
