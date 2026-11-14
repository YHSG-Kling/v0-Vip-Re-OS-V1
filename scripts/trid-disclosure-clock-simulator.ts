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
  // WAVE 153 (lane 153C) — CORRECTED: the CD rule is RECEIPT + three PRECISE business days (Saturdays count). For a Friday close the
  // buyer must receive it by TUESDAY (Tue → Wed, Thu, Fri). The old assertion pinned Wednesday — the one-day-early inclusive count.
  check("CD due-by for a Fri close is the prior TUESDAY (receipt + 3 precise business days)", closingDisclosureDueBy("2026-06-12") === "2026-06-09", closingDisclosureDueBy("2026-06-12"))
  check("businessDaysUntil future is positive, past is negative", businessDaysUntil("2026-06-15", "2026-06-18") === 3 && businessDaysUntil("2026-06-18", "2026-06-15") === -3)

  // FEDERAL-HOLIDAY awareness — the safety-critical fix. A business-day count
  // spanning a holiday must SKIP it (the old code miscounted holidays as days and
  // could call a too-late CD "compliant"). Juneteenth is 2026-06-19; MLK is 2026-01-19.
  check("Juneteenth excluded: Fri 6/19→Mon 6/22 = 1 business day (Mon only)", businessDaysInclusive("2026-06-19", "2026-06-22") === 1)
  check("CD due-by for a Fri 6/19 (Juneteenth) close is Mon 6/15 (a Tue 6/16 receipt reaches Wed, Thu, then skips the holiday to Sat 6/20)", closingDisclosureDueBy("2026-06-19") === "2026-06-15", closingDisclosureDueBy("2026-06-19"))
  check("MLK Day excluded: Fri 1/16→Tue 1/20 = 2 business days (Fri+Tue)", businessDaysInclusive("2026-01-16", "2026-01-20") === 2)

  // AT_RISK: close Fri 6/12, receipt due Tue 6/9 (wave 153: receipt-based), today Mon 6/8 (1 business day left), not received.
  const atRisk = computeTridClock({ today: "2026-06-08", scheduledCloseDate: "2026-06-12" })
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
  // OK: received Mon 6/15 for a THURSDAY 6/18 close (CFPB comment 19(f)(2)(i)-1: received Monday, consummation Thursday).
  const ok = computeTridClock({ today: "2026-06-16", scheduledCloseDate: "2026-06-18", closingDisclosureDeliveredDate: "2026-06-15" })
  check("CD received Monday for a Thursday close → ok (the CFPB's own example)", ok.deadlines.find((d) => d.kind === "closing_disclosure")!.status === "ok")
  // CORRECTED (wave 153): received Mon 6/15 for a WEDNESDAY 6/17 close is a violation — the old inclusive count called it compliant.
  const oldOk = computeTridClock({ today: "2026-06-16", scheduledCloseDate: "2026-06-17", closingDisclosureDeliveredDate: "2026-06-15" })
  check("CD received Monday for a WEDNESDAY close → violation (the old inclusive count's one-day-early answer is gone)", oldOk.deadlines.find((d) => d.kind === "closing_disclosure")!.status === "violation"
    // positive control: the defect's own measure still reads ≥ 3, so this discriminates the rule, not the calendar
    && businessDaysInclusive("2026-06-15", "2026-06-17") >= 3)

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

  await wave153ReceiptLayers()

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

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// WAVE 153 (lane 153C) — TRID FROM THE LENDER: receipt, not a typed date; the precise calendar; the coaching moment.
// Layers 1b–1d are PURE; Layer 1e drives the ONE writer (recordTridReceiptEvidence) and the summary (syncTridSummary) on the
// in-memory client — SIMULATED, never live. Layer 1f scans STRIPPED source for the closed doors and the m905 vocabulary mirror.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function wave153ReceiptLayers() {
  const T = await import("../lib/compliance/trid-disclosure-clock")
  const { readFileSync } = await import("node:fs")
  const { stripComments, blankStrings } = await import("./strip-comments")
  const { memSupabase } = await import("./in-memory-supabase")

  console.log("\n[Layer 1b · the precise calendar (1026.2(a)(6)) + receipt (1026.19(f)(1)(ii)–(iii))]")
  check("received Mon 6/15 → earliest closing Thu 6/18 (comment 19(f)(2)(i)-1)", T.earliestConsummationDate("2026-06-15") === "2026-06-18", T.earliestConsummationDate("2026-06-15"))
  check("received Thu 11/19 → earliest Mon 11/23 (SATURDAY counts, Sunday does not)", T.earliestConsummationDate("2026-11-19") === "2026-11-23", T.earliestConsummationDate("2026-11-19"))
  check("received Thu 6/18 → earliest Tue 6/23 (Fri 6/19 Juneteenth skipped; Sat 6/20 counts)", T.earliestConsummationDate("2026-06-18") === "2026-06-23", T.earliestConsummationDate("2026-06-18"))
  check("received Wed 11/25 → earliest Mon 11/30 (Thanksgiving skipped, Sat counts)", T.earliestConsummationDate("2026-11-25") === "2026-11-30", T.earliestConsummationDate("2026-11-25"))
  check("July 4 2026 is a SATURDAY: the observed Fri 7/3 IS a business day, Sat 7/4 is not (comment 2(a)(6)-2) — received Thu 7/2 → Tue 7/7", T.earliestConsummationDate("2026-07-02") === "2026-07-07", T.earliestConsummationDate("2026-07-02"))
  check("a SUNDAY holiday observed Monday (Jan 1 2023 → Mon 1/2): that Monday is treated as NOT a business day (the safe answer) — received Fri 12/30/2022 → Wed 1/4/2023", T.earliestConsummationDate("2022-12-30") === "2023-01-04", T.earliestConsummationDate("2022-12-30"))
  const emailed = T.effectiveReceiptDate({ deliveryMethod: "email", deliveredOn: "2026-06-08", receivedOn: null, evidence: "mailbox_rule" })
  check("MAILBOX RULE: emailed Mon 6/8 with no receipt evidence → deemed received Thu 6/11 (comment 19(f)(1)(iii)-2)", emailed.date === "2026-06-11" && emailed.basis === "deemed_mailbox_rule", JSON.stringify(emailed))
  const mailedHoliday = T.effectiveReceiptDate({ deliveryMethod: "mail", deliveredOn: "2026-06-18", receivedOn: null, evidence: "mailbox_rule" })
  check("mailed Thu 6/18 → deemed Tue 6/23 (the holiday is skipped, Saturday counts)", mailedHoliday.date === "2026-06-23", JSON.stringify(mailedHoliday))
  const handed = T.effectiveReceiptDate({ deliveryMethod: "in_person", deliveredOn: "2026-06-15", receivedOn: null, evidence: "in_person_delivery" })
  check("in person → received the day it was handed over", handed.date === "2026-06-15" && handed.basis === "in_person")
  const actual = T.effectiveReceiptDate({ deliveryMethod: "email", deliveredOn: "2026-06-08", receivedOn: "2026-06-09", evidence: "consumer_acknowledged_receipt" })
  check("evidence of an earlier ACTUAL receipt is used when the lender names it (Tue 6/9, not the deemed Thu 6/11)", actual.date === "2026-06-09" && actual.basis === "actual_receipt")
  const sigOnly = T.effectiveReceiptDate({ deliveryMethod: "email", deliveredOn: "2026-06-08", receivedOn: "2026-06-08", evidence: "mailbox_rule" })
  check("A SIGNATURE / unnamed date is NOT receipt: a receipt date without named evidence still reads as deemed (6/11)", sigOnly.date === "2026-06-11" && sigOnly.basis === "deemed_mailbox_rule")
  check("no delivery and no receipt → no date (never a guessed receipt)", T.effectiveReceiptDate({ deliveryMethod: "email", deliveredOn: null, receivedOn: null, evidence: "mailbox_rule" }).date === null)
  check("the receipt day is the BUYER's local day: 03:30Z on 6/16 is 6/15 in Los Angeles, 6/16 in UTC terms", T.localReceiptDay("2026-06-16T03:30:00Z", "America/Los_Angeles") === "2026-06-15" && T.localReceiptDay("2026-06-16T03:30:00Z", "Europe/London") === "2026-06-16")
  check("an unreadable time zone reads as null (refused at the door), never a default day", T.localReceiptDay("2026-06-16T03:30:00Z", "Not/AZone") === null)
  check("the form's wall clock round-trips: 8:30 pm 6/15 in Los Angeles is 03:30Z 6/16 (DST-correct)", T.zonedWallTimeToInstant("2026-06-15T20:30", "America/Los_Angeles") === "2026-06-16T03:30:00.000Z", String(T.zonedWallTimeToInstant("2026-06-15T20:30", "America/Los_Angeles")))

  console.log("\n[Layer 1c · the APR tolerance is the LENDER's classification (1026.22(a)(2)–(4)) — never a single hard-coded band]")
  const apr = (p: number | null, c: number | null, r: string | null) => T.aprRevisionVerdict({ previous: p, current: c, regularity: r }).verdict
  check("+0.05 → within both tolerances", apr(6.5, 6.55, null) === "within_tolerance")
  check("+0.20 with NO lender classification → the lender must classify (not decided)", apr(6.5, 6.7, null) === "lender_must_classify")
  check("+0.20, lender says REGULAR → beyond the 1/8 tolerance", apr(6.5, 6.7, "regular") === "beyond_tolerance")
  check("+0.20, lender says IRREGULAR → within the 1/4 tolerance", apr(6.5, 6.7, "irregular") === "within_tolerance")
  check("+0.40 → beyond BOTH tolerances (the lender still confirms)", apr(6.5, 6.9, null) === "beyond_tolerance" && T.aprRevisionVerdict({ previous: 6.5, current: 6.9, regularity: null }).basis === "beyond_both")
  check("−0.20 → lender review (an overstated finance charge can still be accurate, 1026.22(a)(4))", apr(6.7, 6.5, "regular") === "decrease_lender_review")
  check("an APR not stated on both → unknown (never reconstructed)", apr(null, 6.7, "regular") === "unknown")

  console.log("\n[Layer 1d · readiness from the receipt ledger — never a TRID-ready built from a guess]")
  let seq = 0
  const rec = (o: Partial<import("../lib/compliance/trid-disclosure-clock").TridReceiptRecord>): import("../lib/compliance/trid-disclosure-clock").TridReceiptRecord => ({
    id: `r${++seq}`, version: 1, supersedesId: null, verification: "lender_confirmed", source: "lender_portal", deliveryMethod: "electronic_portal",
    deliveredOn: null, receivedOn: "2026-06-15", evidence: "lender_esign_receipt", revisionChanges: [], aprPrevious: null, aprCurrent: null,
    regularity: null, lenderNewWaitDetermination: null, issuerName: "Acme Mortgage", createdAt: `2026-06-0${Math.min(9, seq)}T00:00:00Z`, ...o,
  })
  const ready = (o: Partial<Parameters<typeof T.assessTridReadiness>[0]>) => T.assessTridReadiness({ financing: "financed", tridTracked: true, today: "2026-06-16", scheduledCloseDate: "2026-06-26", receipts: [], draftOnFile: false, lenderOnPlatform: true, ...o })
  const cash = ready({ financing: "cash", tridTracked: false })
  check("CASH closing → not a TRID closing, nothing held (the settlement statement governs)", cash.state === "not_applicable" && cash.readyToConsummateToday === true && !cash.applicable)
  check("financing not recorded → undetermined, NOT ready", ready({ financing: null, tridTracked: false }).state === "undetermined" && !ready({ financing: null, tridTracked: false }).readyToConsummateToday)
  const off = ready({ lenderOnPlatform: false })
  check("lender OFF the platform, nothing recorded → the COACHING step (verbatim) and not ready", off.state === "awaiting_disclosure" && off.coaching === T.TRID_LENDER_COACHING && !off.readyToConsummateToday)
  const draft = ready({ draftOnFile: true })
  check("a CD DRAFT UPLOAD starts nothing → draft_only, not ready", draft.state === "draft_only" && !draft.readyToConsummateToday && draft.governing === null)
  const reported = ready({ lenderOnPlatform: false, receipts: [rec({ verification: "pending_lender_confirmation", source: "agent_reported", evidence: "lender_statement" })] })
  check("an AGENT-REPORTED receipt → pending_lender_confirmation, no governing receipt, not ready (shown, never counted)", reported.state === "pending_lender_confirmation" && reported.governing === null && reported.reportedPending?.reportedReceiptDate === "2026-06-15" && !reported.readyToConsummateToday)
  const running = ready({ receipts: [rec({})] })
  check("lender-confirmed receipt Mon 6/15, today Tue 6/16 → the waiting period is running (earliest Thu 6/18), close on track", running.state === "waiting_period_running" && running.governing?.earliestConsummationDate === "2026-06-18" && running.onTrackForScheduledClose === true && !running.readyToConsummateToday)
  check("the same on Thu 6/18 → ready", ready({ receipts: [rec({})], today: "2026-06-18" }).state === "ready" && ready({ receipts: [rec({})], today: "2026-06-18" }).readyToConsummateToday)
  check("a closing scheduled BEFORE the earliest day → held with the date to move to", ready({ receipts: [rec({})], scheduledCloseDate: "2026-06-17" }).state === "closing_before_earliest_date" && ready({ receipts: [rec({})], scheduledCloseDate: "2026-06-17" }).nextAction.includes("2026-06-18"))
  const v1 = rec({ id: "v1", createdAt: "2026-06-15T00:00:00Z" })
  const aprWait = ready({ receipts: [v1, rec({ id: "v2", version: 2, receivedOn: "2026-06-17", revisionChanges: ["apr_changed"], aprPrevious: 6.5, aprCurrent: 6.9, createdAt: "2026-06-17T00:00:00Z" })], scheduledCloseDate: "2026-06-30" })
  check("APR beyond tolerance on revision v2 (received Wed 6/17) → a NEW wait runs from v2: earliest Mon 6/22 (Juneteenth skipped)", aprWait.governing?.version === 2 && aprWait.governing?.earliestConsummationDate === "2026-06-22", JSON.stringify(aprWait.governing))
  const product = ready({ receipts: [v1, rec({ id: "v2p", version: 2, receivedOn: "2026-06-17", revisionChanges: ["loan_product_changed"], createdAt: "2026-06-17T00:00:00Z" })] })
  check("loan product changed → new wait (v2 governs)", product.governing?.version === 2)
  const ordinary = ready({ receipts: [v1, rec({ id: "v2o", version: 2, receivedOn: "2026-06-17", revisionChanges: ["other_terms"], createdAt: "2026-06-17T00:00:00Z" })] })
  check("an ORDINARY revision (other terms only) → corrected CD, NO restart: v1 still governs (earliest 6/18)", ordinary.governing?.version === 1 && ordinary.governing?.earliestConsummationDate === "2026-06-18")
  const band = (extra: Partial<import("../lib/compliance/trid-disclosure-clock").TridReceiptRecord>) => ready({ receipts: [v1, rec({ id: "v2b", version: 2, receivedOn: "2026-06-17", revisionChanges: ["apr_changed"], aprPrevious: 6.5, aprCurrent: 6.7, createdAt: "2026-06-17T00:00:00Z", ...extra })] })
  check("APR +0.20 with no lender classification → ESCALATED to the lender, not ready", band({}).state === "escalated_to_lender" && !band({}).readyToConsummateToday)
  check("…the lender states IRREGULAR → within tolerance, no restart (v1 governs)", band({ regularity: "irregular" }).governing?.version === 1 && band({ regularity: "irregular" }).state !== "escalated_to_lender")
  check("…the lender determines a NEW WAIT → v2 governs", band({ lenderNewWaitDetermination: "new_wait_required" }).governing?.version === 2)
  const pendingRev = ready({ receipts: [v1, rec({ id: "v2r", version: 2, verification: "pending_lender_confirmation", source: "agent_reported", createdAt: "2026-06-17T00:00:00Z" })] })
  check("a REPORTED revision the lender has not confirmed → not ready (it may restart the wait)", pendingRev.state === "pending_lender_confirmation" && !pendingRev.readyToConsummateToday && pendingRev.governing?.version === 1)
  const verified = ready({ lenderOnPlatform: false, receipts: [rec({ id: "rep", verification: "pending_lender_confirmation", source: "agent_reported" }), rec({ id: "ver", supersedesId: "rep", source: "compliance_verified" })] })
  check("a compliance VERIFICATION superseding the report → lender-confirmed governs; coaching ends", verified.state === "waiting_period_running" && verified.governing?.id === "ver" && verified.coaching === null)
  check("a REJECTED row is never counted", ready({ receipts: [rec({ verification: "rejected" })] }).state === "awaiting_disclosure")

  console.log("\n[Layer 1e · SIMULATED — the ONE writer, the summary, the coaching task, the computed compliance row (in-memory client)]")
  const B1 = "brk-1", B2 = "brk-2"
  const U_AGENT = "u-agent", U_LENDER = "u-lender", U_COMP = "u-comp"
  const txn = (id: string, o: Record<string, unknown>) => ({ id, brokerage_id: B1, agent_id: "a-1", coordinator_id: null, status: "under_contract", stage: "CLOSING_PREP", deal_type: "buyer", financing_type: "conventional", close_date: "2026-06-26", ...o })
  const trid = (id: string, status = "pending") => ({ id: `cl-${id}`, transaction_id: id, brokerage_id: B1, check_type: "trid_timing", check_label: "TRID Timing Verified", status, is_blocking: true })
  const seed = {
    transactions: [txn("t1", { close_date: "2026-06-23" }), txn("t2", { financing_type: "cash" }), txn("t3", { brokerage_id: B2 }), txn("t4", {}), txn("t5", {}), txn("t6", {})],
    agents: [{ id: "a-1", user_id: U_AGENT, brokerage_id: B1, team_id: null }],
    users: [{ id: U_AGENT, brokerage_id: B1, user_type: "agent" }, { id: U_COMP, brokerage_id: B1, user_type: "compliance_officer" }, { id: U_LENDER, brokerage_id: B1, user_type: "vendor" }],
    vendors: [{ id: "l-1", name: "Acme Mortgage", category: "lender", brokerage_id: B1 }, { id: "v-title", name: "Clear Title", category: "title", brokerage_id: B1 }],
    vendor_assignments: [{ id: "va-1", vendor_id: "l-1", transaction_id: "t1", brokerage_id: B1, status: "confirmed" }, { id: "va-2", vendor_id: "v-title", transaction_id: "t1", brokerage_id: B1, status: "confirmed" }],
    user_role_assignments: [{ id: "ura-1", user_id: U_LENDER, vendor_id: "l-1", role: "vendor", brokerage_id: null }],
    transaction_documents: [{ id: "d-cd-draft", transaction_id: "t1", brokerage_id: B1, doc_type: "closing_disclosure" }, { id: "d-conf", transaction_id: "t4", brokerage_id: B1, doc_type: "lender_correspondence" }, { id: "d-other", transaction_id: "t1", brokerage_id: B1, doc_type: "lender_correspondence" }],
    transaction_compliance_log: [trid("t1"), trid("t2"), trid("t4"), trid("t5", "pass"), trid("t6", "waived")],
    trid_timeline: [] as Record<string, unknown>[], trid_disclosure_receipts: [] as Record<string, unknown>[], transaction_tasks: [] as Record<string, unknown>[], agent_action_ledger: [] as Record<string, unknown>[],
  }
  const svc = memSupabase(seed, { stampCreatedAt: true, uuidIds: true, unique: { trid_disclosure_receipts: [["transaction_id", "idempotency_key"]], agent_action_ledger: [["idempotency_key"]], trid_timeline: [["transaction_id"]] } })
  const E = await import("../lib/compliance/trid-disclosure-clock-evidence")
  const row = (table: string, pred: (r: Record<string, any>) => boolean) => (svc.tables[table] ?? []).filter(pred)
  const tridRow = (t: string) => row("transaction_compliance_log", (r) => r.transaction_id === t && r.check_type === "trid_timing")[0]
  const timeline = (t: string) => row("trid_timeline", (r) => r.transaction_id === t)[0]
  const coaching = (t: string) => row("transaction_tasks", (r) => r.transaction_id === t && r.category === "trid_lender_coaching")

  const s1 = await E.syncTridSummary(svc, { brokerageId: B1, transactionId: "t1", today: "2026-06-16" })
  check("DRAFT UPLOAD ONLY (lender on the platform): draft_only, no timeline mirror, the seeded trid_timing row is HELD (not passed)", s1.ok && s1.readiness.state === "draft_only" && !timeline("t1") && tridRow("t1").status === "needs_review" && tridRow("t1").is_blocking === true, JSON.stringify(s1.ok ? s1.readiness.state : s1))
  check("…and no coaching task (the lender records it on its own loan file)", coaching("t1").length === 0)

  const s4 = await E.syncTridSummary(svc, { brokerageId: B1, transactionId: "t4", today: "2026-06-16" })
  const task4 = coaching("t4")[0]
  check("LENDER OFF THE PLATFORM: ONE coaching task, assigned to the deal's AGENT (users.id via agents.user_id), carrying the coaching text verbatim", s4.ok && s4.coachingOpened === 1 && task4?.assigned_user_id === U_AGENT && String(task4?.description ?? "").includes(T.TRID_LENDER_COACHING) && task4?.status === "pending")
  const s4b = await E.syncTridSummary(svc, { brokerageId: B1, transactionId: "t4", today: "2026-06-16" })
  check("…a second sweep opens nothing twice (idempotent)", s4b.ok && s4b.coachingOpened === 0 && coaching("t4").length === 1)

  const base4 = { brokerageId: B1, transactionId: "t4", version: 1, issuerName: "Off-Platform Bank", senderRole: "creditor", deliveryMethod: "email", deliveredAt: "2026-06-15T14:00:00-04:00", receivedAt: "2026-06-15T18:00:00-04:00", receiptTimezone: "America/New_York", receiptEvidence: "lender_statement", today: "2026-06-16" }
  const noContact = await E.recordTridReceiptEvidence(svc, { ...base4, actor: { userId: U_AGENT, kind: "agent" } })
  check("an agent's report must name WHO at the lender said it", !noContact.ok && noContact.code === "invalid")
  const agentClass = await E.recordTridReceiptEvidence(svc, { ...base4, lenderContactName: "Pat Lender", regularity: "irregular", actor: { userId: U_AGENT, kind: "agent" } })
  check("an agent cannot state the lender's loan classification / new-wait determination", !agentClass.ok && agentClass.code === "invalid")
  const rep = await E.recordTridReceiptEvidence(svc, { ...base4, lenderContactName: "Pat Lender", lenderContactMethod: "phone", actor: { userId: U_AGENT, kind: "agent" } })
  const repRow = row("trid_disclosure_receipts", (r) => r.transaction_id === "t4")[0]
  check("OFF-PLATFORM AGENT REPORT → stored agent_reported / pending_lender_confirmation; NOT ready; the timeline mirror stays EMPTY", rep.ok && rep.verification === "pending_lender_confirmation" && repRow?.source === "agent_reported" && rep.ok && rep.readiness.state === "pending_lender_confirmation" && !!timeline("t4") && timeline("t4").closing_disclosure_delivered_date == null)
  check("…the trid_timing row stays HELD with the reason, and the coaching task stays OPEN until the lender confirms", tridRow("t4").status === "needs_review" && /reported/i.test(String(tridRow("t4").failure_reason)) && coaching("t4")[0]?.status === "pending")
  const noDoc = await E.recordTridReceiptEvidence(svc, { ...base4, supersedesId: String(repRow.id), actor: { userId: U_COMP, kind: "compliance" } })
  check("compliance cannot verify WITHOUT the lender's written confirmation filed on the deal", !noDoc.ok && noDoc.code === "invalid")
  const wrongDoc = await E.recordTridReceiptEvidence(svc, { ...base4, supersedesId: String(repRow.id), documentId: "d-other", actor: { userId: U_COMP, kind: "compliance" } })
  check("…nor with a document from ANOTHER deal", !wrongDoc.ok && wrongDoc.code === "not_found")
  const ver = await E.recordTridReceiptEvidence(svc, { ...base4, supersedesId: String(repRow.id), documentId: "d-conf", actor: { userId: U_COMP, kind: "compliance" } })
  check("compliance VERIFIES with the lender's written confirmation → lender-confirmed; the clock starts at the 6/15 receipt (earliest Thu 6/18)", ver.ok && ver.verification === "lender_confirmed" && ver.readiness.governing?.earliestConsummationDate === "2026-06-18" && timeline("t4").closing_disclosure_delivered_date === "2026-06-15")
  check("…the trid_timing row PASSES from the ledger and the coaching task SETTLES (completed)", tridRow("t4").status === "pass" && coaching("t4")[0]?.status === "completed")

  const base1 = { brokerageId: B1, transactionId: "t1", version: 1, issuerName: "Acme Mortgage", senderRole: "creditor", deliveryMethod: "electronic_portal", receivedAt: "2026-06-18T10:00:00-04:00", receiptTimezone: "America/New_York", receiptEvidence: "lender_esign_receipt", today: "2026-06-19" }
  const titleAsLender = await E.recordTridReceiptEvidence(svc, { ...base1, actor: { userId: U_LENDER, kind: "lender", lenderVendorId: "v-title" } })
  check("an UNRELATED vendor (the deal's TITLE company posing as the lender) is refused", !titleAsLender.ok && titleAsLender.code === "forbidden")
  const otherTenant = await E.recordTridReceiptEvidence(svc, { ...base1, transactionId: "t3", actor: { userId: U_LENDER, kind: "lender", lenderVendorId: "l-1" } })
  check("the lender on ANOTHER tenant's deal → refused before anything is written (tenant pin)", !otherTenant.ok && otherTenant.code === "not_found" && row("trid_disclosure_receipts", (r) => r.transaction_id === "t3").length === 0)
  const len = await E.recordTridReceiptEvidence(svc, { ...base1, actor: { userId: U_LENDER, kind: "lender", lenderVendorId: "l-1" } })
  check("ON-PLATFORM LENDER receipt Thu 6/18 (holiday Fri 6/19) → lender-confirmed; earliest closing Tue 6/23; mirror = 6/18; trid_timing passes", len.ok && len.verification === "lender_confirmed" && len.readiness.governing?.earliestConsummationDate === "2026-06-23" && timeline("t1").closing_disclosure_delivered_date === "2026-06-18" && tridRow("t1").status === "pass", JSON.stringify(len.ok ? len.readiness.governing : len))
  check("…the EXISTING close gate reads the mirror on the right day: Mon 6/22 → violation, Tue 6/23 → ok (stage-progression step 10's own computeTridClock call)",
    T.computeTridClock({ today: "2026-06-22", scheduledCloseDate: "2026-06-22", closingDisclosureDeliveredDate: "2026-06-18" }).deadlines[0].status === "violation"
    && T.computeTridClock({ today: "2026-06-23", scheduledCloseDate: "2026-06-23", closingDisclosureDeliveredDate: "2026-06-18" }).deadlines[0].status === "ok")
  const again = await E.recordTridReceiptEvidence(svc, { ...base1, actor: { userId: U_LENDER, kind: "lender", lenderVendorId: "l-1" } })
  check("a DOUBLE SUBMIT of the same evidence records ONE row (idempotent)", again.ok && again.replayed === true && row("trid_disclosure_receipts", (r) => r.transaction_id === "t1").length === 1)
  const rev = await E.recordTridReceiptEvidence(svc, { ...base1, version: 2, receivedAt: "2026-06-22T09:00:00-04:00", revisionChanges: ["apr_changed"], aprPrevious: 6.5, aprCurrent: 6.9, today: "2026-06-22", actor: { userId: U_LENDER, kind: "lender", lenderVendorId: "l-1" } })
  check("APR CHANGE beyond tolerance → a NEW wait from the revised CD (Mon 6/22 → Thu 6/25) — later than the 6/23 close, so the close is HELD", rev.ok && rev.readiness.governing?.version === 2 && rev.readiness.governing?.earliestConsummationDate === "2026-06-25" && rev.readiness.state === "closing_before_earliest_date" && tridRow("t1").status === "needs_review", JSON.stringify(rev.ok ? rev.readiness : rev))
  const esc = await E.recordTridReceiptEvidence(svc, { ...base1, version: 3, receivedAt: "2026-06-23T09:00:00-04:00", revisionChanges: ["apr_changed"], aprPrevious: 6.9, aprCurrent: 7.05, today: "2026-06-23", actor: { userId: U_LENDER, kind: "lender", lenderVendorId: "l-1" } })
  check("APR +0.15 with no classification on v3 → ESCALATED to the lender; the mirror is CLEARED so the existing close gate holds too", esc.ok && esc.readiness.state === "escalated_to_lender" && timeline("t1").closing_disclosure_delivered_date == null)
  const cls = await E.recordTridReceiptEvidence(svc, { ...base1, version: 3, receivedAt: "2026-06-23T09:00:00-04:00", revisionChanges: ["apr_changed"], aprPrevious: 6.9, aprCurrent: 7.05, regularity: "irregular", today: "2026-06-23", actor: { userId: U_LENDER, kind: "lender", lenderVendorId: "l-1" } })
  check("…the lender then states IRREGULAR → within the 1/4 tolerance: no restart, v2 still governs (6/25)", cls.ok && cls.readiness.governing?.version === 2 && cls.readiness.state !== "escalated_to_lender" && timeline("t1").closing_disclosure_delivered_date === "2026-06-22")
  const ord = await E.recordTridReceiptEvidence(svc, { ...base4, version: 2, receivedAt: "2026-06-17T10:00:00-04:00", revisionChanges: ["other_terms"], documentId: null, lenderContactName: "Pat Lender", today: "2026-06-18", actor: { userId: U_AGENT, kind: "agent" } })
  check("an ORDINARY revision reported by the agent → pending (it may restart the wait until the lender says) — not ready", ord.ok && ord.readiness.state === "pending_lender_confirmation" && !ord.readiness.readyToConsummateToday)
  const ordRow = row("trid_disclosure_receipts", (r) => r.transaction_id === "t4" && r.disclosure_version === 2)[0]
  const ordVer = await E.recordTridReceiptEvidence(svc, { ...base4, version: 2, receivedAt: "2026-06-17T10:00:00-04:00", revisionChanges: ["other_terms"], supersedesId: String(ordRow?.id), documentId: "d-conf", today: "2026-06-18", actor: { userId: U_COMP, kind: "compliance" } })
  check("…verified: other terms only → corrected CD, NO restart — v1 still governs and closing can happen on 6/18", ordVer.ok && ordVer.readiness.governing?.version === 1 && ordVer.readiness.state === "ready")
  const s2 = await E.syncTridSummary(svc, { brokerageId: B1, transactionId: "t2", today: "2026-06-16" })
  check("CASH DEAL → no TRID: not_applicable, the seeded trid_timing row PASSES (a cash closing is never held for TRID)", s2.ok && s2.readiness.state === "not_applicable" && tridRow("t2").status === "pass")
  const s5 = await E.syncTridSummary(svc, { brokerageId: B1, transactionId: "t5", today: "2026-06-16" })
  check("a HAND-PASSED trid_timing row the ledger contradicts is RE-HELD (no false TRID-ready)", s5.ok && tridRow("t5").status === "needs_review")
  const s6 = await E.syncTridSummary(svc, { brokerageId: B1, transactionId: "t6", today: "2026-06-16" })
  check("an authorized WAIVER (override + reason, 152E's door) stands — the ledger never reverts it", s6.ok && tridRow("t6").status === "waived")
  const refused = memSupabase(seed, { refuse: { trid_disclosure_receipts: "permission denied for table trid_disclosure_receipts" } })
  const rs = await E.syncTridSummary(refused, { brokerageId: B1, transactionId: "t1", today: "2026-06-16" })
  const ri = await E.tridClosingReadinessItem(refused, { brokerageId: B1, transactionId: "t1", today: "2026-06-16" })
  check("a REFUSED ledger read FAILS CLOSED: the sync refuses and the closing item is `unavailable` + blocking (never ready)", !rs.ok && ri.status === "unavailable" && ri.blocking === true)
  const item = await E.tridClosingReadinessItem(svc, { brokerageId: B1, transactionId: "t4", today: "2026-06-18" })
  check("the closing readiness ITEM (for 153D's closing list) reads ready on the verified deal", item.status === "ready" && item.blocking === false && item.key === "trid_closing_disclosure")

  console.log("\n[Layer 1f · stripped-source rules: the typed-date door is closed; one rule everywhere; m905 mirrors the code vocabulary]")
  const code = (p: string) => blankStrings(stripComments(readFileSync(p, "utf8")))
  const plain = (p: string) => stripComments(readFileSync(p, "utf8"))
  const milestoneList = /const TRID_MILESTONES = \[([\s\S]*?)\]/.exec(plain("app/actions/compliance-monitoring.ts"))?.[1] ?? ""
  const findsCd = (list: string) => list.includes("closing_disclosure_delivered_date")
  check("the TRID milestone door no longer admits a typed CD date (positive control: the pre-fix list is detected)", !findsCd(milestoneList) && findsCd(`"loan_application_date", "closing_disclosure_delivered_date"`) && /=== "closing_disclosure_delivered_date"\)\s*\{\s*throw/.test(plain("app/actions/compliance-monitoring.ts")))
  check("the compliance tab offers no CD-date option", !/SelectItem value="closing_disclosure_delivered_date"/.test(plain("app/components/compliance/transaction-compliance-tab.tsx")))
  check("the post-hoc monitor reads the SAME receipt rule (earliestConsummationDate), not the inclusive count", /earliestConsummationDate\(/.test(code("lib/application/compliance-monitoring.ts")) && /function monitorTRIDComplianceService[\s\S]*earliestConsummationDate\(/.test(code("lib/application/compliance-monitoring.ts")))
  check("the daily sweep syncs the ledger summary AND the insurance checkpoint (no new cron)", /syncTridSummary\(/.test(code("lib/compliance/trid-disclosure-clock-runner.ts")) && /syncLenderInsuranceCheckpoint\(/.test(code("lib/compliance/trid-disclosure-clock-runner.ts")))
  const mig = readFileSync("supabase/migrations/m905-trid-disclosure-receipt-evidence.sql", "utf8")
  check("m905 line 1 is the lane stamp (or the APPLIED stamp) and carries no mNNN token", /^-- (WRITTEN, NOT APPLIED \(wave 153, lane 153C\)|── APPLIED LIVE )/.test(mig.split("\n")[0]) && !/\bm\d{3}\b/.test(mig.split("\n")[0]))
  const checkList = (sql: string, constraint: string): string[] => {
    const m = new RegExp(`ADD CONSTRAINT ${constraint}\\s+CHECK \\(([\\s\\S]*?)\\);`).exec(sql)
    return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort() : []
  }
  const same = (a: readonly string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify(b)
  const mirrors: Array<[string, readonly string[]]> = [
    ["trid_disclosure_receipts_delivery_method_check", T.TRID_DELIVERY_METHODS], ["trid_disclosure_receipts_receipt_evidence_check", T.TRID_RECEIPT_EVIDENCE],
    ["trid_disclosure_receipts_source_check", T.TRID_RECEIPT_SOURCES], ["trid_disclosure_receipts_verification_status_check", T.TRID_VERIFICATION_STATUSES],
    ["trid_disclosure_receipts_sender_role_check", T.TRID_SENDER_ROLES], ["trid_disclosure_receipts_transaction_regularity_check", T.TRID_TRANSACTION_REGULARITY],
    ["trid_disclosure_receipts_lender_new_wait_determination_check", T.TRID_NEW_WAIT_DETERMINATIONS], ["trid_disclosure_receipts_revision_changes_check", T.TRID_REVISION_CHANGES],
  ]
  const drift = mirrors.filter(([c, list]) => !same(list, checkList(mig, c))).map(([c]) => c)
  check(`m905's eight CHECK vocabularies equal their ONE code constant (${mirrors.length} compared)`, drift.length === 0, drift.join(", "))
  check("…positive control: a CHECK missing one literal is detected as drift", !same(T.TRID_RECEIPT_SOURCES, checkList(mig.replace("'compliance_verified'", "'x_removed'"), "trid_disclosure_receipts_source_check")))
  check("m905 refuses an agent / TC report stored as lender-confirmed (the database says it too)", /source NOT IN \('agent_reported', 'tc_reported'\) OR verification_status <> 'lender_confirmed'/.test(mig))
}

main().catch((e) => { console.error(e); process.exit(1) })
