#!/usr/bin/env tsx
/**
 * scripts/coordination-status-simulator.ts   (npm run test:coordination-status) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COORDINATOR'S OPEN-WORK QUERIES ASKED FOR STATES THAT DO NOT EXIST.
 *
 * Every surface answering "what is still open on this deal?" hand-rolled its own
 * status filter, and five of them named a value the column's CHECK cannot hold.
 * A filter on an impossible value returns zero rows and reads as "nothing
 * outstanding" — the most expensive way to be wrong on a coordination surface,
 * because the failure is indistinguishable from success.
 *
 * NOTHING WAS WIDENED. There is no migration in this cluster. Every defect was a
 * value with no business being stored, so the code moved onto the database's
 * vocabulary rather than the reverse.
 *
 * ── 1. 'in_progress' on two ladders that have no such state ─────────────────
 * Four surfaces filtered milestones and deadlines with
 * `["pending", "in_progress"]`. Neither column admits 'in_progress' and nothing
 * has ever written it. 'pending' still matched, so the lists were not empty —
 * which is exactly why this survived. But the sets were ALSO wrong in a way that
 * HID rows:
 *   · milestones omitted 'overdue' — a milestone explicitly stamped overdue
 *     vanished from the list literally named "incomplete milestones", while the
 *     page recomputed overdue from target_date beneath it.
 *   · deadlines omitted 'extended' — extending a deadline made it disappear from
 *     the upcoming list instead of moving.
 * Verified live: a probe 'overdue' milestone and a probe 'extended' deadline
 * both returned 0 under the old filters and 1 under the new ones.
 *
 * ── 2. 'at_risk' is a risk BAND, not a lifecycle status ─────────────────────
 * The autonomy coaching report counted at-risk deadlines with
 * `.in("status", ["at_risk", "missed"])`. transaction_deadlines.status admits no
 * such value and nothing has ever written it, so that report told every
 * brokerage it had ZERO deadlines at risk, every time, forever. On a governance
 * surface a permanent zero is worse than no number: it reads as an all-clear.
 * The fix is not to invent a state nobody transitions into — it is to derive the
 * band the way every other band in this product is derived. 'missed' is a real
 * stored status and is still counted as stored.
 *
 * ── 3. 'pending' on a document ladder that says 'requested' ─────────────────
 * Both readers of transaction_documents filtered `status = 'pending'`. The
 * writer inserts 'requested'; the ladder is
 * (missing|requested|uploaded|under_review|approved|rejected|pending_signature).
 * The pending-documents COUNT and the pending-documents LIST were always zero
 * and always empty. Open is now the complement of terminal, so a status added
 * later is treated as open by default — the safe direction for a compliance
 * checklist, and the direction that would have prevented this.
 *
 * ── 4. Two e-sign ladders, both misspelled ──────────────────────────────────
 * The client portal's "documents you need to sign" asked for
 * `["sent", "pending", "out_for_signature"]`. Two of those are real, so the list
 * was not empty — again, why nobody noticed. 'out_for_signature' is not a value
 * the ladder has, and the set silently omitted 'viewed' and 'agent_signed': a
 * contact who OPENED the envelope, or whose agent had already signed, dropped
 * off their own to-sign list at the moment they engaged with it.
 *
 * The seller-listing execution engine wrote listing_agreements.esign_status
 * 'executed' — not a value that column admits, on a REQUIRED column of that
 * insert, so the whole insert was rejected and the action returned its error:
 * signing a listing agreement through the execution engine could not record
 * one. The e-sign webhook that completes the very same row already writes
 * 'fully_signed'.
 *
 * ── 5. Two writers that reported success without writing ────────────────────
 * executeWorkflow's update_milestone took an operator-authored newStatus from
 * automations JSON, discarded the result, and incremented execution_count
 * regardless. bulkUpdateMilestones took caller-supplied statuses and returned
 * `updated: results.length` — the ARRAY LENGTH, not the number of rows that
 * moved. supabase-js RESOLVES a rejected write with { error } rather than
 * throwing, so neither ever reached a catch. Both now validate against the
 * ladder first and report what actually happened.
 *
 * VERIFIED LIVE: all six impossible literals raise check_violation; all six
 * corrected literals store; and for each corrected filter the OLD predicate
 * returned 0 rows where the NEW one returns the row. Probes deleted, counts
 * confirmed back to the pre-existing 10 milestones and 0 everywhere else.
 */
import { readFileSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  MILESTONE_STATUSES, MILESTONE_OPEN_STATUSES, isMilestoneStatus,
  DEADLINE_STATUSES, DEADLINE_OPEN_STATUSES, isDeadlineStatus,
  DEADLINE_AT_RISK_WINDOW_DAYS, deadlineAtRisk,
  DOCUMENT_STATUSES, DOCUMENT_OPEN_STATUSES, DOCUMENT_TERMINAL_STATUSES,
  CONTRACT_ESIGN_STATUSES, CONTRACT_ESIGN_AWAITING_STATUSES,
  CONTRACT_ESIGN_SENT_AWAITING_STATUSES, CONTRACT_ESIGN_DONE_STATUSES,
  LISTING_AGREEMENT_ESIGN_STATUSES, LISTING_AGREEMENT_EXECUTED_STATUS,
} from "../lib/transactions/coordination-status"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

/** Every constant here must be a subset of what the live CHECK admits. */
const subsetOf = (vals: readonly string[], live: readonly string[]) =>
  live.length > 0 && vals.every((v) => live.includes(v))

console.log("══════════════════════════════════════════════════")
console.log(" Transaction coordination status (open work is findable)")
console.log("══════════════════════════════════════════════════")

console.log("\n── every declared vocabulary matches the live CHECK exactly ──")
{
  const pairs: Array<[string, readonly string[], readonly string[]]> = [
    ["transaction_milestones.status", MILESTONE_STATUSES, CHECK_VOCABULARIES.transaction_milestones?.status ?? []],
    ["transaction_deadlines.status", DEADLINE_STATUSES, CHECK_VOCABULARIES.transaction_deadlines?.status ?? []],
    ["transaction_documents.status", DOCUMENT_STATUSES, CHECK_VOCABULARIES.transaction_documents?.status ?? []],
    ["contract_signatures.esign_status", CONTRACT_ESIGN_STATUSES, CHECK_VOCABULARIES.contract_signatures?.esign_status ?? []],
    ["listing_agreements.esign_status", LISTING_AGREEMENT_ESIGN_STATUSES, CHECK_VOCABULARIES.listing_agreements?.esign_status ?? []],
  ]
  for (const [name, declared, live] of pairs) {
    check(`${name}: ${declared.length} declared, ${live.length} live — same set`,
      declared.length === live.length && subsetOf(declared, live))
  }
}

console.log("\n── the four values the code used to ask for are all impossible ──")
{
  const ms = CHECK_VOCABULARIES.transaction_milestones?.status ?? []
  const ds = CHECK_VOCABULARIES.transaction_deadlines?.status ?? []
  const docs = CHECK_VOCABULARIES.transaction_documents?.status ?? []
  const cs = CHECK_VOCABULARIES.contract_signatures?.esign_status ?? []
  const la = CHECK_VOCABULARIES.listing_agreements?.esign_status ?? []
  check("milestones cannot hold 'in_progress'", !ms.includes("in_progress"))
  check("deadlines cannot hold 'in_progress'", !ds.includes("in_progress"))
  check("deadlines cannot hold 'at_risk' — it is a risk band", !ds.includes("at_risk"))
  check("documents cannot hold 'pending' (the ladder says 'requested')",
    !docs.includes("pending") && docs.includes("requested"))
  check("contract e-sign cannot hold 'out_for_signature' (it says 'sent')",
    !cs.includes("out_for_signature") && cs.includes("sent"))
  check("listing-agreement e-sign cannot hold 'executed' (it says 'fully_signed')",
    !la.includes("executed") && la.includes("fully_signed"))
}

console.log("\n── the open sets are correct, not merely admitted ──")
{
  const ms = CHECK_VOCABULARIES.transaction_milestones?.status ?? []
  const ds = CHECK_VOCABULARIES.transaction_deadlines?.status ?? []
  check("MILESTONE_OPEN is admitted", subsetOf(MILESTONE_OPEN_STATUSES, ms))
  check("…and includes 'overdue', which the old filter dropped",
    (MILESTONE_OPEN_STATUSES as readonly string[]).includes("overdue"))
  check("…and excludes the terminal states",
    !(MILESTONE_OPEN_STATUSES as readonly string[]).includes("completed") &&
    !(MILESTONE_OPEN_STATUSES as readonly string[]).includes("cancelled"))

  check("DEADLINE_OPEN is admitted", subsetOf(DEADLINE_OPEN_STATUSES, ds))
  check("…and includes 'extended', which the old filter dropped",
    (DEADLINE_OPEN_STATUSES as readonly string[]).includes("extended"))
  check("…and excludes completed / missed / waived",
    ["completed", "missed", "waived"].every((s) => !(DEADLINE_OPEN_STATUSES as readonly string[]).includes(s)))

  check("DOCUMENT_OPEN is the complement of terminal — new statuses default to open",
    DOCUMENT_OPEN_STATUSES.length === DOCUMENT_STATUSES.length - DOCUMENT_TERMINAL_STATUSES.length &&
    DOCUMENT_OPEN_STATUSES.every((s) => !(DOCUMENT_TERMINAL_STATUSES as readonly string[]).includes(s)))
  check("…and it contains the value the writer actually inserts",
    (DOCUMENT_OPEN_STATUSES as readonly string[]).includes("requested"))
}

