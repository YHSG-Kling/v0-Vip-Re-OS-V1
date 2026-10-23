#!/usr/bin/env tsx
/**
 * scripts/commission-set-in-stone-simulator.ts   (npm run test:commission-set-in-stone)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CORRECTED money lifecycle: CLOSE (final CD, both signed) FREEZES the commission amount —
 * it does NOT pay. Close ≠ paid. The ledger tracks the money AFTER close (deposit received →
 * disbursed); 'paid' is stamped at DISBURSEMENT, not at close. The full spine:
 *   final calc → (CDA broker-sign → approved) → CLOSE freezes the amount (non-CDA auto-approves) →
 *   deposit received (ledger) → DISBURSEMENT locks BOTH trackings to paid.
 *
 * SOURCE scan (the CLOSED transition is server-only): close calls finalizeCommissionAtClose (freeze,
 * not pay), never force-pays at close; disbursement (kernel markCommissionPaid) is where the ledger
 * lock lives.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { registerHooks } from "node:module"
import { memSupabase, type MemClient } from "./in-memory-supabase"

// Wave 98 — module edges only, for the correction command's in-memory run (no network, no live rows).
const G98 = globalThis as any
G98.__98A = { svc: null as MemClient | null }
const STUB98: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__98A.svc",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__98A.svc",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB98[spec]
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

async function main() {
  const sp = src("lib/transactions/stage-progression.ts")
  const closedIdx = sp.indexOf('params.targetStage === "CLOSED"')
  const block = sp.slice(closedIdx, closedIdx + 3200)

  console.log("\n[CLOSE FREEZES the amount — it does NOT pay (close ≠ paid)]")
  check("CLOSE runs the FINAL commission calc first (freezes the numbers)", /calculationMode:\s*'final'/.test(block))
  check("CLOSE calls finalizeCommissionAtClose (freeze, not pay)", /finalizeCommissionAtClose/.test(block))
  check("CLOSE does NOT force agent_commissions to 'paid'", !/agent_commissions[\s\S]{0,400}status:\s*"paid"/.test(block))
  check("CLOSE does NOT reconcile the ledger to paid at close (that moved to disbursement)", !/reconcileCommissionTrackingAtClose|reconcileCommissionDisbursement/.test(block))

  console.log("\n[non-CDA brokerages auto-APPROVE at close (no CDA broker-sign exists)]")
  const rec = src("lib/commission/reconcile-tracking.ts")
  check("finalizeCommissionAtClose reads brokerages.offers_cda", /finalizeCommissionAtClose[\s\S]*?offers_cda/.test(rec))
  check("non-CDA path auto-approves pending → approved (uniform disbursement path)", /offersCda[\s\S]*?status:\s*"approved"/.test(rec))
  check("CDA brokerages are left to the broker's CDA signature (no auto-approve)", /if\s*\(offersCda\)\s*return/.test(rec))

  console.log("\n[the ledger tracks the DEPOSIT between close and disbursement]")
  check("recordCommissionDepositReceived stamps deposit_received_at", /recordCommissionDepositReceived[\s\S]*?deposit_received_at/.test(rec))
  check("deposit stamp is idempotent (only rows not already marked)", /is\("deposit_received_at",\s*null\)/.test(rec))

  console.log("\n[DISBURSEMENT is the ONE LOCK — both trackings go paid together, at payout]")
  const fin = src("lib/kernel/financial.ts")
  check("kernel markCommissionPaid locks the ledger via reconcileCommissionDisbursement", /markCommissionPaid[\s\S]*?reconcileCommissionDisbursement/.test(fin))
  check("reconcileCommissionDisbursement reuses the canonical payment path", /reconcileCommissionDisbursement[\s\S]*?markCommissionPaid/.test(rec))

  // Wave 97 (lane 97C): a POSTED (paid) distribution entry is APPEND-ONLY — m689's trigger refuses a
  // direct UPDATE/DELETE of it, and every posting UPDATE in code skips posted/voided rows so none hits it.
  console.log("\n[a POSTED commission entry is append-only — corrections are new rows (m689)]")
  const migFile = readdirSync(join(process.cwd(), "supabase/migrations")).find((f) => /^m689-/.test(f))
  const mig = migFile ? stripComments(src(`supabase/migrations/${migFile}`)) : ""
  const TRIGGER = /BEFORE UPDATE OR DELETE ON public\.commission_distributions[\s\S]*?EXECUTE FUNCTION public\.commission_distribution_posted_is_append_only\(\)/
  check("m689 puts a BEFORE UPDATE OR DELETE trigger on commission_distributions", TRIGGER.test(mig))
  check("the trigger refuses only POSTED rows (OLD.status 'paid') and lets referential actions (pg_trigger_depth() > 1) through",
    /IF OLD\.status IS DISTINCT FROM 'paid' THEN\s*RETURN COALESCE\(NEW, OLD\)/.test(mig) && /IF pg_trigger_depth\(\) > 1 THEN/.test(mig) && /RAISE EXCEPTION/.test(mig))
  check("POSITIVE CONTROL: the trigger finder rejects a table-less / wrong-table trigger", !TRIGGER.test("BEFORE UPDATE ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION public.commission_distribution_posted_is_append_only()"))
  // Every UPDATE of commission_distributions in app/lib code must skip posted rows (else the trigger refuses it).
  const writers = ["lib/commission/payment-tracker.ts", "lib/commission/reconcile-tracking.ts", "app/dashboard/transactions/[id]/cda/cda-workflow-client.tsx"]
  const UPDATE_STMT = /from\(\s*["']commission_distributions["']\s*\)\s*\.update\([\s\S]{0,900}?(?=\bif\s*\(|\bawait\b|\breturn\b|$)/g
  let updates = 0, unguarded: string[] = []
  for (const w of writers) for (const m of stripComments(src(w)).matchAll(UPDATE_STMT)) {
    updates++
    if (!/\.not\(\s*["']status["']\s*,\s*["']in["']\s*,\s*['"]\("paid","voided"\)['"]\s*\)/.test(m[0])) unguarded.push(w)
  }
  check(`every posting UPDATE of commission_distributions skips paid + voided rows (${updates} statements; unguarded: ${unguarded.join(", ") || "none"})`, updates >= 4 && unguarded.length === 0)
  const sample = `.from("commission_distributions")\n  .update({ status: "paid" })\n  .eq("id", x)\n\nif (e) {}`
  check("POSITIVE CONTROL: the unguarded-UPDATE finder flags a posting UPDATE with no status filter",
    [...sample.matchAll(UPDATE_STMT)].length === 1 && ![...sample.matchAll(UPDATE_STMT)][0][0].includes('.not("status"'))
  const pt = stripComments(src("lib/commission/payment-tracker.ts"))
  check("markDistributionPaid COUNTS what it posted (an UPDATE matching nothing resolves — CLAUDE.md §3) and refuses 0 rows",
    /const \{ data: posted, error: distributionError \}/.test(pt) && /if \(!posted \|\| posted\.length === 0\)/.test(pt))

  // ════ Wave 98 (lane 98A) — the CORRECTION of a posted entry is a NEW row (owner: "yes build
  // commission correction screen"). Rule, not waypoint: whatever the amounts, the paid row is
  // never written and the new row nets the entry to the corrected figure.
  console.log("\n[a posted entry is CORRECTED by a new reversal / adjustment row — the paid row is never edited]")
  const { planDistributionCorrection } = await import("../lib/commission/distribution-correction")
  const paid = { id: "d1", status: "paid", entry_type: "entry", calculated_amount: 1000.1 }
  const rev = planDistributionCorrection({ original: paid, priorCorrections: [], kind: "reversal", reason: "duplicate payout" })
  check("reversal of a posted 1000.10 writes -1000.10 and nets the entry to 0", rev.ok && rev.amount === -1000.1 && rev.netAfter === 0)
  const adj = planDistributionCorrection({ original: paid, priorCorrections: [{ calculated_amount: -100.05 }], kind: "adjustment", correctedAmount: 850, reason: "split was 85%" })
  check("adjustment counts EARLIER corrections: net 900.05 → target 850 writes -50.05", adj.ok && adj.netBefore === 900.05 && adj.amount === -50.05 && adj.netAfter === 850)
  const cents = planDistributionCorrection({ original: { id: "d", status: "paid", calculated_amount: 0.1 }, priorCorrections: [{ calculated_amount: 0.2 }], kind: "adjustment", correctedAmount: 0.3, reason: "float check" })
  check("money math is integer cents (0.1 + 0.2 → 0.3 is a no-op, refused — not a 0.0000000000000000x row)", !cents.ok)
  check("an UNPOSTED entry is refused (still editable in the posting lifecycle)", !planDistributionCorrection({ original: { ...paid, status: "approved" }, priorCorrections: [], kind: "reversal", reason: "nope nope" }).ok)
  check("a correction row cannot itself be corrected", !planDistributionCorrection({ original: { ...paid, entry_type: "reversal" }, priorCorrections: [], kind: "reversal", reason: "nope nope" }).ok)
  check("a reason is required", !planDistributionCorrection({ original: paid, priorCorrections: [], kind: "reversal", reason: "  " }).ok)
  check("reversing an entry that already nets to zero is refused", !planDistributionCorrection({ original: paid, priorCorrections: [{ calculated_amount: -1000.1 }], kind: "reversal", reason: "again again" }).ok)

  // The REAL kernel command against an in-memory ledger.
  const BRK = "b0000000-0000-4000-8000-000000000098", OTHER = "b0000000-0000-4000-8000-000000000099"
  const ORIG = "d0000000-0000-4000-8000-000000000098"
  const seedRow = { id: ORIG, brokerage_id: BRK, transaction_id: "t1", commission_id: "c1", agent_id: "a1", team_id: null, rule_id: null,
    distribution_type: "agent", source_of_funds: "brokerage", cap_status: "pre_cap", status: "paid", entry_type: "entry", calculated_amount: 9000, paid_at: "2026-10-01T00:00:00Z" }
  // Wave 100 (100C): the two SUMMARY rows the waterfall / deal recalculation write (not derived — no
  // trigger or view behind them), seeded at the pre-correction figure so the re-stamp is observable.
  const svc = memSupabase({
    commission_distributions: [{ ...seedRow }],
    agent_commissions: [{ id: "c1", brokerage_id: BRK, transaction_id: "t1", agent_id: "a1", net_to_agent: 9000, net_to_brokerage: 1000, status: "paid" }],
    transaction_commissions: [
      { id: "tc-a", brokerage_id: BRK, transaction_id: "t1", recipient_type: "agent", recipient_id: "a1", calculated_amount: 9000, status: "paid" },
      { id: "tc-b", brokerage_id: BRK, transaction_id: "t1", recipient_type: "brokerage", recipient_id: BRK, calculated_amount: 1000, status: "paid" },
    ],
  })
  G98.__98A.svc = svc
  const finKernel = await import("../lib/kernel/financial")
  const ctxFor = (userType: string, brokerageId = BRK) => ({ userId: "u-fin", agentId: null, brokerageId, userType: userType as any, isTenantPrincipal: false })
  const before = JSON.stringify(svc.tables.commission_distributions[0])
  const refused = await finKernel.correctCommissionDistribution({ ctx: ctxFor("agent"), distributionId: ORIG, kind: "reversal", reason: "agent tries it" })
  check("a NON-finance role (agent) is refused, and nothing is written", !refused.success && svc.writes.length === 0)
  const tl = await finKernel.correctCommissionDistribution({ ctx: ctxFor("team_lead"), distributionId: ORIG, kind: "reversal", reason: "team lead tries it" })
  check("...team_lead is refused too (the books tier excludes it, m472)", !tl.success && svc.writes.length === 0)
  const cross = await finKernel.correctCommissionDistribution({ ctx: ctxFor("broker", OTHER), distributionId: ORIG, kind: "reversal", reason: "other tenant" })
  check("another tenant's finance admin cannot reach the entry (session tenant pins the read)", !cross.success && svc.writes.length === 0)
  const ok = await finKernel.correctCommissionDistribution({ ctx: ctxFor("broker"), distributionId: ORIG, kind: "adjustment", correctedAmount: 8500, reason: "split corrected to 85%" })
  const rowsNow = svc.tables.commission_distributions
  const added = rowsNow.find((r) => r.id !== ORIG)
  check("a finance admin's correction INSERTS one new row (insert counted)", ok.success && rowsNow.length === 2 && svc.writes.filter((w) => w.op === "insert").length === 1)
  check("...linked to the original, typed, reasoned, posted, -500", !!added && added.adjusts_distribution_id === ORIG && added.entry_type === "adjustment"
    && added.correction_reason === "split corrected to 85%" && added.status === "paid" && added.calculated_amount === -500 && added.agent_id === "a1" && added.distribution_type === "agent")
  check("...and the PAID row is byte-identical — never updated, never deleted", JSON.stringify(rowsNow.find((r) => r.id === ORIG)) === before
    && !svc.writes.some((w) => w.table === "commission_distributions" && (w.op === "update" || w.op === "delete")))
  // Wave 100 (lane 100C — 98A open item / gap row 16): the SUMMARY rows are re-derived from the rows.
  const ac = svc.tables.agent_commissions.find((r) => r.id === "c1")
  const tcA = svc.tables.transaction_commissions.find((r) => r.id === "tc-a")
  const tcB = svc.tables.transaction_commissions.find((r) => r.id === "tc-b")
  check("the correction RE-STAMPS agent_commissions.net_to_agent (9000 → 8500) and the deal stamp's agent row, counted (1 + 1)",
    ac?.net_to_agent === 8500 && tcA?.calculated_amount === 8500 && (ok.data as any)?.summaries?.agentCommissions === 1 && (ok.data as any)?.summaries?.transactionStamps === 1)
  check("...and touches NOTHING of another type: net_to_brokerage and the brokerage stamp keep 1000",
    ac?.net_to_brokerage === 1000 && tcB?.calculated_amount === 1000)
  {
    const { summaryAmountFromDistributions, isSummarizedDistributionType } = await import("../lib/commission/distribution-correction")
    const rows = [{ distribution_type: "agent", calculated_amount: 9000 }, { distribution_type: "agent", calculated_amount: -500.05 }, { distribution_type: "fee", calculated_amount: 300 }]
    check("PURE: the summary is Σ of that type's rows in cents (9000 − 500.05 = 8499.95); other types ignored; re-running gives the same figure (derived, not incremented)",
      summaryAmountFromDistributions(rows, "agent") === 8499.95 && summaryAmountFromDistributions(rows, "agent") === summaryAmountFromDistributions(rows, "agent") && summaryAmountFromDistributions(rows, "brokerage") === 0)
    check("POSITIVE CONTROL: fee / referral / team_member have NO summary column (their corrections net in the rows only); agent + brokerage do",
      !isSummarizedDistributionType("fee") && !isSummarizedDistributionType("team_member") && isSummarizedDistributionType("agent") && isSummarizedDistributionType("brokerage"))
  }
  check("readers that SUM the entry's rows now see the corrected net (9000 + -500 = 8500)",
    rowsNow.filter((r) => r.agent_id === "a1" && r.distribution_type === "agent").reduce((s, r) => s + Number(r.calculated_amount), 0) === 8500)
  const again = await finKernel.correctCommissionDistribution({ ctx: ctxFor("broker"), distributionId: ORIG, kind: "reversal", reason: "reverse it all" })
  check("a second correction nets from the CORRECTED figure (reversal writes -8500)", !!again.success && again.data?.amount === -8500 && again.data?.netAfter === 0)
  check("...and the summaries follow it to 0 (re-derived from all three rows, not 8500 − 8500 applied to a stale cache)",
    svc.tables.agent_commissions.find((r) => r.id === "c1")?.net_to_agent === 0 && svc.tables.transaction_commissions.find((r) => r.id === "tc-a")?.calculated_amount === 0)
  const onCorrection = await finKernel.correctCommissionDistribution({ ctx: ctxFor("broker"), distributionId: added?.id as string, kind: "reversal", reason: "correct a correction" })
  check("correcting a correction row is refused", !onCorrection.success)

  // Wiring + migration (stripped source).
  const kernelSrc = stripComments(src("lib/kernel/financial.ts"))
  const cmd = kernelSrc.slice(kernelSrc.indexOf("export async function correctCommissionDistribution("))
  check("the command gates on the finance tier BEFORE it builds the service client (fail closed)",
    cmd.indexOf("isBrokerageFinanceAdmin(") > -1 && cmd.indexOf("isBrokerageFinanceAdmin(") < cmd.indexOf("createServiceClient()"))
  const action = stripComments(src("app/actions/financial-kernel.ts"))
  const actFn = action.slice(action.indexOf("export async function correctCommissionDistributionAction("), action.indexOf("export async function loadFinancialWorkspaceAction("))
  const actSig = actFn.slice(0, actFn.indexOf(") {"))
  check("the server action takes NO brokerage id and builds the actor from the session", actFn.length > 0 && !/brokerageId/.test(actSig) && /getFinancialActorContext\(\)/.test(actFn))
  const ui = stripComments(src("app/dashboard/transactions/[id]/cda/cda-workflow-client.tsx"))
  const dlg = stripComments(src("app/dashboard/transactions/[id]/cda/correct-entry-dialog.tsx"))
  check("the 'Correct entry' dialog is WIRED on the existing commission breakdown and calls the action",
    /<CorrectEntryDialog\b/.test(ui) && /Correct entry/.test(ui) && /correctCommissionDistributionAction\(/.test(dlg))
  const m690File = readdirSync(join(process.cwd(), "supabase/migrations")).find((f) => /^m690-/.test(f))
  const m690 = m690File ? stripComments(src(`supabase/migrations/${m690File}`)) : ""
  const NEG_ONLY_CORRECTIONS = /CHECK \(calculated_amount >= \(0\)::numeric OR entry_type <> 'entry'\)/
  check("m690: entry_type CHECK + adjusts_distribution_id self-FK + a correction must name its original and reason",
    /entry_type text NOT NULL DEFAULT 'entry'/.test(m690) && /adjusts_distribution_id uuid REFERENCES public\.commission_distributions\(id\)/.test(m690)
    && /entry_type <> 'entry'\s+AND adjusts_distribution_id IS NOT NULL/.test(m690))
  check("m690: only a correction row may be negative", NEG_ONLY_CORRECTIONS.test(m690))
  check("POSITIVE CONTROL: the negative-amount finder rejects the pre-m690 CHECK", !NEG_ONLY_CORRECTIONS.test("CHECK ((calculated_amount >= (0)::numeric))"))

  // ════ Wave 105 (lane 105E, owner ruling 1) — VOID an UNPAID entry IN PLACE; a PAID one is REFUSED to the
  // reversal/adjustment path. Rule, not waypoint: whatever the amounts, the row is preserved (status
  // 'voided' + voided_at + voided_reason stamped, amount untouched, never deleted), the actor rides the
  // ledger row, the audit event is written, and every Σ-over-rows reader drops the row.
  console.log("\n[VOID (105E) — an unpaid entry is voided in place; a paid one goes to reversal/adjustment]")
  const checkD = (n: string, c: boolean, d?: unknown) => { check(n, c); if (!c && d !== undefined) console.log("    ↳ " + (typeof d === "string" ? d : JSON.stringify(d))) }
  const { planDistributionVoid, VOID_REFUSED_PAID, MAX_VOID_REASON_LENGTH, isVoidedDistribution, summaryAmountFromDistributions: sumLive } = await import("../lib/commission/distribution-correction")
  const pendingE = { id: "v1", status: "pending", entry_type: "entry", paid_at: null, voided_at: null }
  check("a PAID entry is refused with the ONE spelling (paid distributions are corrected through reversal/adjustment)",
    (() => { const r = planDistributionVoid({ entry: { ...pendingE, status: "paid" }, corrections: [], reason: "duplicate" }); return !r.ok && r.error === VOID_REFUSED_PAID })())
  check("...and so is an 'approved' row that carries paid_at (settled money, whatever the status says)",
    (() => { const r = planDistributionVoid({ entry: { ...pendingE, status: "approved", paid_at: "2026-10-01T00:00:00Z" }, corrections: [], reason: "x" }); return !r.ok && r.error === VOID_REFUSED_PAID })())
  check("an already-voided row is refused", !planDistributionVoid({ entry: { ...pendingE, status: "voided", voided_at: "2026-10-01T00:00:00Z" }, corrections: [], reason: "again" }).ok)
  check("a correction row is never voided (it is posted the moment it is written)", !planDistributionVoid({ entry: { ...pendingE, entry_type: "adjustment" }, corrections: [], reason: "nope" }).ok)
  check("an entry referenced by a POSTED correction is refused to the reversal/adjustment path",
    (() => { const r = planDistributionVoid({ entry: pendingE, corrections: [{ status: "paid", paid_at: "2026-10-02T00:00:00Z" }], reason: "late" }); return !r.ok && r.error.includes(VOID_REFUSED_PAID) })())
  check("a reason is REQUIRED (blank refused)", !planDistributionVoid({ entry: pendingE, corrections: [], reason: "   " }).ok)
  check(`a reason over ${MAX_VOID_REASON_LENGTH} characters is refused; exactly ${MAX_VOID_REASON_LENGTH} is admitted`,
    !planDistributionVoid({ entry: pendingE, corrections: [], reason: "r".repeat(MAX_VOID_REASON_LENGTH + 1) }).ok && planDistributionVoid({ entry: pendingE, corrections: [], reason: "r".repeat(MAX_VOID_REASON_LENGTH) }).ok)
  check("pending and approved (no paid_at, no posted correction) are the two voidable states; the reason is trimmed",
    (() => { const a = planDistributionVoid({ entry: { ...pendingE, status: "approved" }, corrections: [{ status: "pending", paid_at: null }], reason: "  entered twice  " }); return a.ok && a.reason === "entered twice" && planDistributionVoid({ entry: pendingE, corrections: [], reason: "dup" }).ok })())
  {
    const rows = [{ distribution_type: "agent", calculated_amount: 9000, status: "paid" }, { distribution_type: "agent", calculated_amount: 2000, status: "voided" }, { distribution_type: "agent", calculated_amount: 100 }]
    check("PURE: the summary Σ DROPS a voided row through the ONE predicate (9000 + 2000(voided) + 100 → 9100); a row with no status counts as live",
      sumLive(rows, "agent") === 9100 && isVoidedDistribution(rows[1]) && !isVoidedDistribution(rows[2]))
    check("POSITIVE CONTROL: without the predicate the same rows would sum to 11100", rows.reduce((s, r) => s + r.calculated_amount, 0) === 11100)
  }

  // The REAL kernel command against the same in-memory ledger: a second commission (c2 / t2 / a2) so the
  // earlier assertions' rows are untouched.
  const VOID_ID = "d0000000-0000-4000-8000-000000000105", BRK_ROW = "d0000000-0000-4000-8000-000000000106"
  svc.tables.commission_distributions.push(
    { id: VOID_ID, brokerage_id: BRK, transaction_id: "t2", commission_id: "c2", agent_id: "a2", team_id: null, rule_id: null, distribution_type: "agent", source_of_funds: "brokerage", cap_status: "pre_cap", status: "pending", entry_type: "entry", calculated_amount: 2000, paid_at: null, voided_at: null, voided_reason: null },
    { id: BRK_ROW, brokerage_id: BRK, transaction_id: "t2", commission_id: "c2", agent_id: null, team_id: null, rule_id: null, distribution_type: "brokerage", source_of_funds: "brokerage", cap_status: null, status: "pending", entry_type: "entry", calculated_amount: 500, paid_at: null, voided_at: null, voided_reason: null },
  )
  svc.tables.agent_commissions.push({ id: "c2", brokerage_id: BRK, transaction_id: "t2", agent_id: "a2", net_to_agent: 2000, net_to_brokerage: 500, status: "pending" })
  svc.tables.transaction_commissions.push({ id: "tc2-a", brokerage_id: BRK, transaction_id: "t2", recipient_type: "agent", recipient_id: "a2", calculated_amount: 2000, status: "pending" })
  const distWrites = () => svc.writes.filter((w) => w.table === "commission_distributions" && w.op !== "insert").length
  const w0 = svc.writes.length, dw0 = distWrites()
  const vAgent = await finKernel.voidCommissionDistribution({ ctx: ctxFor("agent"), distributionId: VOID_ID, reason: "agent tries it" })
  check("VOID: a NON-finance role (agent) is refused, and nothing is written", !vAgent.success && svc.writes.length === w0)
  const vTl = await finKernel.voidCommissionDistribution({ ctx: ctxFor("team_lead"), distributionId: VOID_ID, reason: "team lead tries it" })
  check("...team_lead is refused too (BROKERAGE_FINANCE_ADMIN_USER_TYPES excludes it, m472)", !vTl.success && svc.writes.length === w0)
  const vCross = await finKernel.voidCommissionDistribution({ ctx: ctxFor("broker", OTHER), distributionId: VOID_ID, reason: "other tenant" })
  check("TENANT ISOLATION: another tenant's finance admin cannot reach the entry (session tenant pins the read)", !vCross.success && svc.writes.length === w0)
  const paidBefore = JSON.stringify(svc.tables.commission_distributions.find((r) => r.id === ORIG))
  const vPaid = await finKernel.voidCommissionDistribution({ ctx: ctxFor("broker"), distributionId: ORIG, reason: "void the paid one" })
  checkD("a PAID entry is REFUSED with the reversal/adjustment reason, byte-identical afterwards, no UPDATE/DELETE issued",
    !vPaid.success && vPaid.error === VOID_REFUSED_PAID && JSON.stringify(svc.tables.commission_distributions.find((r) => r.id === ORIG)) === paidBefore && distWrites() === dw0, vPaid)
  const vNoReason = await finKernel.voidCommissionDistribution({ ctx: ctxFor("broker"), distributionId: VOID_ID, reason: " " })
  check("a MISSING reason is refused before any write (no ledger claim, no update)", !vNoReason.success && svc.writes.length === w0)
  const rowCount = svc.tables.commission_distributions.length
  const ok105 = await finKernel.voidCommissionDistribution({ ctx: ctxFor("broker"), distributionId: VOID_ID, reason: "  entered twice at intake  " })
  const voidedRow = svc.tables.commission_distributions.find((r) => r.id === VOID_ID)
  checkD("a finance admin's void SUCCEEDS: status 'voided', voided_at stamped, voided_reason stamped (trimmed)", ok105.success === true
    && voidedRow?.status === "voided" && typeof voidedRow?.voided_at === "string" && voidedRow?.voided_reason === "entered twice at intake", ok105)
  check("...the row is PRESERVED — same count, amount untouched (2000), no delete ever issued",
    svc.tables.commission_distributions.length === rowCount && voidedRow?.calculated_amount === 2000 && !svc.writes.some((w) => w.table === "commission_distributions" && w.op === "delete"))
  const voidUpdate = svc.writes.find((w) => w.table === "commission_distributions" && w.op === "update" && w.payload.status === "voided")
  check("...the ONE update matched exactly one row and carried the three stamps together (§3: counted, not assumed)",
    !!voidUpdate && voidUpdate.matched === 1 && "voided_at" in voidUpdate.payload && "voided_reason" in voidUpdate.payload && Object.keys(voidUpdate.payload).length === 3)
  const ledgerRows = (svc.tables.agent_action_ledger ?? []).filter((r) => r.action === "finance.commission_distribution.void")
  checkD("LAW 5 evidence: ONE agent_action_ledger row — FINANCIAL, HUMAN_REQUESTED, the admin as actor, the reason as reason_detail, settled 'executed'",
    ledgerRows.length === 1 && ledgerRows[0].risk_class === "FINANCIAL" && ledgerRows[0].reason_code === "HUMAN_REQUESTED" && ledgerRows[0].actor_type === "user"
    && ledgerRows[0].actor_user_id === "u-fin" && ledgerRows[0].subject_id === VOID_ID && /entered twice at intake/.test(String(ledgerRows[0].reason_detail)) && ledgerRows[0].status === "executed" && ledgerRows[0].brokerage_id === BRK,
    ledgerRows)
  check("...the refused attempts above left NO ledger row (the gate and the plan run before the claim)", (svc.tables.agent_action_ledger ?? []).length === 1)
  const evRows = (svc.tables.lifecycle_events ?? []).filter((r) => r.entity_id === VOID_ID)
  checkD("the canonical COMMISSION_UPDATED event is written with metadata.change 'distribution_voided', the reason and the actor",
    evRows.length === 1 && evRows[0].event_type === "commission_updated" && evRows[0].metadata?.change === "distribution_voided" && evRows[0].metadata?.voidedReason === "entered twice at intake"
    && evRows[0].metadata?.voidedBy === "u-fin" && evRows[0].brokerage_id === BRK, evRows)
  const ac2 = svc.tables.agent_commissions.find((r) => r.id === "c2")
  checkD("PROJECTIONS reconciled: agent_commissions.net_to_agent re-derived WITHOUT the voided row (2000 → 0) and the deal stamp follows (counted 1 + 1); net_to_brokerage keeps 500",
    ac2?.net_to_agent === 0 && ac2?.net_to_brokerage === 500 && svc.tables.transaction_commissions.find((r) => r.id === "tc2-a")?.calculated_amount === 0
    && (ok105.data as any)?.summaries?.agentCommissions === 1 && (ok105.data as any)?.summaries?.transactionStamps === 1, (ok105.data as any)?.summaries)
  checkD("...and the read-only reconciler ran after the void and reports (checked / drifts / measured) with the result",
    !!(ok105.data as any)?.reconciliation && typeof (ok105.data as any).reconciliation.drifts === "number" && typeof (ok105.data as any).reconciliation.checked === "number", (ok105.data as any)?.reconciliation)
  const dw1 = distWrites()
  const vAgain = await finKernel.voidCommissionDistribution({ ctx: ctxFor("broker"), distributionId: VOID_ID, reason: "again" })
  check("voiding a voided row is refused — and the brokerage row of the same commission is untouched (pending, 500)",
    !vAgain.success && distWrites() === dw1 && svc.tables.commission_distributions.find((r) => r.id === BRK_ROW)?.status === "pending")

  // Wiring (stripped source) — the command, the action, the screen, the agent-facing absence, m716.
  const voidCmd = kernelSrc.slice(kernelSrc.indexOf("export async function voidCommissionDistribution("))
  check("the void command gates on the finance tier BEFORE it builds the service client, and the UPDATE sits INSIDE withActionLedger",
    voidCmd.indexOf("isBrokerageFinanceAdmin(") > -1 && voidCmd.indexOf("isBrokerageFinanceAdmin(") < voidCmd.indexOf("createServiceClient()")
    && voidCmd.indexOf("withActionLedger") > -1 && voidCmd.indexOf("withActionLedger") < voidCmd.indexOf('status: "voided"'))
  check("the void UPDATE never matches a paid / voided row (m689 is never hit) and is .select()ed to be counted",
    /\.update\(\{ status: "voided"[\s\S]{0,400}?\.not\("status", "in", '\("paid","voided"\)'\)[\s\S]{0,200}?\.is\("paid_at", null\)[\s\S]{0,200}?\.select\(/.test(voidCmd))
  const voidAct = action.slice(action.indexOf("export async function voidCommissionDistributionAction("), action.indexOf("export async function loadFinancialWorkspaceAction("))
  check("the void server action takes NO brokerage id and builds the actor from the session", voidAct.length > 0 && !/brokerageId/.test(voidAct.slice(0, voidAct.indexOf(") {"))) && /getFinancialActorContext\(\)/.test(voidAct))
  check("the 'Void entry' control is WIRED on the same breakdown, ONLY under the finance-admin gate, through the SAME pure eligibility rule; paid rows show the reversal/adjustment path",
    /canCorrectEntries && \([\s\S]*?isVoidEligibleEntry\([\s\S]*?<VoidEntryDialog\b/.test(ui) && /Correct via reversal\/adjustment/.test(ui) && /voidCommissionDistributionAction\(/.test(dlg) && /planDistributionVoid\(/.test(dlg))
  // Agent-facing surfaces never carry the void (§5: commission is off agent display): nothing under
  // app/portal or the agent brief names the command or the dialog.
  const walk = (dir: string): string[] => readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(`${dir}/${d.name}`) : /\.(ts|tsx)$/.test(d.name) ? [`${dir}/${d.name}`] : [])
  const VOID_TOKEN = /voidCommissionDistribution|VoidEntryDialog/
  const agentFiles = [...walk("app/portal"), "lib/intelligence/user-type-briefs/index.ts", "lib/intelligence/user-type-briefs/agent.ts"].filter((f) => { try { readFileSync(join(process.cwd(), f)); return true } catch { return false } })
  const agentHits = agentFiles.filter((f) => VOID_TOKEN.test(stripComments(src(f))))
  checkD(`no agent / portal surface names the void (${agentFiles.length} files scanned, 0 hits)`, agentFiles.length > 5 && agentHits.length === 0, agentHits.join(","))
  check("POSITIVE CONTROL: the same scanner finds the control on the finance-gated breakdown", VOID_TOKEN.test(ui))
  const m716File = readdirSync(join(process.cwd(), "supabase/migrations")).find((f) => /^m716-/.test(f))
  const m716 = m716File ? stripComments(src(`supabase/migrations/${m716File}`)) : ""
  const VOIDED_SHAPE = /CHECK \(\s*status <> 'voided'\s+OR \(\s*voided_at IS NOT NULL\s+AND voided_reason IS NOT NULL\s+AND length\(btrim\(voided_reason\)\) > 0\s+AND length\(voided_reason\) <= 500\s*\)\s*\)/
  check("m716: a voided row must carry voided_at + a 1..500-char voided_reason (CHECK, added NOT VALID then VALIDATEd in two parts)",
    VOIDED_SHAPE.test(m716) && /NOT VALID/.test(m716) && /VALIDATE CONSTRAINT commission_distributions_voided_shape_check/.test(m716))
  check("POSITIVE CONTROL: the shape finder rejects a CHECK that forgets the reason", !VOIDED_SHAPE.test("CHECK (status <> 'voided' OR (voided_at IS NOT NULL))"))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ COMMISSION_SET_IN_STONE_FAIL"); process.exit(1) }
  console.log(" ✅ COMMISSION_SET_IN_STONE_PASS — close FREEZES the amount; the ledger tracks deposit→disbursement; paid is stamped at disbursement, not close")
}
main().catch((e) => { console.error(e); process.exit(1) })
