"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"

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
  const brokerageId = ctx.brokerageId
  const agentId = ctx.agentId ?? ctx.userId

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
${document.extracted_text || document.description || "No text extracted - review based on metadata only"}

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
    const { data: savedReview } = await supabase
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

    // Create tasks for critical issues
    const criticalIssues = review.issues.filter(i => i.severity === "critical")
    if (criticalIssues.length > 0) {
      const tasks = criticalIssues.map(issue => ({
        transaction_id: params.transactionId,
        brokerage_id: brokerageId,
        agent_id: agentId,
        title: `CRITICAL: ${issue.category}`,
        description: `${issue.description}\n\nRecommendation: ${issue.recommendation}`,
        priority: "urgent",
        status: "pending",
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
        source: "ai_contract_review",
      }))

      await supabase.from("transaction_tasks").insert(tasks)
    }

    // Log compliance event if issues found
    if (review.issues.length > 0) {
      await supabase.from("compliance_checks").insert({
        transaction_id: params.transactionId,
        brokerage_id: brokerageId,
        agent_id: agentId,
        event_type: "contract_review_issues",
        severity: criticalIssues.length > 0 ? "high" : "medium",
        details: {
          document_id: params.documentId,
          issue_count: review.issues.length,
          critical_count: criticalIssues.length,
        },
      })
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
      const docType = inferDocumentType(doc.name || doc.document_type)
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
      model: resolveModel("openai/gpt-4o"),
      prompt: `Compare these two versions of a real estate document and identify all changes:

VERSION 1 (${doc1.name}):
${doc1.extracted_text || "No text available"}

VERSION 2 (${doc2.name}):
${doc2.extracted_text || "No text available"}

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
      .select("document_type, name")
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
${existingDocs?.map(d => `- ${d.name || d.document_type}`).join("\n") || "None uploaded yet"}

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
    // If transactionId is provided, verify ownership before AI burn
    if (params.transactionId && isValidUUID(params.transactionId)) {
      const svc = createServiceClient()
      const { data: txOwnership } = await svc
        .from("transactions").select("brokerage_id").eq("id", params.transactionId).maybeSingle()
      if (txOwnership && txOwnership.brokerage_id !== ctx.brokerageId) {
        return { success: false, error: "Forbidden" }
      }
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

// Apply extracted contract terms to the transaction and create milestone rows
export async function applyContractExtraction(params: {
  transactionId: string
  agentId?: string  // ignored — derived from session
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
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  // CRITICAL auth gate — was previously open. Any caller could update
  // any transaction's purchase_price, close_date, property_address, and
  // create milestone rows on it.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = createServiceClient()

  try {
    // Verify the transaction belongs to caller's brokerage
    const { data: txOwnership } = await supabase
      .from("transactions").select("brokerage_id").eq("id", params.transactionId).maybeSingle()
    if (!txOwnership || txOwnership.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // Build transaction updates from non-null extracted values
    const transactionUpdates: Record<string, unknown> = {}

    if (params.extracted.purchasePrice !== null) {
      // Schema: transactions.purchase_price (NOT contract_price — that column
      // doesn't exist on transactions; previous code silently failed the
      // entire update).
      transactionUpdates.purchase_price = params.extracted.purchasePrice
    }
    // earnest_money_amount lives on offers (extracted at offer time) and on
    // transaction_title_escrow (deposit-tracking). It is NOT a column on
    // transactions, so we don't try to write it here. Earnest money was
    // captured when the offer was created.
    if (params.extracted.closingDate !== null) {
      transactionUpdates.close_date = params.extracted.closingDate
    }
    if (params.extracted.propertyAddress !== null) {
      transactionUpdates.property_address = params.extracted.propertyAddress
    }

    // Update the transactions row if there is anything to update — scoped
    // by brokerage as a belt-and-suspenders check
    if (Object.keys(transactionUpdates).length > 0) {
      const { error: txError } = await supabase
        .from("transactions")
        .update(transactionUpdates)
        .eq("id", params.transactionId)
        .eq("brokerage_id", ctx.brokerageId)

      if (txError) {
        return { success: false, error: txError.message }
      }
    }

    // Upsert milestone rows for each deadline
    const milestoneEntries: Array<{
      transaction_id: string
      brokerage_id: string
      milestone_name: string
      status: string
      due_date: string
    }> = []

    if (params.extracted.inspectionDeadline !== null) {
      milestoneEntries.push({
        transaction_id: params.transactionId,
        brokerage_id: ctx.brokerageId,
        milestone_name: "inspection_deadline",
        status: "pending",
        due_date: params.extracted.inspectionDeadline,
      })
    }
    if (params.extracted.appraisalDeadline !== null) {
      milestoneEntries.push({
        transaction_id: params.transactionId,
        brokerage_id: ctx.brokerageId,
        milestone_name: "appraisal_deadline",
        status: "pending",
        due_date: params.extracted.appraisalDeadline,
      })
    }
    if (params.extracted.financingDeadline !== null) {
      milestoneEntries.push({
        transaction_id: params.transactionId,
        brokerage_id: ctx.brokerageId,
        milestone_name: "financing_deadline",
        status: "pending",
        due_date: params.extracted.financingDeadline,
      })
    }
    if (params.extracted.closingDate !== null) {
      milestoneEntries.push({
        transaction_id: params.transactionId,
        brokerage_id: ctx.brokerageId,
        milestone_name: "closing_day",
        status: "pending",
        due_date: params.extracted.closingDate,
      })
    }

    for (const milestone of milestoneEntries) {
      const { error: msError } = await supabase
        .from("transaction_milestones")
        .upsert(milestone, { onConflict: "transaction_id,milestone_name" })

      if (msError) {
        return { success: false, error: msError.message }
      }
    }

    revalidatePath(`/transactions/${params.transactionId}`)

    return { success: true }
  } catch (error) {
    console.error("[applyContractExtraction Error]:", error)
    return { success: false, error: error instanceof Error ? error.message : "Failed to apply contract extraction" }
  }
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