console.log("\n── at-risk is DERIVED, and the derivation is honest ──")
{
  const day = 24 * 60 * 60 * 1000
  const now = new Date("2026-07-29T12:00:00Z")
  const at = (offsetDays: number) => new Date(now.getTime() + offsetDays * day).toISOString().slice(0, 10)

  check("an open deadline inside the window is at risk",
    deadlineAtRisk({ status: "pending", deadline_date: at(1) }, now))
  check("an open deadline beyond the window is not",
    !deadlineAtRisk({ status: "pending", deadline_date: at(DEADLINE_AT_RISK_WINDOW_DAYS + 5) }, now))
  check("an EXTENDED deadline still counts — it is still owed",
    deadlineAtRisk({ status: "extended", deadline_date: at(1) }, now))
  check("a COMPLETED deadline never counts, however close",
    !deadlineAtRisk({ status: "completed", deadline_date: at(0) }, now))
  check("a WAIVED deadline never counts", !deadlineAtRisk({ status: "waived", deadline_date: at(0) }, now))
  check("an already-past open deadline counts — exactly what a coach must hear",
    deadlineAtRisk({ status: "pending", deadline_date: at(-4) }, now))
  check("no date means no claim", !deadlineAtRisk({ status: "pending", deadline_date: null }, now))
  check("a garbage date means no claim", !deadlineAtRisk({ status: "pending", deadline_date: "not-a-date" }, now))

  const rep = src("lib/kernel/reporting-autonomy.ts")
  check("the report no longer filters the impossible status", !/\.in\("status", \["at_risk", "missed"\]\)/.test(rep))
  check("…it selects the date it now needs", /\.select\("status, deadline_date"\)/.test(rep))
  check("…and derives at-risk instead of counting a stored band",
    /deadlineAtRisk\(d\)/.test(rep) && !/d\.status === "at_risk"/.test(rep))
  check("'missed' is still counted as the STORED status it is",
    /d\.status === "missed"/.test(rep))
}

console.log("\n── the type guards reject the exact values that caused this ──")
{
  check("isMilestoneStatus rejects 'in_progress'", !isMilestoneStatus("in_progress"))
  check("isMilestoneStatus accepts every real one", MILESTONE_STATUSES.every(isMilestoneStatus))
  check("isMilestoneStatus rejects non-strings", !isMilestoneStatus(undefined) && !isMilestoneStatus(3))
  check("isDeadlineStatus rejects 'at_risk' and 'in_progress'",
    !isDeadlineStatus("at_risk") && !isDeadlineStatus("in_progress"))
  check("isDeadlineStatus accepts every real one", DEADLINE_STATUSES.every(isDeadlineStatus))
}

