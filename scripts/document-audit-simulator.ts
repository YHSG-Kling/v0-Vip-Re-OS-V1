#!/usr/bin/env tsx
/**
 * scripts/document-audit-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DOCUMENT-VISION COMPLIANCE AUDIT harness — the live kernel equivalent of the legacy
 * workflows/audit-document.json + workflows/broker-audit.json (per-document vision audit +
 * broker escalation).
 *
 * Layer 1 (pure): auditChecklist per document_type (contract gets signatures/initials/names;
 *   disclosure/required gets the disclosure-presence check); classifyFindings — a vision
 *   result with a missing signature → finding + critical severity; a clean result → passed,
 *   no findings; an ok:false result → 'not_audited' (NEVER a fabricated finding or pass).
 * Layer 2 (live, gated): seed a deal client_documents row → runDocumentComplianceAudit with
 *   an INJECTED vision result showing a missing-signature finding → assert the finding
 *   recorded on the doc (ai_metadata) + a broker escalation notification + a consumed bus
 *   line; a clean doc → recorded pass, NO escalation; vision unavailable → 'not_audited', no
 *   fabricated finding; idempotent (same vision content → no rewrite/re-escalate). Self-cleans.
 *
 * Run: npx tsx scripts/document-audit-simulator.ts  (npm run test:document-audit)
 */
