"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"

// ============================================
// AI DOCUMENT INTELLIGENCE SYSTEM
// Smart document processing, analysis, and compliance checking
// ============================================

/**
 * The live `client_documents_doc_category_check` vocabulary (pg_constraint,
 * verified 2026-08-04). doc_category is the CHECK-constrained INTAKE taxonomy —
 * the free-form AI `category` must never be written into it.
 */
// NOTE: NOT exported as a value — a "use server" module may only export async functions.
const CLIENT_DOCUMENT_CATEGORIES = [
  "pre_approval_letter", "proof_of_funds", "bank_statement", "gift_letter",
  "tax_return", "employment_verification", "offer_form", "contract",
  "disclosure", "inspection_report", "appraisal", "title", "insurance", "other",
] as const

interface DocumentScope {
  ok: boolean
  error?: string
  userId?: string
  agentId?: string | null
  brokerageId?: string
}

/**
 * AUTH + TENANCY for a client_documents row.
 *
 * Every function in this file used to take a caller-supplied `agentId` and a
 * caller-supplied `documentId` with no gate whatsoever. The identity classes are
 * distinct and are NOT interchangeable — verified against pg_constraint:
 *   · client_documents.uploaded_by  FK-> users(id)
 *   · brand_voice_profile.agent_id  FK-> agents(id)
 * so the scope carries both and each read/write picks the one its column means.
 */
async function scopeDocument(documentId: string): Promise<DocumentScope> {
  if (!isValidUUID(documentId)) return { ok: false, error: "Invalid document ID" }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }

  // Service client so the tenancy check sees the row's real stamp rather than an
  // RLS-filtered nothing — and it carries an EXPLICIT brokerage comparison below,
  // never an implicit one.
  const svc = createServiceClient()
  const { data: doc, error } = await svc
    .from("client_documents")
    .select("id, brokerage_id")
    .eq("id", documentId)
    .maybeSingle()

  if (error) return { ok: false, error: `Could not verify the document: ${error.message}` }
  if (!doc) return { ok: false, error: "Document not found" }
  // An unstamped legacy document is readable only by the brokerage that can
  // already see it through RLS; a stamped one must match exactly.
  if (doc.brokerage_id && doc.brokerage_id !== ctx.brokerageId) {
    return { ok: false, error: "Forbidden: document not in your brokerage" }
  }

  return { ok: true, userId: ctx.userId, agentId: ctx.agentId, brokerageId: ctx.brokerageId }
}

/**
 * Models fence JSON in ```json blocks often enough that a bare JSON.parse is a
 * coin flip. The sibling action file already strips fences; this file did not,
 * so every fenced response threw and was reported as an opaque failure.
 */
function parseModelJson<T>(text: string): { ok: true; value: T } | { ok: false; error: string } {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
  try {
    return { ok: true, value: JSON.parse(cleaned) as T }
  } catch {
    return { ok: false, error: "The model did not return readable JSON. Try again." }
  }
}

/**
 * AI-powered document classification and extraction
 * Automatically categorizes documents and extracts key data
 */