console.log("\n── every coordination surface uses the shared sets ──")
{
  // Assert the CONSTRUCT, not the spelling: IF a file filters milestone or
  // deadline rows down to the OPEN ones, that filter must come from the shared
  // set. Requiring the constant to appear unconditionally asserted a spelling —
  // when multi-persona.ts's two orphaned coordinator dashboards were deleted
  // (both unreachable; the real dashboard is app/dashboard/coordinator/page.tsx,
  // which still uses the sets), the file kept only status WRITES and one
  // client-side filter over an embedded array. It had no open-status read left
  // to get wrong, and the check failed anyway.
  //
  // Chain-local: the `.in("status", …)` must belong to a chain that started at
  // .from("<table>"), so an unrelated status filter elsewhere in the file
  // neither satisfies nor trips this.
  const openFilterUsesSharedSet = (text: string, table: string, constName: string): boolean => {
    for (const m of text.matchAll(new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)([\\s\\S]{0,600})`, "g"))) {
      const chain = m[1]
      const filter = chain.match(/\.in\(\s*["']status["']\s*,\s*([^)]*)\)/)
      if (!filter) continue                       // no open-status read in this chain
      if (!filter[1].includes(constName)) return false
    }
    return true
  }

  for (const f of ["app/actions/multi-persona.ts", "app/dashboard/coordinator/page.tsx"]) {
    const t = src(f)
    check(`${f}: no 'in_progress' status filter remains`,
      !/\.in\("status", \["pending", "in_progress"\]\)/.test(t))
    check(`${f}: any open-milestone filter uses MILESTONE_OPEN_STATUSES`,
      openFilterUsesSharedSet(t, "transaction_milestones", "MILESTONE_OPEN_STATUSES"))
    check(`${f}: any open-deadline filter uses DEADLINE_OPEN_STATUSES`,
      openFilterUsesSharedSet(t, "transaction_deadlines", "DEADLINE_OPEN_STATUSES"))
  }
  // The canonical coordinator surface must actually HAVE those reads — this is
  // the half that would otherwise be satisfiable by deleting the feature.
  {
    const page = src("app/dashboard/coordinator/page.tsx")
    check("the coordinator dashboard still reads open milestones AND deadlines from the shared sets",
      /MILESTONE_OPEN_STATUSES/.test(page) && /DEADLINE_OPEN_STATUSES/.test(page))
  }

  const app = src("lib/application/transactions.ts")
  check("the document readers use DOCUMENT_OPEN_STATUSES",
    (app.match(/DOCUMENT_OPEN_STATUSES/g) ?? []).length >= 2)
  check("no bare 'pending' document filter remains",
    !/from\("transaction_documents"\)[\s\S]{0,200}?\.eq\("status", "pending"\)/.test(app))
}

console.log("\n── the two e-sign ladders stay separate, and both are right ──")
{
  const cs = CHECK_VOCABULARIES.contract_signatures?.esign_status ?? []
  const la = CHECK_VOCABULARIES.listing_agreements?.esign_status ?? []
  check("contract awaiting-set is admitted", subsetOf(CONTRACT_ESIGN_AWAITING_STATUSES, cs))
  check("…and includes 'viewed' + 'agent_signed', which the portal dropped",
    ["viewed", "agent_signed"].every((s) => (CONTRACT_ESIGN_AWAITING_STATUSES as readonly string[]).includes(s)))
  check("…and excludes every terminal state",
    ["fully_signed", "voided", "declined"].every((s) => !(CONTRACT_ESIGN_AWAITING_STATUSES as readonly string[]).includes(s)))
  check("the CHASE set deliberately excludes 'pending' — an unsent envelope cannot be chased",
    !(CONTRACT_ESIGN_SENT_AWAITING_STATUSES as readonly string[]).includes("pending") &&
    CONTRACT_ESIGN_SENT_AWAITING_STATUSES.every((s) => (CONTRACT_ESIGN_AWAITING_STATUSES as readonly string[]).includes(s)))
  check("done means fully_signed, and it is admitted", subsetOf(CONTRACT_ESIGN_DONE_STATUSES, cs))
  check("the listing-agreement executed value is admitted on ITS ladder",
    la.includes(LISTING_AGREEMENT_EXECUTED_STATUS))
  check("the two ladders are genuinely different — do not cross them",
    cs.includes("agent_signed") && !la.includes("agent_signed") &&
    la.includes("partially_signed") && !cs.includes("partially_signed"))

  const portal = src("app/portal/[contactId]/documents/page.tsx")
  check("the portal to-sign list uses the shared awaiting set",
    /CONTRACT_ESIGN_AWAITING_STATUSES/.test(portal) && !/out_for_signature/.test(portal))
  const engine = src("app/actions/seller-listing/execution-engine.ts")
  check("the execution engine writes the shared executed value",
    /LISTING_AGREEMENT_EXECUTED_STATUS/.test(engine) && !/esign_status:\s*"executed"/.test(engine))
  const chase = src("lib/kernel/signature-chase.ts")
  check("signature-chase imports its set instead of retyping it",
    /CONTRACT_ESIGN_SENT_AWAITING_STATUSES/.test(chase))
  const war = src("lib/kernel/closing-war-room.ts")
  check("closing-war-room's file-local duplicate now points at the shared const",
    /CONTRACT_ESIGN_DONE_STATUSES/.test(war) && !/=\s*\["fully_signed"\] as const/.test(war))
}

console.log("\n── the two writers that reported success without writing ──")
{
  const mp = src("app/actions/multi-persona.ts")
  check("executeWorkflow validates the operator's newStatus", /isMilestoneStatus\(action\.newStatus\)/.test(mp))
  check("bulkUpdateMilestones validates every caller status",
    /updates\.filter\(\(u\) => !isMilestoneStatus\(u\.status\)\)/.test(mp))
  // The success path may still return results.length — that is CORRECT once
  // nothing failed. What matters is that the rejected writes are inspected at
  // all: supabase-js resolves them with { error } instead of throwing, so the
  // old code's array-length count could never have been wrong-free.
  check("…and inspects each result's error rather than trusting the array",
    /results\.filter\(\(r\) => r\.error\)/.test(mp))
  check("…and reports failure when any row did not move",
    /if \(failed\.length\)/.test(mp) && /success: false/.test(mp))
  check("…and subtracts the failures from what it claims",
    /results\.length - failed\.length/.test(mp))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ COORDINATION_STATUS_FAIL"); process.exit(1) }
console.log(" ✅ COORDINATION_STATUS_PASS — open work is findable and every claimed write happened")
