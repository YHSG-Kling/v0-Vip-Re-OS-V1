#!/usr/bin/env tsx
/**
 * scripts/document-audit-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DOCUMENT-TEXT COMPLIANCE AUDIT harness — the live kernel equivalent of the legacy
 * workflows/audit-document.json + workflows/broker-audit.json (per-document compliance audit +
 * broker escalation). NO VISION: the audit runs over the document's EXTRACTED TEXT (ocr-pdf
 * text layer), deterministic text checks + an optional gateway-TEXT pass.
 *
 * Layer 1 (pure): auditChecklist per document_type (contract gets signatures/dates/names;
 *   disclosure/required gets the disclosure-presence check); deterministicTextIssues — extracted
 *   text missing a signature marker → a signatures_present issue; classifyFindings — issues +
 *   present text → 'findings'; clean text → 'passed'; NO text (ok:false / empty) → 'not_audited'
 *   (NEVER a fabricated finding or pass).
 * Layer 2 (live, gated): seed a deal client_documents row → runDocumentComplianceAudit with an
 *   INJECTED textExtractor returning fixed extracted TEXT → assert findings recorded on the doc
 *   (ai_metadata, method text_extraction) + a broker escalation notification + a consumed bus
 *   line; clean text → recorded pass, NO escalation; no text → 'not_audited', no fabricated
 *   finding; idempotent (same extracted text → no rewrite/re-escalate). Self-cleans.
 *
 * Run: npx tsx scripts/document-audit-simulator.ts  (npm run test:document-audit)
 */
import {
  auditChecklist,
  deterministicTextIssues,
  classifyFindings,
  runDocumentComplianceAudit,
  type ExtractedText,
  type TextExtractor,
} from "../lib/kernel/document-compliance-audit"

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
  console.log(" ✅ Document-text compliance audit verified")
  console.log("DOCUMENT_AUDIT_PASS")
}

// A signed purchase-agreement text (has a signature marker + execution date).
const SIGNED_CONTRACT_TEXT = `RESIDENTIAL PURCHASE AGREEMENT
Property: 44 Birch St.
Buyer: Jane Doe.  Seller: John Roe.
Buyer Signature: /s/ Jane Doe   Date: 06/13/2026
Seller Signature: /s/ John Roe  Date: 06/13/2026`

