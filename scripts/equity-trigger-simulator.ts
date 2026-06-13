#!/usr/bin/env tsx
/**
 * scripts/equity-trigger-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PAST-CLIENT EQUITY TRIGGER harness — the Sphere's recurring-revenue engine:
 * a VALUE/RATE THRESHOLD crossing (not a calendar date) fires a gated "you could
 * pull $X in equity" / "a refi could save $Y/mo" note + a Director equity reel +
 * a portal value card. Reuses anniversary-equity's computeEquityLine for the math.
 *
 * Layer 1 (pure): equityTriggerSignal —
 *   · big equity gain → cash-out crosses (real equity ≥ $150k AND ≥ 35% of value);
 *   · rate drop → refi savings crosses (≥ 75 bps below original AND ≥ $150/mo);
 *   · small/none → no cross;
 *   · MISSING rate → equity-only (refi null, no fabrication);
 *   · MISSING loan → no equity figure → cash-out cannot fire (honest null).
 * Layer 2 (live, gated): seed a past client + CLOSED transaction + loan (amount +
 *   original rate) with an INJECTED valuation + INJECTED authoritative rate → run →
 *   assert the gated note (sphere_of_influence, audience 'agent', proposed, year/
 *   quarter tag) + the Director reel (recorder seam) + the portal value card
 *   (transparency_updates, visible, update_type 'equity_trigger') with REAL numbers;
 *   a below-threshold seed fires NOTHING; rerun is a no-op (idempotent per quarter);
 *   reverse-delete + cleanup count == 0.
 *
 * Run: npx tsx scripts/equity-trigger-simulator.ts  (npm run test:equity-trigger)
 */
