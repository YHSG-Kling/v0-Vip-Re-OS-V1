#!/usr/bin/env tsx
/**
 * scripts/financing-pit-stop-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * FINANCING PIT STOP harness — the Deal Coordinator's RATE/lender layer on the
 * financing window: when a deal enters the financing window (financing milestone
 * approaching, or a buyer's pre-approval going stale) a parallel rate-refresh RACE
 * fires across the preferred lender bench, the known/returned quotes are ranked by
 * lowest EFFECTIVE COST, and it surfaces as ONE gated agent summary + a buyer-portal
 * value card. Complementary to the Title & Closing Watchtower (date side).
 *
 * Layer 1 (pure): financingWindow (window boundaries + which trigger + primary trigger;
 *   NEITHER date → not in window so the runner skips honestly); rankLenderQuotes
 *   (effective cost = rate + points + amortized fees; lower wins; points/fees change the
 *   ordering even when the raw rate would not; no-rate sorts last); composeFinancingSummary
 *   + composeRateRequestFallback (earned lines, rates labeled ESTIMATES, Fair-Housing safe).
 * Layer 2 (live, gated): seed an under-contract deal + buyer contact + a buyer financial
 *   profile with a stale pre-approval (in-window) + an on-file lender quote + preferred
 *   lender bench vendors (category 'Lender'); run runFinancingPitStop; assert a GATED
 *   rate-request draft per preferred lender (the race) + ONE ranked Deal Coordinator
 *   summary (audience 'agent', proposed) + a buyer PORTAL card (transparency_updates,
 *   visible, update_type 'financing_pit_stop') + idempotent rerun; reverse-delete and
 *   verify cleanup count == 0.
 *
 * Run: npx tsx scripts/financing-pit-stop-simulator.ts  (npm run test:financing-pit-stop)
 */
