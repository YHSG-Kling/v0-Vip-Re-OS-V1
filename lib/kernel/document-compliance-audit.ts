// lib/kernel/document-compliance-audit.ts
//
// DOCUMENT-VISION COMPLIANCE AUDIT — the live kernel equivalent of the legacy
// workflows/audit-document.json + workflows/broker-audit.json. Those n8n flows did one
// thing each: download an UPLOADED deal document, run a Gemini vision pass for
// signatures/dates/initials, and (broker-audit) escalate the finding to the broker via
// Slack/Airtable. This module folds BOTH into one governed, idempotent kernel loop.
//
// The existing compliance gate (composition-gate / communication-compliance) covers TEXT
// WE generate. This covers DOCUMENTS clients/agents UPLOAD: an AI vision pass scans the
// uploaded file for missing signatures/dates/initials, wrong/expired form, missing required
// disclosures, and mismatched names/addresses, classifies the findings deterministically,
// records the audit RESULT on the document row (client_documents.ai_metadata — REUSED jsonb,
// no new table, no migration), and on findings ESCALATES to the broker through the EXISTING
// notifications rail (broker/admin/compliance recipients, same pattern as the AI Sentinel)
// plus an audit line on the manager-signals bus.
//
// HONESTY CONTRACT:
//   · vision unavailable (no gateway creds / fetcher returns null) → status 'not_audited'.
//     NEVER fabricate a finding and NEVER fabricate a pass.
//   · a clean vision result → 'passed', zero findings, NO escalation.
//   · a vision result with issues → 'findings', classified findings, broker escalated.
//   · idempotent per (document, version): re-running with the SAME vision content is a no-op.
//
// The vision pass is an INJECTABLE SEAM (visionFetcher) — the real gateway-vision default
// runs in production; the simulator injects fixed results so the live test spends no tokens.
//
// NOT server-only (simulator-driven, like the rest of the kernel loaders). Only ever writes
// through a caller-supplied/service client.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

// ─── Pure layer 1: the checklist ─────────────────────────────────────────────

/** The compliance checks a vision pass should run for a given document type. The
 *  legacy flows hard-coded "signatures + dates + initials"; this makes the checklist
 *  EXPLICIT and type-aware so the prompt + the classifier stay honest about what was
 *  actually inspected. */
export type AuditCheck =
  | "signatures_present"
  | "dates_present"
  | "initials_each_page"
  | "correct_form"
  | "form_not_expired"
  | "required_disclosures_present"
  | "names_match"
  | "addresses_match"

export interface ChecklistItem {
  check: AuditCheck
  /** Plain description the vision prompt instructs the model to verify. */
  describe: string
  /** When true a failure on this check is a BLOCKING (critical) finding, not a warning. */
  blocking: boolean
}

/** Document types that carry binding signatures/initials (contracts) — the full check set. */
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
 * classification we additionally insist required disclosures are present.
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
    items.push({ check: "signatures_present", describe: "Every required signature block is signed by the correct party.", blocking: true })
    items.push({ check: "dates_present", describe: "Every required date/execution field is filled in.", blocking: true })
  }
  if (isContract) {
    items.push({ check: "initials_each_page", describe: "Required initials appear on every page that needs them.", blocking: false })
    items.push({ check: "names_match", describe: "Party names are internally consistent throughout the document.", blocking: false })
    items.push({ check: "addresses_match", describe: "The property address is consistent throughout the document.", blocking: false })
  }
  // Form correctness/expiry applies to any classified form (a wrong or expired form is a
  // license risk regardless of the contract/disclosure split).
  items.push({ check: "correct_form", describe: `The document is the correct form for a ${t} (not a mismatched or superseded form).`, blocking: true })
  items.push({ check: "form_not_expired", describe: "The form version/edition is current and not an expired/withdrawn revision.", blocking: false })

  if (isDisclosure || isRequired) {
    items.push({ check: "required_disclosures_present", describe: "All disclosures required for this document are present and complete.", blocking: true })
  }

  return items
}

// ─── Pure layer 1: classify the vision result → findings ─────────────────────

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

/**
 * The shape a vision fetcher returns. `ok:false` means the vision pass could NOT run
 * (no creds / fetch error) → the audit honestly records 'not_audited'. `ok:true` carries
 * the model's structured issues — an EMPTY issues array is a genuine clean pass.
 */
