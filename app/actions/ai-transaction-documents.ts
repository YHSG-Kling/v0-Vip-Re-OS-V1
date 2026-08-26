"use server"

import { generateTextRouted as generateText } from "@/lib/ai/models"
import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
// THE SPEND ACTOR, AND WHY IT IS NOT `params.brokerageId`.
//
// Every export here is a "use server" endpoint and every one of them takes a
// `brokerageId` straight off the caller — the only callers in the tree are the
// CLIENT component app/dashboard/transactions/[id]/transaction-detail-client.tsx,
// which passes whatever the browser holds. CLAUDE.md §4: "Tenant comes from the
// SESSION. Never from a request body, never from a parameter." Billing AI spend
// against a body-supplied tenant is worse than not billing it: it is an invoice
// written on another brokerage. So the ledger's tenant is resolved here, from
// the session, and `params.brokerageId` is left to the row writes it already
// governs (a pre-existing tenancy defect, reported, not silently widened).
import { getAgentContext } from "@/lib/identity/get-agent-context"
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

  // Tenant for the AI cost ledger — SESSION, never params.brokerageId (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: doc, error: docErr } = await supabase
      .from("transaction_documents")
      .select("id, doc_type, doc_label, storage_url, extracted_data, notes")
      .eq("id", params.documentId)
      .eq("transaction_id", params.transactionId)
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
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
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

    if (updateErr) {
      return { success: false, error: updateErr.message }
    }

    // Write audit row to document_extraction_log
    await supabase.from("document_extraction_log").insert({
      transaction_doc_id: params.documentId,
      transaction_id: params.transactionId,
      brokerage_id: params.brokerageId,
      extraction_method: "ai_claude",
      extracted_fields: extracted,
      confidence_score: confidence,
      processing_status: "completed",
      processed_at: new Date().toISOString(),
    })

    return { success: true, extracted, confidence, analysisType }
  } catch (error) {
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

  // Tenant for the AI cost ledger — SESSION, never params.brokerageId (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    // Load transaction + documents + deadlines
    const [{ data: transaction }, { data: docs }, { data: deadlines }] = await Promise.all([
      supabase
        .from("transactions")
        .select("id, property_address, close_date, stage, status")
        .eq("id", params.transactionId)
        .single(),
      supabase
        .from("transaction_documents")
        .select("id, doc_type, doc_label, status, uploaded_at")
        .eq("transaction_id", params.transactionId),
      supabase
        .from("transaction_deadlines")
        .select("id, deadline_type, deadline_date, status")
        .eq("transaction_id", params.transactionId)
        .eq("status", "pending"),
    ])

    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const { text } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
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
        brokerage_id: params.brokerageId,
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
  if (!isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid brokerage ID" }
  }

  // Tenant for the AI cost ledger — SESSION, never params.brokerageId (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: docs, error: docsError } = await supabase
      .from("transaction_documents")
      .select("doc_type, doc_label, status")
      .eq("transaction_id", params.transactionId)

    // A refused read resolves rather than throwing. Left undestructured, `docs`
    // would be null and the model would be asked to grade a deal it was told has
    // no documents at all — a confidently wrong 0% compliance score.
    if (docsError) {
      return { success: false, error: `Could not read transaction documents: ${docsError.message}` }
    }

    const { text } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
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
        brokerage_id: params.brokerageId,
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

  const supabase = await createClient()

  const { error } = await supabase.from("client_portal_messages").insert({
    transaction_id: params.transactionId,
    contact_id: params.contactId,
    agent_id: params.agentId,
    brokerage_id: params.brokerageId,
    direction: "agent_to_client",
    body: `AI Document Review — ${params.documentLabel}\n\n${params.analysisText}`,
    created_at: new Date().toISOString(),
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}