export async function aiClassifyDocument(params: {
  documentId: string
  /** Ignored — identity comes from the session (see scopeDocument). */
  agentId?: string
  documentText?: string
}): Promise<{
  success: boolean
  classification?: {
    documentType: string
    category: string
    confidence: number
    extractedData: Record<string, any>
    complianceFlags: string[]
    missingFields: string[]
  }
  error?: string
}> {
  const scope = await scopeDocument(params.documentId)
  if (!scope.ok) return { success: false, error: scope.error }

  const supabase = await createClient()

  try {
    // Get document details — `error` destructured, because a refused read used to
    // come back { data: null } and be reported as "Document not found".
    const { data: document, error: docError } = await supabase
      .from("client_documents")
      .select("*")
      .eq("id", params.documentId)
      .maybeSingle()

    if (docError) return { success: false, error: `Could not load the document: ${docError.message}` }
    if (!document) {
      return { success: false, error: "Document not found" }
    }

    const textToAnalyze = params.documentText || document.document_name

    const { object } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        documentType: z.string().describe("Type of document (e.g., purchase_agreement, listing_agreement, disclosure, addendum, inspection_report, loan_estimate)"),
        category: z.string().describe("Category (transaction, compliance, marketing, client, financial)"),
        confidence: z.number().describe("Confidence score 0-1"),
        extractedData: z.record(z.string(), z.any()).describe("Key extracted data fields"),
        complianceFlags: z.array(z.string()).describe("Any compliance issues found"),
        missingFields: z.array(z.string()).describe("Required fields that appear to be missing"),
        suggestedActions: z.array(z.string()).describe("Recommended next actions"),
      }),
      prompt: `Analyze this real estate document and classify it:

Document Name: ${document.document_name}
File Type: ${document.document_type}
Document Content/Text: ${textToAnalyze}

Classify the document type, extract key data points (dates, amounts, parties, addresses, terms), identify any compliance issues, and note any missing required fields.`,
    })

    // Update document with classification.
    // AI outputs consolidate into the canonical ai_metadata bag (no separate ai_* columns). The
    // AI's coarse category is preserved inside classification; doc_category is a CHECK-constrained
    // intake taxonomy (see CLIENT_DOCUMENT_CATEGORIES) and is intentionally NOT overwritten by the
    // free-form AI category (would violate client_documents_doc_category_check).
    // The write is CHECKED: an unchecked update reported a classification the
    // document never received, and the Document Center reads scanStatus straight
    // out of this bag — a lost write means the badge never changes.
    const { error: updateError } = await supabase
      .from("client_documents")
      .update({
        ai_metadata: { ...(document.ai_metadata || {}), classification: object, processing_status: "processed" },
      })
      .eq("id", params.documentId)

    if (updateError) {
      return { success: false, error: `Classified, but the result could not be saved: ${updateError.message}` }
    }

    return { success: true, classification: object }
  } catch (error) {
    return handleError(error, "aiClassifyDocument")
  }
}

/**
 * AI-powered contract analysis
 * Analyzes contracts for risks, key terms, and recommendations
 */
export async function aiAnalyzeContract(params: {
  documentId: string
  agentId: string
  contractText: string
  contractType: "purchase" | "listing" | "lease" | "addendum"
}): Promise<{
  success: boolean
  analysis?: {
    summary: string
    keyTerms: Array<{ term: string; value: string; importance: string }>
    risks: Array<{ risk: string; severity: string; mitigation: string }>
    unusualClauses: string[]
    recommendations: string[]
    deadlines: Array<{ description: string; date: string; daysRemaining: number }>
    negotiationPoints: string[]
  }
  error?: string
}> {
  if (!isValidUUID(params.documentId)) {
    return { success: false, error: "Invalid document ID" }
  }

  const supabase = await createClient()

  try {
    const { object } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        summary: z.string().describe("Executive summary of the contract"),
        keyTerms: z.array(z.object({
          term: z.string(),
          value: z.string(),
          importance: z.enum(["critical", "important", "standard"]),
        })).describe("Key contract terms"),
        risks: z.array(z.object({
          risk: z.string(),
          severity: z.enum(["high", "medium", "low"]),
          mitigation: z.string(),
        })).describe("Identified risks"),
        unusualClauses: z.array(z.string()).describe("Unusual or non-standard clauses"),
        recommendations: z.array(z.string()).describe("Recommendations for the agent/client"),
        deadlines: z.array(z.object({
          description: z.string(),
          date: z.string(),
          daysRemaining: z.number(),
        })).describe("Important deadlines"),
        negotiationPoints: z.array(z.string()).describe("Potential negotiation points"),
      }),
      prompt: `Analyze this ${params.contractType} contract for a real estate professional:

${params.contractText}

Provide a comprehensive analysis including:
1. Executive summary
2. Key terms and their values
3. Potential risks and how to mitigate them
4. Any unusual or non-standard clauses
5. Recommendations for the agent
6. Important deadlines with days remaining
7. Potential negotiation points`,
    })

    // Store analysis in the canonical ai_metadata bag (merge to preserve any prior
    // classification). BOTH halves are checked now: the read was `const { data }`
    // only, so a refused read produced `priorDoc = null` and the merge SILENTLY
    // ERASED any classification already in the bag; the update was unchecked, so a
    // refused write reported an analysis the document never received — and the
    // contract-review surface tells the agent "Analysis saved to the document
    // record (ai_metadata.analysis)".
    const { data: priorDoc, error: priorError } = await supabase
      .from("client_documents")
      .select("ai_metadata")
      .eq("id", params.documentId)
      .maybeSingle()

    if (priorError) {
      return {
        success: false,
        error: `The analysis ran but the document could not be read back (${priorError.message}); saving it would have erased what is already on the record.`,
      }
    }

    const { error: analysisError } = await supabase
      .from("client_documents")
      .update({
        ai_metadata: { ...(priorDoc?.ai_metadata || {}), analysis: object, processing_status: "analyzed" },
      })
      .eq("id", params.documentId)

    if (analysisError) {
      return { success: false, error: `Analysed, but the result could not be saved: ${analysisError.message}` }
    }

    return { success: true, analysis: object }
  } catch (error) {
    return handleError(error, "aiAnalyzeContract")
  }
}