export interface VisionResult {
  ok: boolean
  /** Stable content hash of the model output — drives idempotency per (document, version). */
  contentHash?: string | null
  issues?: VisionIssue[] | null
  /** Free-text reason when ok:false (e.g. "AI_GATEWAY_API_KEY not configured"). */
  reason?: string | null
}

export interface VisionIssue {
  /** The checklist item this issue maps to; unknown maps to "other". */
  check?: string | null
  /** "critical" | "warning"; anything else is treated as warning. */
  severity?: string | null
  /** What is wrong. */
  detail?: string | null
}

const KNOWN_CHECKS = new Set<AuditCheck>([
  "signatures_present", "dates_present", "initials_each_page", "correct_form",
  "form_not_expired", "required_disclosures_present", "names_match", "addresses_match",
])

/**
 * PURE, DETERMINISTIC. Map a vision result to classified findings.
 *   · ok:false                → not_audited (no findings, no severity) — NEVER fabricates.
 *   · ok:true, no issues      → passed (no findings) — an HONEST clean pass.
 *   · ok:true, issues present → findings; overall severity is critical if any finding is
 *                               critical, else warning.
 * The blocking-ness of each check (from the checklist) decides default severity when the
 * model didn't specify one, so a missing SIGNATURE is critical even if the model said nothing.
 */
export function classifyFindings(
  vision: VisionResult,
  checklist: ReadonlyArray<ChecklistItem> = [],
): ClassifiedFindings {
  if (!vision || vision.ok !== true) {
    return { status: "not_audited", severity: null, findings: [] }
  }
  const issues = vision.issues ?? []
  if (issues.length === 0) {
    return { status: "passed", severity: null, findings: [] }
  }

  const blockingByCheck = new Map<string, boolean>()
  for (const item of checklist) blockingByCheck.set(item.check, item.blocking)

  const findings: AuditFinding[] = []
  for (const raw of issues) {
    const checkRaw = (raw.check ?? "").trim()
    const check = (KNOWN_CHECKS.has(checkRaw as AuditCheck) ? checkRaw : "other") as AuditFinding["check"]
    let severity: FindingSeverity
    const sev = (raw.severity ?? "").trim().toLowerCase()
    if (sev === "critical" || sev === "warning") {
      severity = sev
    } else {
      // No explicit severity → defer to the checklist: a blocking check defaults critical.
      severity = blockingByCheck.get(check) ? "critical" : "warning"
    }
    findings.push({
      check,
      severity,
      detail: (raw.detail ?? "").trim() || "Unspecified compliance issue.",
    })
  }

  const overall: FindingSeverity = findings.some((f) => f.severity === "critical") ? "critical" : "warning"
  return { status: "findings", severity: overall, findings }
}

// ─── The vision seam ─────────────────────────────────────────────────────────

export interface VisionFetcherInput {
  documentUrl: string
  documentType: string
  documentName: string | null
  checklist: ReadonlyArray<ChecklistItem>
}
export type VisionFetcher = (input: VisionFetcherInput) => Promise<VisionResult>

/** djb2 — small, dependency-free stable hash for idempotency keys. */
function stableHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/**
 * The REAL gateway-vision default. Mirrors the proven upload-scan call in
 * app/actions/documents.ts (generateText with an image content part through the gateway).
 * Honestly returns ok:false when the gateway key is missing or the call/parse fails — the
 * caller then records 'not_audited' (never a fabricated finding or pass).
 */
export const defaultVisionFetcher: VisionFetcher = async (input) => {
  if (!process.env.AI_GATEWAY_API_KEY) {
    return { ok: false, reason: "AI_GATEWAY_API_KEY not configured — vision pass unavailable" }
  }
  if (!input.documentUrl || input.documentUrl.startsWith("data:")) {
    // A truncated DB-fallback URL is not a fetchable image — can't audit honestly.
    return { ok: false, reason: "document has no fetchable file URL" }
  }
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const checklistLines = input.checklist
      .map((c) => `- ${c.check} (${c.blocking ? "blocking" : "warning"}): ${c.describe}`)
      .join("\n")
    const prompt = `You are a real-estate document compliance auditor. Examine the attached ${input.documentType} ("${input.documentName ?? "document"}") and verify ONLY these checks:
${checklistLines}

Return ONLY valid JSON (no markdown):
{
  "issues": [
    { "check": "<one of the check ids above, or 'other'>", "severity": "critical|warning", "detail": "<what is wrong>" }
  ]
}
Report ONLY real problems you can actually see. If everything checks out, return { "issues": [] }. Do not invent issues.`

    const res = await generateTextRouted({
      feature: "document_compliance_audit",
      // generateTextRouted accepts a messages array with content parts (same as the
      // upload-scan path); pass the image part through.
      messages: [
        {
          role: "user",
          content: ([
            { type: "text", text: prompt },
            { type: "image", image: input.documentUrl },
          ] as any),
        },
      ],
    } as any)

    const text = (res?.text ?? "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim()
    let parsed: { issues?: VisionIssue[] }
    try {
      parsed = JSON.parse(text)
    } catch {
      // The model answered but we cannot trust an unparseable result — not_audited, not a pass.
      return { ok: false, reason: "vision result could not be parsed" }
    }
    const issues = Array.isArray(parsed.issues) ? parsed.issues : []
    return { ok: true, issues, contentHash: stableHash(JSON.stringify(issues)) }
  } catch (e: any) {
    return { ok: false, reason: `vision call failed: ${e?.message ?? String(e)}` }
  }
}

