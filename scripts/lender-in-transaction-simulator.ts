#!/usr/bin/env tsx
/**
 * scripts/lender-in-transaction-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LENDERS ARE VENDORS. A lender in a transaction is a vendor (vendors.category
 * 'Lender') assigned through the vendor rail (vendor_assignments) + a
 * transaction_lenders financing row — NOT a separate user_type/portal identity.
 * This consolidation retired the dead lender_portal_users identity rail (0 rows
 * live) and re-keyed the financing capability (clear-to-close, appraisal, loan
 * status, rate-lock) onto the vendor-in-transaction, which also makes the lender
 * INHERIT the RESPA settlement-service disclosure/kickback gates.
 *
 * Layer 1 (pure): isLenderVendorCategory (Lender/mortgage/loan-officer → true;
 *   inspector/stager → false); lenderFilterIds (empty → safe sentinel).
 * Layer 2 (source): assignLenderToTransaction links via linkLenderVendorToTransaction
 *   (vendor_assignments + transaction_lenders), never lender_portal_users; the
 *   financing actions gate via requireLenderVendorActor(transactionId); the lender
 *   reads scope by vendor assignments; the assign UI lists lender VENDORS.
 * Layer 3 (live, gated): seed a Lender vendor + a transaction → linkLenderVendorToTransaction
 *   → assert a vendor_assignments (assignment_type 'lender') + transaction_lenders
 *   row exist, resolveLenderVendorForTransaction returns the vendor, the lender is
 *   RESPA-regulated (inherits the gate), and the deal is found via the vendor's
 *   assigned transaction ids. Idempotent. Cleans up; verifies count == 0.
 *
 * Run: npx tsx scripts/lender-in-transaction-simulator.ts  (npm run test:lender-in-transaction)
 */
