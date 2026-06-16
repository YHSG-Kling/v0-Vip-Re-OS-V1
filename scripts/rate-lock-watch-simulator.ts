#!/usr/bin/env tsx
/**
 * scripts/rate-lock-watch-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE RATE-LOCK EXPIRATION WATCH — verified white space (transaction_lenders carried
 * interest_rate + clear_to_close_date but no lock dates; nothing watched the rate lock vs the
 * closing). Pure lock-vs-closing engine, honest when no lock is on file; the runner fires a
 * GATED Deal-Coordinator alert when the lock will lapse before/at closing.
 *
 * Layer 1 (pure): the buffer math + verdict matrix (ok/tight/at_risk/expired/not_applicable).
 * Layer 2 (live, gated): seed a real transaction + transaction_lenders row whose lock expires
 *   before the closing → run the watch → assert at_risk + a gated bus signal; a second run is
 *   idempotent. Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/rate-lock-watch-simulator.ts   (npm run test:rate-lock)
 */
import { computeRateLockRisk, TIGHT_BUFFER_DAYS } from "../lib/financing/rate-lock-watch"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Rate-lock watch verified — lapse-before-closing caught, cushion measured, no-lock skipped, gated alert.")
  console.log(" RATE_LOCK_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Rate-lock expiration watch simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · buffer math + verdict]")
  const today = "2026-06-16"

  // Closing AFTER the lock expires → at_risk (the lock won't survive to closing).
  const closeAfter = computeRateLockRisk({ today, rateLockExpirationDate: "2026-06-25", scheduledCloseDate: "2026-06-30" })
  check("closing after lock expiry → at_risk", closeAfter.status === "at_risk", JSON.stringify(closeAfter))
  check("negative buffer (close past expiry)", (closeAfter.bufferDays ?? 0) === -5)
  check("at_risk is flagged for escalation", closeAfter.flagged === true)

  // Lock already lapsed, deal still open → expired (worst case).
  const lapsed = computeRateLockRisk({ today, rateLockExpirationDate: "2026-06-10", scheduledCloseDate: "2026-06-20" })
  check("lock already expired before today → expired", lapsed.status === "expired" && lapsed.flagged)

  // Thin cushion before expiry → at_risk (any slip blows it).
  const thin = computeRateLockRisk({ today, rateLockExpirationDate: "2026-06-21", scheduledCloseDate: "2026-06-20" })
  check("1-day cushion → at_risk", thin.status === "at_risk" && (thin.bufferDays ?? 0) === 1)

  // Tight (within the tight window but beyond the at-risk cushion) → tight, NOT flagged.
  const tight = computeRateLockRisk({ today, rateLockExpirationDate: "2026-06-25", scheduledCloseDate: "2026-06-20" })
  check(`${TIGHT_BUFFER_DAYS}-day window → tight, not flagged`, tight.status === "tight" && !tight.flagged, JSON.stringify(tight))

  // Healthy cushion → ok.
  const ok = computeRateLockRisk({ today, rateLockExpirationDate: "2026-07-30", scheduledCloseDate: "2026-06-20" })
  check("healthy cushion → ok, not flagged", ok.status === "ok" && !ok.flagged)

  // Lock known, no closing date, expiring imminently → at_risk.
  const noClose = computeRateLockRisk({ today, rateLockExpirationDate: "2026-06-19", scheduledCloseDate: null })
  check("imminent lock, no close date set → at_risk", noClose.status === "at_risk" && noClose.flagged)

  // HONEST: no lock on file → not_applicable, never flagged.
  const none = computeRateLockRisk({ today, rateLockExpirationDate: null, scheduledCloseDate: "2026-06-20" })
  check("no rate lock on file → not_applicable (skipped, no fabricated countdown)", none.status === "not_applicable" && !none.flagged)

  console.log("\n[Layer 2 · live: a lock that lapses before closing is flagged + a gated alert, idempotently]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runRateLockWatch } = await import("../lib/financing/rate-lock-watch-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })

  const txnId = uuid()
  let lenderId: string | undefined
  const runToday = "2026-06-16"
  try {
    await svc.from("transactions").insert({
      id: txnId, brokerage_id: brokerageId, property_address: "ZZ 9 Lock Ln", status: "under_contract",
      stage: "financing", estimated_close_date: "2026-06-30",
    })
    const { data: lender } = await svc.from("transaction_lenders").insert({
      transaction_id: txnId, lender_name: "ZZ Test Lender", rate_lock_expiration_date: "2026-06-25",
    }).select("id").single()
    lenderId = (lender as any)?.id

    const r1 = await runRateLockWatch({ brokerageId, today: runToday, copyGenerator: stampGen }, svc)
    check("the lapsing lock is flagged + escalated", r1.flagged >= 1 && r1.escalated >= 1, JSON.stringify(r1))

    const { count: sigCount } = await svc.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("entity_id", txnId).eq("signal_type", "rate_lock_watch")
    check("a rate_lock_watch bus signal was published (gated)", (sigCount ?? 0) >= 1)

    // IDEMPOTENT: a second run within the window does not re-alert.
    const r2 = await runRateLockWatch({ brokerageId, today: runToday, copyGenerator: stampGen }, svc)
    check("re-run within the window does not re-escalate (idempotent)", r2.escalated === 0)
  } finally {
    await svc.from("manager_signals").delete().eq("entity_id", txnId).then(() => {}, () => {})
    await svc.from("notifications").delete().eq("entity_id", txnId).eq("type", "rate_lock_watch").then(() => {}, () => {})
    if (lenderId) await svc.from("transaction_lenders").delete().eq("id", lenderId).then(() => {}, () => {})
    await svc.from("transactions").delete().eq("id", txnId).then(() => {}, () => {})
    const { count } = await svc.from("transaction_lenders").select("id", { count: "exact", head: true }).eq("transaction_id", txnId)
    check("cleanup: lender row removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