/**
 * AI-powered disclosure checker
 * Ensures all required disclosures are present and complete
 *
 * ── DELIBERATELY NOT WIRED TO A SURFACE ──────────────────────────────────────
 * compliance_checklists is UNIQUE on (transaction_id, checklist_type) —
 * compliance_checklists_transaction_id_checklist_type_key, the single surviving
 * constraint after m370 dropped the identical duplicate
 * compliance_checklists_txn_type_unique — so there is exactly ONE 'disclosures'
 * row per deal, and it already has a live writer reached from a real page:
 *
 *     app/actions/ai-transaction-documents.ts : checkTransactionDisclosures
 *       -> called by app/dashboard/transactions/[id]/transaction-detail-client.tsx:1077
 *       -> writes the same (transaction_id, 'disclosures') row, stamps
 *          brokerage_id (which this one did not), and reads the real
 *          transaction_documents doc_type taxonomy rather than free-text names.
 *
 * Wiring this to a second button would make one row two authors' — so it stays
 * unwired. Its defects are fixed below anyway, because an unwired capability is
 * work to finish, not to abandon.
 */
export async function aiCheckDisclosures(params: {
  transactionId: string
  /** Ignored — identity comes from the session. */
  agentId?: string
  state: string
  transactionType: "sale" | "purchase" | "lease"
}): Promise<{
  success: boolean
  disclosureCheck?: {
    requiredDisclosures: Array<{ name: string; required: boolean; present: boolean; status: string }>
    missingDisclosures: string[]
    incompleteDisclosures: string[]
    complianceScore: number
    recommendations: string[]
    stateSpecificRequirements: string[]
  }
  error?: string
}> {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()

  {
    const svc = createServiceClient()
    const { data: txn, error: txnError } = await svc
      .from("transactions")
      .select("brokerage_id")
      .eq("id", params.transactionId)
      .maybeSingle()
    if (txnError) return { success: false, error: `Could not verify the transaction: ${txnError.message}` }
    if (!txn || txn.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden: transaction not in your brokerage" }
    }
  }

  try {
    // Get existing documents for transaction
    const { data: documents, error: docsError } = await supabase
      .from("client_documents")
      .select("*")
      .eq("transaction_id", params.transactionId)

    if (docsError) {
      // A refused read here used to make the gate report "None uploaded" — i.e.
      // a compliance verdict of "everything is missing" produced by a failed
      // query rather than by an empty deal. Never let a gate read clean (or
      // dirty) because the query failed.
      return { success: false, error: `Could not read this deal's documents: ${docsError.message}` }
    }

    const documentNames = documents?.map(d => d.document_name).join(", ") || "None uploaded"

    const { object } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        requiredDisclosures: z.array(z.object({
          name: z.string(),
          required: z.boolean(),
          present: z.boolean(),
          status: z.enum(["complete", "incomplete", "missing", "not_required"]),
        })),
        missingDisclosures: z.array(z.string()),
        incompleteDisclosures: z.array(z.string()),
        complianceScore: z.number().describe("0-100 score"),
        recommendations: z.array(z.string()),
        stateSpecificRequirements: z.array(z.string()),
      }),
      prompt: `Check disclosure requirements for a ${params.transactionType} transaction in ${params.state}:

Documents currently uploaded: ${documentNames}

Analyze what disclosures are required by state law for this transaction type, which ones appear to be present, which are missing, and provide recommendations.

Common required disclosures include:
- Seller's Property Disclosure
- Lead-Based Paint Disclosure (pre-1978 homes)
- Agency Disclosure
- Transfer Disclosure Statement
- Natural Hazard Disclosure
- Megan's Law Disclosure
- Local Transfer Tax
- HOA Disclosures
- Smoke/CO Detector Compliance`,
    })

    // Store compliance check.
    //  · brokerage_id MUST be stamped: brok_compliance_checklists is the only
    //    policy that covers INSERT/UPDATE and its WITH CHECK is
    //    (brokerage_id = current_user_brokerage_id()) — FALSE for NULL, so every
    //    unstamped upsert was refused by RLS (live row count: 0).
    //  · compliance_score has CHECK (>= 0 AND <= 100) — clamp, don't let a model
    //    overshoot refuse the row.
    //  · the write is checked.
    const { error: checklistError } = await supabase.from("compliance_checklists").upsert({
      transaction_id: params.transactionId,
      brokerage_id: ctx.brokerageId,
      checklist_type: "disclosures",
      items: object.requiredDisclosures,
      compliance_score: Math.max(0, Math.min(100, Math.round(object.complianceScore ?? 0))),
      ai_recommendations: object.recommendations,
      updated_at: new Date().toISOString(),
    }, { onConflict: "transaction_id,checklist_type" })

    if (checklistError) {
      return { success: false, error: `Disclosure check could not be recorded: ${checklistError.message}` }
    }

    return { success: true, disclosureCheck: object }
  } catch (error) {
    return handleError(error, "aiCheckDisclosures")
  }
}

