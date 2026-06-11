#!/usr/bin/env tsx
/**
 * scripts/fire-drill-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * FIRE DRILLS (the 9pm save) harness — uncovered deadlines convene the managers.
 *
 * Layer 1 (pure): detectUncoveredDeadlines — a fire is contingency LIVE + deadline in
 *   window + prerequisite MISSING (covered/removed/out-of-window deals are NOT fires);
 *   composeFireDrill — save plan names the bench inspector + loan officer only when
 *   they actually exist (no fabricated people).
 * Layer 2 (live, gated): seed an under-contract deal with financing due tomorrow and
 *   NO clear-to-close, run runFireDrills with an INJECTED synthesizer (vendor seam —
 *   no TTS spend), assert the CRITICAL agent briefing + the client-calming draft in
 *   the gate + the consumed bus audit line + 24h idempotency. Self-cleans.
 *
 * Run: npx tsx scripts/fire-drill-simulator.ts  (npm run test:fire-drill)
 */
import { detectUncoveredDeadlines, composeFireDrill, runFireDrills } from "../lib/kernel/fire-drills"
import type { WhisperSynthesizer } from "../lib/intelligence/appointment-whisper"

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
  console.log(" ✅ Fire Drills (the 9pm save) verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Fire Drills (the 9pm save) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · detect + compose]")
  const now = new Date("2026-06-11T21:00:00Z") // the 9pm save
  const tomorrow = "2026-06-12"
  const nextWeek = "2026-06-18"
  const base = {
    inspectionDeadline: null, appraisalDeadline: null, financingDeadline: null,
    inspectionContingencyRemoved: false, appraisalContingencyRemoved: false, financingContingencyRemoved: false,
    inspectionScheduled: false, appraisalOrdered: false, appraisalCompleted: false, clearToClose: false,
  }
  const fire = detectUncoveredDeadlines({ ...base, financingDeadline: tomorrow }, now)
  check("UNCOVERED financing due tomorrow → FIRE", fire.length === 1 && fire[0].kind === "financing")
  check("fire names the gap (no clear-to-close)", fire[0]?.gap.includes("no clear-to-close"))
  const covered = detectUncoveredDeadlines({ ...base, financingDeadline: tomorrow, clearToClose: true }, now)
  check("COVERED deadline (clear-to-close in hand) → NOT a fire", covered.length === 0)
  const removed = detectUncoveredDeadlines({ ...base, financingDeadline: tomorrow, financingContingencyRemoved: true }, now)
  check("contingency already removed → NOT a fire", removed.length === 0)
  const far = detectUncoveredDeadlines({ ...base, financingDeadline: nextWeek }, now)
  check("deadline outside the 48h window → NOT a fire (yet)", far.length === 0)
  const multi = detectUncoveredDeadlines({ ...base, financingDeadline: tomorrow, inspectionDeadline: tomorrow }, now)
  check("two uncovered deadlines → two threats in one drill", multi.length === 2)

  const composedFull = composeFireDrill({
    dealName: "123 Maple St", clientName: "Jordan",
    threats: multi,
    knowledge: { inspectorCandidate: "Ace Inspections", loanOfficer: "Pat Lender" },
  })
  check("save plan: names the bench inspector + loan officer", composedFull.agentBrief.includes("Ace Inspections") && composedFull.agentBrief.includes("Pat Lender"))
  check("save plan: every threat gets gap + save lines", composedFull.agentBrief.includes("INSPECTION due") && composedFull.agentBrief.includes("FINANCING due") && composedFull.agentBrief.includes("The save:"))
  check("client note: calm, no alarm, approval-gated framing", composedFull.clientBody.includes("Nothing is needed from you") && composedFull.agentBrief.includes("nothing sends until you approve"))
  const composedSparse = composeFireDrill({
    dealName: "9 Elm", clientName: null, threats: fire,
    knowledge: { inspectorCandidate: null, loanOfficer: null },
  })
  check("sparse knowledge → NO fabricated people", !composedSparse.agentBrief.includes("Asset Manager:") && !composedSparse.agentBrief.includes("lender contact is"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live drill]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__firedrill_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id

    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Drill", last_name: TAG,
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })

    const dueTomorrow = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10)
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} 123 Maple St`, client_name: "Drill Client",
      status: "under_contract", agent_id: (agent as any).id, buyer_contact_id: (con as any).id,
      financing_deadline: dueTomorrow,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })
    const { data: lend } = await svc.from("transaction_lenders").insert({
      transaction_id: (txn as any).id, brokerage_id: brokerageId,
      lender_name: `${TAG} Bank`, loan_officer_name: "Pat Lender",
    }).select("id").single()
    cleanup.push({ table: "transaction_lenders", id: (lend as any).id })

    // Injected synthesizer — the vendor seam; never spends TTS credits.
    const synthesizer: WhisperSynthesizer = async () => null // null → text briefing
    const r1 = await runFireDrills(brokerageId, { synthesizer }, svc)
    check("drill: detected the uncovered financing deadline", r1.drills >= 1 && r1.threats >= 1)

    const { data: notif } = await svc.from("notifications").select("id, title, body, priority")
      .eq("user_id", agentUserId).eq("type", "fire_drill").eq("entity_id", (txn as any).id).maybeSingle()
    if (notif) cleanup.push({ table: "notifications", id: (notif as any).id })
    check("briefing: CRITICAL priority to the agent", (notif as any)?.priority === "critical")
    check("briefing: carries the gap + the save + the loan officer by name",
      ((notif as any)?.body ?? "").includes("no clear-to-close") && ((notif as any)?.body ?? "").includes("Pat Lender"))

    const { data: draft } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, rationale, body").eq("entity_id", (txn as any).id)
      .eq("agent_kind", "deal_coordinator").eq("status", "proposed").maybeSingle()
    if (draft) cleanup.push({ table: "agent_client_messages", id: (draft as any).id })
    check("gate: client-calming draft proposed (deal_coordinator, buyer, NOT sent)", !!draft && (draft as any).audience === "buyer")
    check("gate: rationale records the fire drill", ((draft as any)?.rationale ?? "").includes("FIRE DRILL"))
    if (draft) {
      const { data: rtN } = await svc.from("notifications").select("id").eq("entity_id", (draft as any).id).eq("type", "approval_needed").maybeSingle()
      if (rtN) cleanup.push({ table: "notifications", id: (rtN as any).id })
    }

    const { data: sig } = await svc.from("manager_signals").select("id, status, consumed_action")
      .eq("entity_id", (txn as any).id).eq("signal_type", "fire_drill_opened").maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
    check("bus: audit line published and consumed inline (no dangling open business)",
      (sig as any)?.status === "consumed" && ((sig as any)?.consumed_action ?? "").includes("fire drill executed"))

    // Idempotency — one drill per transaction per 24h.
    const r2 = await runFireDrills(brokerageId, { synthesizer }, svc)
    check("idempotency: second run drills nothing for the same deal", r2.drills === 0)
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
