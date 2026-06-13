#!/usr/bin/env tsx
/**
 * scripts/closing-war-room-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * CLOSING-DAY WAR ROOM harness — the Deal Coordinator's final-mile cockpit: every
 * clear-to-close CONDITION with an honest status, the REUSED date-chain critical
 * path, wire/EMD confirmation, and the open-items drive-to-done list.
 *
 * Layer 1 (pure): conditionStatus (date/status/boolean → done|open|unknown; NO
 *   signal → 'unknown', never fabricated done); closingReadiness (all required
 *   conditions met → ready; a missing CTC/signature/doc → blocker listed; an
 *   'unknown' required condition is itself a blocker → never ready on unverified
 *   data); daysToClose / inClosingWindow; buildConditions over real-shaped signals;
 *   assembleOpenItems (unmet conditions + tasks + pending-actions, severity-ordered).
 * Layer 2 (live, guarded): seed an under-contract deal closing inside the window +
 *   the full milestone chain (some completed, one open) + a lender row WITHOUT a
 *   clear-to-close + a title/escrow row (EM received, closing NOT scheduled) +
 *   an open transaction_task; run loadClosingWarRoom; assert the conditions, the
 *   blockers (lender CTC + wire/closing + the open financing chain step), and the
 *   critical path are surfaced FROM REAL ROWS; reverse-delete + verify cleanup == 0.
 *
 * Run: npx tsx scripts/closing-war-room-simulator.ts  (npm run test:closing-war-room)
 */
import {
  conditionStatus,
  closingReadiness,
  daysToClose,
  inClosingWindow,
  buildConditions,
  assembleOpenItems,
  WAR_ROOM_CONDITION_KEYS,
  type WarRoomSignals,
  type WarRoomCondition,
} from "../lib/kernel/closing-war-room"
import { buildDateChain } from "../lib/kernel/title-closing-watchtower"

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
  console.log(" ✅ Closing-Day War Room verified — honest conditions + readiness/blockers + critical path + open items")
  console.log("CLOSING_WAR_ROOM_PASS")
}

