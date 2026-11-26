/**
 * scripts/closing-terms-guard.ts — test:closing-terms (wave 149, lane 149G; pure, in-memory, no DB, no network).
 *
 * OWNER RULING 17 (2026-11-03) / CONTRACT C33: "Early closing needs no executed amendment unless state law requires it.
 * Keep 'on or before'; track contractual vs anticipated vs actual."
 *
 *   A · "on or before" + an earlier day → recorded as the ANTICIPATED day with NO amendment requirement; the contract's
 *       date is untouched; the deal says "closing may occur earlier"
 *   B · a state that requires one is a ROW the sourced state table carries (with its source) — never invented; the live
 *       table carries none today, said; a fixture state WITH a sourced rule flips the verdict (positive control)
 *   C · what still needs an executed instrument: a fixed "on" day moved, any day past the deadline; an unread wording is
 *       UNKNOWN — never a default "needs an amendment"
 *   D · actual tracked separately: the close stamps it; a closed deal's actual day is confirmed from the settlement
 *       statement (proof required, never future, open deals refused, the contract untouched, ledgered)
 *   E · coordination: the readiness day (CTC / walkthrough / wire / CDA) is the EARLIEST credible closing day; the CDA
 *       deadline agrees; a later estimate never pushes either past the contract
 *   F · stripped-source census: no closing door or copy demands an amendment by default; the title appointment door
 *       judges the day with the ONE assessment and never writes transactions; the readiness detectors read the one helper
 *
 * Every absence assertion has a POSITIVE CONTROL (CLAUDE.md §2). Blind spots printed at the end. C23 itself
 * (decideStatusOverride / overrideStatus) is held by test:status-override, which this lane re-ran.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  resolveClosingDates, assessClosingDateChange, applyClosingDateChange, readinessClosingDay, CLOSING_DATE_CHANGE_KINDS,
} from "../lib/transactions/closing-dates"
import { STATE_CLOSING_POLICIES, closingStateNote, type StateClosingPolicy } from "../lib/state-forms/closing-participants"
import { resolveClosingDeadline } from "../lib/transactions/cda-closing-policy"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
/** Comments stripped, string contents KEPT — the copy a person reads is in strings; a tombstone comment is not copy. */
const code = (p: string) => stripComments(raw(p))

type Claim = { kind: "refused"; error: string } | { kind: "replay"; entry: unknown }
const ledgerStub = () => {
  const rows: Array<Record<string, any>> = [], keys = new Set<string>()
  const fn = async (ctx: any, run: () => Promise<any>, hooks: { settle: (r: any) => any; replay: (c: Claim) => any }) => {
    if (keys.has(ctx.idempotencyKey)) return hooks.replay({ kind: "replay", entry: {} })
    keys.add(ctx.idempotencyKey)
    const r = await run(); rows.push({ ...ctx, settled: hooks.settle(r) }); return r
  }
  return { fn: fn as never, rows }
}

const B = "11111111-1111-4111-8111-111111111111", T = "74747474-0000-4000-8000-000000000149"
const REASON = "The buyer's lender can fund a week early"
const deal = (over: Record<string, unknown> = {}) => ({
  id: T, brokerage_id: B, status: "under_contract", close_date: "2026-12-15", estimated_close_date: "2026-12-15",
  contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", contract_closing_source: "executed_contract",
  contract_closing_amendment_ref: null, actual_close_date: null, property_state: "CA", financing_type: "conventional", updated_at: "v1", ...over,
})