import {
  financingWindow,
  rankLenderQuotes,
  effectiveRate,
  composeFinancingSummary,
  composeRateRequestFallback,
  financingWindowSignature,
  daysUntil,
  type LenderQuote,
  type FinancingDates,
} from "../lib/kernel/financing-pit-stop"

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
  console.log(" ✅ Financing Pit Stop verified — window detection + rank-by-effective-cost + lender race + gated summary + buyer portal card")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Financing Pit Stop simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · window boundaries + effective-cost ranking + compose]")

  const now = new Date("2026-06-12T15:00:00Z")
  const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10)

  // ── financingWindow boundaries ──
  // Financing deadline 10d out (≤21 window) → in window via financing_deadline.
  const wFin = financingWindow({ financingDeadline: day(10), preApprovalExpiresAt: null }, now)
  check("financing deadline within window → inWindow via financing_deadline",
    wFin.inWindow && wFin.triggers.includes("financing_deadline") && wFin.primaryTrigger === "financing_deadline")
  // Financing deadline 40d out (>21) → NOT in window.
  const wFar = financingWindow({ financingDeadline: day(40), preApprovalExpiresAt: null }, now)
  check("financing deadline beyond window → not in window", !wFar.inWindow)
  // Financing deadline already passed (−3d) → NOT a rate-refresh trigger (Watchtower territory).
  const wPast = financingWindow({ financingDeadline: day(-3), preApprovalExpiresAt: null }, now)
  check("passed financing deadline → not a pit-stop trigger", !wPast.inWindow)
  // Pre-approval expires in 5d (≤14) → in window via preapproval_stale.
  const wPre = financingWindow({ financingDeadline: null, preApprovalExpiresAt: day(5) }, now)
  check("pre-approval expiring within window → inWindow via preapproval_stale",
    wPre.inWindow && wPre.triggers.includes("preapproval_stale") && wPre.primaryTrigger === "preapproval_stale")
  // Already-stale pre-approval (−2d) → in window, and it's the primary (most urgent) trigger
  // even when a financing deadline is also present and sooner.
  const wBoth = financingWindow({ financingDeadline: day(8), preApprovalExpiresAt: day(-2) }, now)
  check("both triggers; already-stale pre-approval is primary (most urgent)",
    wBoth.inWindow && wBoth.triggers.length === 2 && wBoth.primaryTrigger === "preapproval_stale",
    `triggers=${wBoth.triggers.join("+")} primary=${wBoth.primaryTrigger}`)
  // Cash buyer → pre-approval signal ignored.
  const wCash = financingWindow({ financingDeadline: null, preApprovalExpiresAt: day(3), isCashBuyer: true }, now)
  check("cash buyer → pre-approval signal ignored (not in window)", !wCash.inWindow)
  // NEITHER date → not in window (runner skips honestly).
  const wNone = financingWindow({ financingDeadline: null, preApprovalExpiresAt: null }, now)
  check("no financing date and no pre-approval expiry → not in window (honest skip upstream)", !wNone.inWindow)
  check("daysUntil whole-day math", daysUntil(day(5), now) === 5 && daysUntil(day(-2), now) === -2)

  // ── rankLenderQuotes by effective cost ──
  // Lender X: 6.50% no points/fees. Lender Y: 6.40% but 1 point → effective 7.40%. So X wins
  // on effective cost despite the HIGHER raw rate — points/fees flip the ranking.
  const x: LenderQuote = { id: "X", lenderName: "Bench X", rate: 6.5, source: "bench" }
  const y: LenderQuote = { id: "Y", lenderName: "Bench Y", rate: 6.4, points: 1, source: "bench" }
  check("effectiveRate adds points: Y 6.4%+1pt = 7.4 eff", effectiveRate(y) === 7.4, `got ${effectiveRate(y)}`)
  check("effectiveRate plain rate: X 6.5% eff", effectiveRate(x) === 6.5)
  const ranked1 = rankLenderQuotes([y, x])
  check("rank-by-effective-cost: X (lower effective) beats Y despite Y's lower raw rate",
    ranked1[0].id === "X" && ranked1[1].id === "Y", `order=${ranked1.map((q) => q.id).join(",")}`)

  // Fees amortized over the loan term flip a tie. A: 6.50%, $6,000 fees on $300k over 30y →
  // (6000/300000*100)/30 = 0.0667 eff add → 6.5667. B: 6.55% no fees → 6.55 lower → B wins.
  const a: LenderQuote = { id: "A", lenderName: "Lender A", rate: 6.5, fees: 6000, loanAmount: 300_000, source: "bench" }
  const b: LenderQuote = { id: "B", lenderName: "Lender B", rate: 6.55, source: "bench" }
  const effA = effectiveRate(a)
  check("effectiveRate amortizes fees: A 6.5% + $6k/$300k/30y ≈ 6.5667 eff",
    Math.abs(effA - 6.566667) < 0.0001, `got ${effA}`)
  const ranked2 = rankLenderQuotes([a, b])
  check("amortized fees flip the ranking: B (6.55, no fees) beats A (6.5 + fees)", ranked2[0].id === "B")

  // No-rate quote sorts LAST (incumbent named, no live rate yet).
  const noRate: LenderQuote = { id: "Z", lenderName: "Incumbent", rate: null, source: "on_file" }
  const ranked3 = rankLenderQuotes([noRate, x])
  check("quote with no rate sorts last", ranked3[0].id === "X" && ranked3[1].id === "Z")

  // ── compose ──
  const w = financingWindow({ financingDeadline: null, preApprovalExpiresAt: day(-2) }, now)
  const composed = composeFinancingSummary({
    dealName: "123 Probe St",
    window: w,
    ranked: rankLenderQuotes([x, y]),
    benchRaceCount: 3,
  })
  check("agent subject: names deal + the trigger + the race count",
    composed.agentSubject.includes("123 Probe St") && composed.agentSubject.toLowerCase().includes("pre-approval") && composed.agentSubject.includes("3 preferred lender"))
  check("agent summary labels figures as ESTIMATES (not commitments) + names lowest effective cost + gating note",
    composed.agentSummary.toLowerCase().includes("estimates") && composed.agentSummary.includes("lowest effective cost") && composed.agentSummary.includes("without your approval"))
  check("buyer card: 'your financing is being refreshed' + estimate-not-offer + asks nothing",
    composed.buyerCardBody.toLowerCase().includes("your financing is being refreshed") &&
    composed.buyerCardBody.toLowerCase().includes("estimate") &&
    composed.buyerCardBody.includes("Nothing is needed from you"))
  // Fair-Housing safety: no steering / borrower-characteristic language in the deterministic copy.
  const banned = ["perfect for families", "safe neighborhood", "great for retirees", "good credit", "ideal borrower"]
  const blob = `${composed.agentSummary} ${composed.buyerCardBody}`.toLowerCase()
  check("Fair-Housing safe: no steering / lending-discrimination language in fallback copy",
    !banned.some((p) => blob.includes(p)))

  const rateReq = composeRateRequestFallback({ lenderName: "Bench X", dealName: "123 Probe St", propertyAddress: "123 Probe St", loanAmount: 300_000 })
  check("rate-request draft: names lender + frames an ESTIMATE not a commitment",
    rateReq.body.includes("Bench X") && rateReq.body.toLowerCase().includes("estimate") && rateReq.body.toLowerCase().includes("not a commitment"))

  check("financingWindowSignature stable for the same window",
    financingWindowSignature(w) === financingWindowSignature(financingWindow({ financingDeadline: null, preApprovalExpiresAt: day(-2) }, now)))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live financing pit stop]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live financing pit stop]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runFinancingPitStop } = await import("../lib/kernel/financing-pit-stop")
  const svc = createServiceClient()
  const TAG = `PitStop${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []
  const liveDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // Buyer is a CONTACT (has a portal).
    const { data: buyer } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Buyer", contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (buyer as any).id })

    // Buyer financial profile with a STALE pre-approval (expired 2 days ago) → in-window.
    const { data: fin } = await svc.from("buyer_financial_profiles").insert({
      brokerage_id: brokerageId, contact_id: (buyer as any).id,
      finance_type: "conventional", is_cash_buyer: false,
      pre_approval_amount: 300_000, pre_approval_lender: `${TAG} Incumbent Lender`,
      pre_approval_expires_at: liveDay(-2),
    }).select("id").single()
    cleanup.push({ table: "buyer_financial_profiles", id: (fin as any).id })

    // Live under-contract deal with a financing deadline 10d out (also in-window).
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} 123 Probe St`, property_address: `${TAG} 123 Probe St`,
      status: "under_contract", stage: "FINANCING_PENDING", agent_id: (agent as any).id,
      buyer_contact_id: (buyer as any).id, financing_deadline: liveDay(10), loan_amount: 300_000,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })

    // An on-file lender quote (transaction_lenders) — real columns: interest_rate, loan_amount.
    const { data: lender } = await svc.from("transaction_lenders").insert({
      transaction_id: (txn as any).id, brokerage_id: brokerageId,
      lender_name: `${TAG} On-File Lender`, interest_rate: 6.75, loan_amount: 300_000, loan_term_years: 30,
    }).select("id").single()
    cleanup.push({ table: "transaction_lenders", id: (lender as any).id })

    // PREFERRED LENDER BENCH — 2 Lender vendors (category 'Lender').
    const benchIds: string[] = []
    for (const n of [1, 2]) {
      const { data: v } = await svc.from("vendors").insert({
        brokerage_id: brokerageId, name: `${TAG} Bench Lender ${n}`, category: "Lender",
        email: `${TAG.toLowerCase()}.lender${n}@example.com`, rating: 4 + n * 0.1,
      }).select("id").single()
      cleanup.push({ table: "vendors", id: (v as any).id })
      benchIds.push((v as any).id)
    }

    // Run (deterministic fallback copy — no token spend).
    const r1 = await runFinancingPitStop(brokerageId, { copyGenerator: async () => null }, svc)
    check("runner: deal entered the financing window (≥1 in window, ≥1 summary)",
      r1.inWindow >= 1 && r1.summariesProposed >= 1, JSON.stringify(r1))
    check("runner: rate-refresh race fired a GATED draft per preferred bench lender (≥2)",
      r1.raceDraftsProposed >= 2, JSON.stringify(r1))
    check("runner: buyer portal card pushed (≥1)", r1.portalCardsPushed >= 1, JSON.stringify(r1))

    // The window signature the runner keyed on (financing 10d + pre-approval −2d, both triggers).
    const sig = financingWindowSignature(financingWindow(
      { financingDeadline: liveDay(10), preApprovalExpiresAt: liveDay(-2), isCashBuyer: false } as FinancingDates,
      new Date(),
    ))

    // (a) ONE gated ranked Deal Coordinator summary — audience 'agent', proposed.
    const { data: summaries } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, subject, body, rationale")
      .eq("entity_id", (txn as any).id).ilike("rationale", `PIT STOP — sig:${sig} %`)
    for (const s of (summaries ?? []) as any[]) {
      cleanup.push({ table: "agent_client_messages", id: s.id })
      const { data: notes } = await svc.from("notifications").select("id").eq("entity_id", s.id)
      for (const n of (notes ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    check("gate: exactly ONE ranked summary for this financing window", (summaries ?? []).length === 1)
    const summary = (summaries ?? [])[0] as any
    check("gate: Deal Coordinator, audience 'agent', status proposed",
      summary?.agent_kind === "deal_coordinator" && summary?.audience === "agent" && summary?.status === "proposed")
    check("gate: summary labels rates as ESTIMATES + names the race",
      (summary?.body ?? "").toLowerCase().includes("estimates") && (summary?.subject ?? "").toLowerCase().includes("rate refresh"))

    // (b) The race — one gated rate-request draft per preferred lender (PIT STOP RACE).
    const { data: raceDrafts } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, subject, rationale")
      .eq("entity_id", (txn as any).id).ilike("rationale", `PIT STOP RACE — sig:${sig} %`)
    for (const d of (raceDrafts ?? []) as any[]) {
      cleanup.push({ table: "agent_client_messages", id: d.id })
      const { data: notes } = await svc.from("notifications").select("id").eq("entity_id", d.id)
      for (const n of (notes ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    check("race: one GATED rate-request draft per preferred lender (2), all proposed audience 'agent'",
      (raceDrafts ?? []).length === 2 &&
      (raceDrafts ?? []).every((d: any) => d.status === "proposed" && d.audience === "agent" && d.agent_kind === "deal_coordinator"))

    // (c) Buyer PORTAL card — transparency_updates, visible, update_type 'financing_pit_stop'.
    const { data: card } = await svc.from("transparency_updates")
      .select("id, contact_id, update_type, is_visible_to_client, plain_language_summary, metadata, title")
      .eq("contact_id", (buyer as any).id).eq("update_type", "financing_pit_stop").maybeSingle()
    if (card) cleanup.push({ table: "transparency_updates", id: (card as any).id })
    check("portal: buyer value card pushed (visible, update_type 'financing_pit_stop', to the buyer)",
      (card as any)?.is_visible_to_client === true && (card as any)?.contact_id === (buyer as any).id)
    check("portal: card carries the window + ranked quotes + rates_are_estimates flag",
      Array.isArray((card as any)?.metadata?.ranked_quotes) &&
      (card as any)?.metadata?.rates_are_estimates === true &&
      Array.isArray((card as any)?.metadata?.triggers) && (card as any)?.metadata?.triggers.length >= 1)

    // Idempotency — rerun inside the window: same window signature, no new race/summary/card.
    const r2 = await runFinancingPitStop(brokerageId, { copyGenerator: async () => null }, svc)
    check("idempotency: rerun proposes nothing new and pushes no duplicate card (one race per deal-window)",
      r2.summariesProposed === 0 && r2.raceDraftsProposed === 0 && r2.portalCardsPushed === 0, JSON.stringify(r2))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("transactions").select("id", { count: "exact", head: true }).like("deal_name", `${TAG}%`)
    check("cleanup verified — 0 seeded transactions remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