/**
 * AI-powered signature verification
 * Checks if all required signatures are present
 */
export async function aiVerifySignatures(params: {
  documentId: string
  transactionId?: string
  /** Ignored — identity comes from the session (see scopeDocument). */
  agentId?: string
}): Promise<{
  success: boolean
  verification?: {
    allSignaturesPresent: boolean
    requiredSignatures: Array<{ party: string; required: boolean; signed: boolean; signedDate?: string }>
    missingSignatures: string[]
    recommendations: string[]
  }
  /** True only when this call SEEDED a previously-NULL signature_status. */
  seededStatus?: boolean
  /** The provider-owned status as it stood before this advisory ran. */
  providerStatus?: string | null
  error?: string
}> {
  const scope = await scopeDocument(params.documentId)
  if (!scope.ok) return { success: false, error: scope.error }

  const supabase = await createClient()

  try {
    const { data: document, error: docError } = await supabase
      .from("client_documents")
      .select("*")
      .eq("id", params.documentId)
      .maybeSingle()

    if (docError) return { success: false, error: `Could not load the document: ${docError.message}` }
    if (!document) {
      return { success: false, error: "Document not found" }
    }

    const { text } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `Analyze signature requirements for this document:
      
Document: ${document.document_name}
Category: ${document.doc_category || "unknown"}
Dotloop Status: ${document.signature_status || "not in Dotloop"}

Determine what signatures are required and their current status. Return as JSON:
{
  "allSignaturesPresent": boolean,
  "requiredSignatures": [{"party": string, "required": boolean, "signed": boolean, "signedDate": string or null}],
  "missingSignatures": [string],
  "recommendations": [string]
}`,
    })

    const parsed = parseModelJson<{
      allSignaturesPresent: boolean
      requiredSignatures: Array<{ party: string; required: boolean; signed: boolean; signedDate?: string }>
      missingSignatures: string[]
      recommendations: string[]
    }>(text)
    if (!parsed.ok) return { success: false, error: parsed.error }
    const verification = parsed.value

    // ── THE ADVISORY IS RECORDED; THE PROVIDER'S VERDICT IS NOT OVERWRITTEN ───
    // client_documents.signature_status is a PROVIDER-OWNED column. Its authors
    // are, in order of authority:
    //   · lib/esign-webhooks/finalize-packet.ts (the universal webhook finalizer)
    //   · lib/transactions/sync-from-provider.ts
    //   · app/actions/dotloop-integration.ts sendForDotloopSignature ("pending_signature")
    // This function is an AI *reading* of a document. It must never flip a
    // provider-confirmed "signed" back to "pending_signature", and it must never
    // manufacture a "signed" the provider never reported — that would tell a
    // compliance reader a signature exists on a model's say-so.
    //
    // So: the full advisory always lands in the ai_metadata bag (its own key, no
    // competing writer), and signature_status is only ever SEEDED — set to
    // "pending_signature" when it is still NULL and the AI found a gap. The
    // `.is("signature_status", null)` predicate makes that a database-enforced
    // condition, not a read-then-write race.
    const { error: metaError } = await supabase
      .from("client_documents")
      .update({
        ai_metadata: { ...(document.ai_metadata || {}), signature_check: verification },
      })
      .eq("id", params.documentId)

    if (metaError) {
      return { success: false, error: `Verified, but the result could not be saved: ${metaError.message}` }
    }

    let seededStatus = false
    if (!verification.allSignaturesPresent && document.signature_status == null) {
      const { data: seeded, error: seedError } = await supabase
        .from("client_documents")
        .update({ signature_status: "pending_signature" })
        .eq("id", params.documentId)
        .is("signature_status", null)
        .select("id")
      if (seedError) {
        return { success: false, error: `Could not mark the document pending signature: ${seedError.message}` }
      }
      seededStatus = (seeded?.length ?? 0) > 0
    }

    return {
      success: true,
      verification,
      seededStatus,
      providerStatus: (document.signature_status as string | null) ?? null,
    }
  } catch (error) {
    return handleError(error, "aiVerifySignatures")
  }
}

