#!/usr/bin/env tsx
/**
 * scripts/final-compliance-check-simulator.ts   (npm run test:final-compliance-check)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the FINAL compliance check that gates CDA submission: the deal is clear
 * only when every signature/initial is complete, all required docs are provided,
 * none were rejected, and no blocking compliance check is open. Pure classifier +
 * (creds-gated) live runner that seeds incomplete state, asserts it blocks, then
 * completes it and asserts it passes — cleaned up to 0.
 */
import { evaluateFinalCompliance } from "../lib/transactions/final-compliance-check"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

async function main() {
  console.log("\n[pure verdict — evaluateFinalCompliance]")
  check("all clear → passed", evaluateFinalCompliance({ pendingSignatures: 0, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 0 }).passed)
  const sig = evaluateFinalCompliance({ pendingSignatures: 2, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 0 })
  check("pending signatures → blocked", !sig.passed && sig.blockers.some((b) => /signature/i.test(b)))
  const doc = evaluateFinalCompliance({ pendingSignatures: 0, missingDocs: 1, rejectedDocs: 0, blockingComplianceFailures: 0 })
  check("missing docs → blocked", !doc.passed && doc.blockers.some((b) => /document/i.test(b)))
  const rej = evaluateFinalCompliance({ pendingSignatures: 0, missingDocs: 0, rejectedDocs: 1, blockingComplianceFailures: 0 })
  check("rejected docs → blocked", !rej.passed && rej.blockers.some((b) => /rejected/i.test(b)))
  const comp = evaluateFinalCompliance({ pendingSignatures: 0, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 3 })
  check("blocking compliance → blocked", !comp.passed && comp.blockers.some((b) => /compliance/i.test(b)))
  const all = evaluateFinalCompliance({ pendingSignatures: 1, missingDocs: 1, rejectedDocs: 1, blockingComplianceFailures: 1 })
  check("multiple issues → all 4 blockers listed", all.blockers.length === 4)
  check("singular/plural grammar", evaluateFinalCompliance({ pendingSignatures: 1, missingDocs: 0, rejectedDocs: 0, blockingComplianceFailures: 0 }).blockers[0].includes("1 signature request "))

  // ── LIVE LAYER (creds-gated) ──
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] ⏭  Skipped — SUPABASE creds not set (pure layer ran).")
  } else {
    console.log("\n[live] incomplete state blocks → complete it → passes → cleanup")
    const { createServiceClient } = await import("../lib/supabase/service")
    const { runFinalComplianceCheck } = await import("../lib/transactions/final-compliance-check")
    const svc = createServiceClient()
    const { data: c } = await svc.from("contacts").select("id, brokerage_id").limit(1).maybeSingle()
    if (!c) { console.log("  ⏭  no brokerage/contact available") }
    else {
      const { data: txn } = await svc.from("transactions").insert({
        brokerage_id: c.brokerage_id, contact_id: c.id, status: "closing", deal_name: "LIVE final compliance",
      }).select("id").maybeSingle()
      // Seed an INCOMPLETE state: one pending signature + one missing doc.
      const { data: sigReq } = await svc.from("signature_requests").insert({
        brokerage_id: c.brokerage_id, transaction_id: txn!.id, request_status: "pending",
      }).select("id").maybeSingle()
      const { data: missDoc } = await svc.from("transaction_documents").insert({
        brokerage_id: c.brokerage_id, transaction_id: txn!.id, status: "missing", doc_type: "disclosure", doc_label: "LIVE",
      }).select("id").maybeSingle()
      try {
        const blocked = await runFinalComplianceCheck(txn!.id, c.brokerage_id, svc)
        check("live: incomplete state blocks submission", !blocked.passed && blocked.blockers.length >= 2)
        // Complete it: sign + provide the doc.
        await svc.from("signature_requests").update({ request_status: "completed", completed_at: new Date().toISOString() }).eq("id", sigReq!.id)
        await svc.from("transaction_documents").update({ status: "approved" }).eq("id", missDoc!.id)
        const cleared = await runFinalComplianceCheck(txn!.id, c.brokerage_id, svc)
        check("live: completed state passes (no signature/doc blockers)", !cleared.blockers.some((b) => /signature|document|rejected/i.test(b)))
        // cleanup
        await svc.from("signature_requests").delete().eq("id", sigReq!.id)
        await svc.from("transaction_documents").delete().eq("id", missDoc!.id)
        await svc.from("transactions").delete().eq("id", txn!.id)
        const { count } = await svc.from("transactions").select("id", { count: "exact", head: true }).eq("id", txn!.id)
        check("live: cleanup count == 0", (count ?? 0) === 0)
      } catch (e) {
        await svc.from("signature_requests").delete().eq("id", sigReq?.id ?? "").then(() => {}, () => {})
        await svc.from("transaction_documents").delete().eq("id", missDoc?.id ?? "").then(() => {}, () => {})
        await svc.from("transactions").delete().eq("id", txn?.id ?? "").then(() => {}, () => {})
        throw e
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ FINAL_COMPLIANCE_CHECK_FAIL"); process.exit(1) }
  console.log(" ✅ FINAL_COMPLIANCE_CHECK_PASS — CDA submission gated on signatures + docs + compliance")
}
main()