import {
  equityTriggerSignal,
  quarterKey,
  composeTriggerNote,
  composeTriggerBrief,
  EQUITY_TRIGGER_TAG,
  CASH_OUT_MIN_EQUITY,
  REFI_MIN_RATE_DELTA_BPS,
} from "../lib/kernel/equity-trigger"

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
  console.log(" ✅ Equity Trigger verified — honest threshold math (reuses computeEquityLine) + gated note + Director reel + portal card")
  console.log(" EQUITY_TRIGGER_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Equity Trigger simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure threshold math]")

  // ── CASH-OUT crosses: paid 400k, worth 900k, original loan 300k, 5 yrs.
  // remaining = 300000 × (1 − 0.015×5) = 277,500; equity = 900000 − 277500 = 622,500.
  // equity ≥ 150k AND 622500/900000 = 69% ≥ 35% → cash-out crosses; pull = 50% = 311,250.
  const cashOut = equityTriggerSignal({
    purchasePrice: 400_000, estimatedValue: 900_000, originalLoanAmount: 300_000, yearsHeld: 5,
  })
  check("cash-out: big equity gain crosses (loan known)", cashOut.crosses && cashOut.triggerTypes.includes("cash_out"), JSON.stringify(cashOut.triggerTypes))
  check("cash-out: equity 622,500 → ~311,250 conservatively pullable", cashOut.line.estimatedEquity === 622_500 && cashOut.cashOutOpportunity === 311_250, JSON.stringify({ e: cashOut.line.estimatedEquity, c: cashOut.cashOutOpportunity }))
  check("cash-out: refi NULL here (no rates supplied — no fabrication)", cashOut.refiMonthlySavings === null && cashOut.rateDeltaBps === null)

  // ── REFI crosses: original rate 7.0%, current 6.0% → 100 bps ≥ 75; on a 300k balance,
  // monthly ≈ 300000 × 0.01 / 12 = 250 ≥ 150 → refi crosses.
  const refi = equityTriggerSignal({
    purchasePrice: 400_000, estimatedValue: 420_000, originalLoanAmount: 300_000, yearsHeld: 0,
    originalRate: 7.0, currentMarketRate: 6.0, remainingBalance: 300_000,
  })
  check("refi: rate drop crosses (≥75 bps + ≥$150/mo)", refi.triggerTypes.includes("refi") && refi.rateDeltaBps === 100, JSON.stringify({ t: refi.triggerTypes, bps: refi.rateDeltaBps }))
  check("refi: monthly savings ~$250 modeled", refi.refiMonthlySavings === 250, JSON.stringify(refi.refiMonthlySavings))

  // ── MISSING rate → equity-only: refi null even though equity is huge; no fabricated rate.
  const noRate = equityTriggerSignal({
    purchasePrice: 400_000, estimatedValue: 900_000, originalLoanAmount: 300_000, yearsHeld: 5,
    originalRate: null, currentMarketRate: null,
  })
  check("missing rate: refi is NULL (equity-only, no fabrication)", noRate.refiMonthlySavings === null && noRate.rateDeltaBps === null)
  check("missing rate: cash-out still fires on its own", noRate.cashOutOpportunity !== null && noRate.triggerTypes.length === 1 && noRate.triggerTypes[0] === "cash_out")

  // ── ONE rate present but not the other → still no refi (both halves required).
  const halfRate = equityTriggerSignal({
    purchasePrice: 400_000, estimatedValue: 420_000, originalLoanAmount: 300_000, yearsHeld: 0,
    originalRate: 7.0, currentMarketRate: null,
  })
  check("half rate (original only, no current): refi NULL — current quote required", halfRate.refiMonthlySavings === null)

  // ── MISSING loan → no equity figure → cash-out cannot fire (honest null).
  const noLoan = equityTriggerSignal({
    purchasePrice: 400_000, estimatedValue: 900_000, yearsHeld: 5,
  })
  check("missing loan: NO equity figure → cash-out NULL (appreciation-only)", noLoan.line.estimatedEquity === null && noLoan.cashOutOpportunity === null && noLoan.line.equityBasis === "appreciation_only")

  // ── SMALL/NONE: modest equity below dollar floor → no cross.
  const small = equityTriggerSignal({
    purchasePrice: 400_000, estimatedValue: 450_000, originalLoanAmount: 380_000, yearsHeld: 1,
  })
  check("small: equity below $150k floor → no cross", !small.crosses && small.cashOutOpportunity === null, JSON.stringify({ e: small.line.estimatedEquity }))

  // ── PERCENT guard: big-dollar equity that's a SMALL share of a very pricey home
  // shouldn't trigger on dollars alone. Worth 3M, loan 2.5M fresh → equity ~2.5M IS >35%,
  // so instead test the guard directly: equity ≥ 150k but < 35% of value.
  // paid 2M, worth 3M, loan 2.8M, 0 yrs → equity = 3M − 2.8M = 200k ≥ 150k BUT 200k/3M = 6.7% < 35%.
  const pctGuard = equityTriggerSignal({
    purchasePrice: 2_000_000, estimatedValue: 3_000_000, originalLoanAmount: 2_800_000, yearsHeld: 0,
  })
  check("percent guard: $200k equity but only ~7% of value → cash-out does NOT fire", pctGuard.line.estimatedEquity === 200_000 && pctGuard.cashOutOpportunity === null, JSON.stringify({ e: pctGuard.line.estimatedEquity }))

  // ── rate delta just under the floor → no refi.
  const thinRate = equityTriggerSignal({
    purchasePrice: 400_000, estimatedValue: 420_000, originalLoanAmount: 300_000, yearsHeld: 0,
    originalRate: 6.5, currentMarketRate: 6.0, remainingBalance: 300_000, // 50 bps < 75
  })
  check("thin rate: 50 bps below original (< 75 floor) → refi NULL", thinRate.refiMonthlySavings === null && thinRate.rateDeltaBps === 50)

  // ── BOTH angles cross at once.
  const both = equityTriggerSignal({
    purchasePrice: 400_000, estimatedValue: 900_000, originalLoanAmount: 300_000, yearsHeld: 5,
    originalRate: 7.0, currentMarketRate: 6.0,
  })
  check("both: cash-out AND refi cross together", both.triggerTypes.includes("cash_out") && both.triggerTypes.includes("refi") && both.crosses)

  // ── quarterKey
  check("quarterKey: 2026-06-13 → 2026-Q2", quarterKey(new Date(Date.UTC(2026, 5, 13))) === "2026-Q2")
  check("quarterKey: 2026-01-02 → 2026-Q1", quarterKey(new Date(Date.UTC(2026, 0, 2))) === "2026-Q1")
  check("quarterKey: 2026-12-31 → 2026-Q4", quarterKey(new Date(Date.UTC(2026, 11, 31))) === "2026-Q4")

  // ── compose: honest, labeled estimate, not an appraisal, names the crossing figure.
  const note = composeTriggerNote({ firstName: "Dana", address: "12 Equity Ln", signal: both, estimatedValue: 900_000 })
  check("note: labels estimate + 'not an appraisal' + names cash + refi", note.body.includes("estimate") && note.body.includes("not an appraisal") && note.body.includes("$311,250") && note.body.includes("month"))
  check("note: no financial-advice claim (says 'not financial advice')", note.body.includes("not financial advice"))
  const brief = composeTriggerBrief({ fullName: "Dana Probe", address: "12 Equity Ln", signal: both, estimatedValue: 900_000, valuationSource: "injected", rateSource: "test_feed" })
  check("brief: names both angles + source + 'not an appraisal'", brief.includes("CASH-OUT") && brief.includes("REFI") && brief.includes("not an appraisal"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live equity trigger]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runEquityTrigger } = await import("../lib/kernel/equity-trigger")
  const svc = createServiceClient()
  const TAG = `EqTrig${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 2 · live equity trigger]")
  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // ── CROSSING past client: closed deal, big equity, low original→current rate gap. ──
    const { data: pc } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "PastClient", contact_type: "past_client",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (pc as any).id })
    const contactId = (pc as any).id

    const closeIso = new Date(Date.UTC(new Date().getUTCFullYear() - 5, 0, 15)).toISOString().slice(0, 10)
    const address = `${TAG} 12 Equity Ln`
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} home`, deal_type: "buyer",
      status: "closed", stage: "CLOSED", property_address: address,
      purchase_price: 400_000, close_date: closeIso,
      buyer_contact_id: contactId, contact_id: contactId, agent_id: (agent as any).id,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })

    // Original loan amount + ORIGINAL RATE on file → both angles computable.
    const { data: lender } = await svc.from("transaction_lenders").insert({
      transaction_id: (txn as any).id, brokerage_id: brokerageId,
      loan_amount: 300_000, interest_rate: 7.0,
    }).select("id").single()
    if (lender) cleanup.push({ table: "transaction_lenders", id: (lender as any).id })

    // INJECTED valuation (TAG address ONLY → every other contact gets honest null) +
    // INJECTED authoritative rate (6.0%) + reel RECORDER (no D-ID/render spend).
    const reelCalls: Array<{ contactId: string }> = []
    const opts = {
      valuationFetcher: async (a: { brokerageId: string; address: string }) =>
        a.address === address ? { value: 900_000, source: "injected" } : null,
      currentRateFetcher: async () => ({ ratePct: 6.0, source: "injected_feed" }),
      copyGenerator: async () => null, // deterministic fallback (no token spend)
      reelDispatcher: async (d: { contactId: string }) => {
        reelCalls.push({ contactId: d.contactId })
        return { ok: true, status: "staged" }
      },
    }
    const r1 = await runEquityTrigger(brokerageId, { ...opts, contactId }, svc)
    check("runner: trigger detected + ONE note proposed + reel commissioned + portal card pushed",
      r1.triggersDetected >= 1 && r1.notesProposed >= 1 && r1.reelsCommissioned >= 1 && r1.portalCardsPushed >= 1,
      JSON.stringify(r1))

    const qKey = quarterKey(new Date())

    // (1) ONE GATED proposal — sphere_of_influence, audience 'agent', proposed, quarter tag.
    const { data: msg } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, recipient_contact_id, body, rationale")
      .eq("recipient_contact_id", contactId).ilike("rationale", `${EQUITY_TRIGGER_TAG} %`).maybeSingle()
    if (msg) {
      cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
      const { data: notes } = await svc.from("notifications").select("id").eq("entity_id", (msg as any).id)
      for (const n of (notes ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    check("Sphere Manager: ONE gated proposal (sphere_of_influence, audience 'agent', status proposed)",
      (msg as any)?.status === "proposed" && (msg as any)?.audience === "agent" && (msg as any)?.agent_kind === "sphere_of_influence")
    check("proposal body is the ready-to-send note: 'not an appraisal' + a real dollar figure",
      ((msg as any)?.body ?? "").includes("not an appraisal") && /\$[\d,]+/.test((msg as any)?.body ?? ""))
    check("rationale carries the quarter idempotency tag",
      ((msg as any)?.rationale ?? "").startsWith(EQUITY_TRIGGER_TAG) && ((msg as any)?.rationale ?? "").includes(`[${qKey}]`))

    // (2) PORTAL VALUE CARD — transparency_updates, visible, update_type 'equity_trigger'.
    const { data: card } = await svc.from("transparency_updates")
      .select("id, contact_id, update_type, is_visible_to_client, metadata")
      .eq("contact_id", contactId).eq("update_type", "equity_trigger").maybeSingle()
    if (card) cleanup.push({ table: "transparency_updates", id: (card as any).id })
    check("portal: VALUE card pushed (visible, update_type 'equity_trigger', to the past client)",
      (card as any)?.is_visible_to_client === true && (card as any)?.contact_id === contactId)
    const meta = (card as any)?.metadata ?? {}
    check("portal card metadata: real numbers (value 900k, equity 622,500, refi savings present, not_an_appraisal)",
      meta.estimated_value === 900_000 && meta.estimated_equity === 622_500 &&
      typeof meta.refi_monthly_savings === "number" && meta.not_an_appraisal === true,
      JSON.stringify(meta))

    // (3) Director reel — commissioned ONLY through the injected seam.
    check("reel: Director commission via the seam only (reelsCommissioned matches recorder calls)",
      reelCalls.length === r1.reelsCommissioned && reelCalls.length >= 1, JSON.stringify({ reelCalls: reelCalls.length, r1 }))

    // ── BELOW-THRESHOLD past client: small equity, no rate gap → NO action. ──
    const { data: pc2 } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}low`, last_name: "PastClient", contact_type: "past_client",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (pc2 as any).id })
    const contactId2 = (pc2 as any).id
    const addr2 = `${TAG}low 9 Quiet Ct`
    const { data: txn2 } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG}low home`, deal_type: "buyer",
      status: "closed", stage: "CLOSED", property_address: addr2,
      purchase_price: 400_000, close_date: new Date(Date.UTC(new Date().getUTCFullYear() - 1, 0, 15)).toISOString().slice(0, 10),
      buyer_contact_id: contactId2, contact_id: contactId2, agent_id: (agent as any).id,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn2 as any).id })
    const { data: lender2 } = await svc.from("transaction_lenders").insert({
      transaction_id: (txn2 as any).id, brokerage_id: brokerageId, loan_amount: 380_000, interest_rate: 6.1,
    }).select("id").single()
    if (lender2) cleanup.push({ table: "transaction_lenders", id: (lender2 as any).id })

    const optsLow = {
      valuationFetcher: async (a: { brokerageId: string; address: string }) =>
        a.address === addr2 ? { value: 430_000, source: "injected" } : null, // tiny equity
      currentRateFetcher: async () => ({ ratePct: 6.0, source: "injected_feed" }), // 10 bps gap < 75
      copyGenerator: async () => null,
      reelDispatcher: async () => ({ ok: true, status: "staged" }),
    }
    const rLow = await runEquityTrigger(brokerageId, { ...optsLow, contactId: contactId2 }, svc)
    check("below threshold: NO note, NO reel, NO card; counted skippedBelowThreshold",
      rLow.notesProposed === 0 && rLow.reelsCommissioned === 0 && rLow.portalCardsPushed === 0 && rLow.skippedBelowThreshold >= 1,
      JSON.stringify(rLow))

    // ── Idempotency: rerun the crossing case in the same quarter is a no-op. ──
    const r2 = await runEquityTrigger(brokerageId, { ...opts, contactId }, svc)
    check("idempotency: rerun in the same quarter proposes nothing + pushes no card (skippedDuplicate counted)",
      r2.notesProposed === 0 && r2.portalCardsPushed === 0 && r2.skippedDuplicate >= 1, JSON.stringify(r2))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("transactions").select("id", { count: "exact", head: true }).like("deal_name", `${TAG}%`)
    const { count: cCount } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 seeded rows remain", (count ?? 0) === 0 && (cCount ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