/**
 * AI-powered document generation
 * Generates draft documents based on transaction data
 */
export async function aiGenerateDocument(params: {
  /** Ignored — identity comes from the session. */
  agentId?: string
  transactionId?: string
  documentType: "cover_letter" | "offer_summary" | "counter_proposal" | "property_description" | "agent_remarks"
  context: Record<string, any>
}): Promise<{
  success: boolean
  document?: {
    content: string
    documentType: string
    suggestions: string[]
  }
  error?: string
}> {
  // IDENTITY CLASSES ARE DISTINCT AND ARE RESOLVED, NOT SUBSTITUTED.
  // The old code passed ONE caller-supplied `params.agentId` to both
  //   users.id                     (users class)
  // and
  //   brand_voice_profile.agent_id (FK-> agents(id), agents class)
  // which is the self-contradiction scripts/identity-class-guard.ts flags for
  // this function — whichever class the caller happened to hold, the OTHER
  // lookup silently returned nothing and the document was generated with a
  // blank author and the default brand voice. Both now come from the session.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()

  try {
    if (params.transactionId) {
      if (!isValidUUID(params.transactionId)) {
        return { success: false, error: "Invalid transaction ID" }
      }
      const svc = createServiceClient()
      const { data: txn, error: txnError } = await svc
        .from("transactions")
        .select("brokerage_id")
        .eq("id", params.transactionId)
        .maybeSingle()
      if (txnError) return { success: false, error: `Could not verify the transaction: ${txnError.message}` }
      if (!txn || txn.brokerage_id !== ctx.brokerageId) {
        return { success: false, error: "Forbidden: transaction not in your brokerage" }
      }
    }

    // Get agent profile for personalization — USERS class.
    const { data: agent, error: agentError } = await supabase
      .from("users")
      .select("first_name, last_name, email, phone")
      .eq("id", ctx.userId)
      .maybeSingle()

    if (agentError) {
      return { success: false, error: `Could not load your profile: ${agentError.message}` }
    }

    // Brand voice — AGENTS class (brand_voice_profile.agent_id FK-> agents(id)).
    const { data: brandVoice, error: voiceError } = ctx.agentId
      ? await supabase
          .from("brand_voice_profile")
          .select("*")
          .eq("agent_id", ctx.agentId)
          .maybeSingle()
      : { data: null, error: null as any }

    if (voiceError) {
      return { success: false, error: `Could not load your brand voice: ${voiceError.message}` }
    }

    const prompts: Record<string, string> = {
      cover_letter: `Write a professional cover letter for a real estate offer submission. Include:
- Warm introduction of the buyers
- Why they love this property
- Their qualifications and readiness
- Personal touch that stands out
Context: ${JSON.stringify(params.context)}`,
      offer_summary: `Create an executive summary of this offer for the listing agent. Include:
- Offer price and terms at a glance
- Buyer qualifications
- Key contingencies
- Timeline overview
Context: ${JSON.stringify(params.context)}`,
      counter_proposal: `Draft a counter proposal response that is professional and strategic. Include:
- Acknowledgment of the original terms
- Specific counter terms with rationale
- Win-win framing
Context: ${JSON.stringify(params.context)}`,
      property_description: `Write a compelling property description for MLS/marketing. Include:
- Headline that captures attention
- Key features and upgrades
- Lifestyle benefits
- Call to action
Context: ${JSON.stringify(params.context)}`,
      agent_remarks: `Write agent remarks for MLS that highlight:
- Showing instructions
- Offer submission process
- Key selling points for agents
- Any relevant disclosures
Context: ${JSON.stringify(params.context)}`,
    }

    const { text } = await generateText({
      model: resolveModel("openai/gpt-4o"),
      prompt: `${prompts[params.documentType]}

Agent: ${agent?.first_name} ${agent?.last_name}
Brand Voice: ${brandVoice?.tone || "professional and warm"}

Generate the document content:`,
    })

    return {
      success: true,
      document: {
        content: text,
        documentType: params.documentType,
        suggestions: [
          "Review for accuracy before sending",
          "Personalize any bracketed sections",
          "Have compliance review if required",
        ],
      },
    }
  } catch (error) {
    return handleError(error, "aiGenerateDocument")
  }
}

