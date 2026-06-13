// lib/kernel/document-compliance-audit.ts
//
// DOCUMENT-TEXT COMPLIANCE AUDIT — the live kernel equivalent of the legacy
// workflows/audit-document.json + workflows/broker-audit.json. Those n8n flows each did one
// thing: download an UPLOADED deal document, run a compliance pass for missing
// signatures/dates/required disclosures, and (broker-audit) escalate the finding to the broker
// via Slack/Airtable. This module folds BOTH into one governed, idempotent kernel loop.
//
// NO VISION MODEL. The audit runs over the document's EXTRACTED TEXT, produced by the existing
// text-extraction stack (lib/documents/ocr-pdf.ts → pdf-parse text layer, surfaced through the
// universal scanner lib/documents/scan-uploaded-document.ts). The checklist is verified against
// that extracted TEXT — deterministic text checks (required disclosure clauses / dates / form
// id present) plus an OPTIONAL gateway-TEXT pass (a plain-text JSON model call, NOT an image
// pass) for the harder semantic checks (e.g. "is the signature block actually executed", "are
// party names internally consistent"). Findings are TEXT/CHECKLIST-derived, never vision.
//
// The existing compliance gate (composition-gate / communication-compliance) covers TEXT WE
// generate. This covers DOCUMENTS clients/agents UPLOAD: required-disclosures/clauses/dates
// present in the extracted text, required-document present for the transaction stage, and the
// right form/type — classified deterministically, recorded on the document row
// (client_documents.ai_metadata — REUSED jsonb, no new table, no migration), and on findings
// ESCALATED to the broker through the EXISTING notifications rail (broker/admin/compliance
// recipients) plus an audit line on the manager-signals bus.
//
// HONESTY CONTRACT:
//   · text cannot be extracted (encrypted / image-only with no OCR text) → status 'not_audited'.
//     NEVER fabricate a finding and NEVER fabricate a pass off of empty text.
//   · text extracted + every checklist item satisfied → 'passed', zero findings, NO escalation.
//   · text extracted + checklist gaps → 'findings', classified findings, broker escalated.
//   · idempotent per (document, extracted-text content): re-running over the SAME text is a no-op.
//
// The text extraction is an INJECTABLE SEAM (textExtractor) — the real ocr-pdf default runs in
// production; the simulator injects fixed extracted TEXT so the live test spends no tokens. The
// semantic gateway-text pass is a second injectable seam (textChecker), defaulting to a
// deterministic-only audit when no gateway pass is provided (never a vision call).
//
// NOT server-only (simulator-driven, like the rest of the kernel loaders). Only ever writes
// through a caller-supplied/service client.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

// ─── Pure layer 1: the checklist ─────────────────────────────────────────────

/** The compliance checks the text audit runs for a given document type. The legacy flows
 *  hard-coded "signatures + dates + disclosures"; this makes the checklist EXPLICIT and
 *  type-aware so the audit stays honest about what was actually inspected in the TEXT. */
export type AuditCheck =
  | "signatures_present"
  | "dates_present"
  | "correct_form"
  | "form_not_expired"
  | "required_disclosures_present"
  | "names_match"
  | "addresses_match"

export interface ChecklistItem {
  check: AuditCheck
  /** Plain description of what this check verifies in the extracted text. */
  describe: string
  /** When true a failure on this check is a BLOCKING (critical) finding, not a warning. */
  blocking: boolean
}

/** Document types that carry binding signatures (contracts) — the full check set. */
const CONTRACT_TYPES = new Set<string>([
  "purchase_agreement", "signed_contract", "listing_agreement", "counter_offer",
  "addendum", "commission_agreement", "agency_disclosure", "closing_disclosure",
])
/** Document types that are disclosures/forms — signatures + dates + the disclosure body. */
const DISCLOSURE_TYPES = new Set<string>([
  "disclosure", "disclosure_form", "disclosures", "wire_instructions",
])

/**
 * PURE. Resolve the checklist for a document type. `requiredDocs` (the brokerage's
 * required-document classifications, from lib/compliance/required-documents.ts) decides
 * whether the disclosure-presence check is in scope: if the type is a required
 * classification we additionally insist required disclosures are present in the text.
 */