function findCond(conds: WarRoomCondition[], key: (typeof WAR_ROOM_CONDITION_KEYS)[number]): WarRoomCondition {
  return conds.find((c) => c.key === key)!
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Closing-Day War Room simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · conditionStatus + readiness + window + open items]")

  const now = new Date("2026-06-13T15:00:00Z")
  const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10)

  // conditionStatus — the honest trichotomy.
  check("conditionStatus: a present date → done",
    conditionStatus({ date: "2026-06-01", present: true }) === "done")
  check("conditionStatus: a recognized done-status → done",
    conditionStatus({ statusValue: "clear_to_close", doneValues: ["clear_to_close", "funded"], present: true }) === "done")
  check("conditionStatus: a present-but-not-done status → open",
    conditionStatus({ statusValue: "in_underwriting", doneValues: ["clear_to_close"], present: true }) === "open")
  check("conditionStatus: source present, no value → open (not fabricated done)",
    conditionStatus({ present: true }) === "open")
  check("conditionStatus: NO source/signal → unknown (never done)",
    conditionStatus({}) === "unknown" && conditionStatus({ date: null }) === "unknown")
  check("conditionStatus: explicit boolean true/false → done/open",
    conditionStatus({ done: true }) === "done" && conditionStatus({ done: false }) === "open")

  // daysToClose / window.
  check("daysToClose: whole-day math + null when no date",
    daysToClose(day(5), now) === 5 && daysToClose(null, now) === null)
  check("inClosingWindow: within 14d → in; 30d out → out; no date → out",
    inClosingWindow(day(5), now) === true && inClosingWindow(day(30), now) === false && inClosingWindow(null, now) === false)
  check("inClosingWindow: keeps a just-slipped closing (1d past) live",
    inClosingWindow(day(-1), now) === true)

  // buildConditions over real-shaped signals — ALL met → ready.
  const allMetSignals: WarRoomSignals = {
    milestones: [
      { milestone_name: "inspection_deadline", target_date: day(-10), status: "completed" },
      { milestone_name: "appraisal_deadline",  target_date: day(-7),  status: "completed" },
      { milestone_name: "financing_deadline",  target_date: day(-3),  status: "completed" },
      { milestone_name: "clear_to_close_received", target_date: day(-1), status: "completed" },
      { milestone_name: "closing_date",         target_date: day(4),   status: "pending" },
    ],
    lender:      { clear_to_close_date: day(-1), underwriting_status: "clear_to_close" },
    titleEscrow: { earnest_money_received_date: day(-20), closing_scheduled_date: day(4) },
    signatures:  [{ esign_status: "fully_signed" }, { esign_status: "fully_signed" }],
    docAudit:    { required_total: 4, missing_blocking: [], missing_warning: [] },
  }
  const allMet = buildConditions(allMetSignals, buildDateChain(allMetSignals.milestones))
  const readyVerdict = closingReadiness(allMet)
  check("readiness: every required condition met → READY, zero blockers",
    readyVerdict.ready === true && readyVerdict.blockers.length === 0, JSON.stringify(readyVerdict))
  check("readiness: doneCount == requiredCount when ready",
    readyVerdict.doneCount === readyVerdict.requiredCount && readyVerdict.requiredCount === WAR_ROOM_CONDITION_KEYS.length)

  // A deal missing CTC + wire + a doc → those exact blockers listed.
  const blockedSignals: WarRoomSignals = {
    milestones: [
      { milestone_name: "inspection_deadline", target_date: day(-10), status: "completed" },
      { milestone_name: "appraisal_deadline",  target_date: day(-7),  status: "completed" },
      { milestone_name: "financing_deadline",  target_date: day(2),   status: "pending" }, // open
      { milestone_name: "closing_date",         target_date: day(5),   status: "pending" },
    ],
    lender:      { clear_to_close_date: null, underwriting_status: "in_underwriting" },     // open
    titleEscrow: { earnest_money_received_date: day(-15), closing_scheduled_date: null },   // wire open, EM done
    signatures:  [{ esign_status: "fully_signed" }],
    docAudit:    { required_total: 3, missing_blocking: ["closing_disclosure"], missing_warning: [] }, // open
  }
  const blocked = buildConditions(blockedSignals, buildDateChain(blockedSignals.milestones))
  const blockedVerdict = closingReadiness(blocked)
  check("readiness: NOT ready when CTC / wire / financing / docs are open",
    blockedVerdict.ready === false)
  const blockerKeys = new Set(blockedVerdict.blockers.map((b) => b.key))
  check("blockers: missing lender clear-to-close is a listed blocker",
    blockerKeys.has("lender_clear_to_close") && findCond(blocked, "lender_clear_to_close").status === "open")
  check("blockers: unscheduled wire/closing is a listed blocker",
    blockerKeys.has("wire_closing_scheduled") && findCond(blocked, "wire_closing_scheduled").status === "open")
  check("blockers: open financing chain step is a listed blocker",
    blockerKeys.has("financing") && findCond(blocked, "financing").status === "open")
  check("blockers: missing required doc is a listed blocker",
    blockerKeys.has("required_docs") && findCond(blocked, "required_docs").status === "open")
  check("done conditions are NOT blockers (inspection/appraisal/EM/signatures cleared)",
    !blockerKeys.has("inspection") && !blockerKeys.has("appraisal") && !blockerKeys.has("earnest_money") && !blockerKeys.has("signatures"))

  // UNKNOWN data is honest — never fabricated done, and itself a blocker.
  const unknownSignals: WarRoomSignals = {
    milestones: [{ milestone_name: "closing_date", target_date: day(6), status: "pending" }],
    lender:      null,        // unknown
    titleEscrow: null,        // unknown EM + wire
    signatures:  [],          // unknown
    docAudit:    null,        // unknown
  }
  const unknown = buildConditions(unknownSignals, buildDateChain(unknownSignals.milestones))
  const unknownVerdict = closingReadiness(unknown)
  check("honest unknown: no lender/title/sig/doc rows → those conditions are 'unknown' (never done)",
    findCond(unknown, "lender_clear_to_close").status === "unknown" &&
    findCond(unknown, "earnest_money").status === "unknown" &&
    findCond(unknown, "signatures").status === "unknown" &&
    findCond(unknown, "required_docs").status === "unknown")
  check("honest unknown: an 'unknown' required condition makes the deal NOT ready (blocker)",
    unknownVerdict.ready === false && unknownVerdict.unknownCount >= 4)
  check("honest unknown: missing milestones → inspection/appraisal/financing 'unknown', not done",
    findCond(unknown, "inspection").status === "unknown" && findCond(unknown, "financing").status === "unknown")

  // assembleOpenItems — unmet conditions + tasks + pending-actions, severity-ordered.
  const openItems = assembleOpenItems({
    conditions: blocked,
    tasks: [
      { id: "t1", title: "Order final walkthrough", status: "pending", priority: "high", due_date: day(3), assigned_to: "buyer agent" },
      { id: "t2", title: "Already done", status: "completed", priority: "low", due_date: null, assigned_to: null },
    ],
    pendingActions: [
      { id: "p1", headline: "Wire instructions not finalised", severity: "urgent", due_date: day(5), suggested_recipient: "title", status: "open" },
    ],
  })
  check("open items: unmet conditions + open task + open pending-action assembled (completed task excluded)",
    openItems.some((i) => i.source === "condition") &&
    openItems.some((i) => i.id === "task:t1") &&
    openItems.some((i) => i.id === "pending_action:p1") &&
    !openItems.some((i) => i.id === "task:t2"))
  check("open items: severity-ordered (urgent first)",
    openItems.length > 0 && openItems[0].severity === "urgent")
  check("open items: each carries an owner",
    openItems.every((i) => typeof i.owner === "string" && i.owner.length > 0))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live war room]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live war room]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { loadClosingWarRoom } = await import("../lib/kernel/closing-war-room")
  const svc = createServiceClient()
  const TAG = `WarRoom${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []
  const liveDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // Under-contract deal CLOSING in 6 days → inside the window.
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} 99 Closing Ln`, status: "under_contract",
      agent_id: (agent as any).id, close_date: liveDay(6),
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })

    // Full date chain — inspection/appraisal DONE, financing OPEN, closing pending.
    const chainSeed = [
      { milestone_name: "inspection_deadline",     target_date: liveDay(-12), status: "completed" },
      { milestone_name: "appraisal_deadline",      target_date: liveDay(-8),  status: "completed" },
      { milestone_name: "financing_deadline",      target_date: liveDay(1),   status: "pending" },
      { milestone_name: "clear_to_close_received", target_date: liveDay(3),   status: "pending" },
      { milestone_name: "closing_date",            target_date: liveDay(6),   status: "pending" },
    ]
    for (const m of chainSeed) {
      const { data: ms } = await svc.from("transaction_milestones").insert({
        transaction_id: (txn as any).id, brokerage_id: brokerageId,
        milestone_name: m.milestone_name, target_date: m.target_date, status: m.status,
        is_client_visible: true, created_at: new Date().toISOString(),
      }).select("id").single()
      cleanup.push({ table: "transaction_milestones", id: (ms as any).id })
    }

    // Lender row WITHOUT a clear-to-close (CTC condition → open).
    const { data: lender } = await svc.from("transaction_lenders").insert({
      transaction_id: (txn as any).id, brokerage_id: brokerageId,
      lender_name: `${TAG} Lender`, underwriting_status: "in_underwriting", clear_to_close_date: null,
    }).select("id").single()
    cleanup.push({ table: "transaction_lenders", id: (lender as any).id })

    // Title/escrow — EM RECEIVED, closing NOT scheduled (wire condition → open).
    const { data: title } = await svc.from("transaction_title_escrow").insert({
      transaction_id: (txn as any).id, brokerage_id: brokerageId,
      title_company_name: `${TAG} Title`, earnest_money_received_date: liveDay(-20), closing_scheduled_date: null,
    }).select("id").single()
    cleanup.push({ table: "transaction_title_escrow", id: (title as any).id })

    // An OPEN deal task → surfaces as an open item.
    const { data: task } = await svc.from("transaction_tasks").insert({
      transaction_id: (txn as any).id, brokerage_id: brokerageId,
      title: `${TAG} Confirm final walkthrough`, status: "pending", priority: "high", due_date: liveDay(4),
    }).select("id").single()
    cleanup.push({ table: "transaction_tasks", id: (task as any).id })

    // Load the war room from REAL rows (docAudit checklist not configured → required_docs unknown).
    const wr = await loadClosingWarRoom((txn as any).id, { now: new Date() }, svc)
    check("loader: war room assembled for the seeded deal", !!wr && wr!.transactionId === (txn as any).id)
    check("loader: deal recognized as inside the closing window (closing in 6d)",
      wr!.inWindow === true && wr!.daysToClose !== null && wr!.daysToClose! <= 14)
    check("loader: critical path surfaced from REAL milestone rows (closing date on file)",
      wr!.criticalPath !== null && wr!.criticalPath!.closingDate === liveDay(6) &&
      wr!.criticalPath!.steps.length === 5)

    const condByKey = new Map(wr!.conditions.map((c) => [c.key, c]))
    check("conditions: inspection + appraisal DONE from completed milestones",
      condByKey.get("inspection")?.status === "done" && condByKey.get("appraisal")?.status === "done")
    check("conditions: financing OPEN (pending milestone)",
      condByKey.get("financing")?.status === "open")
    check("conditions: lender clear-to-close OPEN (no CTC date, underwriting in progress)",
      condByKey.get("lender_clear_to_close")?.status === "open")
    check("conditions: earnest money DONE (received date on file)",
      condByKey.get("earnest_money")?.status === "done")
    check("conditions: wire/closing OPEN (no closing_scheduled_date)",
      condByKey.get("wire_closing_scheduled")?.status === "open")
    check("conditions: required docs UNKNOWN (no checklist configured) — never fabricated done",
      condByKey.get("required_docs")?.status === "unknown")

    check("readiness: deal NOT ready, blockers include CTC + wire + financing",
      wr!.readiness.ready === false &&
      wr!.readiness.blockers.some((b) => b.key === "lender_clear_to_close") &&
      wr!.readiness.blockers.some((b) => b.key === "wire_closing_scheduled") &&
      wr!.readiness.blockers.some((b) => b.key === "financing"),
      JSON.stringify(wr!.readiness.blockers.map((b) => b.key)))

    check("open items: the seeded task surfaces + unmet conditions surface",
      wr!.openItems.some((i) => i.id === `task:${(task as any).id}`) &&
      wr!.openItems.some((i) => i.source === "condition"))

    // Honest skip: a deal with NO closing date is out of the window.
    const { data: noClose } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} No Close`, status: "under_contract",
      agent_id: (agent as any).id, close_date: null,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (noClose as any).id })
    const wrNoClose = await loadClosingWarRoom((noClose as any).id, { now: new Date() }, svc)
    check("honest skip: no closing date → inWindow false + null critical path (never fabricated)",
      wrNoClose !== null && wrNoClose!.inWindow === false && wrNoClose!.criticalPath === null)
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