// ─── Live runner ─────────────────────────────────────────────────────────────

export interface RunAuditResult {
  status: AuditStatus
  severity: FindingSeverity | null
  findings: AuditFinding[]
  escalated: number
  /** true when this run reused a prior audit for the same (document, version) — no rewrite. */
  idempotentSkip: boolean
  reason?: string
}

const AUDIT_META_KEY = "document_compliance_audit"

/**
 * Run the document-vision compliance audit for one uploaded document.
 *   1. Load the client_documents row (brokerage-scoped).
 *   2. Build the type-aware checklist (using the brokerage's required-doc classifications).
 *   3. Run the vision pass (injectable seam; real gateway default).
 *   4. Classify deterministically → status/severity/findings.
 *   5. Record the result on client_documents.ai_metadata (REUSED jsonb — no new table).
 *   6. On findings, ESCALATE to the broker via the existing notifications rail + a
 *      consumed manager-signals audit line.
 * Idempotent per (document, vision contentHash): a re-run with the same vision content
 * neither rewrites the audit nor re-escalates.
 */
export async function runDocumentComplianceAudit(
  params: { documentId: string },
  opts: { visionFetcher?: VisionFetcher; now?: Date } = {},
  client?: Svc,
): Promise<RunAuditResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const visionFetcher = opts.visionFetcher ?? defaultVisionFetcher

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

  // Run the vision pass.
  const vision = await visionFetcher({
    documentUrl: d.document_url ?? "",
    documentType,
    documentName: d.document_name ?? null,
    checklist,
  })

  // Idempotency: a prior audit for the SAME vision content is a no-op (don't rewrite/re-escalate).
  const prior = (d.ai_metadata ?? {})?.[AUDIT_META_KEY] as
    | { status?: AuditStatus; content_hash?: string | null; severity?: FindingSeverity | null; findings?: AuditFinding[] }
    | undefined
  if (vision.ok && vision.contentHash && prior && prior.content_hash === vision.contentHash && prior.status !== "not_audited") {
    return {
      status: prior.status ?? "passed",
      severity: prior.severity ?? null,
      findings: prior.findings ?? [],
      escalated: 0,
      idempotentSkip: true,
    }
  }

  const classified = classifyFindings(vision, checklist)

  // RECORD the audit result on the document row (REUSED ai_metadata jsonb — no new table).
  const auditRecord = {
    status: classified.status,
    severity: classified.severity,
    findings: classified.findings,
    content_hash: vision.contentHash ?? null,
    checked: checklist.map((c) => c.check),
    reason: vision.ok ? null : (vision.reason ?? "vision unavailable"),
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
    reason: vision.ok ? undefined : (vision.reason ?? undefined),
  }
}

/**
 * Escalate findings to the broker via the EXISTING notifications rail (broker/admin/
 * compliance recipients — the same owners the AI Sentinel uses) + a consumed audit line on
 * the manager-signals bus (Deal Coordinator owns transaction documents). Idempotent per
 * (document, vision content): re-escalation is skipped by a notification-keyed guard.
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
    `An AI vision audit of an uploaded ${args.documentType} ("${args.documentName}") found ${args.classified.findings.length} compliance issue${args.classified.findings.length === 1 ? "" : "s"}.`,
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
      message: `Uploaded ${args.documentType} "${args.documentName}" failed the vision compliance audit: ${args.classified.findings.length} issue(s) (${args.classified.severity}) — broker escalated.`,
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
