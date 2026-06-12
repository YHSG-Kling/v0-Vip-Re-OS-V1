#!/usr/bin/env tsx
/**
 * scripts/anniversary-equity-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ANNIVERSARY EQUITY REPORT harness — the Sphere-of-Influence lifetime-
 * customer flywheel: on the yearly closing anniversary, a personal home-equity
 * update (est. value vs purchase price; equity only when the original loan is
 * KNOWN — otherwise appreciation-only and the copy SAYS so).
 *
 * Layer 1 (pure): computeEquityLine (loan-known equity = value − est. remaining
 *   balance; no-loan path returns NULL equity + "appreciation_only" — the honest
 *   degrade); anniversaryWindow (boundaries, sub-year exclusion, YEAR ROLLOVER:
 *   a late-December closing checked in early January); composeEquityNote
 *   (labels estimates, says "not an appraisal", honest no-loan wording).
 * Layer 2 (live, gated): seed a past client + a CLOSED transaction dated ~1 year
 *   ago + the original loan amount (transaction_lenders); run runAnniversaryEquity
 *   with an INJECTED valuation (TAG address only — every other contact gets an
 *   honest null → skippedNoValuation, no fabricated values touch real rows);
 *   assert ONE gated proposal (sphere_of_influence, audience 'agent', proposed,
 *   rationale carries the year tag) AND the portal VALUE card (transparency_updates,
 *   visible, update_type 'equity_report') with the REAL computed numbers; rerun is
 *   a no-op (one report per contact per YEAR). Self-cleans with a unique TAG.
 *
 * Run: npx tsx scripts/anniversary-equity-simulator.ts  (npm run test:anniversary-equity)
 */
