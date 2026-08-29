"use server"

import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
// ─── THE TENANT, AND WHY `params.brokerageId` IS NOW A CLAIM AND NOT AN INPUT ───
//
// Every export here is a "use server" endpoint and every one of them takes a
// `brokerageId` straight off the caller — the only in-tree caller is the CLIENT
// component app/dashboard/transactions/[id]/transaction-detail-client.tsx, which
// passes whatever the browser holds. An earlier pass moved the AI COST LEDGER to
// the session and deliberately left the ROW WRITES on the parameter, reporting the
// tenancy defect rather than widening it. This is that report being acted on.
//
// RESEARCHED VERDICT (2026-08-26, owner ruling "idor shapes need to include them
// but that is a researched call for business reason"): THERE IS NO CROSS-TENANT
// BUSINESS CASE HERE. A transaction, its documents, its deadlines and its
// compliance checklist all belong to exactly one brokerage; nobody edits another
// brokerage's deal file. The one legitimate cross-tenant actor — platform staff
// operating a tenant — is already served by the act-as seam, which resolves the
// TARGET tenant server-side (lib/platform/acting-context.ts). Evidence that no
// second case exists is recorded in that file's CLAIMED-TENANT RULE header:
// live `has_brokerage_access()` grants exactly one brokerage per user plus
// platform admin, and `user_brokerage_roles` (the multi-seat table) is empty and
// read by no application code.
//
// So the parameter STAYS — it keeps the call self-describing and catches a stale
// browser tab — but it is VERIFIED, never trusted: resolveWriteContextForTenant
// refuses when it names a tenant this session does not act on, and every write
// below stamps `wc.brokerageId` (the session's answer), never `params.brokerageId`.
//
// GATING HERE ALSO REPAIRS ACT-AS. These writes used the cookie (RLS) client, and
// every table below carries `WITH CHECK (brokerage_id = current_user_brokerage_id())`
// — which is the STAFF member's own brokerage while they act as a tenant. So a
// superadmin operating a tenant had every one of these writes refused by RLS, and
// supabase-js resolves a refusal: the extraction-log insert below was a bare
// `await`, so it reported success over nothing. `wc.db` is the service client under
// an active FULL grant, and the extraction-log error is now read.
import { resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import {
  TRANSACTION_TASK_PRIORITY_PROMPT_UNION,
  coerceTaskPriority,
} from "@/lib/transactions/task-vocabulary"

// CONTRACT-TYPE doc_type values — drives which analysis path is used
const CONTRACT_TYPES = new Set([
  "purchase_agreement",
  "listing_agreement",
  "counter_offer",
  "addendum",
  "buyer_representation",
  "seller_disclosure",
  "lease_agreement",
])

const DISCLOSURE_TYPES = new Set([
  "seller_disclosure",
  "lead_paint_disclosure",
  "natural_hazard_disclosure",
  "agency_disclosure",
  "transfer_disclosure",
])

/**
 * Analyze a transaction_document row using AI SDK generateText.
 * Writes extracted_data + classification_confidence back to transaction_documents.
 * Also writes a document_extraction_log row for the audit trail.
 */
export async function analyzeTransactionDocument(params: {
  documentId: string
  transactionId: string
  brokerageId: string
  agentId: string
}): Promise<{
  success: boolean
  extracted?: Record<string, unknown>
  confidence?: number
  analysisType?: "classification" | "contract" | "disclosure"
  error?: string
}> {
  if (!isValidUUID(params.documentId) || !isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid document or transaction ID" }
  }

  // ★ ACT-AS WRITE SEAM ★ — tenant from the SESSION; params.brokerageId is a
  // claim verified against it (see header). Fails closed: no session tenant,
  // read-only act-as grant, or a foreign claim all refuse before any I/O.
  const wc = await resolveWriteContextForTenant(params.brokerageId)
  if (!wc.ok) return { success: false, error: wc.error }
  const supabase = wc.db

  try {
    const { data: doc, error: docErr } = await supabase
      .from("transaction_documents")
      .select("id, doc_type, doc_label, storage_url, extracted_data, notes")
      .eq("id", params.documentId)
      .eq("transaction_id", params.transactionId)
      // EXPLICIT TENANT PREDICATE, because `wc.db` is the SERVICE client under an
      // act-as grant and RLS is not there to confine it (§4 gate-then-service).
      .eq("brokerage_id", wc.brokerageId)
      .single()

    if (docErr || !doc) {
      return { success: false, error: "Document not found" }
    }

    const docType = doc.doc_type ?? "unknown"
    const docLabel = doc.doc_label ?? docType
    const isContract = CONTRACT_TYPES.has(docType)
    const isDisclosure = DISCLOSURE_TYPES.has(docType)

    let systemPrompt = ""
    let userPrompt = ""
    let analysisType: "classification" | "contract" | "disclosure" = "classification"

    if (isContract) {
      analysisType = "contract"
      systemPrompt =
        "You are a real estate contract analyst. Extract structured data from real estate contracts and identify risks, obligations, and deadlines. Always respond with valid JSON only."
      userPrompt = `Analyze this ${docLabel} document for a real estate transaction.

Document type: ${docType}
Document URL (for reference): ${doc.storage_url ?? "not available"}
Agent notes: ${doc.notes ?? "none"}

Return a JSON object with these exact keys:
{
  "summary": "brief plain-language summary",
  "keyTerms": [{"term": string, "value": string, "importance": "critical"|"important"|"standard"}],
  "obligations": [string],
  "deadlines": [{"description": string, "date": string}],
  "redFlags": [string],
  "negotiationPoints": [string],
  "recommendedActions": [string],
  "confidence": number between 0 and 1
}`
    } else if (isDisclosure) {
      analysisType = "disclosure"
      systemPrompt =
        "You are a real estate compliance specialist. Review disclosure documents for completeness and legal compliance. Always respond with valid JSON only."
      userPrompt = `Review this ${docLabel} disclosure document.

Document type: ${docType}
Document URL: ${doc.storage_url ?? "not available"}

Return a JSON object:
{
  "summary": "plain-language summary of what this disclosure covers",
  "complianceStatus": "complete"|"incomplete"|"requires_review",
  "missingItems": [string],
  "issues": [string],
  "clientImplications": [string],
  "recommendedActions": [string],
  "confidence": number between 0 and 1
}`
    } else {
      analysisType = "classification"
      systemPrompt =
        "You are a real estate document specialist. Classify and extract key data from real estate documents. Always respond with valid JSON only."
      userPrompt = `Classify and extract data from this document.

Document label: ${docLabel}
Document type: ${docType}
Document URL: ${doc.storage_url ?? "not available"}
Notes: ${doc.notes ?? "none"}

Return a JSON object:
{
  "documentCategory": string,
  "summary": "plain-language description of what this document is and why it matters",
  "keyFields": [{"field": string, "value": string}],
  "actionRequired": boolean,
  "actionDescription": string or null,
  "recommendedActions": [string],
  "confidence": number between 0 and 1
}`
    }

    const { text } = await generateText({
      brokerageId: wc.brokerageId,
      userId: wc.userId || null,
      model: "openai/gpt-4o-mini",
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    })

    // Parse JSON — strip markdown fences if present
    let extracted: Record<string, unknown>
    try {
      const cleaned = text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim()
      extracted = JSON.parse(cleaned)
    } catch {
      return { success: false, error: "AI returned unparseable response" }
    }

    const confidence = typeof extracted.confidence === "number" ? (extracted.confidence as number) : 0.7

    // Write back to transaction_documents
    const { error: updateErr } = await supabase
      .from("transaction_documents")
      .update({
        extracted_data: extracted,
        classification_confidence: confidence,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.documentId)
      .eq("brokerage_id", wc.brokerageId)

    if (updateErr) {
      return { success: false, error: updateErr.message }
    }

    // Write audit row to document_extraction_log.
    // THE ERROR IS READ. This was a bare `await`, and supabase-js RESOLVES a
    // refusal — so an RLS-blocked audit write (every act-as run, and every run
    // whose brokerage_id disagreed with the session) returned success with no
    // audit trail at all. The extraction happened; the record that it happened
    // did not. A failed audit row does not undo the analysis, so it is reported
    // rather than thrown, but it is never again silent.
    const { error: logErr } = await supabase.from("document_extraction_log").insert({
      transaction_doc_id: params.documentId,
      transaction_id: params.transactionId,
      brokerage_id: wc.brokerageId,
      extraction_method: "ai_claude",
      extracted_fields: extracted,
      confidence_score: confidence,
      processing_status: "completed",
      processed_at: new Date().toISOString(),
    })
    if (logErr) {
      console.error("[analyzeTransactionDocument] extraction audit row NOT written:", logErr.message)
    }

    return { success: true, extracted, confidence, analysisType }
  } catch (error) {
    // ── THE FAILURE HALF OF THE EXTRACTION LOG ──────────────────────────────
    //
    // `document_extraction_log.error_message` was READ BY CODE AND WRITTEN BY
    // NOBODY (census 1b) — app/portal/[contactId]/documents/page.tsx:68 selects
    // it on every extraction the client can see. It had no writer because BOTH
    // writers of this table (here and app/actions/documents.ts:201) only ever
    // logged the SUCCESS path, hardcoding processing_status 'completed'. A
    // document the AI could not read produced no row at all, so the extraction
    // ledger recorded only extractions that worked — the one shape of audit
    // trail that cannot be audited.
    //
    // 'failed' is a live value of the processing_status CHECK
    // (scripts/check-vocabularies.ts:662), so this needs no migration.
    //
    // The message is the thrown error's own text, truncated. It is written for
    // the agent and the audit trail; the client portal shows it as "we could not
    // read this document", never a raw stack.
    const message = error instanceof Error ? error.message : String(error ?? "extraction failed")
    const { error: failLogErr } = await supabase.from("document_extraction_log").insert({
      transaction_doc_id: params.documentId,
      transaction_id: params.transactionId,
      brokerage_id: wc.brokerageId,
      extraction_method: "ai_claude",
      processing_status: "failed",
      error_message: message.slice(0, 2000),
      processed_at: new Date().toISOString(),
    })
    if (failLogErr) {
      console.error("[analyzeTransactionDocument] FAILURE row not written either — this extraction failure is unrecorded:", failLogErr.message)
    }
    return handleError(error, "analyzeTransactionDocument")
  }
}

/**
 * Generate document deadline reminders for a transaction.
 * Creates rows in the tasks table (ai_generated = true).
 * Uses aiGenerateDocumentReminders signature from ai-document-intelligence.ts
 * but operates directly here to write to tasks (not client_documents).
 */
export async function generateTransactionDocumentReminders(params: {
  transactionId: string
  brokerageId: string
  agentId: string
}): Promise<{
  success: boolean
  remindersCreated?: number
  error?: string
}> {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  // ★ ACT-AS WRITE SEAM ★ — see header. Tenant from the session; the claim is verified.
  const wc = await resolveWriteContextForTenant(params.brokerageId)
  if (!wc.ok) return { success: false, error: wc.error }
  const supabase = wc.db

  try {
    // Load transaction + documents + deadlines.
    // Every read carries its own tenant predicate: `wc.db` is the SERVICE client
    // under an act-as grant, so RLS is not confining these (§4).
    const [{ data: transaction }, { data: docs }, { data: deadlines }] = await Promise.all([
      supabase
        .from("transactions")
        .select("id, property_address, close_date, stage, status")
        .eq("id", params.transactionId)
        .eq("brokerage_id", wc.brokerageId)
        .single(),
      supabase
        .from("transaction_documents")
        .select("id, doc_type, doc_label, status, uploaded_at")
        .eq("transaction_id", params.transactionId)
        .eq("brokerage_id", wc.brokerageId),
      supabase
        .from("transaction_deadlines")
        .select("id, deadline_type, deadline_date, status")
        .eq("transaction_id", params.transactionId)
        .eq("brokerage_id", wc.brokerageId)
        .eq("status", "pending"),
    ])

    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const { text } = await generateText({
      brokerageId: wc.brokerageId,
      userId: wc.userId || null,
      model: "openai/gpt-4o-mini",
      system:
        "You are a real estate transaction coordinator. Generate actionable document deadline reminders. Always respond with valid JSON only.",
      messages: [
        {
          role: "user",
          content: `Generate document reminders for this transaction:

Property: ${transaction.property_address}
Close Date: ${transaction.close_date ?? "TBD"}
Stage: ${transaction.stage}
Current Date: ${new Date().toISOString().split("T")[0]}

Documents uploaded (${docs?.length ?? 0}):
${JSON.stringify(docs ?? [])}

Pending deadlines:
${JSON.stringify(deadlines ?? [])}

Return a JSON array of reminders. Each must have:
[{
  "title": string (short task title),
  "description": string (clear action for the agent),
  "priority": ${TRANSACTION_TASK_PRIORITY_PROMPT_UNION},
  "dueDateOffset": number (days from today, 0 = today, negative = overdue),
  "category": string
}]

Only generate reminders for real missing or upcoming items. Maximum 8 reminders.`,
        },
      ],
    })

    let reminders: Array<{
      title: string
      description: string
      priority: string
      dueDateOffset: number
      category: string
    }>

    try {
      const cleaned = text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim()
      reminders = JSON.parse(cleaned)
    } catch {
      return { success: false, error: "AI returned unparseable reminder list" }
    }

    if (!Array.isArray(reminders) || reminders.length === 0) {
      return { success: true, remindersCreated: 0 }
    }

    const today = new Date()
    const taskRows = reminders.slice(0, 8).map((r) => {
      const dueDate = new Date(today)
      dueDate.setDate(dueDate.getDate() + (r.dueDateOffset ?? 3))
      return {
        transaction_id: params.transactionId,
        brokerage_id: wc.brokerageId,
        assigned_to_agent_id: params.agentId,
        title: r.title,
        description: r.description,
        // `r.priority ?? "medium"` was not a defence: `??` only fires on
        // null/undefined, so a PRESENT but invalid value ("urgent", which this
        // very prompt used to offer) went straight to a column whose
        // transaction_tasks_priority_check accepts only critical|high|medium|low
        // — and because this insert IS error-checked, one bad value failed the
        // WHOLE batch. Both the offered vocabulary above and this narrowing now
        // come from the same constant, so they cannot drift.
        priority: coerceTaskPriority(r.priority),
        due_date: dueDate.toISOString().split("T")[0],
        category: r.category ?? "documents",
        status: "pending",
        ai_generated: true,
        auto_generated: true,
      }
    })

    const { data: inserted, error: insertErr } = await supabase
      .from("transaction_tasks")
      .insert(taskRows)
      .select("id")

    if (insertErr) {
      return { success: false, error: insertErr.message }
    }

    return { success: true, remindersCreated: inserted?.length ?? 0 }
  } catch (error) {
    return handleError(error, "generateTransactionDocumentReminders")
  }
}

/**
 * Run a disclosure compliance check against existing transaction_documents.
 * Writes a compliance_checklists row and returns the result.
 */
export async function checkTransactionDisclosures(params: {
  transactionId: string
  brokerageId: string
  agentId: string
  state: string
}): Promise<{
  success: boolean
  complianceScore?: number
  missingDisclosures?: string[]
  issues?: string[]
  recommendations?: string[]
  error?: string
}> {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }
  // Tenant scope is not optional here — the compliance_checklists RLS WITH CHECK
  // is (brokerage_id = current_user_brokerage_id()) and NULL fails it, so an
  // unstamped write is refused. Reject up front rather than at the database.
  // (The value itself is no longer what gets written — see the header. It is
  // still shape-checked so a malformed claim is refused before the seam runs.)
  if (!isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid brokerage ID" }
  }

  // ★ ACT-AS WRITE SEAM ★ — see header. Tenant from the session; the claim is verified.
  const wc = await resolveWriteContextForTenant(params.brokerageId)
  if (!wc.ok) return { success: false, error: wc.error }
  const supabase = wc.db

  try {
    const { data: docs, error: docsError } = await supabase
      .from("transaction_documents")
      .select("doc_type, doc_label, status")
      .eq("transaction_id", params.transactionId)
      .eq("brokerage_id", wc.brokerageId)

    // A refused read resolves rather than throwing. Left undestructured, `docs`
    // would be null and the model would be asked to grade a deal it was told has
    // no documents at all — a confidently wrong 0% compliance score.
    if (docsError) {
      return { success: false, error: `Could not read transaction documents: ${docsError.message}` }
    }

    const { text } = await generateText({
      brokerageId: wc.brokerageId,
      userId: wc.userId || null,
      model: "openai/gpt-4o-mini",
      system:
        "You are a real estate compliance officer specializing in state disclosure requirements. Always respond with valid JSON only.",
      messages: [
        {
          role: "user",
          content: `Check disclosure compliance for a real estate transaction in ${params.state}.

Documents present:
${JSON.stringify(docs ?? [])}

Return JSON:
{
  "complianceScore": number 0-100,
  "requiredDisclosures": [{"name": string, "present": boolean, "status": "complete"|"missing"|"incomplete"}],
  "missingDisclosures": [string],
  "issues": [string],
  "recommendations": [string],
  "stateNotes": string
}`,
        },
      ],
    })

    let result: Record<string, unknown>
    try {
      const cleaned = text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim()
      result = JSON.parse(cleaned)
    } catch {
      return { success: false, error: "AI returned unparseable compliance data" }
    }

    // ── THE DISCLOSURE CHECK MUST BE RE-RUNNABLE ─────────────────────────────
    // This was a plain .insert() under a comment that denied the unique index
    // here existed. It does: compliance_checklists is UNIQUE on
    // (transaction_id, checklist_type), so the FIRST run wrote a row and every
    // run after it raised duplicate-key. The result was not destructured, so
    // supabase-js RESOLVED the refusal and this action returned success while
    // nothing was written — the check could only ever land once per deal.
    //
    // The fix is an UPSERT rather than a history table, because no reader of
    // compliance_checklists orders by created_at or takes a latest row —
    // lib/deal-health/health-scorer.ts, lib/application/compliance-monitoring.ts
    // and app/actions/workflows.ts all read every row for a transaction and treat
    // it as CURRENT STATE. Keeping a row per run would feed stale scores into the
    // live deal-health number. One authoritative row per checklist_type;
    // re-running UPDATES it, and updated_at makes the re-run visible.
    //
    // onConflict MUST name the arbiter: an upsert with no onConflict falls back
    // to the primary key (id), which never collides, so Postgres re-raises the
    // very same duplicate-key on the unique index. Naming the arbiter is the fix.
    //
    // brokerage_id is required, not optional: brok_compliance_checklists is the
    // only policy covering INSERT/UPDATE and its WITH CHECK is
    // (brokerage_id = current_user_brokerage_id()), which is FALSE for NULL.
    // compliance_score is clamped to satisfy CHECK (>= 0 AND <= 100).
    const { error: checklistError } = await supabase.from("compliance_checklists").upsert(
      {
        transaction_id: params.transactionId,
        brokerage_id: wc.brokerageId,
        checklist_type: "disclosures",
        items: result.requiredDisclosures ?? [],
        compliance_score: Math.max(0, Math.min(100, Math.round(Number(result.complianceScore ?? 0)))),
        ai_recommendations: result.recommendations ?? [],
        updated_at: new Date().toISOString(),
      },
      { onConflict: "transaction_id,checklist_type" },
    )

    if (checklistError) {
      return { success: false, error: `Disclosure check could not be recorded: ${checklistError.message}` }
    }

    return {
      success: true,
      complianceScore: result.complianceScore as number,
      missingDisclosures: result.missingDisclosures as string[],
      issues: result.issues as string[],
      recommendations: result.recommendations as string[],
    }
  } catch (error) {
    return handleError(error, "checkTransactionDisclosures")
  }
}

/**
 * Share an AI document analysis result as a portal message to the contact.
 * Writes to client_portal_messages.
 */
export async function shareDocumentAnalysisWithClient(params: {
  transactionId: string
  contactId: string
  brokerageId: string
  agentId: string
  documentLabel: string
  analysisText: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.transactionId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid IDs" }
  }

  // ★ ACT-AS WRITE SEAM ★ — see header. THIS EXPORT HAD NO IDENTITY CHECK AT ALL:
  // it took tenant, agent and contact from the caller and wrote a message into a
  // client's portal. It is the most sensitive of the four (the row is delivered to
  // a human being outside the brokerage), so it gates the same way as the rest.
  const wc = await resolveWriteContextForTenant(params.brokerageId)
  if (!wc.ok) return { success: false, error: wc.error }
  const supabase = wc.db

  const { error } = await supabase.from("client_portal_messages").insert({
    transaction_id: params.transactionId,
    contact_id: params.contactId,
    agent_id: params.agentId,
    brokerage_id: wc.brokerageId,
    direction: "agent_to_client",
    body: `AI Document Review — ${params.documentLabel}\n\n${params.analysisText}`,
    created_at: new Date().toISOString(),
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}