/**
 * AI-powered document comparison
 * Compares two versions of a document to highlight changes
 */
export async function aiCompareDocuments(params: {
  documentId1: string
  documentId2: string
  /** Ignored — identity comes from the session (see scopeDocument). */
  agentId?: string
}): Promise<{
  success: boolean
  comparison?: {
    summary: string
    changes: Array<{ section: string; original: string; modified: string; significance: string }>
    addedClauses: string[]
    removedClauses: string[]
    riskAssessment: string
    recommendations: string[]
  }
  error?: string
}> {
  if (params.documentId1 === params.documentId2) {
    return { success: false, error: "Pick two different documents to compare." }
  }

  // BOTH sides are tenancy-gated — a comparison is a read of two documents, and
  // one caller-supplied id used to be enough to pull a row from anywhere.
  const scope1 = await scopeDocument(params.documentId1)
  if (!scope1.ok) return { success: false, error: scope1.error }
  const scope2 = await scopeDocument(params.documentId2)
  if (!scope2.ok) return { success: false, error: scope2.error }

  const supabase = await createClient()

  try {
    const [{ data: doc1, error: err1 }, { data: doc2, error: err2 }] = await Promise.all([
      supabase.from("client_documents").select("*").eq("id", params.documentId1).maybeSingle(),
      supabase.from("client_documents").select("*").eq("id", params.documentId2).maybeSingle(),
    ])

    if (err1 || err2) {
      return { success: false, error: `Could not load the documents: ${(err1 ?? err2)!.message}` }
    }
    if (!doc1 || !doc2) {
      return { success: false, error: "One or both documents not found" }
    }

    const { object } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        summary: z.string(),
        changes: z.array(z.object({
          section: z.string(),
          original: z.string(),
          modified: z.string(),
          significance: z.enum(["critical", "important", "minor"]),
        })),
        addedClauses: z.array(z.string()),
        removedClauses: z.array(z.string()),
        riskAssessment: z.string(),
        recommendations: z.array(z.string()),
      }),
      prompt: `Compare these two document versions and identify all changes:

Document 1 (Original): ${doc1.document_name}
Content: ${doc1.content || doc1.ai_metadata?.analysis?.content || "Content not available"}

Document 2 (Modified): ${doc2.document_name}
Content: ${doc2.content || doc2.ai_metadata?.analysis?.content || "Content not available"}

Provide detailed comparison with risk assessment.`,
    })

    return { success: true, comparison: object }
  } catch (error) {
    return handleError(error, "aiCompareDocuments")
  }
}

