#!/usr/bin/env tsx
/**
 * scripts/document-audit-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DOCUMENT COMPLIANCE AUDIT harness — the live kernel equivalent of the legacy
 * workflows/audit-document.json + workflows/broker-audit.json (per-document compliance audit +
 * broker escalation), now HYBRID: an OCR/content TEXT pass (ocr-pdf text layer + deterministic
 * checks + an optional gateway-TEXT pass) MERGED with a gateway VISION pass (gpt-4o /
 * claude-3-5-sonnet — NEVER Gemini) that sees the visual execution marks OCR text is blind to
 * (signature inked per signer, initials, checkboxes, stamp/seal, date filled).
 *
 * Layer 1 (pure): auditChecklist per document_type; deterministicTextIssues (OCR text missing a
 *   signature marker → signatures_present issue); visionIssues (a VISION result with present:false
 *   → a critical signatures_present finding; null fields raise NOTHING — no fabrication);
 *   classifyFindings (the MERGE + honest method/degradation):
 *     · text + vision both ran, ≥1 issue        → 'findings' (method 'vision+text')
 *     · both ran clean                           → 'passed'  (method 'vision+text')
 *     · vision unavailable, text clean           → 'partial_audit' (method 'text_only')
 *     · text unavailable, vision clean           → 'partial_audit' (method 'vision_only')
 *     · NEITHER ran                              → 'not_audited' (method 'not_audited')
 *   NEVER a fabricated finding or pass.
 * Layer 2 (live, gated): seed a deal client_documents row → runDocumentComplianceAudit with BOTH
 *   seams injected (textExtractor + visionFetcher):
 *     · vision shows a MISSING signature (+ clean text) → 'findings'/critical, broker escalated,
 *       recorded method 'vision+text', the signature finding came FROM vision.
 *     · clean signed text + vision shows ALL signatures present → 'passed', NO escalation.
 *     · vision UNAVAILABLE (ok:false) + clean text → 'partial_audit' method 'text_only', the OCR
 *       findings still recorded, NO fabricated signature finding, NO escalation.
 *     · BOTH unavailable → 'not_audited', nothing recorded as a finding, NO escalation.
 *   Idempotent (same text + same vision → no rewrite/re-escalate). Self-cleans.
 *
 * Run: npx tsx scripts/document-audit-simulator.ts  (npm run test:document-audit)
 */
import {
  auditChecklist,
  deterministicTextIssues,
  visionIssues,
  classifyFindings,
  runDocumentComplianceAudit,
  type ExtractedText,
  type TextExtractor,
  type VisionResult,
  type VisionFetcher,
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
  console.log(" ✅ Hybrid vision+text document compliance audit verified")
  console.log("DOCUMENT_VISION_PASS")
}

// A signed purchase-agreement text (has a signature marker + execution date).
const SIGNED_CONTRACT_TEXT = `RESIDENTIAL PURCHASE AGREEMENT
Property: 44 Birch St.
Buyer: Jane Doe.  Seller: John Roe.
Buyer Signature: /s/ Jane Doe   Date: 06/13/2026
Seller Signature: /s/ John Roe  Date: 06/13/2026`

// An UNSIGNED contract text (no signature marker, no date) — the deterministic text layer flags it.
const UNSIGNED_CONTRACT_TEXT = `RESIDENTIAL PURCHASE AGREEMENT
Property: 44 Birch St.
Buyer: Jane Doe.  Seller: John Roe.
(unexecuted draft — signature blocks blank)`

