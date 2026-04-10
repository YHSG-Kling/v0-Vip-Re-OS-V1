"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"

// ============================================
// AI DOCUMENT INTELLIGENCE SYSTEM
// Smart document processing, analysis, and compliance checking
// ============================================

/**
 * AI-powered document classification and extraction
 * Automatically categorizes documents and extracts key data
 */
export async function aiClassifyDocument(params: {
  documentId: string
  agentId: string
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
  if (!isValidUUID(params.documentId)) {
    return { success: false, error: "Invalid document ID" }
  }

  const supabase = await createClient()

  try {
    // Get document details
    const { data: document } = await supabase
      .from("client_documents")
      .select("*")
      .eq("id", params.documentId)
      .single()

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
File Type: ${document.file_type}
Document Content/Text: ${textToAnalyze}

Classify the document type, extract key data points (dates, amounts, parties, addresses, terms), identify any compliance issues, and note any missing required fields.`,
    })

    // Update document with classification
    await supabase
      .from("client_documents")
      .update({
        document_category: object.category,
        ai_classification: object,
        processing_status: "processed",
      })
      .eq("id", params.documentId)

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

    // Store analysis
    await supabase
      .from("client_documents")
      .update({
        ai_analysis: object,
        processing_status: "analyzed",
      })
      .eq("id", params.documentId)

    return { success: true, analysis: object }
  } catch (error) {
    return handleError(error, "aiAnalyzeContract")
  }
}

/**
 * AI-powered disclosure checker
 * Ensures all required disclosures are present and complete
 */
export async function aiCheckDisclosures(params: {
  transactionId: string
  agentId: string
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

  const supabase = await createClient()

  try {
    // Get existing documents for transaction
    const { data: documents } = await supabase
      .from("client_documents")
      .select("*")
      .eq("transaction_id", params.transactionId)

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

    // Store compliance check
    await supabase.from("compliance_checklists").upsert({
      transaction_id: params.transactionId,
      checklist_type: "disclosures",
      items: object.requiredDisclosures,
      compliance_score: object.complianceScore,
      ai_recommendations: object.recommendations,
      updated_at: new Date().toISOString(),
    })

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
  transactionId: string
  agentId: string
}): Promise<{
  success: boolean
  verification?: {
    allSignaturesPresent: boolean
    requiredSignatures: Array<{ party: string; required: boolean; signed: boolean; signedDate?: string }>
    missingSignatures: string[]
    recommendations: string[]
  }
  error?: string
}> {
  if (!isValidUUID(params.documentId)) {
    return { success: false, error: "Invalid document ID" }
  }

  const supabase = await createClient()

  try {
    const { data: document } = await supabase
      .from("client_documents")
      .select("*")
      .eq("id", params.documentId)
      .single()

    if (!document) {
      return { success: false, error: "Document not found" }
    }

    // Check Dotloop for signature status if integrated
    const { data: dotloopDoc } = await supabase
      .from("dotloop_documents")
      .select("*")
      .eq("document_id", params.documentId)
      .maybeSingle()

    const { text } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `Analyze signature requirements for this document:
      
Document: ${document.document_name}
Category: ${document.document_category || "unknown"}
Dotloop Status: ${dotloopDoc?.signature_status || "not in Dotloop"}

Determine what signatures are required and their current status. Return as JSON:
{
  "allSignaturesPresent": boolean,
  "requiredSignatures": [{"party": string, "required": boolean, "signed": boolean, "signedDate": string or null}],
  "missingSignatures": [string],
  "recommendations": [string]
}`,
    })

    const verification = JSON.parse(text)

    // Update document status
    await supabase
      .from("client_documents")
      .update({
        signature_status: verification.allSignaturesPresent ? "complete" : "pending",
        ai_signature_check: verification,
      })
      .eq("id", params.documentId)

    return { success: true, verification }
  } catch (error) {
    return handleError(error, "aiVerifySignatures")
  }
}

/**
 * AI-powered document generation
 * Generates draft documents based on transaction data
 */
export async function aiGenerateDocument(params: {
  agentId: string
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
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get agent profile for personalization
    const { data: agent } = await supabase
      .from("users")
      .select("first_name, last_name, email, phone")
      .eq("id", params.agentId)
      .single()

    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", params.agentId)
      .maybeSingle()

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
  agentId: string
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
  if (!isValidUUID(params.documentId1) || !isValidUUID(params.documentId2)) {
    return { success: false, error: "Invalid document IDs" }
  }

  const supabase = await createClient()

  try {
    const [{ data: doc1 }, { data: doc2 }] = await Promise.all([
      supabase.from("client_documents").select("*").eq("id", params.documentId1).single(),
      supabase.from("client_documents").select("*").eq("id", params.documentId2).single(),
    ])

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
Content: ${doc1.ai_analysis?.content || "Content not available"}

Document 2 (Modified): ${doc2.document_name}  
Content: ${doc2.ai_analysis?.content || "Content not available"}

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
  agentId: string
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

  const supabase = await createClient()

  try {
    // Get transaction and document deadlines
    const { data: transaction } = await supabase
      .from("transactions")
      .select("*, client_documents(*)")
      .eq("id", params.transactionId)
      .single()

    if (!transaction) {
      return { success: false, error: "Transaction not found" }
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

    const reminders = JSON.parse(text)

    return { success: true, reminders }
  } catch (error) {
    return handleError(error, "aiGenerateDocumentReminders")
  }
}