// An UNSIGNED contract text (no signature marker, no date) — the deterministic layer flags it.
const UNSIGNED_CONTRACT_TEXT = `RESIDENTIAL PURCHASE AGREEMENT
Property: 44 Birch St.
Buyer: Jane Doe.  Seller: John Roe.
(unexecuted draft — signature blocks blank)`

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Document-text compliance audit simulator")
  console.log("══════════════════════════════════════════════════")

  // ── Layer 1 · auditChecklist ──────────────────────────────────────────────
  console.log("\n[Layer 1 · auditChecklist]")
  const contractChecks = auditChecklist("purchase_agreement", [])
  const contractIds = contractChecks.map((c) => c.check)
  check("contract → signatures + dates are BLOCKING checks",
    contractChecks.some((c) => c.check === "signatures_present" && c.blocking) &&
    contractChecks.some((c) => c.check === "dates_present" && c.blocking))
  check("contract → name/address consistency checked",
    contractIds.includes("names_match") && contractIds.includes("addresses_match"))
  check("contract → correct_form check always present", contractIds.includes("correct_form"))

  const otherChecks = auditChecklist("other", [])
  check("non-contract/non-required 'other' → NO signature check, only form correctness",
    !otherChecks.some((c) => c.check === "signatures_present") && otherChecks.some((c) => c.check === "correct_form"))
  check("non-required type → NO required_disclosures check",
    !otherChecks.some((c) => c.check === "required_disclosures_present"))

  const requiredChecks = auditChecklist("proof_of_funds", ["proof_of_funds"])
  check("type listed in requiredDocs → required_disclosures check added",
    requiredChecks.some((c) => c.check === "required_disclosures_present"))

  const disclosureChecks = auditChecklist("disclosure_form", [])
  check("disclosure_form → signatures + required_disclosures both checked",
    disclosureChecks.some((c) => c.check === "signatures_present") &&
    disclosureChecks.some((c) => c.check === "required_disclosures_present"))

  // ── Layer 1 · deterministicTextIssues (over EXTRACTED TEXT, no vision) ──────
  console.log("\n[Layer 1 · deterministicTextIssues]")
  const unsignedIssues = deterministicTextIssues(UNSIGNED_CONTRACT_TEXT, contractChecks)
  check("unsigned contract text → signatures_present issue raised",
    unsignedIssues.some((i) => i.check === "signatures_present"))
  check("unsigned contract text → dates_present issue raised (no execution date)",
    unsignedIssues.some((i) => i.check === "dates_present"))

  const signedIssues = deterministicTextIssues(SIGNED_CONTRACT_TEXT, contractChecks)
  check("signed contract text → NO signature/date issue (markers present)",
    !signedIssues.some((i) => i.check === "signatures_present") &&
    !signedIssues.some((i) => i.check === "dates_present"))

  const reqDiscChecks = auditChecklist("disclosure_form", [])
  const noDiscIssues = deterministicTextIssues("/s/ A. Agent  06/13/2026 — cover sheet only, body omitted.", reqDiscChecks)
  check("disclosure type w/ no disclosure language → required_disclosures issue raised",
    noDiscIssues.some((i) => i.check === "required_disclosures_present"))

  // ── Layer 1 · classifyFindings (text-driven) ───────────────────────────────
  console.log("\n[Layer 1 · classifyFindings]")
  const extractedUnsigned: ExtractedText = { ok: true, text: UNSIGNED_CONTRACT_TEXT }
  const c1 = classifyFindings(extractedUnsigned, unsignedIssues, contractChecks)
  check("unsigned text → status 'findings'", c1.status === "findings")
  check("unsigned text → CRITICAL overall severity (missing signature is blocking)", c1.severity === "critical")
  check("unsigned text → a signatures_present finding mapped + critical",
    c1.findings.some((f) => f.check === "signatures_present" && f.severity === "critical"))

  // An issue with no severity on a NON-blocking check → warning.
  const warnIssue = [{ check: "names_match", detail: "buyer name spelled two ways" }]
  const c1c = classifyFindings({ ok: true, text: SIGNED_CONTRACT_TEXT }, warnIssue, contractChecks)
  check("issue on a NON-blocking check w/ no severity → warning", c1c.severity === "warning" && c1c.status === "findings")

  const c2 = classifyFindings({ ok: true, text: SIGNED_CONTRACT_TEXT }, [], contractChecks)
  check("clean text, no issues → status 'passed', zero findings, no severity",
    c2.status === "passed" && c2.findings.length === 0 && c2.severity === null)

  const noText: ExtractedText = { ok: false, reason: "no extractable text (encrypted)" }
  const c3 = classifyFindings(noText, [], contractChecks)
  check("text unavailable (ok:false) → 'not_audited', NO fabricated finding",
    c3.status === "not_audited" && c3.findings.length === 0 && c3.severity === null)

  const emptyText: ExtractedText = { ok: true, text: "   " }
  const c3b = classifyFindings(emptyText, [], contractChecks)
  check("empty extracted text (ok:true but blank) → 'not_audited' (never a fabricated pass)",
    c3b.status === "not_audited")

  // ── Layer 2 · live ────────────────────────────────────────────────────────
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live audit]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__docaudit_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    // A brokerage that has at least one broker/admin/compliance user to escalate to.
    const { data: brokerUser } = await svc.from("users")
      .select("id, brokerage_id").in("user_type", ["broker", "admin", "compliance_officer"])
      .not("brokerage_id", "is", null).limit(1).maybeSingle()
    if (!brokerUser) { console.log("\n[Layer 2] ⏭  Skipped — need a broker/admin user with a brokerage."); report(); return }
    const brokerageId = (brokerUser as any).brokerage_id
    const brokerUserId = (brokerUser as any).id

    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "DocAudit", last_name: TAG,
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })

    // Seed a deal document (tied to the contact) — a purchase agreement.
    async function seedDoc(name: string): Promise<string> {
      const { data: doc } = await svc.from("client_documents").insert({
        brokerage_id: brokerageId, contact_id: (con as any).id,
        document_name: `${TAG} ${name}`, document_url: "https://example.com/fake.pdf",
        document_type: "purchase_agreement", doc_category: "purchase_agreement",
      }).select("id").single()
      cleanup.push({ table: "client_documents", id: (doc as any).id })
      return (doc as any).id
    }

    // 1) UNSIGNED document text → finding recorded + broker escalated.
    const docId = await seedDoc("Offer A")
    const unsignedExtractor: TextExtractor = async () => ({ ok: true, text: UNSIGNED_CONTRACT_TEXT })
    const r1 = await runDocumentComplianceAudit({ documentId: docId }, { textExtractor: unsignedExtractor }, svc)
    check("live: unsigned-text doc → status 'findings'", r1.status === "findings" && r1.severity === "critical")
    check("live: unsigned-text doc → broker escalated (≥1 recipient)", r1.escalated >= 1)
    check("live: finding names the missing signature",
      r1.findings.some((f) => f.check === "signatures_present"))

    const { data: afterDoc } = await svc.from("client_documents").select("ai_metadata").eq("id", docId).single()
    const rec = (afterDoc as any)?.ai_metadata?.document_compliance_audit
    check("live: finding RECORDED on the doc's ai_metadata (method=text_extraction)",
      rec?.status === "findings" && (rec?.findings ?? []).length >= 1 && rec?.method === "text_extraction")

    const { data: notif } = await svc.from("notifications").select("id, title, body, priority, user_id")
      .eq("type", "document_compliance_finding").eq("entity_id", docId).eq("user_id", brokerUserId).maybeSingle()
    if (notif) cleanup.push({ table: "notifications", id: (notif as any).id })
    check("live: broker notification landed (CRITICAL, text-audit body)",
      !!notif && (notif as any).priority === "critical" && ((notif as any).body ?? "").includes("text compliance audit"))

    const { data: sig } = await svc.from("manager_signals").select("id, status, consumed_action")
      .eq("entity_id", docId).eq("signal_type", "document_compliance_finding").maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
    check("live: bus audit line published + consumed inline",
      (sig as any)?.status === "consumed" && ((sig as any)?.consumed_action ?? "").includes("document compliance audit escalated"))

    // Idempotency — same extracted text → no rewrite, no re-escalation.
    const r1b = await runDocumentComplianceAudit({ documentId: docId }, { textExtractor: unsignedExtractor }, svc)
    check("live: idempotent re-run (same extracted text) → idempotentSkip, 0 new escalations",
      r1b.idempotentSkip === true && r1b.escalated === 0)
    const { count: dupNotif } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", "document_compliance_finding").eq("entity_id", docId).eq("user_id", brokerUserId)
    check("live: no duplicate broker notification after re-run", (dupNotif ?? 0) === 1)

    // 2) CLEAN (signed) document text → recorded pass, NO escalation.
    const cleanDocId = await seedDoc("Offer B clean")
    const cleanExtractor: TextExtractor = async () => ({ ok: true, text: SIGNED_CONTRACT_TEXT })
    const r2 = await runDocumentComplianceAudit({ documentId: cleanDocId }, { textExtractor: cleanExtractor }, svc)
    check("live: clean (signed) text → status 'passed', 0 escalations", r2.status === "passed" && r2.escalated === 0)
    const { data: cleanDoc } = await svc.from("client_documents").select("ai_metadata").eq("id", cleanDocId).single()
    check("live: clean pass recorded on ai_metadata (passed, no findings)",
      (cleanDoc as any)?.ai_metadata?.document_compliance_audit?.status === "passed")
    const { count: cleanNotif } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", "document_compliance_finding").eq("entity_id", cleanDocId)
    check("live: clean doc → NO broker notification", (cleanNotif ?? 0) === 0)

    // 3) TEXT UNAVAILABLE → 'not_audited', no fabricated finding, no escalation.
    const naDocId = await seedDoc("Offer C notext")
    const noTextExtractor: TextExtractor = async () => ({ ok: false, reason: "no extractable text (image-only, no OCR text layer)" })
    const r3 = await runDocumentComplianceAudit({ documentId: naDocId }, { textExtractor: noTextExtractor }, svc)
    check("live: text unavailable → status 'not_audited', 0 findings, 0 escalations",
      r3.status === "not_audited" && r3.findings.length === 0 && r3.escalated === 0)
    const { data: naDoc } = await svc.from("client_documents").select("ai_metadata").eq("id", naDocId).single()
    const naRec = (naDoc as any)?.ai_metadata?.document_compliance_audit
    check("live: not_audited recorded honestly (status + reason, no findings)",
      naRec?.status === "not_audited" && (naRec?.findings ?? []).length === 0 && !!naRec?.reason)
    const { count: naNotif } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", "document_compliance_finding").eq("entity_id", naDocId)
    check("live: not_audited → NO broker notification (no fabricated finding)", (naNotif ?? 0) === 0)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("client_documents").select("id", { count: "exact", head: true }).like("document_name", `${TAG}%`)
    check("cleanup verified — 0 seeded documents remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