import {
  isLenderVendorCategory,
  lenderFilterIds,
  LENDER_VENDOR_CATEGORY,
} from "../lib/kernel/lender-linkage"
import { readFileSync } from "node:fs"
import { join } from "node:path"

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
  console.log(" ✅ Lenders-are-vendors verified — vendor-rail identity + financing capability + RESPA inheritance")
  console.log(" LENDER_IN_TRANSACTION_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lender-is-a-vendor (transaction financing) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure category + filter]")
  check("LENDER_VENDOR_CATEGORY is 'Lender'", LENDER_VENDOR_CATEGORY === "Lender")
  check("isLenderVendorCategory: Lender / mortgage / loan officer → true",
    isLenderVendorCategory("Lender") && isLenderVendorCategory("Mortgage Broker") && isLenderVendorCategory("loan officer"))
  check("isLenderVendorCategory: inspector / stager / null → false",
    !isLenderVendorCategory("Inspector") && !isLenderVendorCategory("Stager") && !isLenderVendorCategory(null))
  check("lenderFilterIds([]) → safe sentinel; passes real ids through",
    lenderFilterIds([]).length === 1 && JSON.stringify(lenderFilterIds(["a"])) === JSON.stringify(["a"]))

  console.log("\n[Layer 2 · the vendor rail is the single source of truth]")
  const actionSrc = readFileSync(join(process.cwd(), "app/actions/multi-persona.ts"), "utf8")
  check("assignLenderToTransaction links via linkLenderVendorToTransaction (vendor rail)",
    /linkLenderVendorToTransaction\(/.test(actionSrc) && !/linkLenderToTransaction\(/.test(actionSrc))
  check("assignLenderToTransaction rejects a non-lender vendor / cross-brokerage",
    /is not a lender/.test(actionSrc) && /another brokerage/.test(actionSrc))

  const authSrc = readFileSync(join(process.cwd(), "lib/kernel/portal-auth.ts"), "utf8")
  check("requireLenderVendorActor gates by vendor identity + assignment (no lender_portal_users query)",
    /requireLenderVendorActor/.test(authSrc) && /vendor_assignments/.test(authSrc) && !/from\("lender_portal_users"\)/.test(authSrc))

  const lpSrc = readFileSync(join(process.cwd(), "app/actions/lender-portal-actions.ts"), "utf8")
  check("financing actions (CTC / docs / status) gate via requireLenderVendorActor(transactionId)",
    /requireLenderVendorActor\(data\.transactionId\)|requireLenderVendorActor\(transactionId\)/.test(lpSrc) &&
    !/requireLenderActor\b/.test(lpSrc))

  const linkSrc = readFileSync(join(process.cwd(), "lib/kernel/lender-linkage.ts"), "utf8")
  check("linkLenderVendorToTransaction writes vendor_assignments (assignment_type 'lender') + ensures transaction_lenders",
    /assignment_type:\s*"lender"/.test(linkSrc) && /transaction_lenders/.test(linkSrc))

  const briefSrc = readFileSync(join(process.cwd(), "lib/intelligence/user-type-briefs/tc-compliance-lender-vendor.ts"), "utf8")
  check("lender brief scopes by the vendor's assigned transaction ids (not lender_portal_users)",
    /lenderVendorTransactionIds\(/.test(briefSrc) && !/lenderPortalRowIdsForUser/.test(briefSrc))

  // RESPA inheritance — a Lender vendor is a settlement service.
  const { isRespaRegulatedCategory } = await import("../lib/compliance/vendor-respa")
  check("a Lender vendor INHERITS the RESPA settlement-service gate",
    isRespaRegulatedCategory("Lender") === true)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live vendor-rail link]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const {
    linkLenderVendorToTransaction, resolveLenderVendorForTransaction,
    lenderVendorTransactionIds, lenderFilterIds: filterIds,
  } = await import("../lib/kernel/lender-linkage")
  const svc = createServiceClient()
  const TAG = `LenderVend${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 3 · live vendor-rail link]")
  try {
    const { data: agent } = await svc.from("agents").select("id, brokerage_id")
      .not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need a brokerage."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // Seed a LENDER vendor (a lender IS a vendor).
    const { data: vendor, error: vErr } = await svc.from("vendors").insert({
      brokerage_id: brokerageId, name: `${TAG} Capital`, category: "Lender", email: `${TAG}@lender.local`.toLowerCase(),
    }).select("id").single()
    if (vErr) { check("seed lender vendor", false, vErr.message); report(); return }
    const vendorId = (vendor as any).id
    cleanup.push({ table: "vendors", id: vendorId })

    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} deal`, deal_type: "buyer",
      status: "active", stage: "FINANCING_PENDING", property_address: `${TAG} 1 Loan St`,
      agent_id: (agent as any).id,
    }).select("id").single()
    if (!txn) { check("seed transaction", false); report(); return }
    const transactionId = (txn as any).id
    cleanup.push({ table: "transactions", id: transactionId })

    // THE LINK — exactly what assignLenderToTransaction does.
    const link = await linkLenderVendorToTransaction(svc, {
      vendorId, transactionId, brokerageId, lenderName: `${TAG} Capital`,
    })
    check("linkLenderVendorToTransaction succeeded", link.ok && !!link.assignmentId, link.error)
    if (link.assignmentId) cleanup.push({ table: "vendor_assignments", id: link.assignmentId })

    // vendor_assignments (lending) exists.
    const { data: va } = await svc.from("vendor_assignments")
      .select("vendor_id, transaction_id, brokerage_id, assignment_type, status").eq("id", link.assignmentId!).single()
    check("vendor_assignments: lending grant with vendor + transaction + brokerage",
      (va as any)?.vendor_id === vendorId && (va as any)?.transaction_id === transactionId &&
      (va as any)?.brokerage_id === brokerageId && (va as any)?.assignment_type === "lender",
      JSON.stringify(va))

    // transaction_lenders financing row ensured.
    const { data: tl } = await svc.from("transaction_lenders")
      .select("id, transaction_id, lender_name").eq("transaction_id", transactionId).maybeSingle()
    if (tl) cleanup.push({ table: "transaction_lenders", id: (tl as any).id })
    check("transaction_lenders financing row ensured (lender_name from the vendor)",
      !!tl && (tl as any).lender_name === `${TAG} Capital`)

    // resolveLenderVendorForTransaction returns THIS vendor.
    const resolved = await resolveLenderVendorForTransaction(svc, transactionId)
    check("resolveLenderVendorForTransaction returns the lender vendor",
      resolved?.vendorId === vendorId && resolved?.brokerageId === brokerageId, JSON.stringify(resolved))

    // The lender sees the deal via its assigned transaction ids.
    const txnIds = filterIds(await lenderVendorTransactionIds(svc, vendorId, brokerageId))
    check("lender vendor's assigned transaction ids include this deal", txnIds.includes(transactionId))

    // RESPA inheritance (live category).
    const { isRespaRegulatedCategory } = await import("../lib/compliance/vendor-respa")
    check("lender vendor is a RESPA settlement service (inherits disclosure/kickback gate)",
      isRespaRegulatedCategory("Lender") === true)

    // Idempotent re-link — reuses the single assignment.
    const link2 = await linkLenderVendorToTransaction(svc, { vendorId, transactionId, brokerageId, lenderName: `${TAG} Capital` })
    check("idempotent re-link reuses the same assignment (no duplicate per vendor+transaction)",
      link2.ok && link2.assignmentId === link.assignmentId)
    const { count } = await svc.from("vendor_assignments")
      .select("id", { count: "exact", head: true }).eq("vendor_id", vendorId).eq("transaction_id", transactionId)
    check("exactly ONE lending assignment per (vendor, transaction)", (count ?? 0) === 1, `count=${count}`)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("vendors").select("id", { count: "exact", head: true }).ilike("name", `${TAG}%`)
    const { count: tCount } = await svc.from("transactions").select("id", { count: "exact", head: true }).like("deal_name", `${TAG}%`)
    check("cleanup verified — 0 seeded rows remain", (count ?? 0) === 0 && (tCount ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
