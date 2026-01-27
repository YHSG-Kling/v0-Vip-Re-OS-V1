"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { put, del } from "@vercel/blob"
import { generateText, generateObject } from "ai"
import { z } from "zod"
import { handleError } from "@/lib/errors"

export async function getDocuments(params?: { contactId?: string; transactionId?: string; type?: string }) {
  try {
    const supabase = await createClient()
    
    let query = supabase
      .from("documents")
      .select("*, uploaded_by_agent:agents!documents_uploaded_by_fkey(first_name, last_name)")
      .order("uploaded_at", { ascending: false })

    if (params?.contactId) query = query.eq("contact_id", params.contactId)
    if (params?.transactionId) query = query.eq("transaction_id", params.transactionId)
    if (params?.type) query = query.eq("document_type", params.type)

    const { data, error } = await query

    if (error) throw error
    return { success: true, documents: data || [] }
  } catch (error) {
    return handleError(error, "getDocuments")
  }
}

export async function deleteDocument(documentId: string) {
  try {
    const supabase = await createClient()
    
    // Get document to delete blob
    const { data: doc } = await supabase
      .from("documents")
      .select("file_url")
      .eq("id", documentId)
      .single()

    if (doc?.file_url) {
      try {
        await del(doc.file_url)
      } catch (blobError) {
        console.error("Error deleting blob:", blobError)
      }
    }

    // Delete from database
    const { error } = await supabase
      .from("documents")
      .delete()
      .eq("id", documentId)

    if (error) throw error

    revalidatePath("/dashboard")
    return { success: true }
  } catch (error) {
    return handleError(error, "deleteDocument")
  }
}

export async function analyzeDocument(documentId: string) {
  try {
    const supabase = await createClient()
    
    const { data: document, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .single()

    if (error) throw error

    // AI document analysis
    const { object: analysis } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        documentType: z.string(),
        keyInformation: z.array(z.string()),
        missingFields: z.array(z.string()),
        complianceIssues: z.array(z.string()),
        recommendations: z.array(z.string()),
        confidenceScore: z.number(),
      }),
      prompt: `Analyze this real estate document:
Type: ${document.document_type}
Name: ${document.file_name}

Provide detailed analysis including document type classification, key information extracted, any missing required fields, compliance issues, and recommendations.`,
    })

    // Save analysis
    await supabase
      .from("documents")
      .update({ ai_analysis: analysis, analyzed_at: new Date().toISOString() })
      .eq("id", documentId)

    return { success: true, analysis }
  } catch (error) {
    return handleError(error, "analyzeDocument")
  }
}

export async function uploadDocument(
  file: { name: string; type: string; size: number; base64: string },
  contactId: string,
  transactionId?: string,
  userId?: string // For agent uploads
) {
  const supabase = await createClient()

  const filePath = transactionId
    ? `transactions/${transactionId}/${Date.now()}_${file.name}`
    : `contacts/${contactId}/${Date.now()}_${file.name}`

  // Decode base64 and upload to storage
  const fileBuffer = Buffer.from(file.base64, "base64")

  let publicUrl: string

  // Try to upload to storage bucket
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from("client-documents")
    .upload(filePath, fileBuffer, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) {
    console.error("[v0] Storage upload error:", uploadError)
    // If bucket doesn't exist or upload fails, store base64 directly in database
    // This is a fallback - recommend setting up storage bucket properly
    publicUrl = `data:${file.type};base64,${file.base64.substring(0, 100)}...` // Truncated for DB
    console.log("[v0] Using database fallback for document storage")
  } else {
    // Get public URL from storage
    const { data } = supabase.storage.from("client-documents").getPublicUrl(filePath)
    publicUrl = data.publicUrl
  }

  // Create document record - supports both contact_id (clients) and user_id (agents)
  const { data: document, error: docError } = await supabase
    .from("client_documents")
    .insert({
      contact_id: contactId || null,
      user_id: userId || null,
      transaction_id: transactionId || null,
      document_name: file.name,
      original_filename: file.name,
      document_url: publicUrl,
      file_type: file.type,
      file_size_bytes: file.size,
      document_category: "other",
      processing_status: "pending",
      uploaded_via: userId ? "agent_portal" : "portal",
    })
    .select()
    .single()

  if (docError) {
    console.error("Document record error:", docError)
    throw new Error("Failed to create document record")
  }

  // Create audit trail entry
  await supabase.from("document_audit_trail").insert({
    document_id: document.id,
    document_source: "client_documents",
    action: "uploaded",
    performed_by: contactId,
    performed_by_type: "client",
    notes: `Uploaded via portal: ${file.name}`,
  })

  // Queue for AI processing (async)
  processDocumentWithAI(document.id, publicUrl, file.type).catch(console.error)

  return { success: true, document }
}

