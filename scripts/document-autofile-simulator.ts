#!/usr/bin/env tsx
/**
 * scripts/document-autofile-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AI AUTO-FILING CLERK harness — classify an uploaded document and file it to the
 * correct deal folder (in-app canonical filing: doc_category + document_type +
 * transaction_id on the client_documents row).
 *
 * Layer 1 (pure, no I/O): classifyDocumentType across the canonical doc_category
 *   enum (purchase agreement / disclosure / inspection / pre-approval / contract /
 *   title / appraisal / ID→other / …), confidence tiers, and a low-confidence
 *   unknown → {other, low}; resolveDealFolder (already-on-deal / matched-by-contact /
 *   no-contact / no-open-deal / ambiguous).
 * Layer 2 (live, gated): seed an UNFILED client_documents row + an open transaction
 *   linked by contact → runAutoFile with an INJECTED classifier → assert the doc is
 *   FILED (doc_category + document_type + transaction_id set) and recorded on
 *   lifecycle_events; a LOW-confidence doc → left UNFILED + flagged (no misfile);
 *   idempotent rerun; reverse-delete + cleanup count == 0.
 *
 * Run: npx tsx scripts/document-autofile-simulator.ts  (npm run test:document-autofile)
 */
import {
  classifyDocumentType,
  resolveDealFolder,
  DOC_CATEGORIES,
  isDocCategory,
  AUTOFILE_EVENT,
  AUTOFILE_FLAGGED_EVENT,
  type DocCategory,
  type DealRow,
  type DocClassification,
} from "../lib/kernel/document-autofile"

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
  console.log(" ✅ Auto-Filing Clerk verified — classify + resolve deal + file + flag low-confidence + idempotent")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" AI Auto-Filing Clerk simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure classify across canonical doc types]")

  // Every classification must land on the canonical enum.
  const cases: Array<{ name: string; expect: DocCategory; minConf?: "high" | "medium" }> = [
    { name: "2026-06-01_Purchase Agreement_44 Birch.pdf", expect: "offer_form", minConf: "medium" },
    { name: "PSA - 12 Oak St signed.pdf", expect: "offer_form", minConf: "medium" },
    { name: "Counter Offer #2.pdf", expect: "offer_form" },
    { name: "Sellers Property Disclosure.pdf", expect: "disclosure", minConf: "medium" },
    { name: "Lead-Based Paint Disclosure.pdf", expect: "disclosure" },
    { name: "Home Inspection Report - full.pdf", expect: "inspection_report", minConf: "medium" },
    { name: "Pre-Approval Letter - Wells Fargo.pdf", expect: "pre_approval_letter", minConf: "medium" },
    { name: "preapproval_buyer.pdf", expect: "pre_approval_letter" },
    { name: "Proof of Funds statement.pdf", expect: "proof_of_funds" },
    { name: "Addendum to Purchase Agreement.pdf", expect: "offer_form" }, // "purchase agreement" is most-specific
    { name: "Buyer Agency Agreement.pdf", expect: "contract" },
    { name: "Appraisal Report URAR.pdf", expect: "appraisal" },
    { name: "Preliminary Title Report.pdf", expect: "title" },
    { name: "Closing Disclosure final.pdf", expect: "title" },
    { name: "Homeowners Insurance Declarations.pdf", expect: "insurance" },
    { name: "2024 Tax Return 1040.pdf", expect: "tax_return" },
    { name: "Gift Letter from parents.pdf", expect: "gift_letter" },
  ]
  for (const c of cases) {
    const r = classifyDocumentType(c.name)
    check(`classify "${c.name}" → ${c.expect}`, r.documentType === c.expect, `got ${r.documentType} (${r.confidence})`)
    check(`  on canonical enum`, isDocCategory(r.documentType))
    if (c.minConf) {
      const ok = c.minConf === "high" ? r.confidence === "high" : r.confidence !== "low"
      check(`  confidence ≥ ${c.minConf}`, ok, `got ${r.confidence}`)
    }
  }

  // Government ID → other (no id_document folder), recognized explicitly.
  const idr = classifyDocumentType("Drivers License - buyer.jpg")
  check("ID document → other (no id_document folder; recognized)", idr.documentType === "other" && idr.signals.some((s) => s.includes("ID")))

  // Multiple corroborating signals → HIGH confidence.
  const hi = classifyDocumentType("Residential Purchase Agreement and Counter Offer.pdf")
  check("multiple matches → HIGH confidence", hi.documentType === "offer_form" && hi.confidence === "high", `got ${hi.confidence}`)

  // LOW-confidence unknown → {other, low} (the clerk will leave it unfiled).
  const lo = classifyDocumentType("scan0001.pdf")
  check("unrecognized name → {other, low}", lo.documentType === "other" && lo.confidence === "low", `got ${lo.documentType}/${lo.confidence}`)
  const lo2 = classifyDocumentType("")
  check("empty name → {other, low}", lo2.documentType === "other" && lo2.confidence === "low")

  // Declared category (uploader/extractor) is a HIGH prior, coerced onto the enum.
  const dec = classifyDocumentType("random.pdf", { declaredCategory: "purchase agreement" })
  check("declared 'purchase agreement' → offer_form HIGH", dec.documentType === "offer_form" && dec.confidence === "high")
  const decEnum = classifyDocumentType("random.pdf", { declaredCategory: "inspection_report" })
  check("declared canonical value respected", decEnum.documentType === "inspection_report" && decEnum.confidence === "high")

  // Financial-verification hint corroborates a money doc when the name is thin.
  const fin = classifyDocumentType("statement.pdf", { isFinancialVerification: true })
  check("financial-verification hint → proof_of_funds (medium)", fin.documentType === "proof_of_funds" && fin.confidence === "medium", `got ${fin.documentType}/${fin.confidence}`)

  console.log("\n[Layer 1 · pure resolve deal folder]")

  const deals: DealRow[] = [
    { id: "txA", contact_id: "c1", buyer_contact_id: null, seller_contact_id: null, status: "active" },
    { id: "txB", contact_id: null, buyer_contact_id: "c2", seller_contact_id: null, status: "under_contract" },
    { id: "txC", contact_id: null, buyer_contact_id: null, seller_contact_id: "c2", status: "closed" }, // closed — excluded
    { id: "txD", contact_id: "c3", buyer_contact_id: null, seller_contact_id: null, status: "active" },
    { id: "txE", contact_id: "c3", buyer_contact_id: null, seller_contact_id: null, status: "active" }, // c3 ambiguous
  ]
  check("already-on-deal → keep stamped transaction_id",
    resolveDealFolder({ id: "d", transaction_id: "txZ", contact_id: "c1" }, deals).transactionId === "txZ")
  check("matched by contact (legacy contact_id link)",
    resolveDealFolder({ id: "d", transaction_id: null, contact_id: "c1" }, deals).transactionId === "txA")
  const buyerMatch = resolveDealFolder({ id: "d", transaction_id: null, contact_id: "c2" }, deals)
  check("matched by buyer side; CLOSED deal excluded → single open match txB",
    buyerMatch.transactionId === "txB" && buyerMatch.reason === "matched_by_contact")
  check("no contact → null (no_contact)",
    resolveDealFolder({ id: "d", transaction_id: null, contact_id: null }, deals).reason === "no_contact")
  check("contact with no open deal → null (no_open_deal_for_contact)",
    resolveDealFolder({ id: "d", transaction_id: null, contact_id: "c99" }, deals).reason === "no_open_deal_for_contact")
  const amb = resolveDealFolder({ id: "d", transaction_id: null, contact_id: "c3" }, deals)
  check("contact on >1 open deal → ambiguous, null (never guess)",
    amb.transactionId === null && amb.reason === "ambiguous_multiple_open_deals")

  // ───────────────────────────────────────────────────────────────────────────
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live auto-file]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live auto-file]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runAutoFile, runAutoFileSweep } = await import("../lib/kernel/document-autofile")
  const svc = createServiceClient()
  const TAG = `Autofile${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent with a brokerage."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // A contact who is the buyer on one open deal — the doc files to THAT deal.
    const { data: contact } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: TAG, last_name: "Buyer", contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (contact as any).id })

    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} 44 Birch St`, status: "under_contract",
      agent_id: (agent as any).id, buyer_contact_id: (contact as any).id,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })

    // UNFILED upload: doc_category NULL, contact set, NO transaction stamped yet.
    const { data: pdoc } = await svc.from("client_documents").insert({
      brokerage_id: brokerageId, contact_id: (contact as any).id,
      document_name: `${TAG} Residential Purchase Agreement - 44 Birch.pdf`,
      document_url: "https://example.test/psa.pdf",
    }).select("id").single()
    const docId = (pdoc as any).id
    cleanup.push({ table: "client_documents", id: docId })

    // INJECTED classifier — deterministic, no token spend (mirrors a confident gateway).
    const inject = {
      classifier: async (input: { filename: string }): Promise<DocClassification> =>
        classifyDocumentType(input.filename),
    }

    const r1 = await runAutoFile({ documentId: docId }, inject, svc)
    check("runAutoFile: outcome 'filed'", r1.outcome === "filed", JSON.stringify(r1))
    check("runAutoFile: classified offer_form", r1.documentType === "offer_form", String(r1.documentType))
    check("runAutoFile: resolved the deal by contact", r1.transactionId === (txn as any).id && r1.dealReason === "matched_by_contact", JSON.stringify(r1))

    // The row is FILED: doc_category + document_type + transaction_id all set.
    const { data: filed } = await svc.from("client_documents")
      .select("doc_category, document_type, transaction_id, ai_metadata").eq("id", docId).single()
    check("row filed: doc_category = offer_form (canonical enum)", (filed as any)?.doc_category === "offer_form")
    check("row filed: document_type folder key set", (filed as any)?.document_type === "offer_form")
    check("row filed: transaction_id stamped to the deal", (filed as any)?.transaction_id === (txn as any).id)
    check("row filed: ai_metadata.autofile audit (status filed, drive_synced false)",
      (filed as any)?.ai_metadata?.autofile?.status === "filed" && (filed as any)?.ai_metadata?.autofile?.drive_synced === false)

    // The filing is RECORDED on lifecycle_events.
    const { data: ev } = await svc.from("lifecycle_events")
      .select("id, event_type, entity_type, entity_id, payload")
      .eq("entity_id", docId).eq("event_type", AUTOFILE_EVENT).maybeSingle()
    if (ev) cleanup.push({ table: "lifecycle_events", id: (ev as any).id })
    check("filing recorded on lifecycle_events (document.auto_filed)",
      !!ev && (ev as any).entity_type === "document" && (ev as any).payload?.document_type === "offer_form")

    // IDEMPOTENT — rerun does not re-file (already carries a canonical doc_category).
    const r2 = await runAutoFile({ documentId: docId }, inject, svc)
    check("idempotent: rerun → already_filed, no second event", r2.outcome === "already_filed")
    const { count: evCount } = await svc.from("lifecycle_events")
      .select("id", { count: "exact", head: true }).eq("entity_id", docId).eq("event_type", AUTOFILE_EVENT)
    check("idempotent: exactly ONE auto_filed event", (evCount ?? 0) === 1, `got ${evCount}`)

    // LOW-confidence doc → left UNFILED + flagged, NO misfile.
    const { data: ldoc } = await svc.from("client_documents").insert({
      brokerage_id: brokerageId, contact_id: (contact as any).id,
      document_name: `${TAG} scan_0007.pdf`, document_url: "https://example.test/scan.pdf",
    }).select("id").single()
    const lowId = (ldoc as any).id
    cleanup.push({ table: "client_documents", id: lowId })

    const lr = await runAutoFile({ documentId: lowId }, inject, svc)
    check("low-confidence: outcome 'flagged'", lr.outcome === "flagged", JSON.stringify(lr))
    const { data: lowRow } = await svc.from("client_documents")
      .select("doc_category, transaction_id, ai_metadata").eq("id", lowId).single()
    check("low-confidence: doc_category STILL NULL (NOT misfiled)", (lowRow as any)?.doc_category === null)
    check("low-confidence: transaction_id NOT stamped", (lowRow as any)?.transaction_id === null)
    check("low-confidence: ai_metadata.autofile.status = needs_review",
      (lowRow as any)?.ai_metadata?.autofile?.status === "needs_review")
    const { data: lev } = await svc.from("lifecycle_events")
      .select("id").eq("entity_id", lowId).eq("event_type", AUTOFILE_FLAGGED_EVENT).maybeSingle()
    if (lev) cleanup.push({ table: "lifecycle_events", id: (lev as any).id })
    check("low-confidence: needs-review event recorded", !!lev)

    // The SWEEP path — runs over unfiled docs; the low-confidence one is the only one
    // still unfiled (offer_form already filed), so it gets flagged, nothing misfiled.
    const sweep = await runAutoFileSweep(brokerageId, inject, svc, { lookbackHours: 1, limit: 50 })
    check("sweep: ran over the brokerage's unfiled queue (scanned ≥ 1)", sweep.scanned >= 1, JSON.stringify(sweep))
    check("sweep: no errors", sweep.errors.length === 0, sweep.errors.join("; "))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count: docCount } = await svc.from("client_documents").select("id", { count: "exact", head: true }).like("document_name", `${TAG}%`)
    const { count: txCount } = await svc.from("transactions").select("id", { count: "exact", head: true }).like("deal_name", `${TAG}%`)
    check("cleanup verified — 0 seeded documents + transactions remain", (docCount ?? 0) === 0 && (txCount ?? 0) === 0, `docs=${docCount} txns=${txCount}`)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
