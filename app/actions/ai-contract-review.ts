"use server"

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { bookedGenerateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"

// Wave 98 (98C): every model call in this file is BOOKED to the SESSION tenant (lib/ai/generate.ts::bookedGenerateObject).
const generateObject = bookedGenerateObject("ai_contract_review")

// Every exported function in this file previously skipped the auth gate
// and the brokerage scope check. Any signed-in caller could:
//   - Run AI contract review against any brokerage's documents (Claude/GPT cost burn)
//   - Read/extract contract terms from any transaction
//   - Apply extracted terms to any transaction (mutating purchase_price,
//     close_date, property_address, milestones) — wreaking havoc on
//     other tenants' deals
//   - Compare any two documents in the database
//   - Generate AI document checklists for any transaction
//
// Helper resolves session brokerage; every function then verifies the
// target transaction / document belongs to that brokerage.

/**
 * AI Contract Review System
 * Analyzes real estate contracts for compliance, issues, and missing items
 */

const ContractIssueSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  category: z.string(),
  description: z.string(),
  location: z.string().optional(),
  recommendation: z.string(),
  regulatoryReference: z.string().optional(),
})

const ContractReviewSchema = z.object({
  overallScore: z.number().min(0).max(100),
  overallAssessment: z.string(),
  issues: z.array(ContractIssueSchema),
  missingItems: z.array(z.object({
    item: z.string(),
    required: z.boolean(),
    deadline: z.string().optional(),
  })),
  signatureStatus: z.array(z.object({
    party: z.string(),
    required: z.boolean(),
    signed: z.boolean(),
    signedDate: z.string().optional(),
  })),
  keyDates: z.array(z.object({
    date: z.string(),
    event: z.string(),
    daysRemaining: z.number().optional(),
  })),
  riskFactors: z.array(z.string()),
  recommendations: z.array(z.string()),
})