export function auditChecklist(
  documentType: string | null | undefined,
  requiredDocs: ReadonlyArray<string> = [],
): ChecklistItem[] {
  const t = (documentType ?? "other").toLowerCase()
  const isContract = CONTRACT_TYPES.has(t)
  const isDisclosure = DISCLOSURE_TYPES.has(t)
  const isRequired = requiredDocs.map((d) => d.toLowerCase()).includes(t)

  const items: ChecklistItem[] = []

  if (isContract || isDisclosure) {
    items.push({ check: "signatures_present", describe: "Every required signature block is executed (signed) in the document text.", blocking: true })
    items.push({ check: "dates_present", describe: "Every required date/execution field is filled in.", blocking: true })
  }
  if (isContract) {
    items.push({ check: "names_match", describe: "Party names are internally consistent throughout the document.", blocking: false })
    items.push({ check: "addresses_match", describe: "The property address is consistent throughout the document.", blocking: false })
  }
  // Form correctness/expiry applies to any classified form (a wrong or expired form is a
  // license risk regardless of the contract/disclosure split).
  items.push({ check: "correct_form", describe: `The document is the correct form for a ${t} (not a mismatched or superseded form).`, blocking: true })
  items.push({ check: "form_not_expired", describe: "The form version/edition is current and not an expired/withdrawn revision.", blocking: false })

  if (isDisclosure || isRequired) {
    items.push({ check: "required_disclosures_present", describe: "All disclosures required for this document are present and complete in the text.", blocking: true })
  }

  return items
}

// ─── The extracted-text seam ─────────────────────────────────────────────────

/**
 * The shape a text extractor returns. `ok:false` means text could NOT be extracted
 * (no fetchable file / encrypted / image-only with no OCR text) → the audit honestly records
 * 'not_audited'. `ok:true` carries the extracted plain text — an EMPTY-but-ok payload is still
 * treated as not_audited (no text = nothing to audit honestly).
 */
export interface ExtractedText {
  ok: boolean
  /** The plain text extracted from the document (truncated by the extractor). */
  text?: string | null
  /** Free-text reason when ok:false (e.g. "OCR returned no text layer"). */
  reason?: string | null
}

export interface TextExtractorInput {
  documentUrl: string
  brokerageId: string | null
  documentType: string
  documentName: string | null
}
export type TextExtractor = (input: TextExtractorInput) => Promise<ExtractedText>

/**
 * The REAL default — reuses lib/documents/ocr-pdf.ts (the SAME text-extraction source of
 * truth the universal scanner uses: pdf-parse text layer first). NO vision: when the text
 * layer is empty the extractor honestly returns ok:false → the audit records 'not_audited'.
 */
export const defaultTextExtractor: TextExtractor = async (input) => {
  if (!input.documentUrl || input.documentUrl.startsWith("data:")) {
    // A truncated DB-fallback URL is not a fetchable file — can't extract text honestly.
    return { ok: false, reason: "document has no fetchable file URL" }
  }
  try {
    const { ocrDocumentFromUrl } = await import("@/lib/documents/ocr-pdf")
    const ocr = await ocrDocumentFromUrl({ storageUrl: input.documentUrl, brokerageId: input.brokerageId })
    if (!ocr.success || !ocr.text || ocr.text.trim().length === 0) {
      return { ok: false, reason: ocr.error ?? "no extractable text (encrypted/image-only with no text layer)" }
    }
    return { ok: true, text: ocr.text }
  } catch (e: any) {
    return { ok: false, reason: `text extraction failed: ${e?.message ?? String(e)}` }
  }
}

// ─── The semantic gateway-TEXT seam (NOT vision) ─────────────────────────────

/** A single text-derived issue the audit surfaces as a finding. */
export interface TextIssue {
  /** The checklist item this issue maps to; unknown maps to "other". */
  check?: string | null
  /** "critical" | "warning"; anything else defers to the checklist blocking-ness. */
  severity?: string | null
  /** What is wrong (quoted/derived from the extracted text). */
  detail?: string | null
}

export interface TextCheckerInput {
  text: string
  documentType: string
  documentName: string | null
  checklist: ReadonlyArray<ChecklistItem>
}
/** Returns the semantic issues found in the TEXT, or null when no gateway pass ran (the audit
 *  then relies on the deterministic text checks only — never a vision fallback). */
export type TextChecker = (input: TextCheckerInput) => Promise<TextIssue[] | null>

