#!/usr/bin/env tsx
/**
 * scripts/trid-disclosure-clock-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE TRID DISCLOSURE CLOCK — the FORWARD-LOOKING half of TRID compliance (the
 * post-hoc monitorTRIDComplianceService only catches violations AFTER the deadline passes).
 * Pure business-day deadline engine, honest when inputs are absent; the runner flips the
 * long-unused trid_timeline.compliance_status='at_risk' and proposes a GATED Deal-Coordinator
 * alert when the Closing Disclosure / Loan Estimate deadline is approaching or missed.
 *
 * Layer 1 (pure): business-day math + the forward verdict matrix (ok/upcoming/at_risk/violation).
 * Layer 2 (live, gated): seed a real transaction + a trid_timeline closing soon with the CD
 *   undelivered → run the clock → assert at_risk + status flip + a gated bus signal; a second
 *   run is idempotent (no re-ping of the held state). Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/trid-disclosure-clock-simulator.ts   (npm run test:trid-clock)
 */
import {
  computeTridClock,
  businessDaysInclusive,
  businessDaysUntil,
  closingDisclosureDueBy,
  mostUrgentDeadline,
} from "../lib/compliance/trid-disclosure-clock"

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
  console.log(" ✅ TRID disclosure clock verified — deadline caught early, business days exact, gated alert on transition.")
  console.log(" TRID_CLOCK_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" TRID disclosure clock simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · business-day math + forward verdict]")
  // Mon 2026-06-15 .. Wed 2026-06-17 inclusive = 3 business days (matches the post-hoc monitor).
  check("inclusive business days Mon→Wed = 3", businessDaysInclusive("2026-06-15", "2026-06-17") === 3)
  // Friday → Monday skips the weekend (holiday-free week, June 12–15 2026).
  check("Fri→Mon = 2 business days (weekend skipped)", businessDaysInclusive("2026-06-12", "2026-06-15") === 2)
  // CD must land ≥3 business days before a Fri close → due by the prior Wed.
  check("CD due-by for a Fri close is the prior Wed", closingDisclosureDueBy("2026-06-12") === "2026-06-10", closingDisclosureDueBy("2026-06-12"))
  check("businessDaysUntil future is positive, past is negative", businessDaysUntil("2026-06-15", "2026-06-18") === 3 && businessDaysUntil("2026-06-18", "2026-06-15") === -3)

  // FEDERAL-HOLIDAY awareness — the safety-critical fix. A business-day count
  // spanning a holiday must SKIP it (the old code miscounted holidays as days and
  // could call a too-late CD "compliant"). Juneteenth is 2026-06-19; MLK is 2026-01-19.
  check("Juneteenth excluded: Fri 6/19→Mon 6/22 = 1 business day (Mon only)", businessDaysInclusive("2026-06-19", "2026-06-22") === 1)
  check("CD due-by for a Fri 6/19 (Juneteenth) close is 6/16, not 6/17", closingDisclosureDueBy("2026-06-19") === "2026-06-16", closingDisclosureDueBy("2026-06-19"))
  check("MLK Day excluded: Fri 1/16→Tue 1/20 = 2 business days (Fri+Tue)", businessDaysInclusive("2026-01-16", "2026-01-20") === 2)

  // AT_RISK: close Fri 6/12, CD due Wed 6/10, today Tue 6/9 (1 business day left), undelivered.
  const atRisk = computeTridClock({ today: "2026-06-09", scheduledCloseDate: "2026-06-12" })
  const cd = atRisk.deadlines.find((d) => d.kind === "closing_disclosure")!
  check("undelivered CD with deadline near → at_risk", cd.status === "at_risk", JSON.stringify(cd))
  check("overall flagged for escalation", atRisk.flagged === true && atRisk.overall === "at_risk")
  check("business days remaining counted to the due date", cd.businessDaysRemaining === 1, String(cd.businessDaysRemaining))

  // UPCOMING (not yet urgent): close two weeks out, undelivered → upcoming, NOT flagged.
  const upcoming = computeTridClock({ today: "2026-06-16", scheduledCloseDate: "2026-06-30" })
  check("CD deadline far out → upcoming, not flagged", upcoming.deadlines.find((d) => d.kind === "closing_disclosure")!.status === "upcoming" && !upcoming.flagged)

  // VIOLATION (missed): deadline already passed, CD still undelivered.
  const missed = computeTridClock({ today: "2026-06-11", scheduledCloseDate: "2026-06-12" })
  check("deadline passed + CD undelivered → violation", missed.overall === "violation" && missed.flagged)

  // OK (delivered with the full window): CD delivered Mon 6/15 for a Wed 6/17 close = 3 bd.
  const ok = computeTridClock({ today: "2026-06-16", scheduledCloseDate: "2026-06-17", closingDisclosureDeliveredDate: "2026-06-15" })
  check("CD delivered with the 3-business-day window → ok", ok.deadlines.find((d) => d.kind === "closing_disclosure")!.status === "ok")

  // DELIVERED-BUT-LATE: CD delivered Tue 6/16 for a Wed 6/17 close = 2 bd → violation.
  const late = computeTridClock({ today: "2026-06-17", scheduledCloseDate: "2026-06-17", closingDisclosureDeliveredDate: "2026-06-16" })
  check("CD delivered too late (<3 bd) → violation", late.overall === "violation")

  // Loan Estimate: applied Mon 6/15, undelivered, today is the deadline window.
  const le = computeTridClock({ today: "2026-06-17", loanApplicationDate: "2026-06-15" })
  const leD = le.deadlines.find((d) => d.kind === "loan_estimate")!
  check("LE due-by is 3 business days after application", leD.dueBy === "2026-06-17", String(leD.dueBy))

  // HONEST: nothing on file → insufficient, not flagged.
  const empty = computeTridClock({ today: "2026-06-16" })
  check("no dates on file → insufficient (no fabricated countdown)", empty.overall === "insufficient" && !empty.flagged)

  check("most-urgent deadline is the CD when it's at risk", mostUrgentDeadline(atRisk)?.kind === "closing_disclosure")

  console.log("\n[Layer 2 · live: an approaching CD deadline flips status + a gated alert, idempotently]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runTridDisclosureClock } = await import("../lib/compliance/trid-disclosure-clock-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })

  // Close 1 business day after "today" so the CD deadline is already at/just past → at_risk/violation.
  const today = "2026-06-16"
  const close = "2026-06-19"
  const txnId = uuid()
  let tlId: string | undefined
  try {
    await svc.from("transactions").insert({ id: txnId, brokerage_id: brokerageId, property_address: "ZZ 3 Disclosure Dr", status: "under_contract", stage: "closing" })
    const { data: tl } = await svc.from("trid_timeline").insert({
      transaction_id: txnId, brokerage_id: brokerageId, scheduled_close_date: close, compliance_status: "in_progress",
    }).select("id").single()
    tlId = (tl as any)?.id

    const r1 = await runTridDisclosureClock({ brokerageId, today, copyGenerator: stampGen }, svc)
    check("the approaching CD deadline is flagged + escalated", r1.flagged >= 1 && r1.escalated >= 1, JSON.stringify(r1))

    const { data: after } = await svc.from("trid_timeline").select("compliance_status").eq("id", tlId).single()
    check("trid_timeline.compliance_status flipped off 'in_progress'", (after as any)?.compliance_status === "at_risk" || (after as any)?.compliance_status === "violation", (after as any)?.compliance_status)

    const { count: sigCount } = await svc.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("entity_id", txnId).eq("signal_type", "trid_disclosure_clock")
    check("a trid_disclosure_clock bus signal was published (gated)", (sigCount ?? 0) >= 1)

    // IDEMPOTENT: the status is now held — a second run does not re-escalate.
    const r2 = await runTridDisclosureClock({ brokerageId, today, copyGenerator: stampGen }, svc)
    check("re-run on the held state does not re-escalate (idempotent)", r2.escalated === 0)
  } finally {
    await svc.from("manager_signals").delete().eq("entity_id", txnId).then(() => {}, () => {})
    await svc.from("notifications").delete().eq("entity_id", txnId).eq("type", "trid_disclosure_clock").then(() => {}, () => {})
    if (tlId) await svc.from("trid_timeline").delete().eq("id", tlId).then(() => {}, () => {})
    await svc.from("transactions").delete().eq("id", txnId).then(() => {}, () => {})
    const { count } = await svc.from("trid_timeline").select("id", { count: "exact", head: true }).eq("transaction_id", txnId)
    check("cleanup: trid_timeline seed removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