// VISION result: both required signatures present, date filled — a clean executed document.
const VISION_ALL_PRESENT: VisionResult = {
  ok: true,
  signatures: [{ signer: "Buyer", present: true }, { signer: "Seller", present: true }],
  initialsComplete: true, checkboxesComplete: true, stampPresent: null, dateFilled: true,
  rationale: "Both signature lines are inked and the date field is filled.",
}
// VISION result: the Seller's signature line is BLANK — the core visual finding OCR can't make.
const VISION_MISSING_SELLER: VisionResult = {
  ok: true,
  signatures: [{ signer: "Buyer", present: true }, { signer: "Seller", present: false }],
  initialsComplete: true, checkboxesComplete: true, stampPresent: null, dateFilled: true,
  rationale: "The Seller signature line is blank.",
}
// VISION result: the pass could NOT run (no creds / unfetchable image).
const VISION_UNAVAILABLE: VisionResult = { ok: false, reason: "AI_GATEWAY_API_KEY not configured" }

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Hybrid vision+text document compliance audit simulator")
  console.log("══════════════════════════════════════════════════")

  const contractChecks = auditChecklist("purchase_agreement", [])

  // ── Layer 1 · auditChecklist ──────────────────────────────────────────────
  console.log("\n[Layer 1 · auditChecklist]")
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

  // ── Layer 1 · deterministicTextIssues (OCR/content pass) ───────────────────
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

  // ── Layer 1 · visionIssues (execution/marks pass) ──────────────────────────
  console.log("\n[Layer 1 · visionIssues]")
  const missingSigVisionIssues = visionIssues(VISION_MISSING_SELLER, contractChecks)
  check("vision missing-signature → a CRITICAL signatures_present issue, names the signer",
    missingSigVisionIssues.some((i) => i.check === "signatures_present" && i.severity === "critical" && (i.detail ?? "").includes("Seller")))
  check("vision missing-signature → does NOT flag the PRESENT signer (Buyer)",
    !missingSigVisionIssues.some((i) => (i.detail ?? "").includes("Buyer")))

  const cleanVisionIssues = visionIssues(VISION_ALL_PRESENT, contractChecks)
  check("vision all-present → NO signature/mark issues (clean execution)", cleanVisionIssues.length === 0)

  const unavailVisionIssues = visionIssues(VISION_UNAVAILABLE, contractChecks)
  check("vision UNAVAILABLE (ok:false) → ZERO issues (never fabricates a signature finding)",
    unavailVisionIssues.length === 0)

  // null fields raise nothing — only an affirmative FALSE produces a finding (no fabrication).
  const nullVision: VisionResult = { ok: true, signatures: null, initialsComplete: null, checkboxesComplete: null, stampPresent: null, dateFilled: null }
  check("vision all-null assessments → ZERO issues (null ≠ a finding)", visionIssues(nullVision, contractChecks).length === 0)

  // ── Layer 1 · classifyFindings — the HYBRID MERGE + honest degradation ──────
  console.log("\n[Layer 1 · classifyFindings — hybrid merge]")

  // (a) text clean + vision shows a MISSING signature → findings, critical, method vision+text.
  const mergedA = classifyFindings({ ok: true, text: SIGNED_CONTRACT_TEXT }, [...signedIssues, ...missingSigVisionIssues], contractChecks, { text: true, vision: true })
  check("MERGE: clean text + vision missing-signature → 'findings', CRITICAL, method 'vision+text'",
    mergedA.status === "findings" && mergedA.severity === "critical" && mergedA.method === "vision+text")
  check("MERGE: the missing-signature finding (from VISION) is carried into the merged findings",
    mergedA.findings.some((f) => f.check === "signatures_present" && f.severity === "critical"))

  // (b) both passes clean → passed, method vision+text, zero findings.
  const mergedB = classifyFindings({ ok: true, text: SIGNED_CONTRACT_TEXT }, [...signedIssues, ...cleanVisionIssues], contractChecks, { text: true, vision: true })
  check("MERGE: clean text + clean vision → 'passed', method 'vision+text', 0 findings",
    mergedB.status === "passed" && mergedB.method === "vision+text" && mergedB.findings.length === 0 && mergedB.severity === null)

  // (c) vision unavailable, text clean → partial_audit, method text_only, no fabricated finding.
  const mergedC = classifyFindings({ ok: true, text: SIGNED_CONTRACT_TEXT }, signedIssues, contractChecks, { text: true, vision: false })
  check("MERGE: clean text + vision UNAVAILABLE → 'partial_audit', method 'text_only', 0 findings",
    mergedC.status === "partial_audit" && mergedC.method === "text_only" && mergedC.findings.length === 0)

  // (d) text unavailable, vision clean → partial_audit, method vision_only.
  const mergedD = classifyFindings({ ok: false, reason: "image-only, no OCR text" }, cleanVisionIssues, contractChecks, { text: false, vision: true })
  check("MERGE: text UNAVAILABLE + clean vision → 'partial_audit', method 'vision_only'",
    mergedD.status === "partial_audit" && mergedD.method === "vision_only")

  // (e) a real finding survives degradation: text unavailable + vision missing-signature → findings.
  const mergedE = classifyFindings({ ok: false, reason: "image-only" }, missingSigVisionIssues, contractChecks, { text: false, vision: true })
  check("MERGE: text unavailable + vision missing-signature → 'findings' (a real gap outranks degradation)",
    mergedE.status === "findings" && mergedE.method === "vision_only" && mergedE.severity === "critical")

  // (f) NEITHER pass ran → not_audited, no findings, method not_audited.
  const mergedF = classifyFindings({ ok: false, reason: "no text" }, [], contractChecks, { text: false, vision: false })
  check("MERGE: NEITHER pass ran → 'not_audited', method 'not_audited', 0 findings, no severity",
    mergedF.status === "not_audited" && mergedF.method === "not_audited" && mergedF.findings.length === 0 && mergedF.severity === null)

  // (g) unsigned text + vision missing-signature → the SAME gap from both passes de-dupes by detail
  //     but each pass's distinct wording stands; severity stays critical, method vision+text.
  const mergedG = classifyFindings({ ok: true, text: UNSIGNED_CONTRACT_TEXT }, [...unsignedIssues, ...missingSigVisionIssues], contractChecks, { text: true, vision: true })
  check("MERGE: unsigned text + vision missing-signature → 'findings', CRITICAL, method 'vision+text'",
    mergedG.status === "findings" && mergedG.severity === "critical" && mergedG.method === "vision+text")

  // (h) back-compat: passes omitted → inferred text-only behavior preserved.
  const legacyClean = classifyFindings({ ok: true, text: SIGNED_CONTRACT_TEXT }, [], contractChecks)
  check("BACK-COMPAT: passes omitted, clean text → 'partial_audit' text_only (text ran, vision did not)",
    legacyClean.status === "partial_audit" && legacyClean.method === "text_only")
  const legacyNoText = classifyFindings({ ok: false, reason: "x" }, [], contractChecks)
  check("BACK-COMPAT: passes omitted, no text → 'not_audited'",
    legacyNoText.status === "not_audited" && legacyNoText.method === "not_audited")

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

    async function seedDoc(name: string): Promise<string> {
      const { data: doc } = await svc.from("client_documents").insert({
        brokerage_id: brokerageId, contact_id: (con as any).id,
        document_name: `${TAG} ${name}`, document_url: "https://example.com/fake.pdf",
        document_type: "purchase_agreement", doc_category: "purchase_agreement",
      }).select("id").single()
      cleanup.push({ table: "client_documents", id: (doc as any).id })
      return (doc as any).id
    }

    // Seams — inject BOTH a fixed extracted text AND a fixed vision result (no token spend).
    const cleanText: TextExtractor = async () => ({ ok: true, text: SIGNED_CONTRACT_TEXT })
    const visionMissing: VisionFetcher = async () => VISION_MISSING_SELLER
    const visionPresent: VisionFetcher = async () => VISION_ALL_PRESENT
    const visionDown: VisionFetcher = async () => VISION_UNAVAILABLE
    const noText: TextExtractor = async () => ({ ok: false, reason: "no extractable text (image-only, no OCR text layer)" })

    // 1) VISION missing-signature (text clean) → finding recorded + broker escalated.
    const docId = await seedDoc("Offer A vision-missing-sig")
    const r1 = await runDocumentComplianceAudit({ documentId: docId }, { textExtractor: cleanText, visionFetcher: visionMissing }, svc)
    check("live: clean text + vision missing-signature → 'findings'/critical", r1.status === "findings" && r1.severity === "critical")
    check("live: missing-signature finding came from VISION (signatures_present)",
      r1.findings.some((f) => f.check === "signatures_present"))
    check("live: broker escalated (≥1 recipient)", r1.escalated >= 1)

    const { data: afterDoc } = await svc.from("client_documents").select("ai_metadata").eq("id", docId).single()
    const rec = (afterDoc as any)?.ai_metadata?.document_compliance_audit
    check("live: recorded on ai_metadata with method 'vision+text' (vision_ran + text_ran true)",
      rec?.status === "findings" && rec?.method === "vision+text" && rec?.vision_ran === true && rec?.text_ran === true)

    const { data: notif } = await svc.from("notifications").select("id, body, priority, user_id")
      .eq("type", "document_compliance_finding").eq("entity_id", docId).eq("user_id", brokerUserId).maybeSingle()
    if (notif) cleanup.push({ table: "notifications", id: (notif as any).id })
    check("live: broker notification landed (CRITICAL, hybrid-audit body)",
      !!notif && (notif as any).priority === "critical" && ((notif as any).body ?? "").includes("hybrid vision+text compliance audit"))

    const { data: sig } = await svc.from("manager_signals").select("id, status, consumed_action")
      .eq("entity_id", docId).eq("signal_type", "document_compliance_finding").maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
    check("live: bus audit line published + consumed inline",
      (sig as any)?.status === "consumed" && ((sig as any)?.consumed_action ?? "").includes("document compliance audit escalated"))

    // Idempotency — same text + same vision → no rewrite, no re-escalation.
    const r1b = await runDocumentComplianceAudit({ documentId: docId }, { textExtractor: cleanText, visionFetcher: visionMissing }, svc)
    check("live: idempotent re-run (same text + same vision) → idempotentSkip, 0 new escalations",
      r1b.idempotentSkip === true && r1b.escalated === 0)
    const { count: dupNotif } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", "document_compliance_finding").eq("entity_id", docId).eq("user_id", brokerUserId)
    check("live: no duplicate broker notification after re-run", (dupNotif ?? 0) === 1)

    // 2) CLEAN signed text + vision ALL signatures present → recorded pass, NO escalation.
    const cleanDocId = await seedDoc("Offer B clean")
    const r2 = await runDocumentComplianceAudit({ documentId: cleanDocId }, { textExtractor: cleanText, visionFetcher: visionPresent }, svc)
    check("live: clean text + vision all-present → 'passed', 0 escalations", r2.status === "passed" && r2.escalated === 0)
    const { data: cleanDoc } = await svc.from("client_documents").select("ai_metadata").eq("id", cleanDocId).single()
    const cleanRec = (cleanDoc as any)?.ai_metadata?.document_compliance_audit
    check("live: clean pass recorded (passed, method 'vision+text', no findings)",
      cleanRec?.status === "passed" && cleanRec?.method === "vision+text" && (cleanRec?.findings ?? []).length === 0)
    const { count: cleanNotif } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", "document_compliance_finding").eq("entity_id", cleanDocId)
    check("live: clean doc → NO broker notification", (cleanNotif ?? 0) === 0)

    // 3) VISION UNAVAILABLE (clean text) → 'partial_audit' text_only, OCR findings still recorded,
    //    NO fabricated signature finding, NO escalation.
    const partialDocId = await seedDoc("Offer C vision-down")
    const r3 = await runDocumentComplianceAudit({ documentId: partialDocId }, { textExtractor: cleanText, visionFetcher: visionDown }, svc)
    check("live: vision unavailable + clean text → 'partial_audit', 0 findings, 0 escalations",
      r3.status === "partial_audit" && r3.findings.length === 0 && r3.escalated === 0)
    const { data: partialDoc } = await svc.from("client_documents").select("ai_metadata").eq("id", partialDocId).single()
    const partialRec = (partialDoc as any)?.ai_metadata?.document_compliance_audit
    check("live: partial_audit recorded honestly (method 'text_only', vision_ran false, reason names vision)",
      partialRec?.status === "partial_audit" && partialRec?.method === "text_only" &&
      partialRec?.vision_ran === false && (partialRec?.reason ?? "").includes("vision"))
    check("live: partial_audit → NO fabricated signature finding (OCR text was clean)",
      !(partialRec?.findings ?? []).some((f: any) => f.check === "signatures_present"))
    const { count: partialNotif } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", "document_compliance_finding").eq("entity_id", partialDocId)
    check("live: partial_audit → NO broker notification", (partialNotif ?? 0) === 0)

    // 4) BOTH unavailable → 'not_audited', no fabricated finding, no escalation.
    const naDocId = await seedDoc("Offer D both-down")
    const r4 = await runDocumentComplianceAudit({ documentId: naDocId }, { textExtractor: noText, visionFetcher: visionDown }, svc)
    check("live: text + vision BOTH unavailable → 'not_audited', 0 findings, 0 escalations",
      r4.status === "not_audited" && r4.findings.length === 0 && r4.escalated === 0)
    const { data: naDoc } = await svc.from("client_documents").select("ai_metadata").eq("id", naDocId).single()
    const naRec = (naDoc as any)?.ai_metadata?.document_compliance_audit
    check("live: not_audited recorded honestly (method 'not_audited', reason, no findings)",
      naRec?.status === "not_audited" && naRec?.method === "not_audited" && (naRec?.findings ?? []).length === 0 && !!naRec?.reason)
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
