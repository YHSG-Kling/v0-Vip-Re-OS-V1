#!/usr/bin/env tsx
/**
 * scripts/closing-watchtower-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * TITLE & CLOSING WATCHTOWER harness — the Deal Coordinator's early layer on the
 * date chain: the moment a chain date MOVES, one gated agent alert with the
 * recomputed critical path + a plain-language portal card to BOTH represented sides.
 *
 * Layer 1 (pure): buildDateChain (real milestone rows → ordered chain, gaps honest);
 *   computeCriticalPath (binding constraint + slack vs documented runway + severity
 *   thresholds: slack<0 or past-due → at_risk, 0..3 → tight, else ok; NO closing
 *   date → null, never fabricated); describeMove ("Appraisal slipped 4 days
 *   (Jun 10 → Jun 14)"); composeWatchtowerFallback (earned lines only);
 *   moveSetSignature (order-independent idempotency key).
 * Layer 2 (live, gated): seed an under-contract deal with buyer + seller contacts
 *   and the full milestone chain; MOVE the appraisal date the way production does
 *   (transaction_milestones.target_date update + the lifecycle_events
 *   'lifecycle.milestone.date_changed' audit row that setMilestoneDate writes);
 *   run runClosingWatchtower; assert ONE gated Deal Coordinator alert (audience
 *   'agent', proposed) + portal value cards for BOTH sides (transparency_updates,
 *   visible, update_type 'closing_watchtower') + idempotent rerun; reverse-delete
 *   and verify cleanup count == 0.
 *
 * Run: npx tsx scripts/closing-watchtower-simulator.ts  (npm run test:closing-watchtower)
 */