// Review a contract document
export async function reviewContract(params: {
  documentId: string
  transactionId: string
  agentId?: string  // ignored — derived from session
  documentType: "purchase_agreement" | "listing_agreement" | "disclosure" | "addendum" | "amendment" | "other"
  state: string
}) {
  if (!isValidUUID(params.documentId) || !isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid document or transaction ID" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  // THE DEAL DESK (wave 156, lane 156E — lib/transactions/role-guard.ts requireDealDesk): sharing the deal's tenant is not working
  // it. A vendor / contact / ISA seat of the tenant, or an agent off the deal, is refused HERE — before any deal record is read
  // and before the model is reached (AI is platform-covered: a call a seat may not make is a wrong invoice).
  const desk = await (await import("@/lib/transactions/role-guard")).requireDealDesk(params.transactionId)
  if (!desk.ok) return { success: false, error: desk.error }
  const brokerageId = ctx.brokerageId
  // NOT `?? ctx.userId` (m360) — contract_reviews.agent_id is agents-class.
  const agentId = ctx.agentId
  if (!agentId) return { success: false, error: "No agent profile for this user yet — finish account setup." }

  const supabase = createServiceClient()

  try {
    // Verify the transaction belongs to caller's brokerage before any AI burn
    const { data: txOwnership } = await supabase
      .from("transactions").select("brokerage_id").eq("id", params.transactionId).maybeSingle()
    if (!txOwnership || txOwnership.brokerage_id !== brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // Get document content — scoped to brokerage
    const { data: document } = await supabase
      .from("transaction_documents")
      .select("*, transactions(*)")
      .eq("id", params.documentId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (!document) {
      return { success: false, error: "Document not found" }
    }

    // Get transaction context — scoped to brokerage
    const { data: transaction } = await supabase
      .from("transactions")
      .select("*, listings(*), contacts:contact_id(*)")
      .eq("id", params.transactionId)
      .eq("brokerage_id", brokerageId)
      .single()

    // Get state-specific requirements
    const { data: stateRequirements } = await supabase
      .from("state_compliance_requirements")
      .select("*")
      .eq("state", params.state)
      .eq("document_type", params.documentType)

    // Perform AI contract review
    const { object: review } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: ContractReviewSchema,
      prompt: `You are an expert real estate contract reviewer with deep knowledge of ${params.state} real estate law and regulations.

DOCUMENT TYPE: ${params.documentType}
STATE: ${params.state}
TRANSACTION VALUE: $${transaction?.price?.toLocaleString() || "Unknown"}

DOCUMENT CONTENT/METADATA:
${(document.extracted_data?.text as string) || document.notes || "No text extracted - review based on metadata only"}

STATE REQUIREMENTS:
${stateRequirements?.map(r => `- ${r.requirement_name}: ${r.description}`).join("\n") || "Standard state requirements apply"}

TRANSACTION CONTEXT:
- Property: ${transaction?.listings?.address || "Unknown"}
- Buyer: ${transaction?.contacts?.first_name} ${transaction?.contacts?.last_name}
- Closing Date: ${transaction?.closing_date || "Not set"}
- Contingencies: ${transaction?.contingencies?.join(", ") || "None specified"}

Analyze the document for:
1. Compliance with ${params.state} real estate regulations
2. Missing required clauses or disclosures
3. Signature completeness
4. Key dates and deadlines
5. Potential risk factors
6. TRID/RESPA compliance if applicable
7. Fair Housing compliance
8. Any unusual or concerning terms

Be thorough but practical. Focus on actionable issues.`,
    })

    // Save review results
    const { data: savedReview, error: reviewSaveErr } = await supabase
      .from("contract_reviews")
      .insert({
        document_id: params.documentId,
        transaction_id: params.transactionId,
        brokerage_id: brokerageId,
        agent_id: agentId,
        review_type: "ai_automated",
        overall_score: review.overallScore,
        overall_assessment: review.overallAssessment,
        issues: review.issues,
        missing_items: review.missingItems,
        signature_status: review.signatureStatus,
        key_dates: review.keyDates,
        risk_factors: review.riskFactors,
        recommendations: review.recommendations,
        state: params.state,
        document_type: params.documentType,
        reviewed_at: new Date().toISOString(),
      })
      .select()
      .single()
    // The review is returned either way; a refused save means no record of it exists.
    if (reviewSaveErr) console.error(`[ai-contract-review] review for document ${params.documentId} NOT saved: ${reviewSaveErr.message}`)

    // Create tasks for critical issues. pass 14 (variable-insert sweep):
    // transaction_tasks has NO agent_id/source columns — assignment keys on
    // assigned_user_id (users class) with category carrying the origin.
    const criticalIssues = review.issues.filter(i => i.severity === "critical")
    if (criticalIssues.length > 0) {
      const { data: reviewerRow } = ctx.agentId
        ? await supabase.from("agents").select("user_id").eq("id", ctx.agentId).maybeSingle()
        : { data: null as { user_id: string } | null }
      const tasks = criticalIssues.map(issue => ({
        transaction_id: params.transactionId,
        brokerage_id: brokerageId,
        assigned_user_id: reviewerRow?.user_id ?? ctx.userId,
        title: `CRITICAL: ${issue.category}`,
        description: `${issue.description}\n\nRecommendation: ${issue.recommendation}`,
        priority: "urgent",
        status: "pending",
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
        category: "ai_contract_review",
        ai_generated: true,
      }))

      await sentinelWrite(supabase, supabase.from("transaction_tasks").insert(tasks), { table: "transaction_tasks", flow: "transaction_tasks_write", reason: "AI follow-up tasks from a review whose findings are returned to the caller" })
    }

    // Log compliance event if issues found. Canonical gate-event schema is
    // compliance_events (compliance_checks is a different table: check_type/status/findings).
    // actor_user_id FKs users.id — ctx.agentId is an agents.id, so resolve it.
    if (review.issues.length > 0) {
      const { data: agentRow } = ctx.agentId
        ? await supabase.from("agents").select("user_id").eq("id", ctx.agentId).maybeSingle()
        : { data: null }
      const { error: complianceLogError } = await supabase.from("compliance_events").insert({
        brokerage_id: brokerageId,
        actor_role: ctx.role,
        actor_user_id: agentRow?.user_id ?? ctx.userId,
        entity_type: "transaction",
        entity_id: params.transactionId,
        gate_name: "contract_review_issues",
        allowed: false,
        violations: review.issues,
        severity: criticalIssues.length > 0 ? "high" : "medium",
        details: {
          document_id: params.documentId,
          issue_count: review.issues.length,
          critical_count: criticalIssues.length,
        },
      })
      if (complianceLogError) {
        // The review itself is saved and returned; this is the ledger row a
        // broker would produce as evidence that the issues were flagged. It is
        // not allowed to disappear without a word.
        console.error(
          `[ai-contract-review] compliance_events insert REFUSED for transaction ${params.transactionId} — ${review.issues.length} contract issue(s) are UNRECORDED:`,
          complianceLogError.message,
        )
      }
    }

    revalidatePath(`/transactions/${params.transactionId}`)

    return {
      success: true,
      review: savedReview,
      summary: {
        score: review.overallScore,
        criticalIssues: criticalIssues.length,
        warnings: review.issues.filter(i => i.severity === "warning").length,
        missingItems: review.missingItems.filter(i => i.required).length,
        unsignedParties: review.signatureStatus.filter(s => s.required && !s.signed).length,
      },
    }
  } catch (error) {
    console.error("[AI Contract Review Error]:", error)
    return handleError(error, "reviewContract")
  }
}

// Check all documents for a transaction
export async function reviewTransactionDocuments(params: {
  transactionId: string
  agentId?: string  // ignored — derived from session
  state: string
}) {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  // THE DEAL DESK (wave 156, lane 156E) — the seat must WORK this deal before its documents are read or reviewed by a model.
  const desk = await (await import("@/lib/transactions/role-guard")).requireDealDesk(params.transactionId)
  if (!desk.ok) return { success: false, error: desk.error }

  const supabase = createServiceClient()

  try {
    // Verify the transaction belongs to caller's brokerage
    const { data: txOwnership } = await supabase
      .from("transactions").select("brokerage_id").eq("id", params.transactionId).maybeSingle()
    if (!txOwnership || txOwnership.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    const { data: documents } = await supabase
      .from("transaction_documents")
      .select("*")
      .eq("transaction_id", params.transactionId)
      .eq("brokerage_id", ctx.brokerageId)

    if (!documents || documents.length === 0) {
      return { success: true, reviews: [], message: "No documents to review" }
    }

    const reviews = []
    for (const doc of documents) {
      const docType = inferDocumentType(doc.doc_label || doc.doc_type)
      // reviewContract runs its own auth + brokerage gate — safe to call
      const result = await reviewContract({
        documentId: doc.id,
        transactionId: params.transactionId,
        documentType: docType,
        state: params.state,
      })
      if (result.success) {
        reviews.push(result)
      }
    }

    // Generate overall transaction compliance score
    const avgScore = reviews.reduce((sum, r) => sum + (r.summary?.score || 0), 0) / reviews.length
    const totalCritical = reviews.reduce((sum, r) => sum + (r.summary?.criticalIssues || 0), 0)

    return {
      success: true,
      reviews,
      transactionSummary: {
        documentsReviewed: reviews.length,
        averageScore: Math.round(avgScore),
        totalCriticalIssues: totalCritical,
        complianceStatus: totalCritical > 0 ? "needs_attention" : avgScore >= 80 ? "compliant" : "review_needed",
      },
    }
  } catch (error) {
    return handleError(error, "reviewTransactionDocuments")
  }
}

// Compare contract versions
export async function compareContractVersions(params: {
  documentId1: string
  documentId2: string
  agentId?: string  // ignored — derived from session
}) {
  if (!isValidUUID(params.documentId1) || !isValidUUID(params.documentId2)) {
    return { success: false, error: "Invalid document ID" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return await ledgerSessionAction({ brokerageId: ctx.brokerageId, action: "contract.versions.compare", actor: { type: "user", userId: ctx.userId, agentId: ctx.agentId ?? null }, subject: { type: "document", id: params.documentId1 }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { compared_with: params.documentId2 } }, async () => {

  const supabase = createServiceClient()

  try {
    // Scope both lookups by caller's brokerage so a hostile caller can't
    // diff their own document against another tenant's contract.
    const [{ data: doc1 }, { data: doc2 }] = await Promise.all([
      supabase.from("transaction_documents").select("*")
        .eq("id", params.documentId1).eq("brokerage_id", ctx.brokerageId).single(),
      supabase.from("transaction_documents").select("*")
        .eq("id", params.documentId2).eq("brokerage_id", ctx.brokerageId).single(),
    ])

    if (!doc1 || !doc2) {
      return { success: false, error: "One or both documents not found" }
    }

    const { text: comparison } = await generateText({
      brokerageId: ctx.brokerageId,
      userId: ctx.userId,
      agentId: ctx.agentId,
      model: resolveModel("openai/gpt-4o"),
      prompt: `Compare these two versions of a real estate document and identify all changes:

VERSION 1 (${doc1.doc_label}):
${(doc1.extracted_data?.text as string) || "No text available"}

VERSION 2 (${doc2.doc_label}):
${(doc2.extracted_data?.text as string) || "No text available"}

Provide:
1. Summary of all changes
2. Added clauses or terms
3. Removed clauses or terms
4. Modified terms (show before/after)
5. Impact assessment of changes
6. Any concerning modifications
7. Recommended action`,
    })

    return { success: true, comparison }
  } catch (error) {
    return handleError(error, "compareContractVersions")
  }
  })
}

// Generate missing document checklist
export async function generateDocumentChecklist(params: {
  transactionId: string
  transactionType: "purchase" | "sale" | "lease"
  state: string
  agentId?: string  // ignored — derived from session
}) {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  // THE DEAL DESK (wave 156, lane 156E) — the seat must WORK this deal before its documents are read or the model is reached.
  const desk = await (await import("@/lib/transactions/role-guard")).requireDealDesk(params.transactionId)
  if (!desk.ok) return { success: false, error: desk.error }

  const supabase = createServiceClient()

  try {
    // Verify the transaction belongs to caller's brokerage
    const { data: txOwnership } = await supabase
      .from("transactions").select("brokerage_id").eq("id", params.transactionId).maybeSingle()
    if (!txOwnership || txOwnership.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // Get existing documents — scoped by brokerage
    const { data: existingDocs } = await supabase
      .from("transaction_documents")
      .select("doc_type, doc_label")
      .eq("transaction_id", params.transactionId)
      .eq("brokerage_id", ctx.brokerageId)

    // Get state requirements
    const { data: stateReqs } = await supabase
      .from("state_compliance_requirements")
      .select("*")
      .eq("state", params.state)
      .eq("transaction_type", params.transactionType)

    const { object: checklist } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        requiredDocuments: z.array(z.object({
          name: z.string(),
          category: z.string(),
          required: z.boolean(),
          deadline: z.string().optional(),
          status: z.enum(["received", "pending", "missing", "expired"]),
          notes: z.string().optional(),
        })),
        optionalDocuments: z.array(z.object({
          name: z.string(),
          reason: z.string(),
        })),
        upcomingDeadlines: z.array(z.object({
          document: z.string(),
          deadline: z.string(),
          daysRemaining: z.number(),
        })),
      }),
      prompt: `Generate a comprehensive document checklist for a ${params.transactionType} transaction in ${params.state}.

EXISTING DOCUMENTS:
${existingDocs?.map(d => `- ${d.doc_label || d.doc_type}`).join("\n") || "None uploaded yet"}

STATE REQUIREMENTS:
${stateReqs?.map(r => `- ${r.requirement_name} (${r.required ? "Required" : "Optional"})`).join("\n") || "Standard requirements"}

Create a complete checklist of all required and recommended documents, marking which ones are already received vs missing.`,
    })

    return { success: true, checklist }
  } catch (error) {
    return handleError(error, "generateDocumentChecklist")
  }
}

// Extract key contract terms from raw contract text using AI
export async function extractContractTerms(params: {
  contractText: string
  transactionId: string
  agentId: string
}): Promise<{
  success: boolean
  extracted?: {
    purchasePrice: number | null
    earnestMoneyAmount: number | null
    inspectionDeadline: string | null
    appraisalDeadline: string | null
    financingDeadline: string | null
    closingDate: string | null
    buyerName: string | null
    sellerName: string | null
    propertyAddress: string | null
  }
  error?: string
}> {
  try {
    // Auth gate — burns paid GPT-4o inference per call.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    // A deal NAMED here must be one the session's seat WORKS (lib/transactions/role-guard.ts requireDealDesk, wave 156) — before
    // the model is reached. WAS: a tenant comparison that PASSED when the deal could not be found (`txOwnership && …`) and was
    // skipped for a malformed id, so a seat spent a model call "for" any deal id. No deal named: the extraction reads only the
    // text the caller pasted (no deal record is retrieved) and stays a tenant-member tool.
    if (params.transactionId) {
      const desk = await (await import("@/lib/transactions/role-guard")).requireDealDesk(params.transactionId)
      if (!desk.ok) return { success: false, error: desk.error }
    }

    const ContractTermsSchema = z.object({
      purchasePrice: z.number().nullable(),
      earnestMoneyAmount: z.number().nullable(),
      inspectionDeadline: z.string().nullable(),
      appraisalDeadline: z.string().nullable(),
      financingDeadline: z.string().nullable(),
      closingDate: z.string().nullable(),
      buyerName: z.string().nullable(),
      sellerName: z.string().nullable(),
      propertyAddress: z.string().nullable(),
    })

    const { object: extracted } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: ContractTermsSchema,
      prompt: `Extract key fields from this real estate purchase contract. Return all monetary values as numbers (no currency symbols), all dates as ISO 8601 strings (YYYY-MM-DD), and return null for any field not found in the contract.

CONTRACT TEXT:
${params.contractText}`,
    })

    return { success: true, extracted }
  } catch (error) {
    console.error("[extractContractTerms Error]:", error)
    return { success: false, error: error instanceof Error ? error.message : "Failed to extract contract terms" }
  }
}