async function main() {
  // ── A ─────────────────────────────────────────────────────────────────────────────────────────
  section("A · 'on or before' + an earlier day — no amendment; the contract untouched; closing may occur earlier")
  {
    const db = memSupabase({ transactions: [deal()] })
    const L = ledgerStub()
    const r = await applyClosingDateChange(db as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "anticipated", date: "2026-12-08", reason: REASON }, { ledger: L.fn })
    const t = db.tables.transactions[0]
    check("the earlier day is RECORDED (as the anticipated day) with no evidence reference asked for", r.ok && t.estimated_close_date === "2026-12-08")
    check("…and NO executed amendment is required (withinContract true, requiresExecutedAmendment false, basis none)", r.ok && r.assessment?.withinContract === true && r.assessment.requiresExecutedAmendment === false && r.assessment.amendmentBasis === "none", JSON.stringify(r.ok ? r.assessment : r))
    check("the contract's date and wording are untouched (contractual never replaced by the anticipated early day)", t.contract_closing_date === "2026-12-15" && t.close_date === "2026-12-15" && t.contract_closing_terms === "on_or_before" && t.contract_closing_source === "executed_contract")
    check("the three facts stay separate: contractual 12-15, anticipated 12-08, actual none", r.ok && r.dates.contractual?.date === "2026-12-15" && r.dates.anticipated?.date === "2026-12-08" && r.dates.actual === null)
    check("the deal SAYS closing may occur earlier (the C33 note), and needs no amendment", r.ok && r.dates.earlierClosing?.allowed === true && r.dates.earlierClosing.requiresExecutedAmendment === false && /closing may occur earlier/i.test(r.dates.earlierClosing.note) && /no executed amendment/i.test(r.dates.earlierClosing.note))
    check("the coordination list still names the lender (TRID), who conducts the closing, every party and the CDA", r.ok && !!r.assessment && ["lender", "title / escrow", "every party", "CDA"].every((w) => r.assessment!.coordinate.some((c) => c.includes(w))))
    check("ledgered as transaction.closing_date.record (LOW_RISK_WRITE — a proposal, not a legal instrument)", L.rows.length === 1 && L.rows[0].action === "transaction.closing_date.record" && L.rows[0].riskClass === "LOW_RISK_WRITE")
    const cash = assessClosingDateChange(deal({ financing_type: "cash" }) as never, { date: "2026-12-08", kind: "anticipated" })
    check("POSITIVE CONTROL: a cash deal's coordination does not list the lender (the list is derived, not boilerplate)", !cash.coordinate.some((c) => /lender/.test(c)))
  }

  // ── B ─────────────────────────────────────────────────────────────────────────────────────────
  section("B · a state requirement is a sourced row in the state table — or absent")
  {
    const withRule = Object.entries(STATE_CLOSING_POLICIES).filter(([, p]) => !!p.earlierClosing)
    check("every state row that carries an early-closing rule carries its https source and holding (none may be invented)", withRule.every(([, p]) => /^https:\/\//.test(p.earlierClosing!.source.url) && p.earlierClosing!.source.says.length > 40 && p.earlierClosing!.summary.length > 20), withRule.map(([s]) => s).join(","))
    console.log(`  · states carrying a sourced early-closing amendment rule today: ${withRule.length} (${withRule.map(([s]) => s).join(", ") || "none — no source verified, so none is assumed"})`)
    const ga = closingStateNote("GA")
    check("an attorney-closing state (GA, sourced) does NOT by itself make an early closing need an amendment", ga.conductedBy === "attorney_required" && ga.earlierClosing === null && assessClosingDateChange(deal({ property_state: "GA" }) as never, { date: "2026-12-08", kind: "anticipated" }).requiresExecutedAmendment === false)
    const FIXTURE: Record<string, StateClosingPolicy> = {
      ...STATE_CLOSING_POLICIES,
      TX: {
        state: "TX", stateName: "Fixture Texas", involvement: "required", basis: "statute",
        summary: "Fixture only — a closing attorney conducts the closing (Fixture Gen. Stat. § 1).",
        expects: [{ role: "closing_attorney", presence: "required", why: "fixture" }],
        titleSearch: { assignedByLaw: false, note: "fixture" },
        sources: [{ title: "Fixture Gen. Stat. § 1", url: "https://example.test/statute", says: "Fixture text standing in for a cited holding of at least forty characters." }],
        earlierClosing: { requiresExecutedAmendment: true, summary: "a fixture statute requires every party to sign before closing earlier", source: { title: "Fixture Gen. Stat. § 2", url: "https://example.test/statute-2", says: "Fixture text standing in for a cited early-closing holding of forty characters." } },
      },
    }
    const zz = assessClosingDateChange(deal({ property_state: "TX" }) as never, { date: "2026-12-08", kind: "anticipated" }, { statePolicies: FIXTURE })
    check("POSITIVE CONTROL: a state WITH a sourced rule → the earlier day needs an executed amendment, basis state_rule, the source named", zz.requiresExecutedAmendment === true && zz.amendmentBasis === "state_rule" && /Fixture Gen\. Stat\. § 2/.test(zz.explanation), JSON.stringify(zz))
    const zzDates = resolveClosingDates(deal({ property_state: "TX" }) as never, { statePolicies: FIXTURE })
    check("…and the deal's note says so (closing may occur earlier, but this state requires an amendment first)", zzDates.earlierClosing?.requiresExecutedAmendment === true && /requires an executed amendment/.test(zzDates.earlierClosing.note) && /Fixture Gen\. Stat\. § 2/.test(zzDates.stateNote.note))
    check("…the same state (TX) WITHOUT the row (the live table) → no amendment: the requirement exists only as a sourced row", assessClosingDateChange(deal({ property_state: "TX" }) as never, { date: "2026-12-08", kind: "anticipated" }).requiresExecutedAmendment === false)
    check("an unsupported / unknown state is said as unknown, never as 'no requirement'", closingStateNote(null).conductedBy === "unknown" && /not on file/.test(closingStateNote(null).note))
  }

  // ── C ─────────────────────────────────────────────────────────────────────────────────────────
  section("C · what still needs an executed instrument — and what is UNKNOWN")
  {
    const on = assessClosingDateChange(deal({ contract_closing_terms: "on" }) as never, { date: "2026-12-08", kind: "anticipated" })
    check("a fixed 'on' day moved earlier → an amendment (the CONTRACT fixes the day — basis contract_fixed_day)", on.requiresExecutedAmendment === true && on.amendmentBasis === "contract_fixed_day" && on.withinContract === false)
    const late = assessClosingDateChange(deal() as never, { date: "2026-12-20", kind: "anticipated" })
    check("any day past an 'on or before' deadline → an executed extension (basis contract_deadline_passed)", late.requiresExecutedAmendment === true && late.amendmentBasis === "contract_deadline_passed" && /extension/.test(late.explanation))
    const unread = assessClosingDateChange(deal({ contract_closing_terms: null }) as never, { date: "2026-12-08", kind: "anticipated" })
    check("an UNREAD wording → 'unknown' (read the contract) — never a default amendment, never 'fine'", unread.requiresExecutedAmendment === "unknown" && unread.withinContract === "unknown" && unread.amendmentBasis === "wording_unread" && !/treat an earlier day as needing an executed amendment/.test(unread.explanation))
    const unreadDates = resolveClosingDates(deal({ contract_closing_terms: null }) as never)
    check("…and the deal's notes ask for the reading instead of demanding an amendment", unreadDates.notes.some((n) => /has not been read yet/.test(n)) && !unreadDates.notes.some((n) => /treated as needing an executed amendment/.test(n)) && unreadDates.earlierClosing?.allowed === "unknown")
    const same = assessClosingDateChange(deal({ contract_closing_terms: "on" }) as never, { date: "2026-12-15", kind: "anticipated" })
    check("the contract's own day needs nothing under either wording", same.requiresExecutedAmendment === false && same.direction === "same")
    const db = memSupabase({ transactions: [deal({ contract_closing_terms: "on" })] })
    const noProof = await applyClosingDateChange(db as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "executed_amendment", date: "2026-12-08", reason: "All parties signed Amendment 1" }, { ledger: ledgerStub().fn })
    check("an executed amendment without its document reference is refused, the contract untouched (C23 proof floor preserved)", !noProof.ok && db.tables.transactions[0].contract_closing_date === "2026-12-15")
  }

  // ── D ─────────────────────────────────────────────────────────────────────────────────────────
  section("D · the ACTUAL day — tracked separately, confirmed from the settlement statement")
  {
    check("the vocabulary of governed records is anticipated / executed_amendment / contract_wording / actual_confirmation", CLOSING_DATE_CHANGE_KINDS.join(",") === "anticipated,executed_amendment,contract_wording,actual_confirmation")
    const closedDeal = deal({ status: "closed", contract_closing_date: "2026-10-15", close_date: "2026-10-11", actual_close_date: "2026-10-11" })
    const db = memSupabase({ transactions: [closedDeal] })
    const L = ledgerStub()
    const noProof = await applyClosingDateChange(db as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "actual_confirmation", date: "2026-10-09", reason: "Settlement statement shows signing on the 9th" }, { ledger: L.fn })
    check("confirming the actual day WITHOUT the settlement statement / closing file is refused", !noProof.ok && /settlement statement/.test((noProof as { error: string }).error) && db.tables.transactions[0].actual_close_date === "2026-10-11")
    const future = await applyClosingDateChange(db as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "actual_confirmation", date: "2999-01-01", reason: "Settlement statement shows signing on the 9th", evidenceRef: "doc:alta-ss" }, { ledger: L.fn })
    check("an actual day in the future is refused", !future.ok && /future/.test((future as { error: string }).error))
    const ok = await applyClosingDateChange(db as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "actual_confirmation", date: "2026-10-09", reason: "Settlement statement shows signing on the 9th", evidenceRef: "doc:alta-ss" }, { ledger: L.fn })
    const t = db.tables.transactions[0]
    check("with its proof, the actual day is corrected (and the effective close_date follows); the contract's deadline survives", ok.ok && t.actual_close_date === "2026-10-09" && t.close_date === "2026-10-09" && t.contract_closing_date === "2026-10-15" && t.contract_closing_terms === "on_or_before")
    check("…ledgered LEGAL with the before-state (actual 10-11)", L.rows.length === 1 && L.rows[0].riskClass === "LEGAL" && L.rows[0].detail?.before?.actual === "2026-10-11" && L.rows[0].detail?.kind === "actual_confirmation")
    check("…and the result reads closed: actual 10-09, no anticipated day, no early-closing verdict", ok.ok && ok.dates.closed && ok.dates.actual?.date === "2026-10-09" && ok.dates.anticipated === null && ok.dates.earlierClosing === null)
    const openDb = memSupabase({ transactions: [deal()] })
    const openTry = await applyClosingDateChange(openDb as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "actual_confirmation", date: "2026-10-09", reason: "Settlement statement shows signing on the 9th", evidenceRef: "doc:alta-ss" }, { ledger: ledgerStub().fn })
    check("POSITIVE CONTROL: an OPEN deal cannot be given an actual day by hand (the gated close stamps it)", !openTry.ok && openDb.tables.transactions[0].actual_close_date === null)
    const closedTry = await applyClosingDateChange(memSupabase({ transactions: [closedDeal] }) as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "anticipated", date: "2026-12-08", reason: REASON }, { ledger: ledgerStub().fn })
    check("a closed deal still refuses a new anticipated / contract change (the actual day is the record)", !closedTry.ok)
    const wrong = await applyClosingDateChange(memSupabase({ transactions: [closedDeal] }) as never, { brokerageId: "22222222-2222-4222-8222-222222222222", transactionId: T, actorUserId: "u-1", kind: "actual_confirmation", date: "2026-10-09", reason: "Settlement statement shows signing on the 9th", evidenceRef: "doc:alta-ss" }, { ledger: ledgerStub().fn })
    check("another tenant's deal is not found (tenant-pinned read)", !wrong.ok && /not found/i.test((wrong as { error: string }).error))
    const bogus = await applyClosingDateChange(memSupabase({ transactions: [deal()] }) as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "rewrite" as never, date: "2026-12-08", reason: REASON }, { ledger: ledgerStub().fn })
    check("an unknown record kind is refused (fail closed)", !bogus.ok)
  }

  // ── E ─────────────────────────────────────────────────────────────────────────────────────────
  section("E · coordination — readiness and the CDA are measured against the EARLIEST credible closing day")
  {
    const earlier = readinessClosingDay({ contract_closing_date: "2026-12-15", close_date: "2026-12-15", estimated_close_date: "2026-12-08" })
    check("an earlier anticipated day governs readiness (CTC / walkthrough / wire / CDA detectors)", earlier?.date === "2026-12-08" && earlier.basis === "anticipated")
    const later = readinessClosingDay({ contract_closing_date: "2026-12-15", close_date: "2026-12-15", estimated_close_date: "2026-12-20" })
    check("a LATER anticipated day never pushes readiness past the contract (that needs an executed extension)", later?.date === "2026-12-15" && later.basis === "contract")
    const sched = readinessClosingDay({ contract_closing_date: "2026-12-15", estimated_close_date: "2026-12-10", scheduled_closing_date: "2026-12-09" })
    check("the title / escrow appointment, when earliest, governs", sched?.date === "2026-12-09" && sched.basis === "title_schedule")
    check("a closed deal has no readiness day; a legacy deal falls back to close_date", readinessClosingDay({ status: "closed", close_date: "2026-12-10" }) === null && readinessClosingDay({ close_date: "2026-12-15" })?.date === "2026-12-15")
    const cdaEarly = resolveClosingDeadline({ closeDate: "2026-12-15", estimatedCloseDate: "2026-12-08", timeZone: "UTC" })
    const cdaLate = resolveClosingDeadline({ closeDate: "2026-12-15", estimatedCloseDate: "2026-12-20", timeZone: "UTC" })
    check("the CDA deadline AGREES: an earlier estimate governs, a later one never does", cdaEarly.basis === "estimated_close_date" && cdaEarly.dueAt!.startsWith("2026-12-08") && cdaLate.basis === "close_date" && cdaLate.dueAt!.startsWith("2026-12-15"), JSON.stringify({ cdaEarly, cdaLate }))
    check("…and the title appointment still wins over both (the existing CDA rule, preserved)", resolveClosingDeadline({ closingScheduledDate: "2026-12-12", closeDate: "2026-12-15", estimatedCloseDate: "2026-12-08", timeZone: "UTC" }).basis === "closing_scheduled_date")
  }

  // ── F ─────────────────────────────────────────────────────────────────────────────────────────
  section("F · stripped-source census — no default amendment demand; the doors read the one model")
  {
    const DEFAULT_DEMAND = /treated as needing an executed amendment|treat an earlier day as needing an executed amendment|A different day is a date change|a different day is an amendment/i
    const FILES = [
      "lib/transactions/closing-dates.ts", "app/dashboard/transactions/[id]/closing-dates-panel.tsx", "app/actions/transactions.ts",
      "app/actions/title/closing-appointment.ts", "app/title/closing/new/page.tsx", "app/title/closing/new/closing-appointment-form.tsx",
      "lib/state-forms/closing-participants.ts", "lib/transactions/cda-closing-policy.ts", "lib/transactions/closing-orchestration.ts",
    ]
    const missing = FILES.filter((f) => !raw(f))
    check("every file the census reads exists (a missing file would read as clean)", missing.length === 0, missing.join(","))
    const offenders = FILES.filter((f) => DEFAULT_DEMAND.test(code(f)))
    check(`no closing door or copy demands an amendment by DEFAULT (${FILES.length} files, comments stripped, copy kept)`, offenders.length === 0, offenders.join(","))
    check("POSITIVE CONTROL: the finder catches the wave-148 note and the wave-147 refusal as copy, and ignores them in a tombstone comment",
      DEFAULT_DEMAND.test(stripComments(`notes.push("until it is, an earlier day is treated as needing an executed amendment.")`)) && DEFAULT_DEMAND.test(stripComments("return { message: `A different day is a date change — an amendment` }")) && !DEFAULT_DEMAND.test(stripComments("// the wave-148 note said: treated as needing an executed amendment")))
    const door = code("app/actions/title/closing-appointment.ts")
    const fn = door.slice(door.indexOf("export async function proposeClosingAppointment"))
    check("the title appointment door judges a different day with the ONE assessment, BEFORE it writes the agent's task", /assessClosingDateChange\(/.test(fn) && fn.search(/assessClosingDateChange\(/) < fn.search(/\.from\("tasks"\)\.insert\(/))
    check("…and still never writes transactions (the closing date stays a contract term; the agent records the expected day)", !/\.from\("transactions"\)\.(?:update|upsert|insert|delete)\(/.test(door))
    check("…and still refuses an extension / a fixed day as the amendment it is", /requiresExecutedAmendment === true/.test(fn) && /amendment/.test(fn))
    const form = code("app/title/closing/new/closing-appointment-form.tsx")
    check("the title form offers a date input bounded by the contract's day unless the contract fixes the day", /type="date"/.test(form) && /max=\{deal\?\.closeDate/.test(form) && /fixedDay/.test(form))
    check("the closing-orchestration readiness detectors read the one readiness helper", /readinessClosingDay\(/.test(code("lib/transactions/closing-orchestration.ts")))
    const panel = code("app/dashboard/transactions/[id]/closing-dates-panel.tsx")
    check("the deal panel shows the early-closing note and says 'unknown' as unknown (never as 'needs an amendment')", /earlierClosing/.test(panel) && /requiresExecutedAmendment === "unknown"/.test(panel) && /actual_confirmation/.test(panel))
    check("the deal's read door also reads the title appointment (tenant-pinned) for the anticipated day", /transaction_title_escrow/.test(code("app/actions/transactions.ts")) && /scheduled_closing_date: scheduled/.test(code("app/actions/transactions.ts")))
    check("closing-dates.ts holds no second state table (merged onto lib/state-forms/closing-participants.ts)", !/ATTORNEY_CLOSING_REPORTED\s*[:=]/.test(code("lib/transactions/closing-dates.ts")) && /from "@\/lib\/state-forms\/closing-participants"/.test(code("lib/transactions/closing-dates.ts")))
  }

  console.log("\n BLIND SPOTS: the title appointment door and the deal's read door are 'use server' modules judged on stripped source here (their session gates are held by test:capability-closure D4 and test:status-override §G); the state table is checked for sourced rows, not for the TRUTH of any source — no state's early-closing law was researched exhaustively, so 'none today' means 'none verified', not 'none exist'; the census reads nine named files (copy elsewhere — emails, prompts — is not scanned); the readiness change in closing-orchestration is asserted on source, its detectors' behaviour by the existing closing-orchestration simulators; dry vs wet funding by state is not modelled.")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(`\n ❌ CLOSING_TERMS_FAIL — ${failures.join(" | ")}`); process.exit(1) }
  console.log("\n ✅ CLOSING_TERMS_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
