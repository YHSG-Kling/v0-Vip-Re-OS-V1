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

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ COMMISSION_SET_IN_STONE_FAIL"); process.exit(1) }
  console.log(" ✅ COMMISSION_SET_IN_STONE_PASS — close FREEZES the amount; the ledger tracks deposit→disbursement; paid is stamped at disbursement, not close")
}
main().catch((e) => { console.error(e); process.exit(1) })