/**
 * The REAL semantic checker — a PLAIN-TEXT gateway pass (NOT an image/vision pass). It sends the
 * already-extracted text and asks the model to report ONLY checklist gaps it can read in that
 * text. Honestly returns null when the gateway key is missing or the call/parse fails (the audit
 * then stands on the deterministic text checks alone).
 */
export const defaultTextChecker: TextChecker = async (input) => {
  if (!process.env.AI_GATEWAY_API_KEY) return null
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const checklistLines = input.checklist
      .map((c) => `- ${c.check} (${c.blocking ? "blocking" : "warning"}): ${c.describe}`)
      .join("\n")
    const prompt = `You are a real-estate document compliance auditor. Below is the EXTRACTED TEXT of a ${input.documentType} ("${input.documentName ?? "document"}"). Using ONLY this text, verify these checks:
${checklistLines}

Return ONLY valid JSON (no markdown):
{
  "issues": [
    { "check": "<one of the check ids above, or 'other'>", "severity": "critical|warning", "detail": "<what is wrong, grounded in the text>" }
  ]
}
Report ONLY real problems you can actually read in the text. If everything checks out, return { "issues": [] }. Do not invent issues you cannot ground in the text.

--- DOCUMENT TEXT START ---
${input.text.slice(0, 16_000)}
--- DOCUMENT TEXT END ---`

    const res = await generateTextRouted({
      feature: "document_compliance_audit",
      system: "You are a strict JSON compliance auditor for real-estate documents. Output JSON only — no prose. Ground every issue in the provided text.",
      prompt,
      temperature: 0,
      maxTokens: 800,
    } as any)

    const text = (res?.text ?? "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim()
    let parsed: { issues?: TextIssue[] }
    try {
      parsed = JSON.parse(text)
    } catch {
      return null // unparseable → fall back to deterministic-only (never a fabricated pass)
    }
    return Array.isArray(parsed.issues) ? parsed.issues : []
  } catch {
    return null
  }
}

// ─── Pure layer 1: deterministic text checks ─────────────────────────────────

/** Signature EXECUTION markers a signed document text carries (DocuSign/wet/e-sign). These are
 *  evidence the document was actually SIGNED, not merely a blank signature-block LABEL (the bare
 *  word "signature" appears on unexecuted forms too, so it is intentionally excluded). */
const SIGNATURE_MARKERS = [
  "/s/", "signed by", "electronically signed", "docusign", "e-signature",
  "esignature", "signed:", "x___", "x____", "digitally signed",
]
/** Date markers — a filled execution date leaves a year + a month or an ISO/US date. */
const DATE_REGEXES = [
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,                       // 06/13/2026
  /\b\d{4}-\d{2}-\d{2}\b/,                               // 2026-06-13
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i, // June 13, 2026
]
/** Disclosure-body markers — a real disclosure form names what it discloses. */
const DISCLOSURE_MARKERS = [
  "disclosure", "disclose", "lead-based paint", "lead based paint", "hereby disclos",
  "seller's property", "transfer disclosure", "natural hazard", "material defect",
]

function textHasAny(text: string, needles: ReadonlyArray<string>): boolean {
  const t = text.toLowerCase()
  return needles.some((n) => t.includes(n.toLowerCase()))
}

/**
 * PURE, DETERMINISTIC. Run the text-checkable items of the checklist against the extracted text.
 * Only checks that have an honest TEXT signal are evaluated here:
 *   · signatures_present          — needs a signature marker in the text.
 *   · dates_present               — needs a real date in the text.
 *   · required_disclosures_present — needs disclosure-body language in the text.
 * The semantic checks (correct_form / form_not_expired / names_match / addresses_match) are left
 * to the optional gateway-text pass — the deterministic layer NEVER fabricates a pass for a
 * check it cannot read from the text; it only raises a finding when the required marker is
 * ABSENT from a document type that must carry it.
 */
