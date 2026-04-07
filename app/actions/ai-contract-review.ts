"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"

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
  agentId: string
  documentType: "purchase_agreement" | "listing_agreement" | "disclosure" | "addendum" | "amendment" | "other"
  state: string
}) {
  if (!isValidUUID(params.documentId) || !isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid document or transaction ID" }
  }

  const supabase = await createClient()

  try {
    // Get document content
    const { data: document } = await supabase
      .from("transaction_documents")
      .select("*, transactions(*)")
      .eq("id", params.documentId)
      .single()

    if (!document) {
      return { success: false, error: "Document not found" }
    }

    // Get transaction context
    const { data: transaction } = await supabase
      .from("transactions")
      .select("*, listings(*), contacts:contact_id(*)")
      .eq("id", params.transactionId)
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
        agent_id: params.agentId,
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
        agent_id: params.agentId,
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
      await supabase.from("compliance_events").insert({
        transaction_id: params.transactionId,
        agent_id: params.agentId,
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
  agentId: string
  state: string
}) {
  const supabase = await createClient()

  try {
    const { data: documents } = await supabase
      .from("transaction_documents")
      .select("*")
      .eq("transaction_id", params.transactionId)

    if (!documents || documents.length === 0) {
      return { success: true, reviews: [], message: "No documents to review" }
    }

    const reviews = []
    for (const doc of documents) {
      const docType = inferDocumentType(doc.name || doc.document_type)
      const result = await reviewContract({
        documentId: doc.id,
        transactionId: params.transactionId,
        agentId: params.agentId,
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
  agentId: string
}) {
  const supabase = await createClient()

  try {
    const [{ data: doc1 }, { data: doc2 }] = await Promise.all([
      supabase.from("transaction_documents").select("*").eq("id", params.documentId1).single(),
      supabase.from("transaction_documents").select("*").eq("id", params.documentId2).single(),
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
  agentId: string
}) {
  const supabase = await createClient()

  try {
    // Get existing documents
    const { data: existingDocs } = await supabase
      .from("transaction_documents")
      .select("document_type, name")
      .eq("transaction_id", params.transactionId)

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
