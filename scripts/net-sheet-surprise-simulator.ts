#!/usr/bin/env tsx
/**
 * scripts/net-sheet-surprise-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE NET-SHEET SURPRISE GUARD — verified white space (the stack ESTIMATES a seller
 * net sheet but never reconciled it against the FINAL settlement statement). Pure
 * reconciliation engine over estimate-vs-actual figures, honest when a side is missing; the
 * runner records every reconciliation and proposes a GATED Deal-Coordinator alert on a
 * material negative surprise.
 *
 * Layer 1 (pure): the surprise verdict matrix + per-line driver + the idempotency signature.
 * Layer 2 (live, gated): seed a real transaction + winning offer (seller_net_estimate) + a
 *   settlement-statement document whose actuals are materially short → run the guard →
 *   assert a flagged reconciliation row + a gated bus signal; re-run is idempotent. Seeds
 *   cleaned up. No mocks.
 *
 * Run: npx tsx scripts/net-sheet-surprise-simulator.ts   (npm run test:net-sheet-surprise)
 */
import {
  reconcileNetSheet,
  deriveNet,
  actualSignature,
  type NetSheetFigures,
} from "../lib/net-sheet/net-sheet-reconciler"

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
  console.log(" ✅ Net-sheet surprise guard verified — gap caught, top driver named, thin data held, alert gated.")
  console.log(" NET_SHEET_SURPRISE_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Net-sheet surprise guard simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · reconciliation verdict]")

  // Estimate: $550k sale, 6% commission, $300k payoff, $5k taxes → net = 550000 - 33000 - 300000 - 5000 = 212000.
  const estimate: NetSheetFigures = { salePrice: 550_000, commission: 33_000, mortgagePayoff: 300_000, taxesProration: 5_000 }
  check("derived estimate net is correct", deriveNet(estimate) === 212_000, String(deriveNet(estimate)))

  // SEVERE: payoff came in $20k higher than quoted → net short by $20k.
  const severeActual: NetSheetFigures = { salePrice: 550_000, commission: 33_000, mortgagePayoff: 320_000, taxesProration: 5_000 }
  const severe = reconcileNetSheet(estimate, severeActual)
  check("a $20k shortfall → SEVERE surprise", severe.surpriseLevel === "severe", severe.reason)
  check("variance is negative (seller nets less)", (severe.varianceAmount ?? 0) === -20_000)
  check("flagged for escalation", severe.flagged === true)
  check("top driver is the mortgage payoff", severe.topDriver?.key === "mortgagePayoff", JSON.stringify(severe.topDriver))
  check("driver net impact is negative", (severe.topDriver?.netImpact ?? 0) < 0)

  // CONCERNING: a $6k gap — above the material threshold (max($2.5k, 2% of $212k = $4.24k)),
  // below the severe threshold (max($10k, 5% = $10.6k)) — via higher title/escrow.
  const concerningActual: NetSheetFigures = { salePrice: 550_000, commission: 33_000, mortgagePayoff: 300_000, taxesProration: 5_000, titleEscrow: 6_000 }
  const concerning = reconcileNetSheet(estimate, concerningActual)
  check(`a $6k gap (≥ material 2%, < severe 5%) → CONCERNING`, concerning.surpriseLevel === "concerning", concerning.reason)
  check("concerning is flagged", concerning.flagged === true)

  // NONE: within tolerance ($1k under).
  const within = reconcileNetSheet(estimate, { ...estimate, titleEscrow: 1_000 })
  check("a $1k gap → within tolerance (NONE), not flagged", within.surpriseLevel === "none" && within.flagged === false, within.reason)

  // PLEASANT: payoff came in $15k LOWER → seller nets more.
  const pleasant = reconcileNetSheet(estimate, { ...estimate, mortgagePayoff: 285_000 })
  check("a $15k better outcome → PLEASANT, not flagged", pleasant.surpriseLevel === "pleasant" && pleasant.flagged === false, pleasant.reason)

  // HONEST on thin data: no actual net → not reconciled, no false surprise.
  const noActual = reconcileNetSheet(estimate, {})
  check("no actual figures → not reconciled (no false alarm)", noActual.reconciled === false && noActual.flagged === false)
  const noEstimate = reconcileNetSheet({}, severeActual)
  check("no estimate on file → not reconciled", noEstimate.reconciled === false)

  // Net-only reconciliation (settlement states 'cash to seller' directly, no line breakout).
  const netOnly = reconcileNetSheet({ netProceeds: 212_000 }, { netProceeds: 190_000 })
  check("net-only figures still reconcile (no line breakout) → SEVERE", netOnly.surpriseLevel === "severe" && netOnly.lineDeltas.length === 0, netOnly.reason)

  // Idempotency signature: same actuals → same sig; corrected statement → different sig.
  check("same settlement → same signature", actualSignature(severeActual) === actualSignature({ ...severeActual }))
  check("corrected settlement → different signature", actualSignature(severeActual) !== actualSignature({ ...severeActual, mortgagePayoff: 315_000 }))

  console.log("\n[Layer 2 · live: a short settlement is flagged + a gated alert proposed, idempotently]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runNetSheetSurpriseGuard } = await import("../lib/net-sheet/net-sheet-guard-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })

  const txnId = uuid()
  const offerId = uuid()
  let docId: string | undefined
  try {
    // Real winning offer carrying the PROMISED net.
    await svc.from("offers").insert({
      id: offerId, brokerage_id: brokerageId, transaction_id: txnId, offer_price: 550_000,
      seller_net_estimate: 212_000, is_winning_offer: true, status: "accepted",
    })
    // Real transaction linked to the offer.
    await svc.from("transactions").insert({
      id: txnId, brokerage_id: brokerageId, offer_id: offerId, property_address: "ZZ 42 Settlement Way",
      status: "active", stage: "closing",
    })
    // Real settlement statement whose actual net is $20k short (payoff came in higher).
    const { data: doc } = await svc.from("transaction_documents").insert({
      transaction_id: txnId, doc_type: "final_settlement_statement",
      extracted_data: { sale_price: 550_000, commission: 33_000, mortgage_payoff: 320_000, property_taxes: 5_000, seller_net: 192_000 },
    }).select("id").single()
    docId = (doc as any)?.id

    const r1 = await runNetSheetSurpriseGuard({ brokerageId, transactionId: txnId, copyGenerator: stampGen }, svc)
    check("the short settlement is flagged + escalated", r1.recon.flagged === true && r1.escalated === true, r1.recon.reason)
    check("recorded a reconciliation row", !!r1.reconciliationId)

    const { count: sigCount } = await svc.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("entity_id", txnId).eq("signal_type", "net_sheet_surprise")
    check("a net_sheet_surprise bus signal was published (gated)", (sigCount ?? 0) >= 1)

    // IDEMPOTENT: same settlement → no second reconciliation, no second alert.
    const r2 = await runNetSheetSurpriseGuard({ brokerageId, transactionId: txnId, copyGenerator: stampGen }, svc)
    check("re-run on the same settlement is idempotent (no duplicate)", r2.alreadyReconciled === true && r2.escalated === false)
    const { count: recCount } = await svc.from("net_sheet_reconciliations").select("id", { count: "exact", head: true }).eq("transaction_id", txnId)
    check("exactly one reconciliation row persisted", (recCount ?? 0) === 1, String(recCount))
  } finally {
    await svc.from("manager_signals").delete().eq("entity_id", txnId).then(() => {}, () => {})
    await svc.from("notifications").delete().eq("entity_id", txnId).eq("type", "net_sheet_surprise").then(() => {}, () => {})
    await svc.from("net_sheet_reconciliations").delete().eq("transaction_id", txnId).then(() => {}, () => {})
    if (docId) await svc.from("transaction_documents").delete().eq("id", docId).then(() => {}, () => {})
    await svc.from("transactions").delete().eq("id", txnId).then(() => {}, () => {})
    await svc.from("offers").delete().eq("id", offerId).then(() => {}, () => {})
    const { count } = await svc.from("net_sheet_reconciliations").select("id", { count: "exact", head: true }).eq("transaction_id", txnId)
    check("cleanup: reconciliation rows removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