export function deterministicTextIssues(
  text: string,
  checklist: ReadonlyArray<ChecklistItem>,
): TextIssue[] {
  const issues: TextIssue[] = []
  const has = (c: AuditCheck) => checklist.some((i) => i.check === c)

  if (has("signatures_present") && !textHasAny(text, SIGNATURE_MARKERS)) {
    issues.push({ check: "signatures_present", severity: "critical", detail: "No signature/execution marker found in the document text — the document does not appear to be signed." })
  }
  if (has("dates_present") && !DATE_REGEXES.some((re) => re.test(text))) {
    issues.push({ check: "dates_present", severity: "critical", detail: "No execution date found in the document text." })
  }
  if (has("required_disclosures_present") && !textHasAny(text, DISCLOSURE_MARKERS)) {
    issues.push({ check: "required_disclosures_present", severity: "critical", detail: "Required disclosure language not found in the document text." })
  }
  return issues
}

// ─── Pure layer 1: classify text issues → findings ───────────────────────────

export type FindingSeverity = "critical" | "warning"
export type AuditStatus = "passed" | "findings" | "not_audited"

export interface AuditFinding {
  check: AuditCheck | "other"
  severity: FindingSeverity
  detail: string
}

export interface ClassifiedFindings {
  status: AuditStatus
  severity: FindingSeverity | null
  findings: AuditFinding[]
}

const KNOWN_CHECKS = new Set<AuditCheck>([
  "signatures_present", "dates_present", "correct_form", "form_not_expired",
  "required_disclosures_present", "names_match", "addresses_match",
])

/** Stable content hash of the extracted text + audit version — drives idempotency. */
function stableHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/**
 * PURE, DETERMINISTIC. Map an extracted-text result + collected text issues to classified
 * findings.
 *   · extracted.ok !== true OR empty text → not_audited (no findings, no severity) — NEVER
 *     fabricates a pass or a finding off of missing text.
 *   · text present, no issues             → passed (no findings) — an HONEST clean pass.
 *   · text present, issues collected      → findings; overall severity is critical if any
 *                                           finding is critical, else warning.
 * The blocking-ness of each check (from the checklist) decides default severity when an issue
 * didn't specify one, so a missing SIGNATURE is critical even if the issue said nothing.
 */
export function classifyFindings(
  extracted: ExtractedText,
  issues: ReadonlyArray<TextIssue>,
  checklist: ReadonlyArray<ChecklistItem> = [],
): ClassifiedFindings {
  if (!extracted || extracted.ok !== true || !extracted.text || extracted.text.trim().length === 0) {
    return { status: "not_audited", severity: null, findings: [] }
  }
  if (!issues || issues.length === 0) {
    return { status: "passed", severity: null, findings: [] }
  }

  const blockingByCheck = new Map<string, boolean>()
  for (const item of checklist) blockingByCheck.set(item.check, item.blocking)

  // De-dupe issues per (check) — the deterministic + gateway passes can both flag the same gap.
  const seen = new Set<string>()
  const findings: AuditFinding[] = []
  for (const raw of issues) {
    const checkRaw = (raw.check ?? "").trim()
    const check = (KNOWN_CHECKS.has(checkRaw as AuditCheck) ? checkRaw : "other") as AuditFinding["check"]
    const detail = (raw.detail ?? "").trim() || "Unspecified compliance issue."
    const key = `${check}::${detail}`
    if (seen.has(key)) continue
    seen.add(key)
    let severity: FindingSeverity
    const sev = (raw.severity ?? "").trim().toLowerCase()
    if (sev === "critical" || sev === "warning") {
      severity = sev
    } else {
      severity = blockingByCheck.get(check) ? "critical" : "warning"
    }
    findings.push({ check, severity, detail })
  }

  const overall: FindingSeverity = findings.some((f) => f.severity === "critical") ? "critical" : "warning"
  return { status: "findings", severity: overall, findings }
}

// ─── Live runner ─────────────────────────────────────────────────────────────

export interface RunAuditResult {
  status: AuditStatus
  severity: FindingSeverity | null
  findings: AuditFinding[]
  escalated: number
  /** true when this run reused a prior audit for the same extracted text — no rewrite. */
  idempotentSkip: boolean
  reason?: string
}

const AUDIT_META_KEY = "document_compliance_audit"