import {
  computeEquityLine,
  anniversaryWindow,
  composeEquityNote,
  composeAgentBrief,
  ANNIVERSARY_EQUITY_TAG,
} from "../lib/kernel/anniversary-equity"

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
  console.log(" ✅ Anniversary Equity verified — honest equity math + portal value card + gated yearly report")
  console.log(" ANNIVERSARY_EQUITY_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Anniversary Equity simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · equity math + anniversary window + compose]")

  // Loan KNOWN: paid 500k, worth 600k, original loan 400k, 1 year held.
  // remaining = 400000 × (1 − 0.015×1) = 394000; equity = 600000 − 394000 = 206000.
  const withLoan = computeEquityLine({ purchasePrice: 500_000, estimatedValue: 600_000, originalLoanAmount: 400_000, yearsHeld: 1 })
  check("equity (loan known): appreciation 100k @ 20%", withLoan.appreciation === 100_000 && withLoan.appreciationPct === 20, JSON.stringify(withLoan))
  check("equity (loan known): est. remaining balance 394k → equity 206k", withLoan.estimatedRemainingBalance === 394_000 && withLoan.estimatedEquity === 206_000, JSON.stringify(withLoan))
  check("equity (loan known): basis flag = value_minus_estimated_balance", withLoan.equityBasis === "value_minus_estimated_balance" && withLoan.hasLoanData === true)

  // Loan UNKNOWN — the honest path: NULL equity, appreciation-only flag.
  const noLoan = computeEquityLine({ purchasePrice: 500_000, estimatedValue: 600_000, yearsHeld: 3 })
  check("equity (NO loan data): estimatedEquity is NULL — never fabricated", noLoan.estimatedEquity === null && noLoan.estimatedRemainingBalance === null)
  check("equity (NO loan data): basis flag = appreciation_only, hasLoanData false", noLoan.equityBasis === "appreciation_only" && noLoan.hasLoanData === false)

  // Honesty over flattery: value below purchase reports negative appreciation.
  const under = computeEquityLine({ purchasePrice: 500_000, estimatedValue: 450_000, yearsHeld: 1 })
  check("equity: value below purchase → NEGATIVE appreciation (-50k @ -10%)", under.appreciation === -50_000 && under.appreciationPct === -10)

  // Paydown clamps at zero — a very long hold never produces a negative balance.
  const longHold = computeEquityLine({ purchasePrice: 100_000, estimatedValue: 400_000, originalLoanAmount: 80_000, yearsHeld: 100 })
  check("equity: paydown clamps at 0 → equity = full estimated value", longHold.estimatedRemainingBalance === 0 && longHold.estimatedEquity === 400_000)

  // closePrice override takes precedence as the basis when provided.
  const closeBasis = computeEquityLine({ purchasePrice: 500_000, closePrice: 480_000, estimatedValue: 600_000, yearsHeld: 1 })
  check("equity: closePrice overrides purchasePrice as the basis", closeBasis.basisPrice === 480_000 && closeBasis.appreciation === 120_000)

  // ── anniversaryWindow ──
  const now = new Date(Date.UTC(2026, 5, 12)) // 2026-06-12
  const exact = anniversaryWindow("2025-06-12", now, 7)
  check("window: exactly 1 year → 1st anniversary, year keyed 2026", exact.isAnniversary && exact.anniversaryNumber === 1 && exact.anniversaryYear === 2026, JSON.stringify(exact))
  const edge7 = anniversaryWindow("2025-06-19", now, 7)
  const edge8 = anniversaryWindow("2025-06-20", now, 7)
  check("window: +7 days inside the boundary, +8 outside", edge7.isAnniversary === true && edge8.isAnniversary === false)
  const past5 = anniversaryWindow("2021-06-08", now, 7)
  check("window: 5th anniversary 4 days past → hit, n=5", past5.isAnniversary && past5.anniversaryNumber === 5 && past5.daysToAnniversary === -4, JSON.stringify(past5))
  // YEAR ROLLOVER — Dec-28 closing checked Jan 2: the anniversary belongs to the
  // PREVIOUS calendar year and the idempotency year says so.
  const jan = new Date(Date.UTC(2026, 0, 2)) // 2026-01-02
  const roll = anniversaryWindow("2024-12-28", jan, 7)
  check("window: YEAR ROLLOVER (closed Dec 28 2024, now Jan 2 2026) → 1st anniversary keyed to 2025", roll.isAnniversary && roll.anniversaryNumber === 1 && roll.anniversaryYear === 2025, JSON.stringify(roll))
  check("window: closed <1 year ago is NEVER an anniversary", anniversaryWindow("2026-03-01", now, 7).isAnniversary === false)
  check("window: same-day closing (year 0) is not an anniversary", anniversaryWindow("2026-06-12", now, 7).isAnniversary === false)
  check("window: invalid close date → honest non-hit (no fabricated dates)", anniversaryWindow("not-a-date", now, 7).isAnniversary === false)

  // ── compose (deterministic fallback) ──
  const noteLoan = composeEquityNote({ firstName: "Dana", address: "12 Equity Ln", anniversaryNumber: 1, estimatedValue: 600_000, line: withLoan })
  check("note (loan known): labels estimates + says 'not an appraisal' + names the equity",
    noteLoan.body.includes("estimate") && noteLoan.body.includes("not an appraisal") && noteLoan.body.includes("$206,000"))
  check("note: subject marks the anniversary + equity update", noteLoan.subject.toLowerCase().includes("anniversary") && noteLoan.subject.toLowerCase().includes("equity"))
  const noteNoLoan = composeEquityNote({ firstName: "Dana", address: null, anniversaryNumber: 3, estimatedValue: 600_000, line: noLoan })
  check("note (NO loan data): SAYS loan details aren't on file — value growth only, no equity claim",
    noteNoLoan.body.includes("loan details on file") && !noteNoLoan.body.includes("your estimated equity is"))
  check("note (NO loan data): still labeled estimate + not an appraisal", noteNoLoan.body.includes("estimate") && noteNoLoan.body.includes("not an appraisal"))
  const brief = composeAgentBrief({ fullName: "Dana Probe", address: "12 Equity Ln", anniversaryNumber: 3, estimatedValue: 600_000, valuationSource: "rentcast", line: noLoan })
  check("agent brief (NO loan data): honest 'appreciation only' wording + source named",
    brief.includes("appreciation only") && brief.includes("rentcast") && brief.includes("not an appraisal"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live anniversary equity]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runAnniversaryEquity } = await import("../lib/kernel/anniversary-equity")
  const svc = createServiceClient()
  const TAG = `AnnivEq${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 2 · live anniversary equity]")
  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // Past client (the closed transaction below IS the proof of the relationship).
    const { data: pc } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "PastClient", contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (pc as any).id })
    const contactId = (pc as any).id

    // CLOSED transaction dated exactly one year ago (UTC month/day) — the 1st anniversary is today.
    const runNow = new Date()
    const closeIso = new Date(Date.UTC(runNow.getUTCFullYear() - 1, runNow.getUTCMonth(), runNow.getUTCDate()))
      .toISOString().slice(0, 10)
    const address = `${TAG} 12 Equity Ln`
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} home`, deal_type: "buyer",
      status: "closed", stage: "CLOSED", property_address: address,
      purchase_price: 500_000, close_date: closeIso,
      buyer_contact_id: contactId, contact_id: contactId, agent_id: (agent as any).id,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })

    // The ORIGINAL loan amount on file → the equity path (not appreciation-only).
    const { data: lender } = await svc.from("transaction_lenders").insert({
      transaction_id: (txn as any).id, brokerage_id: brokerageId, loan_amount: 400_000,
    }).select("id").single()
    if (lender) cleanup.push({ table: "transaction_lenders", id: (lender as any).id })

    // INJECTED valuation — fixed numbers for OUR seeded address ONLY; every other
    // contact gets an honest null (skippedNoValuation) so no fabricated value can
    // ever touch a real contact's portal. Video dispatcher is a recorder (no D-ID spend).
    const videoCalls: Array<{ contactId: string; yearsAgo: number }> = []
    const opts = {
      valuationFetcher: async (a: { brokerageId: string; address: string }) =>
        a.address === address ? { value: 600_000, source: "injected" } : null,
      copyGenerator: async () => null, // deterministic fallback (no token spend)
      videoDispatcher: async (d: { contactId: string; yearsAgo: number }) => {
        videoCalls.push({ contactId: d.contactId, yearsAgo: d.yearsAgo })
        return { ok: true, status: "rendering" }
      },
    }
    const r1 = await runAnniversaryEquity(brokerageId, opts, svc)
    check("runner: anniversary detected + ONE report proposed + portal card pushed",
      r1.anniversariesDetected >= 1 && r1.reportsProposed >= 1 && r1.portalCardsPushed >= 1,
      JSON.stringify(r1))

    const yearTag = `${ANNIVERSARY_EQUITY_TAG} [${runNow.getUTCFullYear()}]`

    // (b) ONE GATED agent-facing proposal — sphere_of_influence, audience 'agent',
    // proposed (never auto-sent); rationale carries the year tag + the agent brief.
    const { data: msg } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, recipient_contact_id, subject, body, rationale")
      .eq("recipient_contact_id", contactId).ilike("rationale", `${yearTag}%`).maybeSingle()
    if (msg) {
      cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
      const { data: notes } = await svc.from("notifications").select("id").eq("entity_id", (msg as any).id)
      for (const n of (notes ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    check("Sphere Manager: ONE gated proposal (sphere_of_influence, audience 'agent', status proposed)",
      (msg as any)?.status === "proposed" && (msg as any)?.audience === "agent" && (msg as any)?.agent_kind === "sphere_of_influence")
    check("proposal body is the ready-to-send note: labeled estimate, 'not an appraisal', real equity $206,000",
      ((msg as any)?.body ?? "").includes("not an appraisal") && ((msg as any)?.body ?? "").includes("$206,000"))
    check("rationale carries the year idempotency tag + honest agent brief",
      ((msg as any)?.rationale ?? "").startsWith(yearTag) && ((msg as any)?.rationale ?? "").includes("$600,000"))

    // (a) PORTAL VALUE CARD — transparency_updates, visible, update_type 'equity_report',
    // metadata carries ONLY the real computed numbers.
    const { data: card } = await svc.from("transparency_updates")
      .select("id, contact_id, update_type, is_visible_to_client, metadata, title")
      .eq("contact_id", contactId).eq("update_type", "equity_report").maybeSingle()
    if (card) cleanup.push({ table: "transparency_updates", id: (card as any).id })
    check("portal: VALUE card pushed (visible, update_type 'equity_report', to the past client)",
      (card as any)?.is_visible_to_client === true && (card as any)?.contact_id === contactId)
    const meta = (card as any)?.metadata ?? {}
    check("portal card metadata: real numbers (value 600k, equity 206k, basis value−balance, not_an_appraisal)",
      meta.estimated_value === 600_000 && meta.estimated_equity === 206_000 &&
      meta.equity_basis === "value_minus_estimated_balance" && meta.not_an_appraisal === true,
      JSON.stringify(meta))

    // (c) Avatar video honesty — D-ID + ElevenLabs ONLY through the injected seam;
    // no avatar/voice profile → text-only and the result count says so.
    check("video: dispatched ONLY via the seam, and text-only runs are counted (videosDispatched + skippedNoAvatar ≥ 1)",
      videoCalls.length === r1.videosDispatched && (r1.videosDispatched + r1.skippedNoAvatar) >= 1,
      JSON.stringify({ videoCalls: videoCalls.length, r1 }))

    // Idempotency — the SAME year reruns as a no-op (one report per contact per YEAR).
    const r2 = await runAnniversaryEquity(brokerageId, opts, svc)
    check("idempotency: rerun in the same year proposes nothing + pushes no card (skippedDuplicate counted)",
      r2.reportsProposed === 0 && r2.portalCardsPushed === 0 && r2.skippedDuplicate >= 1,
      JSON.stringify(r2))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("transactions").select("id", { count: "exact", head: true }).like("deal_name", `${TAG}%`)
    const { count: cCount } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("first_name", TAG)
    check("cleanup verified — 0 seeded rows remain", (count ?? 0) === 0 && (cCount ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