import {
  buildDateChain,
  computeCriticalPath,
  describeMove,
  composeWatchtowerFallback,
  moveSetSignature,
  daysBetween,
  fmtChainDate,
  type MilestoneMove,
} from "../lib/kernel/title-closing-watchtower"

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
  console.log(" ✅ Closing Watchtower verified — date-move detection + critical path + gated alert + dual-side portal cards")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Title & Closing Watchtower simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · chain build + critical path + move describe + compose]")

  const now = new Date("2026-06-12T15:00:00Z")

  // Chain build — gaps stay honest (no row → date null), order is canonical.
  const rows = [
    { milestone_name: "closing_date",        target_date: "2026-07-10", status: "pending" },
    { milestone_name: "appraisal_deadline",  target_date: "2026-06-22", status: "pending" },
    { milestone_name: "inspection_deadline", target_date: "2026-06-08", status: "completed" },
    { milestone_name: "financing_deadline",  target_date: "2026-07-01", status: "pending" },
  ]
  const chain = buildDateChain(rows)
  check("chain ordered inspection→appraisal→financing→CTC→closing",
    chain.map((s) => s.key).join(",") === "inspection_deadline,appraisal_deadline,financing_deadline,clear_to_close_received,closing_date")
  check("missing step (clear-to-close) present with date null — gap honest",
    chain[3].key === "clear_to_close_received" && chain[3].date === null)
  check("completed inspection carries completed=true", chain[0].completed === true)

  // Critical path — appraisal Jun 22 vs Jul 10 closing = 18d gap − 14d runway = 4d slack;
  // financing Jul 1 = 9d gap − 7d runway = 2d slack → financing is binding, TIGHT.
  const path = computeCriticalPath(chain, now)
  check("critical path computed (closing date on file)", path !== null)
  check("binding constraint is the least-slack remaining step (loan commitment)",
    path?.bindingStep === "financing_deadline", `got ${path?.bindingStep}`)
  check("slack math: financing 2d, appraisal 4d (gap − documented runway)",
    path?.slackDays === 2 && path?.steps.find((s) => s.key === "appraisal_deadline")?.slackDays === 4,
    `got binding=${path?.slackDays}, appraisal=${path?.steps.find((s) => s.key === "appraisal_deadline")?.slackDays}`)
  check("severity TIGHT (0 ≤ slack ≤ 3)", path?.severity === "tight", `got ${path?.severity}`)
  check("completed step never the binding constraint",
    path?.bindingStep !== "inspection_deadline")

  // Severity thresholds documented: slip appraisal past its runway → negative slack → at_risk.
  const slipped = buildDateChain(rows.map((r) =>
    r.milestone_name === "appraisal_deadline" ? { ...r, target_date: "2026-07-05" } : r))
  const riskPath = computeCriticalPath(slipped, now)
  check("appraisal slipped inside its runway → negative slack → AT_RISK",
    riskPath?.severity === "at_risk" && riskPath?.bindingStep === "appraisal_deadline" && (riskPath?.slackDays ?? 0) < 0,
    `got ${riskPath?.severity}/${riskPath?.bindingStep}/${riskPath?.slackDays}`)

  // Past-due incomplete step → at_risk regardless of slack.
  const pastDue = buildDateChain(rows.map((r) =>
    r.milestone_name === "appraisal_deadline" ? { ...r, target_date: "2026-06-10" } : r))
  const pastPath = computeCriticalPath(pastDue, now)
  check("incomplete step already past its date → AT_RISK", pastPath?.severity === "at_risk")

  // Roomy chain → ok.
  const roomy = buildDateChain([
    { milestone_name: "appraisal_deadline", target_date: "2026-06-20", status: "pending" },
    { milestone_name: "closing_date",       target_date: "2026-08-28", status: "pending" },
  ])
  const okPath = computeCriticalPath(roomy, now)
  check("plenty of runway → OK", okPath?.severity === "ok", `got ${okPath?.severity}`)

  // NO closing date → no critical path (skip honestly, never fabricate).
  const noClose = buildDateChain([{ milestone_name: "appraisal_deadline", target_date: "2026-06-20", status: "pending" }])
  check("no closing date on file → computeCriticalPath returns null (honest skip)",
    computeCriticalPath(noClose, now) === null)

  // Move description — the concrete impact line.
  const move: MilestoneMove = { eventId: "e1", milestone: "appraisal_deadline", previousDate: "2026-06-10", newDate: "2026-06-14" }
  const desc = describeMove(move)
  check("describeMove: 'Appraisal slipped 4 days (Jun 10 → Jun 14)'",
    desc.deltaDays === 4 && desc.direction === "slipped" && desc.phrase === "Appraisal slipped 4 days (Jun 10 → Jun 14)", desc.phrase)
  const earlier = describeMove({ eventId: "e2", milestone: "closing_date", previousDate: "2026-07-10", newDate: "2026-07-08" })
  check("describeMove: moved UP (earlier) named correctly",
    earlier.deltaDays === -2 && earlier.direction === "moved_up" && earlier.phrase.includes("moved up 2 days"))
  const setMove = describeMove({ eventId: "e3", milestone: "clear_to_close_received", previousDate: null, newDate: "2026-07-07" })
  check("describeMove: first-time date is 'set', not a slip", setMove.direction === "set")

  // Compose — agent gets the move + the new critical path; client gets plain language.
  const composed = composeWatchtowerFallback({ dealName: "123 Maple St", moves: [move], path: riskPath! })
  check("agent subject: deal + concrete impact + closing at risk",
    composed.agentSubject.includes("123 Maple St") && composed.agentSubject.includes("Appraisal slipped 4 days") && composed.agentSubject.includes("closing at risk"))
  check("agent summary: names the binding constraint + new critical path + gating note",
    composed.agentSummary.includes("binding constraint") && composed.agentSummary.includes("New critical path") && composed.agentSummary.includes("without your approval"))
  check("client body: plain language, names the change + closing date, no action needed",
    composed.clientBody.includes("Appraisal slipped 4 days") && composed.clientBody.includes(fmtChainDate(riskPath!.closingDate)) && composed.clientBody.includes("Nothing is needed from you"))

  check("moveSetSignature order-independent", moveSetSignature(["b", "a"]) === moveSetSignature(["a", "b"]))
  check("daysBetween whole-day math", daysBetween("2026-06-10", "2026-06-14") === 4 && daysBetween("2026-06-14", "2026-06-10") === -4)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live watchtower]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live watchtower]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runClosingWatchtower, DATE_CHANGED_EVENT } = await import("../lib/kernel/title-closing-watchtower")
  const svc = createServiceClient()
  const TAG = `Watchtower${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // BOTH represented sides are contacts (each has a portal).
    const { data: buyer } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Buyer", contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (buyer as any).id })
    const { data: seller } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Seller", contact_type: "seller",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (seller as any).id })

    // Live under-contract deal, dual-represented.
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} 123 Maple St`, status: "under_contract",
      agent_id: (agent as any).id, buyer_contact_id: (buyer as any).id, seller_contact_id: (seller as any).id,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })

    // The REAL date chain (transaction_milestones — the table setMilestoneDate edits).
    const chainSeed = [
      { milestone_name: "inspection_deadline",     target_date: day(-3), status: "completed" },
      { milestone_name: "appraisal_deadline",      target_date: day(7),  status: "pending" },
      { milestone_name: "financing_deadline",      target_date: day(18), status: "pending" },
      { milestone_name: "clear_to_close_received", target_date: day(24), status: "pending" },
      { milestone_name: "closing_date",            target_date: day(28), status: "pending" },
    ]
    for (const m of chainSeed) {
      const { data: ms } = await svc.from("transaction_milestones").insert({
        transaction_id: (txn as any).id, brokerage_id: brokerageId,
        milestone_name: m.milestone_name, target_date: m.target_date, status: m.status,
        is_client_visible: true, created_at: new Date().toISOString(),
      }).select("id").single()
      cleanup.push({ table: "transaction_milestones", id: (ms as any).id })
    }

    // MOVE the appraisal date +11 days — exactly the writes production's
    // setMilestoneDate performs: target_date update + the lifecycle audit row
    // carrying previous_date/new_date (the watchtower's detection signal).
    const prevAppraisal = day(7), newAppraisal = day(18)
    await svc.from("transaction_milestones")
      .update({ target_date: newAppraisal, updated_at: new Date().toISOString() })
      .eq("transaction_id", (txn as any).id).eq("milestone_name", "appraisal_deadline")
    const { data: ev } = await svc.from("lifecycle_events").insert({
      brokerage_id: brokerageId, entity_type: "transaction", entity_id: (txn as any).id,
      event_type: DATE_CHANGED_EVENT, actor_user_id: (agent as any).user_id,
      metadata: { milestone_name: "appraisal_deadline", previous_date: prevAppraisal, new_date: newAppraisal, reason: `${TAG} appraiser reschedule`, from_state: "milestone_pending", to_state: "target_date_changed" },
    }).select("id").single()
    cleanup.push({ table: "lifecycle_events", id: (ev as any).id })

    // Run the sweep (deterministic fallback copy — no token spend).
    const r1 = await runClosingWatchtower(brokerageId, { copyGenerator: async () => null }, svc)
    check("runner: detected the move on the seeded deal (1 deal, ≥1 move)",
      r1.transactionsWithMoves >= 1 && r1.movesDetected >= 1,
      JSON.stringify(r1))
    check("runner: ONE gated alert proposed + portal cards for BOTH sides",
      r1.alertsProposed >= 1 && r1.portalCardsPushed >= 2, JSON.stringify(r1))

    const sig = moveSetSignature([(ev as any).id])

    // (a) ONE gated Deal Coordinator alert — audience 'agent', proposed, never sent.
    const { data: alerts } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, subject, body, rationale")
      .eq("entity_id", (txn as any).id).ilike("rationale", `CLOSING WATCHTOWER — sig:${sig} %`)
    for (const a of (alerts ?? []) as any[]) {
      cleanup.push({ table: "agent_client_messages", id: a.id })
      const { data: notes } = await svc.from("notifications").select("id").eq("entity_id", a.id)
      for (const n of (notes ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }
    check("gate: exactly ONE alert for this move-set", (alerts ?? []).length === 1)
    const alert = (alerts ?? [])[0] as any
    check("gate: Deal Coordinator, audience 'agent', status proposed",
      alert?.agent_kind === "deal_coordinator" && alert?.audience === "agent" && alert?.status === "proposed")
    check("gate: concrete impact — 'Appraisal slipped 11 days' + new critical path + binding constraint",
      (alert?.subject ?? "").includes("Appraisal slipped 11 days") &&
      (alert?.body ?? "").includes("New critical path") && (alert?.body ?? "").includes("binding constraint"))

    // (b) Portal value cards — BOTH represented sides, visible, plain language.
    for (const side of [{ id: (buyer as any).id, who: "buyer" }, { id: (seller as any).id, who: "seller" }]) {
      const { data: card } = await svc.from("transparency_updates")
        .select("id, contact_id, update_type, is_visible_to_client, plain_language_summary, metadata")
        .eq("contact_id", side.id).eq("update_type", "closing_watchtower").maybeSingle()
      if (card) cleanup.push({ table: "transparency_updates", id: (card as any).id })
      check(`portal: ${side.who} card pushed (visible, update_type 'closing_watchtower')`,
        (card as any)?.is_visible_to_client === true)
      check(`portal: ${side.who} card plain language names the change + asks nothing`,
        ((card as any)?.plain_language_summary ?? "").includes("Appraisal slipped 11 days") &&
        ((card as any)?.plain_language_summary ?? "").includes("Nothing is needed from you"))
      check(`portal: ${side.who} card metadata carries the move (prev → new) + severity + binding step`,
        (card as any)?.metadata?.moves?.[0]?.previous_date === prevAppraisal &&
        (card as any)?.metadata?.moves?.[0]?.new_date === newAppraisal &&
        !!(card as any)?.metadata?.severity && !!(card as any)?.metadata?.binding_step)
    }

    // Idempotency — rerun inside the window: same move-set, no new alert, no new cards
    // (the portal card's daily window collapses repeat pushes).
    const r2 = await runClosingWatchtower(brokerageId, { copyGenerator: async () => null }, svc)
    check("idempotency: rerun proposes nothing new and pushes no duplicate cards",
      r2.alertsProposed === 0 && r2.portalCardsPushed === 0, JSON.stringify(r2))
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