/**
 * Run the document-TEXT compliance audit for one uploaded document.
 *   1. Load the client_documents row (brokerage-scoped).
 *   2. Build the type-aware checklist (using the brokerage's required-doc classifications).
 *   3. EXTRACT TEXT (injectable seam; ocr-pdf default). No vision.
 *   4. Run the deterministic text checks + the optional gateway-TEXT semantic pass → collect
 *      issues; classify deterministically → status/severity/findings.
 *   5. Record the result on client_documents.ai_metadata (REUSED jsonb — no new table).
 *   6. On findings, ESCALATE to the broker via the existing notifications rail + a consumed
 *      manager-signals audit line.
 * Idempotent per (document, extracted-text content): a re-run over the same text neither
 * rewrites the audit nor re-escalates.
 */
export async function runDocumentComplianceAudit(
  params: { documentId: string },
  opts: { textExtractor?: TextExtractor; textChecker?: TextChecker; now?: Date } = {},
  client?: Svc,
): Promise<RunAuditResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const textExtractor = opts.textExtractor ?? defaultTextExtractor
  // Default to a deterministic-only audit (textChecker null) — the gateway-text pass is opt-in
  // via opts.textChecker or, in production, callers may pass defaultTextChecker. NEVER vision.
  const textChecker = opts.textChecker ?? null

  const { data: doc } = await supabase
    .from("client_documents")
    .select("id, brokerage_id, contact_id, transaction_id, document_name, document_url, document_type, doc_category, ai_metadata")
    .eq("id", params.documentId)
    .maybeSingle()

  if (!doc) {
    return { status: "not_audited", severity: null, findings: [], escalated: 0, idempotentSkip: false, reason: "document not found" }
  }
  const d = doc as any
  const documentType: string = d.document_type ?? d.doc_category ?? "other"

  // Resolve the brokerage's required-document classifications (drives disclosure check).
  let requiredDocs: string[] = []
  if (d.brokerage_id) {
    const { data: reqRows } = await supabase
      .from("brokerage_required_documents")
      .select("classification")
      .eq("brokerage_id", d.brokerage_id)
      .eq("is_required", true)
    requiredDocs = ((reqRows ?? []) as Array<{ classification: string }>).map((r) => r.classification)
  }

  const checklist = auditChecklist(documentType, requiredDocs)

  // EXTRACT TEXT (no vision).
  const extracted = await textExtractor({
    documentUrl: d.document_url ?? "",
    brokerageId: d.brokerage_id ?? null,
    documentType,
    documentName: d.document_name ?? null,
  })

  // Idempotency key = hash of the extracted text (the audit input). A prior audit over the SAME
  // text is a no-op (don't rewrite/re-escalate).
  const contentHash =
    extracted.ok && extracted.text && extracted.text.trim().length > 0
      ? stableHash(`v2|${documentType}|${extracted.text}`)
      : null

  const prior = (d.ai_metadata ?? {})?.[AUDIT_META_KEY] as
    | { status?: AuditStatus; content_hash?: string | null; severity?: FindingSeverity | null; findings?: AuditFinding[] }
    | undefined
  if (contentHash && prior && prior.content_hash === contentHash && prior.status && prior.status !== "not_audited") {
    return {
      status: prior.status ?? "passed",
      severity: prior.severity ?? null,
      findings: prior.findings ?? [],
      escalated: 0,
      idempotentSkip: true,
    }
  }

  // Collect issues from the extracted text (deterministic + optional gateway-text), then classify.
  let issues: TextIssue[] = []
  if (extracted.ok && extracted.text && extracted.text.trim().length > 0) {
    issues = deterministicTextIssues(extracted.text, checklist)
    if (textChecker) {
      try {
        const semantic = await textChecker({ text: extracted.text, documentType, documentName: d.document_name ?? null, checklist })
        if (Array.isArray(semantic)) issues = issues.concat(semantic)
      } catch {
        /* gateway-text pass best-effort — the deterministic layer still stands */
      }
    }
  }

  const classified = classifyFindings(extracted, issues, checklist)

  // RECORD the audit result on the document row (REUSED ai_metadata jsonb — no new table).
  const auditRecord = {
    status: classified.status,
    severity: classified.severity,
    findings: classified.findings,
    content_hash: contentHash,
    checked: checklist.map((c) => c.check),
    method: "text_extraction",
    reason: extracted.ok ? null : (extracted.reason ?? "text extraction unavailable"),
    audited_at: now.toISOString(),
    source: "document_compliance_audit",
  }
  await supabase
    .from("client_documents")
    .update({ ai_metadata: { ...(d.ai_metadata ?? {}), [AUDIT_META_KEY]: auditRecord } })
    .eq("id", d.id)
    .eq("brokerage_id", d.brokerage_id)

  // Only findings escalate. A clean pass and an honest 'not_audited' do NOT alert anyone.
  let escalated = 0
  if (classified.status === "findings" && d.brokerage_id) {
    escalated = await escalateToBroker(supabase, {
      brokerageId: d.brokerage_id,
      documentId: d.id,
      documentName: d.document_name ?? "uploaded document",
      documentType,
      contactId: d.contact_id ?? null,
      transactionId: d.transaction_id ?? null,
      classified,
      now,
    })
  }

  return {
    status: classified.status,
    severity: classified.severity,
    findings: classified.findings,
    escalated,
    idempotentSkip: false,
    reason: extracted.ok ? undefined : (extracted.reason ?? undefined),
  }
}