// PROPOSE the extracted governing terms of ONE deal — never write them (wave 156, lane 156E).
//
// TOMBSTONE (wave 156, lane 156E — CLAUDE.md §1 case 2): this export used to WRITE the extracted terms onto the deal — purchase
// price, close date and address on public.transactions, and four deadline milestones — straight from a model's reading of a
// document (app/actions/documents.ts runs it on every classified purchase agreement, a client's portal upload included). A model
// may not rewrite governing terms without deterministic authority and human review (directive, "Prohibited shortcuts"). The
// write MOVED to the confirm door: SURVIVOR app/actions/governing-terms.ts confirmGoverningTermsAction (desk first, per-field
// accept, idempotent, counted, receipted), over lib/documents/governing-terms-proposal.ts applyGoverningTermsDecisions. This
// export now only records a PROPOSAL (lib/documents/governing-terms-proposal.ts recordGoverningTermsProposal) and the deal is
// unchanged.
//
// WHO MAY PROPOSE: a seat on the deal desk for this deal (lib/transactions/role-guard.ts requireDealDesk) — or, for an UPLOADED
// document, the person who uploaded it (client_documents.uploaded_by = the session user): a client's or a vendor's own upload
// can therefore only ever create a proposal, which only a desk seat can accept. A pasted contract (no document) needs the desk.
// The document must be on this deal (its transaction_id, or its contact a client on the deal) and in the deal's tenant; a
// session that carries a tenant must carry THAT tenant. Tenant and deal come from the desk / the deal row, never the body.
export async function applyContractExtraction(params: {
  transactionId: string
  agentId?: string  // ignored — derived from session
  /** The uploaded document (client_documents.id) the terms were read from. */
  documentId?: string
  /** A contract pasted on the contract-review screen (no document row) — its hash and an excerpt are kept as the source. */
  sourceText?: string
  extracted: {
    purchasePrice: number | null
    earnestMoneyAmount: number | null
    inspectionDeadline: string | null
    appraisalDeadline: string | null
    financingDeadline: string | null
    closingDate: string | null
    buyerName: string | null
    sellerName: string | null
    propertyAddress: string | null
  }
}): Promise<{ success: boolean; error?: string; proposalId?: string | null; proposedFields?: string[] }> {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }
  if (params.documentId && !isValidUUID(params.documentId)) return { success: false, error: "Invalid document ID" }
  if (!params.documentId && !(typeof params.sourceText === "string" && params.sourceText.trim())) {
    return { success: false, error: "Proposed terms need their source: the uploaded document or the pasted contract text" }
  }
  const sessionCtx = await getAgentContext()
  if (!sessionCtx.isAuthenticated || !sessionCtx.userId) return { success: false, error: "Unauthorized" }

  const { requireDealDesk } = await import("@/lib/transactions/role-guard")
  const desk = await requireDealDesk(params.transactionId)
  const svc = createServiceClient()
  // The deal's tenant: the desk's (it read the deal in the session's tenant) — or, for an uploader, the deal row's own,
  // which the uploaded document must share (and a tenanted session must equal).
  let brokerageId: string | null = desk.ok ? desk.brokerageId : null
  let source: import("@/lib/documents/governing-terms-proposal").ProposalSource
  if (params.documentId) {
    const { data: doc, error: docErr } = await svc.from("client_documents")
      .select("id, brokerage_id, transaction_id, contact_id, uploaded_by, document_name").eq("id", params.documentId).maybeSingle()
    if (docErr) return { success: false, error: `Could not read the source document: ${docErr.message}` }
    const d = doc as { id: string; brokerage_id: string | null; transaction_id: string | null; contact_id: string | null; uploaded_by: string | null; document_name: string | null } | null
    if (!d) return { success: false, error: "Source document not found" }
    const { data: deal, error: dealErr } = await svc.from("transactions")
      .select("id, brokerage_id, contact_id, buyer_contact_id, seller_contact_id").eq("id", params.transactionId).maybeSingle()
    if (dealErr) return { success: false, error: `Could not read the deal: ${dealErr.message}` }
    const t = deal as { id: string; brokerage_id: string | null; contact_id: string | null; buyer_contact_id: string | null; seller_contact_id: string | null } | null
    if (!t || !t.brokerage_id) return { success: false, error: "Transaction not found" }
    const onDeal = d.transaction_id === t.id || (!!d.contact_id && [t.contact_id, t.buyer_contact_id, t.seller_contact_id].includes(d.contact_id))
    if (d.brokerage_id !== t.brokerage_id || !onDeal) return { success: false, error: "That document is not on this deal" }
    const isUploader = !!d.uploaded_by && d.uploaded_by === sessionCtx.userId
    if (!desk.ok && !isUploader) return { success: false, error: desk.error }
    if (sessionCtx.brokerageId && sessionCtx.brokerageId !== t.brokerage_id) return { success: false, error: "Transaction not found in your brokerage" }
    brokerageId = t.brokerage_id
    source = { kind: "client_document", document_id: d.id, document_name: d.document_name }
  } else {
    if (!desk.ok) return { success: false, error: desk.error }
    const text = String(params.sourceText).trim()
    const { createHash } = await import("node:crypto")
    source = { kind: "pasted_contract_text", sha256: createHash("sha256").update(text).digest("hex"), excerpt: text.slice(0, 280) }
  }
  if (!brokerageId) return { success: false, error: "Unauthorized" }
  const tenant = brokerageId
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const { recordGoverningTermsProposal } = await import("@/lib/documents/governing-terms-proposal")
  return await ledgerSessionAction({ brokerageId: tenant, action: "contract.extraction.propose", actor: { type: "user", userId: sessionCtx.userId, agentId: sessionCtx.agentId ?? null }, subject: { type: "transaction", id: params.transactionId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { source: source.kind, document_id: source.kind === "client_document" ? source.document_id : null } }, async () => {
    const r = await recordGoverningTermsProposal(svc, { transactionId: params.transactionId, brokerageId: tenant, proposedBy: sessionCtx.userId, source, extracted: params.extracted as unknown as Record<string, unknown> })
    if (!r.ok) return { success: false, error: r.error }
    revalidatePath(`/transactions/${params.transactionId}`)
    return { success: true, proposalId: r.proposalId, proposedFields: r.fields }
  })
}

// Helper to infer document type from name
function inferDocumentType(name: string): "purchase_agreement" | "listing_agreement" | "disclosure" | "addendum" | "amendment" | "other" {
  const lower = name.toLowerCase()
  if (lower.includes("purchase") || lower.includes("contract") || lower.includes("offer")) return "purchase_agreement"
  if (lower.includes("listing") || lower.includes("exclusive")) return "listing_agreement"
  if (lower.includes("disclosure") || lower.includes("seller")) return "disclosure"
  if (lower.includes("addendum") || lower.includes("add")) return "addendum"
  if (lower.includes("amendment") || lower.includes("change")) return "amendment"
  return "other"
}