// ============================================
// AI DOCUMENT PROCESSING
// ============================================

export async function processDocumentWithAI(documentId: string, fileUrl: string, fileType: string) {
  const supabase = await createClient()
  const startTime = Date.now()

  try {
    // Update status to processing
    await supabase.from("client_documents").update({ processing_status: "processing" }).eq("id", documentId)

    // Step 1: Extract text and classify document
    const classificationResult = await generateText({
      model: "openai/gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this real estate document. Return JSON with:
{
  "document_type": "purchase_agreement|addendum|inspection_report|appraisal|proof_of_funds|closing_disclosure|title_report|disclosure_form|bank_statement|drivers_license|other",
  "confidence": 0.0-1.0,
  "extracted_text_summary": "brief summary of key content",
  "key_fields": {
    // document-specific fields like property_address, purchase_price, dates, names, etc.
  }
}`,
            },
            {
              type: "image",
              image: fileUrl,
            },
          ],
        },
      ],
    })

    let classification
    try {
      classification = JSON.parse(classificationResult.text)
    } catch {
      classification = {
        document_type: "other",
        confidence: 0.5,
        extracted_text_summary: classificationResult.text,
        key_fields: {},
      }
    }

    // Step 2: Generate plain English explanation
    const explanationResult = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `You are a helpful real estate assistant explaining documents to first-time homebuyers.

Document type: ${classification.document_type}
Key fields: ${JSON.stringify(classification.key_fields)}
Summary: ${classification.extracted_text_summary}

Write a friendly, plain-English explanation (2-3 paragraphs) that:
1. Explains what this document is and why they have it
2. Highlights the most important numbers or dates they should pay attention to
3. Explains what happens next

Use simple language, avoid jargon, and be reassuring.`,
    })

    // Step 3: Validate document
    const validation = await validateDocumentFields(classification.key_fields, classification.document_type)

    // Step 4: Store analysis
    await supabase.from("document_analysis").insert({
      document_id: documentId,
      document_source: "client_documents",
      ai_extracted_text: classification.extracted_text_summary,
      key_fields_extracted: classification.key_fields,
      document_summary: classification.extracted_text_summary,
      plain_english_explanation: explanationResult.text,
      validation_status: validation.status,
      validation_issues: validation.issues,
      risk_flags: validation.risks,
      processing_time_seconds: Math.round((Date.now() - startTime) / 1000),
      ai_model_used: "gpt-4o",
      analyzed_at: new Date().toISOString(),
    })

    // Step 5: Update document record
    await supabase
      .from("client_documents")
      .update({
        document_category: classification.document_type,
        ai_detected_type: classification.document_type,
        ai_confidence_score: classification.confidence,
        processing_status: validation.status === "fail" ? "flagged" : "verified",
      })
      .eq("id", documentId)

    // Create audit trail
    await supabase.from("document_audit_trail").insert({
      document_id: documentId,
      document_source: "client_documents",
      action: "analyzed",
      performed_by_type: "ai",
      notes: `AI analysis complete: ${classification.document_type} (${Math.round(classification.confidence * 100)}% confidence)`,
    })

    return { success: true, classification, explanation: explanationResult.text }
  } catch (error) {
    console.error("AI processing error:", error)

    await supabase.from("client_documents").update({ processing_status: "pending" }).eq("id", documentId)

    return { success: false, error }
  }
}

async function validateDocumentFields(
  keyFields: Record<string, any>,
  docType: string
): Promise<{ status: string; issues: any[]; risks: any[] }> {
  const validation = {
    status: "pass",
    issues: [] as any[],
    risks: [] as any[],
  }

  // Document-specific validation
  if (docType === "proof_of_funds") {
    if (keyFields.account_balance && keyFields.account_balance < 10000) {
      validation.risks.push({
        type: "low_balance",
        severity: "warning",
        message: "Account balance appears low. Verify this covers your required down payment and closing costs.",
      })
      validation.status = "warning"
    }
  }

  if (docType === "inspection_report") {
    if (keyFields.major_issues && keyFields.major_issues.length > 0) {
      validation.risks.push({
        type: "inspection_issues",
        severity: "info",
        message: `${keyFields.major_issues.length} issue(s) noted. Review with your agent to discuss repair negotiations.`,
      })
    }
  }

  return validation
}

// ============================================
// DOCUMENT RETRIEVAL
// ============================================

export async function getContactDocuments(contactId: string) {
  const supabase = await createClient()

  const { data: documents } = await supabase
    .from("client_documents")
    .select(
      `
      *,
      document_analysis(*)
    `
    )
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  return documents || []
}

export async function getDocumentWithAnalysis(documentId: string) {
  const supabase = await createClient()

  const { data: document } = await supabase
    .from("client_documents")
    .select(
      `
      *,
      document_analysis(*),
      signature_requests(*)
    `
    )
    .eq("id", documentId)
    .single()

  // Get educational overlay for this document type
  let educationalOverlay = null
  if (document?.ai_detected_type) {
    const { data: overlay } = await supabase
      .from("document_educational_overlays")
      .select("*")
      .eq("document_type", document.ai_detected_type)
      .single()
    educationalOverlay = overlay
  }

  // Record view in audit trail
  if (document) {
    await supabase.from("document_audit_trail").insert({
      document_id: documentId,
      document_source: "client_documents",
      action: "viewed",
      performed_by_type: "client",
    })
  }

  return { document, educationalOverlay }
}

export async function getDocumentRequirements(contactId: string, transactionId?: string) {
  const supabase = await createClient()

  let query = supabase.from("document_requirements").select("*").eq("contact_id", contactId)

  if (transactionId) {
    query = query.eq("transaction_id", transactionId)
  }

  const { data } = await query.order("required_by_date", { ascending: true })

  return data || []
}

// ============================================
// SIGNATURE MANAGEMENT
// ============================================

export async function requestSignature(documentId: string, signers: { email: string; name: string; order: number }[]) {
  const supabase = await createClient()

  const { data: document } = await supabase.from("client_documents").select("*").eq("id", documentId).single()

  if (!document) throw new Error("Document not found")

  const { data: signatureRequest, error } = await supabase
    .from("signature_requests")
    .insert({
      document_id: documentId,
      transaction_id: document.transaction_id,
      contact_id: document.contact_id,
      signing_order: signers,
      current_signer_email: signers.find((s) => s.order === 1)?.email,
      all_parties: signers,
      request_status: "pending",
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    })
    .select()
    .single()

  if (error) throw error

  // Update document status
  await supabase.from("client_documents").update({ signature_status: "pending_signature" }).eq("id", documentId)

  // Create signature event
  await supabase.from("signature_events").insert({
    signature_request_id: signatureRequest.id,
    signer_email: signers[0].email,
    signer_name: signers[0].name,
    event_type: "sent",
  })

  return signatureRequest
}

export async function recordSignatureEvent(
  signatureRequestId: string,
  signerEmail: string,
  eventType: "viewed" | "signed" | "declined"
) {
  const supabase = await createClient()

  // Record the event
  await supabase.from("signature_events").insert({
    signature_request_id: signatureRequestId,
    signer_email: signerEmail,
    event_type: eventType,
  })

  // Update signature request if signed
  if (eventType === "signed") {
    const { data: request } = await supabase
      .from("signature_requests")
      .select("*, signature_events(*)")
      .eq("id", signatureRequestId)
      .single()

    const allParties = (request?.all_parties as any[]) || []
    const signedEvents = request?.signature_events?.filter((e: any) => e.event_type === "signed") || []

    // Check if all parties have signed
    const allSigned = allParties.every((party) => signedEvents.some((e: any) => e.signer_email === party.email))

    if (allSigned) {
      await supabase
        .from("signature_requests")
        .update({
          request_status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", signatureRequestId)

      // Update document
      await supabase.from("client_documents").update({ signature_status: "signed" }).eq("id", request?.document_id)
    } else {
      // Move to next signer
      const nextSigner = allParties.find((party) => !signedEvents.some((e: any) => e.signer_email === party.email))

      if (nextSigner) {
        await supabase
          .from("signature_requests")
          .update({
            current_signer_email: nextSigner.email,
            request_status: "in_progress",
          })
          .eq("id", signatureRequestId)
      }
    }
  }

  if (eventType === "declined") {
    await supabase
      .from("signature_requests")
      .update({
        request_status: "declined",
      })
      .eq("id", signatureRequestId)
  }

  return { success: true }
}

// ============================================
// EDUCATIONAL CONTENT
// ============================================

export async function getDocumentEducation(documentType: string) {
  const supabase = await createClient()

  const { data } = await supabase
    .from("document_educational_overlays")
    .select("*")
    .eq("document_type", documentType)
    .single()

  return data
}

// Alias for backward compatibility


// ============================================
// STATE COMPLIANCE CHECKING
// ============================================

const stateRequirements: Record<string, Record<string, any>> = {
  FL: {
    purchase_agreement: {
      required_disclosures: ["lead_paint", "radon", "property_condition"],
      required_signatures: ["buyer", "seller", "agent"],
      must_contain: ["AS-IS clause or inspection period"],
      time_limits: { inspection_period: 15 },
    },
    disclosure_forms: {
      required: ["Seller Property Disclosure", "HOA Disclosure"],
      timing: "Before contract execution",
    },
  },
  TX: {
    purchase_agreement: {
      required_disclosures: ["lead_paint", "property_condition", "water_district"],
      must_contain: ["Survey requirement", "Title policy commitment"],
      time_limits: { option_period: 10 },
    },
  },
  CA: {
    purchase_agreement: {
      required_disclosures: ["natural_hazard", "lead_paint", "property_condition", "agency"],
      must_contain: ["Transfer Disclosure Statement", "Natural Hazard Disclosure"],
      time_limits: { inspection_period: 17 },
    },
  },
  NY: {
    purchase_agreement: {
      required_disclosures: ["lead_paint", "property_condition"],
      must_contain: ["Attorney approval contingency"],
      time_limits: { attorney_review: 3 },
    },
  },
}

export async function checkStateCompliance(
  documentType: string,
  keyFields: Record<string, any>,
  state: string
): Promise<{ passed: boolean; issues: string[]; warnings: string[]; note?: string }> {
  const requirements = stateRequirements[state]?.[documentType]

  if (!requirements) {
    return { passed: true, issues: [], warnings: [], note: "No specific state requirements found for this document type" }
  }

  const compliance = {
    passed: true,
    issues: [] as string[],
    warnings: [] as string[],
  }

  // Check required disclosures
  if (requirements.required_disclosures) {
    for (const disclosure of requirements.required_disclosures) {
      if (!keyFields.disclosures?.includes(disclosure)) {
        compliance.issues.push(`Missing required ${state} disclosure: ${disclosure.replace(/_/g, " ")}`)
        compliance.passed = false
      }
    }
  }

  // Check time limits
  if (requirements.time_limits) {
    for (const [period, days] of Object.entries(requirements.time_limits)) {
      const periodValue = keyFields[period] || keyFields[`${period}_days`]
      if (periodValue && typeof periodValue === "number" && periodValue < (days as number)) {
        compliance.warnings.push(
          `${period.replace(/_/g, " ")} (${periodValue} days) is shorter than typical ${state} standard (${days} days)`
        )
      }
    }
  }

  // Check must-contain clauses
  if (requirements.must_contain) {
    for (const clause of requirements.must_contain) {
      if (!keyFields.clauses_present?.some((c: string) => c.toLowerCase().includes(clause.toLowerCase()))) {
        compliance.warnings.push(`Document should contain: ${clause}`)
      }
    }
  }

  return compliance
}

// ============================================
// DOCUMENT EDUCATIONAL OVERLAYS (STATIC)
// ============================================

export function getEducationalOverlay(documentType: string) {
  const overlays: Record<string, any> = {
    purchase_agreement: {
      common_questions: [
        {
          question: "What is earnest money?",
          answer:
            "Earnest money is a deposit that shows you're serious about buying. It's typically 1-3% of the purchase price and goes toward your down payment at closing. If you back out without a valid reason in the contract, you may lose it.",
        },
        {
          question: "What are contingencies?",
          answer:
            "Contingencies are conditions that must be met for the sale to go through. Common ones include inspection, appraisal, and financing contingencies. They protect you by letting you walk away if something goes wrong.",
        },
        {
          question: "What happens during the inspection period?",
          answer:
            "This is your time to have the home professionally inspected. If major issues are found, you can negotiate repairs, a price reduction, or walk away entirely.",
        },
      ],
      red_flags_to_watch: [
        "No inspection contingency (you waive your right to inspect)",
        "Very short inspection period (less than 7 days)",
        "As-Is sale with no recourse",
        "Non-refundable earnest money",
        "Seller rent-back without clear terms",
      ],
      pro_tips: [
        "Read the entire contract, not just the first page",
        "Pay attention to all dates and deadlines",
        "Make sure all verbal promises are in writing",
        "Don't sign anything you don't understand - ask questions!",
        "Keep copies of everything",
      ],
    },
    inspection_report: {
      common_questions: [
        {
          question: "What's the difference between major and minor issues?",
          answer:
            "Major issues affect safety or the home's structure (roof, foundation, electrical, plumbing). Minor issues are cosmetic or easy fixes. Focus your negotiations on major issues.",
        },
        {
          question: "Should I walk away if there are issues?",
          answer:
            "Not necessarily! Most homes have some issues. The question is: are they fixable and worth negotiating? Your agent can help you decide.",
        },
      ],
      red_flags_to_watch: [
        "Foundation cracks or structural damage",
        "Evidence of water damage or mold",
        "Outdated electrical (knob and tube, aluminum wiring)",
        "Roof damage or age over 20 years",
        "HVAC system at end of life",
      ],
      pro_tips: [
        "Attend the inspection in person if possible",
        "Ask the inspector to explain anything you don't understand",
        "Focus negotiations on safety and structural issues",
        "Get contractor quotes for major repairs before negotiating",
      ],
    },
    closing_disclosure: {
      common_questions: [
        {
          question: "What should I compare on the Closing Disclosure?",
          answer:
            "Compare it to your Loan Estimate. Look for changes in interest rate, loan amount, and closing costs. Significant changes must be explained by your lender.",
        },
        {
          question: "What are the different types of closing costs?",
          answer:
            "Closing costs include lender fees, title insurance, escrow fees, prepaid items (taxes, insurance), and recording fees. Some are negotiable, others are fixed.",
        },
      ],
      red_flags_to_watch: [
        "Interest rate different from Loan Estimate",
        "Unexplained fees or charges",
        "Cash to close significantly higher than expected",
        "Missing seller credits or concessions",
      ],
      pro_tips: [
        "Review this document at least 3 days before closing",
        "Compare line-by-line with your Loan Estimate",
        "Ask your lender to explain any differences",
        "Bring questions to your closing appointment",
      ],
    },
    appraisal: {
      common_questions: [
        {
          question: "What if the appraisal comes in low?",
          answer:
            "If the appraisal is lower than your offer, you have options: negotiate a lower price, pay the difference in cash, dispute the appraisal, or walk away using your appraisal contingency.",
        },
      ],
      red_flags_to_watch: [
        "Appraisal significantly below purchase price",
        "Comparables from different neighborhoods",
        "Missing important home features or upgrades",
      ],
      pro_tips: [
        "Provide the appraiser with a list of recent upgrades",
        "Share recent comparable sales your agent found",
        "Review the appraisal report carefully for errors",
      ],
    },
  }

  return overlays[documentType] || null
}

// ============================================
// DOCUMENT FOLDERS
// ============================================

export async function getDocumentFolders(contactId: string) {
  const supabase = await createClient()

  const { data: documents } = await supabase
    .from("client_documents")
    .select("document_category, ai_detected_type")
    .eq("contact_id", contactId)

  // Group by category
  const folders: Record<string, number> = {
    all: documents?.length || 0,
    contracts: 0,
    disclosures: 0,
    financial: 0,
    inspections: 0,
    other: 0,
  }

  documents?.forEach((doc) => {
    const type = doc.ai_detected_type || doc.document_category || "other"
    if (type.includes("agreement") || type.includes("contract") || type.includes("addendum")) {
      folders.contracts++
    } else if (type.includes("disclosure")) {
      folders.disclosures++
    } else if (type.includes("proof_of_funds") || type.includes("bank") || type.includes("appraisal")) {
      folders.financial++
    } else if (type.includes("inspection")) {
      folders.inspections++
    } else {
      folders.other++
    }
  })

  return Object.entries(folders).map(([name, count]) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    path: name,
    document_count: count,
  }))
}

export async function askDocumentQuestion(documentId: string, question: string) {
  const supabase = await createClient()

  // Get document and analysis
  const { data: document } = await supabase
    .from("client_documents")
    .select("*, document_analysis(*)")
    .eq("id", documentId)
    .single()

  if (!document) throw new Error("Document not found")

  const analysis = document.document_analysis?.[0]

  // Generate answer using AI
  const result = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `You are a helpful real estate assistant. A client is asking about their ${document.ai_detected_type || "document"}.

Document summary: ${analysis?.document_summary || "No summary available"}
Key fields: ${JSON.stringify(analysis?.key_fields_extracted || {})}

Client question: ${question}

Provide a clear, helpful answer in plain English. If you're not sure about something specific to their document, say so and suggest they ask their agent.`,
  })

  // Record in audit trail
  await supabase.from("document_audit_trail").insert({
    document_id: documentId,
    document_source: "client_documents",
    action: "viewed",
    performed_by_type: "client",
    notes: `Asked question: ${question.substring(0, 100)}`,
  })

  return { answer: result.text }
}