/**
 * Escalate findings to the broker via the EXISTING notifications rail (broker/admin/
 * compliance recipients — the same owners the AI Sentinel uses) + a consumed audit line on
 * the manager-signals bus (Deal Coordinator owns transaction documents). Idempotent per
 * document: re-escalation is skipped by a notification-keyed guard.
 */
async function escalateToBroker(
  supabase: Svc,
  args: {
    brokerageId: string
    documentId: string
    documentName: string
    documentType: string
    contactId: string | null
    transactionId: string | null
    classified: ClassifiedFindings
    now: Date
  },
): Promise<number> {
  // Idempotency guard — one escalation per document while findings stand.
  const { data: already } = await supabase
    .from("notifications")
    .select("id")
    .eq("type", "document_compliance_finding")
    .eq("entity_id", args.documentId)
    .eq("is_read", false)
    .limit(1)
    .maybeSingle()
  if (already) return 0

  const { data: recipients } = await supabase
    .from("users")
    .select("id")
    .eq("brokerage_id", args.brokerageId)
    .in("user_type", ["broker", "admin", "compliance_officer"])
    .limit(20)
  const recipientRows = (recipients ?? []) as Array<{ id: string }>

  const critical = args.classified.severity === "critical"
  const lines = args.classified.findings
    .map((f) => `· [${f.severity.toUpperCase()}] ${f.check}: ${f.detail}`)
    .join("\n")
  const title = critical
    ? "🚨 Document compliance — BLOCKING issues on an uploaded document"
    : "⚠️ Document compliance — review needed on an uploaded document"
  const body = [
    `A text compliance audit of an uploaded ${args.documentType} ("${args.documentName}") found ${args.classified.findings.length} compliance issue${args.classified.findings.length === 1 ? "" : "s"}.`,
    lines,
    `No automated action was taken on the document — this is a broker review.`,
  ].join("\n")
  const priority = critical ? "critical" : "high"

  let escalated = 0
  for (const r of recipientRows) {
    const { error } = await supabase.from("notifications").insert({
      user_id: r.id,
      brokerage_id: args.brokerageId,
      type: "document_compliance_finding",
      title,
      body,
      priority,
      entity_type: "document",
      entity_id: args.documentId,
      contact_id: args.contactId,
      is_read: false,
    })
    if (!error) escalated += 1
  }

  // Audit line on the bus — Deal Coordinator (owns transaction documents) → Campaign
  // Orchestrator (the governance feed). Consumed inline (the work is done this pass).
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const pub = await publishManagerSignal({
      brokerageId: args.brokerageId,
      fromManager: "deal_coordinator",
      toManager: "campaign_orchestrator",
      signalType: "document_compliance_finding",
      message: `Uploaded ${args.documentType} "${args.documentName}" failed the text compliance audit: ${args.classified.findings.length} issue(s) (${args.classified.severity}) — broker escalated.`,
      entityType: "document",
      entityId: args.documentId,
      contactId: args.contactId,
    }, supabase)
    if (pub.ok && pub.signalId && !pub.reason) {
      await supabase
        .from("manager_signals")
        .update({
          status: "consumed",
          consumed_at: args.now.toISOString(),
          consumed_action: `document compliance audit escalated ${args.classified.findings.length} finding(s) to ${escalated} broker recipient(s)`,
        })
        .eq("id", pub.signalId)
    }
  } catch {
    /* bus audit line is best-effort — the broker escalation already landed */
  }

  return escalated
}