/**
 * AI-powered document reminder system
 * Generates smart reminders for document deadlines
 */
export async function aiGenerateDocumentReminders(params: {
  transactionId: string
  /** Ignored — identity comes from the session. */
  agentId?: string
}): Promise<{
  success: boolean
  reminders?: Array<{
    documentName: string
    deadline: string
    daysRemaining: number
    priority: string
    reminderMessage: string
    suggestedAction: string
  }>
  error?: string
}> {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()

  try {
    // Get transaction and document deadlines. The embed is REAL here —
    // client_documents.transaction_id FK-> transactions(id) (pg_constraint:
    // client_documents_transaction_id_fkey), so PostgREST can infer it.
    const { data: transaction, error: txnError } = await supabase
      .from("transactions")
      .select("*, client_documents(*)")
      .eq("id", params.transactionId)
      .maybeSingle()

    if (txnError) return { success: false, error: `Could not load the transaction: ${txnError.message}` }
    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }
    if (transaction.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden: transaction not in your brokerage" }
    }

    const { text } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `Generate document deadline reminders for this transaction:

Transaction: ${JSON.stringify(transaction)}
Current Date: ${new Date().toISOString()}

Create reminders for any documents that:
1. Are missing but required
2. Have upcoming deadlines
3. Need signatures
4. Require review

Return as JSON array:
[{
  "documentName": string,
  "deadline": ISO date string,
  "daysRemaining": number,
  "priority": "urgent" | "high" | "medium" | "low",
  "reminderMessage": string (personalized message for agent),
  "suggestedAction": string
}]`,
    })

    // Fenced ```json responses used to throw straight out of JSON.parse and be
    // reported as an opaque failure. Parsed defensively now, and a non-array
    // response is refused rather than rendered as an empty reminder list.
    const parsed = parseModelJson<
      Array<{
        documentName: string
        deadline: string
        daysRemaining: number
        priority: string
        reminderMessage: string
        suggestedAction: string
      }>
    >(text)
    if (!parsed.ok) return { success: false, error: parsed.error }
    if (!Array.isArray(parsed.value)) {
      return { success: false, error: "The model did not return a reminder list. Try again." }
    }

    return { success: true, reminders: parsed.value }
  } catch (error) {
    return handleError(error, "aiGenerateDocumentReminders")
  }
}