import {
  auditChecklist,
  classifyFindings,
  runDocumentComplianceAudit,
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
  console.log(" ✅ Document-vision compliance audit verified")
  console.log("DOCUMENT_AUDIT_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Document-vision compliance audit simulator")
  console.log("══════════════════════════════════════════════════")

  // ── Layer 1 · auditChecklist ──────────────────────────────────────────────
  console.log("\n[Layer 1 · auditChecklist]")
  const contractChecks = auditChecklist("purchase_agreement", [])
  const contractIds = contractChecks.map((c) => c.check)
  check("contract → signatures + dates are BLOCKING checks",
    contractChecks.some((c) => c.check === "signatures_present" && c.blocking) &&
    contractChecks.some((c) => c.check === "dates_present" && c.blocking))
  check("contract → initials + name/address consistency checked",
    contractIds.includes("initials_each_page") && contractIds.includes("names_match") && contractIds.includes("addresses_match"))
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

  // ── Layer 1 · classifyFindings ────────────────────────────────────────────
  console.log("\n[Layer 1 · classifyFindings]")
  const missingSigVision: VisionResult = {
    ok: true,
    contentHash: "h_missing_sig",
    issues: [{ check: "signatures_present", severity: "critical", detail: "Seller signature block is blank." }],
  }
  const c1 = classifyFindings(missingSigVision, contractChecks)
  check("missing signature → status 'findings'", c1.status === "findings")
  check("missing signature → CRITICAL overall severity", c1.severity === "critical")
  check("missing signature → one finding mapped to signatures_present",
    c1.findings.length === 1 && c1.findings[0].check === "signatures_present" && c1.findings[0].severity === "critical")

  // No explicit severity → defer to checklist blocking-ness (signatures is blocking → critical)
  const noSevVision: VisionResult = { ok: true, contentHash: "h2", issues: [{ check: "signatures_present", detail: "missing" }] }
  const c1b = classifyFindings(noSevVision, contractChecks)
  check("finding with no severity on a BLOCKING check → defaults to critical", c1b.severity === "critical")

  const warnVision: VisionResult = { ok: true, contentHash: "h3", issues: [{ check: "initials_each_page", detail: "page 3 missing initials" }] }
  const c1c = classifyFindings(warnVision, contractChecks)
  check("finding on a NON-blocking check w/ no severity → warning", c1c.severity === "warning" && c1c.status === "findings")

  const cleanVision: VisionResult = { ok: true, contentHash: "h_clean", issues: [] }
  const c2 = classifyFindings(cleanVision, contractChecks)
  check("clean result → status 'passed', zero findings, no severity",
    c2.status === "passed" && c2.findings.length === 0 && c2.severity === null)

  const unavailVision: VisionResult = { ok: false, reason: "no creds" }
  const c3 = classifyFindings(unavailVision, contractChecks)
  check("vision unavailable → status 'not_audited', NO fabricated finding",
    c3.status === "not_audited" && c3.findings.length === 0 && c3.severity === null)

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

    // 1) MISSING-SIGNATURE document → finding recorded + broker escalated.
    const docId = await seedDoc("Offer A")
    const missingSigFetcher: VisionFetcher = async () => ({
      ok: true, contentHash: "live_missing_sig",
      issues: [{ check: "signatures_present", severity: "critical", detail: "Buyer signature missing on page 1." }],
    })
    const r1 = await runDocumentComplianceAudit({ documentId: docId }, { visionFetcher: missingSigFetcher }, svc)
    check("live: missing-signature doc → status 'findings'", r1.status === "findings" && r1.severity === "critical")
    check("live: missing-signature doc → broker escalated (≥1 recipient)", r1.escalated >= 1)

    const { data: afterDoc } = await svc.from("client_documents").select("ai_metadata").eq("id", docId).single()
    const rec = (afterDoc as any)?.ai_metadata?.document_compliance_audit
    check("live: finding RECORDED on the doc's ai_metadata", rec?.status === "findings" && (rec?.findings ?? []).length === 1)

    const { data: notif } = await svc.from("notifications").select("id, title, body, priority, user_id")
      .eq("type", "document_compliance_finding").eq("entity_id", docId).eq("user_id", brokerUserId).maybeSingle()
    if (notif) cleanup.push({ table: "notifications", id: (notif as any).id })
    check("live: broker notification landed (CRITICAL, names the missing signature)",
      !!notif && (notif as any).priority === "critical" && ((notif as any).body ?? "").includes("Buyer signature missing"))

    const { data: sig } = await svc.from("manager_signals").select("id, status, consumed_action")
      .eq("entity_id", docId).eq("signal_type", "document_compliance_finding").maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
    check("live: bus audit line published + consumed inline",
      (sig as any)?.status === "consumed" && ((sig as any)?.consumed_action ?? "").includes("document compliance audit escalated"))

    // Idempotency — same vision content → no rewrite, no re-escalation.
    const r1b = await runDocumentComplianceAudit({ documentId: docId }, { visionFetcher: missingSigFetcher }, svc)
    check("live: idempotent re-run (same vision content) → idempotentSkip, 0 new escalations",
      r1b.idempotentSkip === true && r1b.escalated === 0)
    const { count: dupNotif } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", "document_compliance_finding").eq("entity_id", docId).eq("user_id", brokerUserId)
    check("live: no duplicate broker notification after re-run", (dupNotif ?? 0) === 1)

    // 2) CLEAN document → recorded pass, NO escalation.
    const cleanDocId = await seedDoc("Offer B clean")
    const cleanFetcher: VisionFetcher = async () => ({ ok: true, contentHash: "live_clean", issues: [] })
    const r2 = await runDocumentComplianceAudit({ documentId: cleanDocId }, { visionFetcher: cleanFetcher }, svc)
    check("live: clean doc → status 'passed', 0 escalations", r2.status === "passed" && r2.escalated === 0)
    const { data: cleanDoc } = await svc.from("client_documents").select("ai_metadata").eq("id", cleanDocId).single()
    check("live: clean pass recorded on ai_metadata (passed, no findings)",
      (cleanDoc as any)?.ai_metadata?.document_compliance_audit?.status === "passed")
    const { count: cleanNotif } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", "document_compliance_finding").eq("entity_id", cleanDocId)
    check("live: clean doc → NO broker notification", (cleanNotif ?? 0) === 0)

    // 3) VISION UNAVAILABLE → 'not_audited', no fabricated finding, no escalation.
    const naDocId = await seedDoc("Offer C novision")
    const unavailFetcher: VisionFetcher = async () => ({ ok: false, reason: "AI_GATEWAY_API_KEY not configured" })
    const r3 = await runDocumentComplianceAudit({ documentId: naDocId }, { visionFetcher: unavailFetcher }, svc)
    check("live: vision unavailable → status 'not_audited', 0 findings, 0 escalations",
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
