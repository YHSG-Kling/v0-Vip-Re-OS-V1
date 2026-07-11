#!/usr/bin/env tsx
/**
 * scripts/doc-kernel-simulator.ts   (npm run test:doc-kernel)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DOCUMENT KERNEL PROOF — program item #3, Phase A: scanned deal
 * documents become GOVERNED action. Per-field extraction ledger +
 * green/amber/red policy decisions + document-derived deadlines with
 * source provenance, on the EXISTING transaction_deadlines rail.
 *
 * Layer 1 (pure): the policy verdicts (conflict ALWAYS ambers; low
 * confidence never acts; additive green only), date parsing, and the
 * candidate planner (past-event dates are records, not deadlines).
 * Layer 2 (source locks): scanner hook wired, keep-one rail (canonical
 * deadline_type vocabulary; no parallel table), signal registered with a
 * classifier-matching kind, registry ownership, snapshot columns, UI
 * provenance badge.
 * Layer 3 (live, creds-gated): seed a real transaction + scanned
 * document → run the derivation → assert the extraction ledger, the
 * policy ledger, the derived deadline with provenance, the amber
 * conflict signal — then clean to count==0.
 */
import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { decideDeadlinePolicy } from "../lib/documents/policy-decisions"
import { deriveDeadlineCandidates, parseDocDate } from "../lib/documents/deadline-derivation"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf-8") : "")

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Document kernel simulator (extraction ledger + policy + deadlines)")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[1 · pure — the green/amber/red policy]")
  check("no usable date → RED, nothing moves",
    decideDeadlinePolicy({ confidence: "high", derivedDate: null, existingDate: null }).decision === "red")
  check("a CONFLICT always ambers — even a high-confidence scan never silently moves a tracked date",
    decideDeadlinePolicy({ confidence: "high", derivedDate: "2026-08-01", existingDate: "2026-07-15" }).decision === "amber"
    && decideDeadlinePolicy({ confidence: "high", derivedDate: "2026-08-01", existingDate: "2026-07-15" }).recommendedAction === "confirm_deadline_correction"
    && decideDeadlinePolicy({ confidence: "high", derivedDate: "2026-08-01", existingDate: "2026-07-15" }).requiredApproverRole === "tc")
  check("document confirms the tracked date → GREEN stamp_source_provenance (evidence, not a rewrite)",
    decideDeadlinePolicy({ confidence: "medium", derivedDate: "2026-07-15", existingDate: "2026-07-15" }).recommendedAction === "stamp_source_provenance")
  check("high confidence + nothing tracked → GREEN insert (additive-only autonomy)",
    decideDeadlinePolicy({ confidence: "high", derivedDate: "2026-08-01", existingDate: null }).recommendedAction === "insert_deadline")
  check("medium → AMBER propose (human confirms); low → RED (rescan first)",
    decideDeadlinePolicy({ confidence: "medium", derivedDate: "2026-08-01", existingDate: null }).decision === "amber"
    && decideDeadlinePolicy({ confidence: "low", derivedDate: "2026-08-01", existingDate: null }).decision === "red")
  check("every verdict carries REASONS (the ledger is explainable, never a bare color)",
    decideDeadlinePolicy({ confidence: "low", derivedDate: "2026-08-01", existingDate: null }).reasons.length > 0
    && decideDeadlinePolicy({ confidence: "high", derivedDate: "2026-08-01", existingDate: "2026-07-15" }).reasons.some((r) => r.includes("2026-08-01") && r.includes("2026-07-15")))

  console.log("\n[2 · pure — dates + deadline candidates]")
  check("parseDocDate: ISO, prose date, garbage",
    parseDocDate("2026-08-15") === "2026-08-15"
    && parseDocDate("August 15, 2026") === "2026-08-15"
    && parseDocDate("N/A") === null && parseDocDate("") === null && parseDocDate(42 as any) === null)
  const contract = deriveDeadlineCandidates("signed_contract", {
    contract_effective_date: "2026-07-01", earnest_money_due_days: 3, price: 500000,
  })
  check("signed contract: effective date + EM window → earnest_money deadline on the CANONICAL type",
    contract.length === 1 && contract[0].deadlineType === "earnest_money" && contract[0].date === "2026-07-04"
    && contract[0].fieldKey === "earnest_money_due_days")
  check("closing disclosure → closing; PAL → pre_approval_expiration; commission agreement → its expiration",
    deriveDeadlineCandidates("closing_disclosure", { closing_date: "2026-09-30" })[0]?.deadlineType === "closing"
    && deriveDeadlineCandidates("pre_approval_letter", { expires_at: "2026-10-01" })[0]?.deadlineType === "pre_approval_expiration"
    && deriveDeadlineCandidates("commission_agreement", { expires_at: "2026-12-31" })[0]?.deadlineType === "commission_agreement_expiration")
  check("past-event dates are RECORDS, not deadlines — inspection/appraisal reports derive nothing",
    deriveDeadlineCandidates("inspection_report", { inspection_date: "2026-06-01" }).length === 0
    && deriveDeadlineCandidates("appraisal_report", { appraisal_date: "2026-06-05" }).length === 0)
  check("missing anchor or window → no candidate (never a fabricated date)",
    deriveDeadlineCandidates("signed_contract", { earnest_money_due_days: 3 }).length === 0
    && deriveDeadlineCandidates("signed_contract", { contract_effective_date: "2026-07-01" }).length === 0
    && deriveDeadlineCandidates("closing_disclosure", { closing_date: "TBD" }).length === 0)

  console.log("\n[3 · wiring — keep-one rail, scanner hook, registry, UI]")
  const scan = src("lib/documents/scan-uploaded-document.ts")
  check("the scanner runs the kernel post-scan (ledger + derivation), best-effort",
    scan.includes("recordFieldExtractions") && scan.includes("deriveDeadlinesFromDocument")
    && scan.includes("document-kernel hook failed (non-fatal)"))
  const deriv = src("lib/documents/deadline-derivation.ts")
  check("deadlines land on the EXISTING transaction_deadlines rail with source provenance — no parallel table",
    deriv.includes('from("transaction_deadlines")') && deriv.includes("source_document_id")
    && deriv.includes("source_field_key") && !deriv.includes("document_deadlines"))
  check("every candidate records a policy decision BEFORE any action; red stops; amber dedupes 14d on the bus",
    deriv.includes("recordPolicyDecision") && deriv.includes("deadline_conflict_finding")
    && deriv.includes("14 * 86_400_000"))
  check("completed/waived deadlines are settled history — the kernel never reopens them",
    deriv.includes('existing.status === "completed" || existing.status === "waived"'))
  const ledger = src("lib/documents/field-extraction-ledger.ts")
  check("the extraction ledger upserts per (document, field) and never clobbers a human-verified row",
    ledger.includes('onConflict: "document_id,field_key"') && ledger.includes('not("verified_at", "is", null)'))
  const registry = src("lib/kernel/manager-registry.ts")
  check("registry: document_kernel domain owned by deal_coordinator; both ledgers table-owned",
    registry.includes("document_kernel:") && registry.includes('proof: "test:doc-kernel"')
    && registry.includes('document_field_extractions: "deal_coordinator"')
    && registry.includes('policy_decisions: "compliance_officer"'))
  const signals = src("lib/kernel/signal-registry.ts")
  check("deadline_conflict_finding registered as an ALERT ('finding' matches the classifier) on the feed",
    /deadline_conflict_finding:.*kind: "alert"/.test(signals))
  check("the coordinator's Deadline Intelligence panel shows document provenance (assisted-mode transparency)",
    src("app/dashboard/coordinator/components/os/deadline-intelligence-panel.tsx").includes("source_document_id")
    && src("app/dashboard/coordinator/components/os/deadline-intelligence-panel.tsx").includes("from document"))
  const snapshot = src("scripts/schema-snapshot.ts")
  check("schema snapshot carries the new tables + deadline provenance columns",
    snapshot.includes("document_field_extractions:") && snapshot.includes("policy_decisions:")
    && /transaction_deadlines:.*source_document_id/.test(snapshot))

  console.log("\n[4 · live — the full derivation against the real database]")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("  ○ skipped (no live credentials in this environment)")
  } else {
    const { createServiceClient } = await import("../lib/supabase/service")
    const { deriveDeadlinesFromDocument } = await import("../lib/documents/deadline-derivation")
    const { recordFieldExtractions } = await import("../lib/documents/field-extraction-ledger")
    const svc = createServiceClient()
    const { data: b } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    if (!b?.id) { console.log("  ○ skipped (no live brokerage)") }
    else {
      const brokerageId = (b as any).id as string
      let txId: string | null = null, docId: string | null = null, doc2Id: string | null = null
      try {
        const { data: tx, error: txErr } = await svc.from("transactions").insert({
          brokerage_id: brokerageId, deal_name: "doc-kernel-sim deal", deal_type: "buyer",
          status: "under_contract", property_address: "1 Doc Kernel Sim Way",
        }).select("id").single()
        if (txErr || !tx) throw new Error(`seed tx failed: ${txErr?.message}`)
        txId = (tx as any).id

        const fields = { property_address: "1 Doc Kernel Sim Way", contract_effective_date: "2026-07-01", earnest_money_due_days: 3, price: 500000 }
        const { data: d1, error: d1Err } = await svc.from("documents").insert({
          brokerage_id: brokerageId, transaction_id: txId, document_type: "contract",
          classification: "signed_contract", classification_confidence: "high",
          extracted_fields: fields, status: "complete",
        }).select("id").single()
        if (d1Err || !d1) throw new Error(`seed doc failed: ${d1Err?.message}`)
        docId = (d1 as any).id

        // The ledger: one row per usable field, idempotent on re-run.
        const rec1 = await recordFieldExtractions(svc as any, { documentId: docId!, brokerageId, fields, confidence: "high", extractionModel: "router:document_classification" })
        const rec2 = await recordFieldExtractions(svc as any, { documentId: docId!, brokerageId, fields, confidence: "high", extractionModel: "router:document_classification" })
        const { count: ledgerCount } = await svc.from("document_field_extractions").select("id", { count: "exact", head: true }).eq("document_id", docId!)
        check("live: extraction ledger writes one row per field, idempotent on re-scan",
          rec1.recorded === 4 && rec2.recorded === 4 && ledgerCount === 4)

        // GREEN insert: high confidence, nothing tracked → deadline with provenance.
        const run1 = await deriveDeadlinesFromDocument(svc as any, { documentId: docId!, brokerageId, transactionId: txId, classification: "signed_contract", confidence: "high", fields })
        const { data: dl } = await svc.from("transaction_deadlines").select("deadline_type, deadline_date, status, source_document_id, source_field_key").eq("transaction_id", txId!).eq("deadline_type", "earnest_money").maybeSingle()
        check("live: GREEN — earnest_money deadline derived (effective+3d) with document provenance",
          run1.inserted === 1 && !!dl
          && String((dl as any).deadline_date).slice(0, 10) === "2026-07-04"
          && (dl as any).source_document_id === docId && (dl as any).source_field_key === "earnest_money_due_days", JSON.stringify(run1))
        const run1b = await deriveDeadlinesFromDocument(svc as any, { documentId: docId!, brokerageId, transactionId: txId, classification: "signed_contract", confidence: "high", fields })
        check("live: re-run confirms instead of duplicating (idempotent)", run1b.inserted === 0 && run1b.confirmed === 1)

        // AMBER conflict: a second document asserts a DIFFERENT closing date than a tracked one.
        await svc.from("transaction_deadlines").insert({ transaction_id: txId, brokerage_id: brokerageId, deadline_type: "closing", deadline_date: "2026-09-15", status: "pending" })
        const cdFields = { closing_date: "2026-09-30", lender_name: "Sim Lender" }
        const { data: d2 } = await svc.from("documents").insert({
          brokerage_id: brokerageId, transaction_id: txId, document_type: "closing_disclosure",
          classification: "closing_disclosure", classification_confidence: "high",
          extracted_fields: cdFields, status: "complete",
        }).select("id").single()
        doc2Id = (d2 as any)?.id ?? null
        const run2 = await deriveDeadlinesFromDocument(svc as any, { documentId: doc2Id!, brokerageId, transactionId: txId, classification: "closing_disclosure", confidence: "high", fields: cdFields })
        const { data: sig } = await svc.from("manager_signals").select("id, message, payload").eq("brokerage_id", brokerageId).eq("signal_type", "deadline_conflict_finding").contains("payload", { transaction_id: txId }).maybeSingle()
        const { data: dlAfter } = await svc.from("transaction_deadlines").select("deadline_date").eq("transaction_id", txId!).eq("deadline_type", "closing").maybeSingle()
        check("live: AMBER — the conflicting date raised a gated review signal and the tracked date did NOT move",
          run2.conflictsProposed === 1 && !!sig
          && String((dlAfter as any)?.deadline_date).slice(0, 10) === "2026-09-15"
          && String((sig as any)?.message ?? "").includes("2026-09-30"), JSON.stringify(run2))

        // The policy ledger recorded every verdict.
        const { data: pds } = await svc.from("policy_decisions").select("decision, target_id, recommended_action").eq("transaction_id", txId!)
        const pdRows = (pds ?? []) as any[]
        check("live: policy_decisions carries the full trail — green insert, green confirm, amber conflict",
          pdRows.some((r) => r.decision === "green" && r.recommended_action === "insert_deadline")
          && pdRows.some((r) => r.decision === "green" && r.recommended_action === "stamp_source_provenance")
          && pdRows.some((r) => r.decision === "amber" && r.target_id === "closing"))
      } catch (e: any) {
        check("live: derivation flow ran", false, e?.message ?? String(e))
      } finally {
        // Clean to count==0 (FK cascade order: signals/policy/ledger/deadlines → docs → tx).
        if (txId) {
          await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("signal_type", "deadline_conflict_finding").contains("payload", { transaction_id: txId })
          await svc.from("policy_decisions").delete().eq("transaction_id", txId)
          await svc.from("transaction_deadlines").delete().eq("transaction_id", txId)
        }
        if (docId) { await svc.from("document_field_extractions").delete().eq("document_id", docId); await svc.from("documents").delete().eq("id", docId) }
        if (doc2Id) await svc.from("documents").delete().eq("id", doc2Id)
        if (txId) await svc.from("transactions").delete().eq("id", txId)
        if (txId && docId) {
          const [{ count: c1 }, { count: c2 }, { count: c3 }, { count: c4 }] = await Promise.all([
            svc.from("policy_decisions").select("id", { count: "exact", head: true }).eq("transaction_id", txId),
            svc.from("document_field_extractions").select("id", { count: "exact", head: true }).eq("document_id", docId),
            svc.from("transaction_deadlines").select("id", { count: "exact", head: true }).eq("transaction_id", txId),
            svc.from("transactions").select("id", { count: "exact", head: true }).eq("id", txId),
          ])
          check("live: cleaned to count==0", (c1 ?? -1) === 0 && (c2 ?? -1) === 0 && (c3 ?? -1) === 0 && (c4 ?? -1) === 0)
        }
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Document kernel Phase A verified — per-field ledger, policy-gated deadlines, provenance end to end.")
  console.log(" DOC_KERNEL_PASS")
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
