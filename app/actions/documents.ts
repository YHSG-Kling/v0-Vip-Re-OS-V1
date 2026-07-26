"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { revalidatePath } from "next/cache"
import { put, del } from "@vercel/blob"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { z } from "zod"
import { handleError } from "@/lib/errors"

export async function getDocuments(params?: { contactId?: string; transactionId?: string; type?: string }) {
  try {
    // AUTH GATE — was returning any caller-supplied contact/transaction docs
    // without scoping by brokerage. Multi-tenant leak.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    const supabase = await createClient()
    const svc = createServiceClient()

    // If the caller targets a specific contact or transaction, verify it
    // belongs to their brokerage before returning any rows.
    if (params?.contactId) {
      const { data: c } = await svc
        .from("contacts").select("brokerage_id").eq("id", params.contactId).maybeSingle()
      if (!c || c.brokerage_id !== ctx.brokerageId) {
        return { success: false, error: "Forbidden" }
      }
    }
    if (params?.transactionId) {
      const { data: t } = await svc
        .from("transactions").select("brokerage_id").eq("id", params.transactionId).maybeSingle()
      if (!t || t.brokerage_id !== ctx.brokerageId) {
        return { success: false, error: "Forbidden" }
      }
    }

    // Contact/transaction/type-filtered listing lives on `documents` (the
    // contact-keyed doc table); transaction_documents has no contact_id and the
    // documents_uploaded_by_fkey embed only exists on `documents`.
    let query = supabase
      .from("documents")
      .select("*")
      .eq("brokerage_id", ctx.brokerageId)
      .order("created_at", { ascending: false })

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
      .from("transaction_documents")
      .select("storage_url")
      .eq("id", documentId)
      .single()

    if (doc?.storage_url) {
      try {
        await del(doc.storage_url)
      } catch (blobError) {
        console.error("Error deleting blob:", blobError)
      }
    }

    // Delete from database
    const { error } = await supabase
      .from("transaction_documents")
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
    // AUTH GATE — previously kicked off paid AI analysis on any document id.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    const supabase = await createClient()

    const { data: document, error } = await supabase
      .from("transaction_documents")
      .select("*")
      .eq("id", documentId)
      .maybeSingle()

    if (error || !document) throw error ?? new Error("Document not found")

    // Cross-tenant scope check before burning AI tokens.
    if (document.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // AI document analysis
    const { object: analysis } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        documentType: z.string(),
        keyInformation: z.array(z.string()),
        missingFields: z.array(z.string()),
        complianceIssues: z.array(z.string()),
        recommendations: z.array(z.string()),
        confidenceScore: z.number(),
      }),
      prompt: `Analyze this real estate document:
Type: ${document.doc_type}
Name: ${document.doc_label}

Provide detailed analysis including document type classification, key information extracted, any missing required fields, compliance issues, and recommendations.`,
    })

    // Update transaction_documents with extracted_data and classification_confidence
    await supabase
      .from("transaction_documents")
      .update({ 
        extracted_data: analysis,
        classification_confidence: analysis.confidenceScore,
      })
      .eq("id", documentId)

    // Insert into document_extraction_log
    await supabase.from("document_extraction_log").insert({
      transaction_doc_id: documentId,
      transaction_id: document.transaction_id,
      brokerage_id: document.brokerage_id,
      extraction_method: "ai_claude",
      extracted_fields: analysis,
      confidence_score: analysis.confidenceScore,
      raw_text: JSON.stringify(analysis.keyInformation),
      processing_status: "completed",
      processed_at: new Date().toISOString(),
    })

    // Log activity (fire-and-forget, never throw on audit failure)
    supabase.from("activities").insert({
      brokerage_id: document.brokerage_id,
      agent_id: document.brokerage_id, // best-effort; no agent_id on transaction_documents
      activity_type: "document_action",
      title: "Document analyzed",
      description: `AI analysis of document: ${document.doc_label ?? documentId}`,
      notes: JSON.stringify({ action: "analyzed", document_source: "transaction_documents", performed_by_type: "ai" }),
      status: "completed",
      entity_type: "transaction",
      transaction_id: document.transaction_id ?? null,
    }).then(() => {}, () => {})

    return { success: true, analysis }
  } catch (error) {
    return handleError(error, "analyzeDocument")
  }
}

export async function uploadDocument(
  file: { name: string; type: string; size: number; base64: string },
  contactId: string,
  transactionId?: string,
  _userId?: string // ignored — derived from session
) {
  // AUTH GATE — previously accepted spoofed userId + arbitrary contactId,
  // letting any caller upload docs into any tenant's contact folder.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const userId = ctx.userId

  const supabase = await createClient()
  const svc = createServiceClient()

  // Verify the contact belongs to the caller's brokerage
  if (contactId) {
    const { data: c } = await svc
      .from("contacts").select("brokerage_id").eq("id", contactId).maybeSingle()
    if (!c || c.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden: contact not in your brokerage" }
    }
  }
  // Verify the transaction (if provided) belongs to the caller's brokerage
  if (transactionId) {
    const { data: t } = await svc
      .from("transactions").select("brokerage_id").eq("id", transactionId).maybeSingle()
    if (!t || t.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden: transaction not in your brokerage" }
    }
  }

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
    // Signed URL — client-documents is a PRIVATE bucket (m278); a public URL 403s.
    const { signedDocUrl } = await import("@/lib/storage/signed-doc-url")
    publicUrl = await signedDocUrl(supabase, "client-documents", filePath)
  }

  // Create document record - supports both contact_id (clients) and user_id (agents)
  const { data: document, error: docError } = await supabase
    .from("client_documents")
    .insert({
      brokerage_id: ctx.brokerageId,
      contact_id: contactId || null,
      transaction_id: transactionId || null,
      document_name: file.name,
      document_url: publicUrl,
      document_type: "other",
      doc_category: "other",
      uploaded_by: userId || null,
    })
    .select()
    .single()

  if (docError) {
    console.error("Document record error:", docError)
    throw new Error("Failed to create document record")
  }

  // Log activity (fire-and-forget)
  supabase.from("activities").insert({
    brokerage_id: document.brokerage_id ?? null,
    agent_id: document.brokerage_id ?? null, // best-effort; no direct agent_id on client_documents
    contact_id: contactId ?? null,
    activity_type: "document_action",
    title: `Document uploaded: ${file.name}`,
    description: `Uploaded via portal: ${file.name}`,
    notes: JSON.stringify({ action: "uploaded", document_source: "client_documents", performed_by_type: "client" }),
    status: "completed",
    entity_type: "contact",
  }).then(() => {}, () => {})

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
    // Get document to get brokerage_id
    const { data: docRecord } = await supabase
      .from("client_documents")
      .select("id, brokerage_id, contact_id")
      .eq("id", documentId)
      .maybeSingle()

    // Step 1: Extract text and classify document
    const classificationResult = await generateText({
      model: "openai/gpt-4o",
      messages: [
        {
          role: "user",
          content: ([
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
          ] as any),
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

    // Step 4: Build extracted_fields with internal keys for plain_english, validation, risk
    const extractedFieldsWithMeta = {
      ...classification.key_fields,
      _plain_english: explanationResult.text,
      _validation_issues: validation.issues,
      _risk_flags: validation.risks,
    }

    // Step 5: Insert into document_extraction_log (correct table per schema)
    // Note: We don't have transaction_doc_id for client_documents, so we skip if no transaction context
    // For transaction documents this would work properly

    // Step 6: Update client_documents record
    await supabase
      .from("client_documents")
      .update({
        doc_category: classification.document_type,
        document_type: classification.document_type,
      })
      .eq("id", documentId)

    // Step 7: For contract document types — run state-specific signature compliance scan
    // Plan FIX 0B/J10: when any contract is uploaded, scan for signature/initial completeness per state requirements
    const CONTRACT_TYPES = ["purchase_agreement", "listing_agreement", "addendum", "disclosure_form"]
    let signatureScan: any = null
    if (CONTRACT_TYPES.includes(classification.document_type)) {
      try {
        // Resolve state from brokerage
        let brokerageState: string | null = null
        if (docRecord?.brokerage_id) {
          const { data: brokerage } = await supabase
            .from("brokerages")
            .select("state")
            .eq("id", docRecord.brokerage_id)
            .maybeSingle()
          brokerageState = brokerage?.state ?? null
        }

        // Pull state requirements
        const { data: stateReqs } = brokerageState
          ? await supabase
              .from("state_compliance_requirements")
              .select("requirement_name, description, document_type")
              .eq("state", brokerageState)
              .eq("document_type", classification.document_type)
          : { data: null }

        const reqList = stateReqs?.length
          ? stateReqs.map((r: any) => `- ${r.requirement_name}: ${r.description}`).join("\n")
          : "Standard state requirements apply."

        const scanResult = await generateText({
          model: "openai/gpt-4o",
          messages: [
            {
              role: "user",
              content: ([
                {
                  type: "text",
                  text: `You are a real estate compliance reviewer. Examine this ${classification.document_type} for ${brokerageState ?? "the applicable state"} and return ONLY valid JSON — no markdown.

Check:
1. Are all required signature blocks signed?
2. Are all required initials initialed?
3. Does it meet these state-specific requirements?
${reqList}

Return this exact structure:
{
  "signatureCompleteness": {
    "allRequiredSignaturesPresent": boolean,
    "allRequiredInitialsPresent": boolean,
    "missingSignatures": [{ "page": number|null, "location": string, "signer_role": "buyer|seller|agent|broker|witness|notary", "severity": "critical|warning|info" }],
    "missingInitials": [{ "page": number|null, "location": string, "signer_role": string }]
  },
  "stateComplianceIssues": [{ "requirement": string, "status": "pass|fail|unclear", "note": string }],
  "overallStatus": "pass|warnings|blocking_issues"
}

Set overallStatus to "blocking_issues" only if missing signatures would invalidate the contract.`,
                },
                { type: "image", image: fileUrl },
              ] as any),
            },
          ],
        })

        let scan: any = null
        try {
          const cleaned = scanResult.text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim()
          scan = JSON.parse(cleaned)
        } catch (parseErr) {
          console.error("[v0] Failed to parse signature scan JSON:", parseErr)
          scan = {
            signatureCompleteness: {
              allRequiredSignaturesPresent: false,
              allRequiredInitialsPresent: false,
              missingSignatures: [],
              missingInitials: [],
            },
            stateComplianceIssues: [],
            overallStatus: "warnings",
          }
        }
        signatureScan = scan

        // Persist scan as a row in compliance_checks (table created by migration 565)
        // Schema: id, contract_review_id (nullable), check_type, status, findings JSONB
        await supabase
          .from("compliance_checks")
          .insert({
            check_type: "signature_completeness",
            status: scan.overallStatus,
            findings: {
              ...scan,
              document_id: documentId,
              brokerage_id: docRecord?.brokerage_id ?? null,
              state: brokerageState,
              source: "client_document_upload",
            } as any,
          })
          .then(() => {}, (err) => console.error("[v0] compliance_checks insert error:", err))

        // Activity log entry — surfaces issues to agent
        const issueCount =
          scan.signatureCompleteness.missingSignatures.length +
          scan.signatureCompleteness.missingInitials.length +
          scan.stateComplianceIssues.filter((i: any) => i.status === "fail").length
        supabase
          .from("activities")
          .insert({
            brokerage_id: docRecord?.brokerage_id ?? null,
            agent_id: docRecord?.brokerage_id ?? null,
            contact_id: docRecord?.contact_id ?? null,
            activity_type: "compliance_scan",
            title:
              scan.overallStatus === "pass"
                ? `Compliance scan passed: ${classification.document_type}`
                : `Compliance scan found ${issueCount} issue(s): ${classification.document_type}`,
            description: `State-specific signature/initial scan ran on uploaded document.`,
            notes: JSON.stringify({ scan_status: scan.overallStatus, issue_count: issueCount }),
            status: scan.overallStatus === "pass" ? "completed" : "needs_review",
            entity_type: "document",
          })
          .then(() => {}, () => {})
      } catch (scanErr) {
        console.error("[v0] Signature compliance scan error:", scanErr)
      }
    }

    // Step 8: For purchase agreements — extract terms and auto-populate transaction
    if (classification.document_type === "purchase_agreement" && classification.key_fields) {
      try {
        // Find an open transaction for this contact (most recent)
        if (docRecord?.contact_id) {
          const { data: tx } = await supabase
            .from("transactions")
            .select("id, status")
            .eq("contact_id", docRecord.contact_id)
            .in("status", ["pending", "under_contract", "active"])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()

          if (tx?.id) {
            const { applyContractExtraction } = await import("./ai-contract-review")
            const k = classification.key_fields
            await applyContractExtraction({
              transactionId: tx.id,
              agentId: docRecord.brokerage_id ?? "",
              extracted: {
                purchasePrice: typeof k.purchase_price === "number" ? k.purchase_price : null,
                earnestMoneyAmount: typeof k.earnest_money === "number" ? k.earnest_money : null,
                inspectionDeadline: k.inspection_deadline ?? null,
                appraisalDeadline: k.appraisal_deadline ?? null,
                financingDeadline: k.financing_deadline ?? null,
                closingDate: k.closing_date ?? null,
                buyerName: k.buyer_name ?? null,
                sellerName: k.seller_name ?? null,
                propertyAddress: k.property_address ?? null,
              },
            })
          }
        }
      } catch (applyErr) {
        console.error("[v0] applyContractExtraction error:", applyErr)
      }
    }

    // Step 9: Trigger compliance-pass workflow chains when scan PASSES on
    // a contract document. Each chain self-decides whether to act on its
    // trigger event (e.g. listing-agreement → auto-create listing,
    // executed purchase-agreement → auto-create transaction).
    if (signatureScan?.overallStatus === "pass" && docRecord?.brokerage_id) {
      try {
        const { triggerChainsForEvent } = await import("./workflow-orchestrator")

        const baseExtracted = {
          propertyAddress: classification.key_fields?.property_address ?? null,
          listPrice: classification.key_fields?.list_price ?? classification.key_fields?.listing_price ?? null,
          listDate: classification.key_fields?.list_date ?? null,
          expirationDate: classification.key_fields?.expiration_date ?? null,
          commissionRate: classification.key_fields?.commission_rate ?? null,
          purchasePrice: classification.key_fields?.purchase_price ?? null,
          earnestMoneyAmount: classification.key_fields?.earnest_money ?? null,
          inspectionDeadline: classification.key_fields?.inspection_deadline ?? null,
          appraisalDeadline: classification.key_fields?.appraisal_deadline ?? null,
          financingDeadline: classification.key_fields?.financing_deadline ?? null,
          closingDate: classification.key_fields?.closing_date ?? null,
          contractDate: classification.key_fields?.contract_date ?? null,
          buyerName: classification.key_fields?.buyer_name ?? null,
          sellerName: classification.key_fields?.seller_name ?? null,
          city: classification.key_fields?.city ?? null,
          state: classification.key_fields?.state ?? null,
          zipCode: classification.key_fields?.zip_code ?? null,
        }

        if (classification.document_type === "listing_agreement") {
          // A listing agreement is EXECUTABLE only when BOTH the listing agent AND
          // the seller have completed signatures AND initials. overallStatus="pass"
          // is an aggregate and can pass with one party missing, so enforce per-role
          // from the scan before auto-creating the listing.
          const sc = (signatureScan as any)?.signatureCompleteness ?? {}
          const PARTIES = ["agent", "seller"]
          const roleOf = (m: any) => String(m?.signer_role ?? "").toLowerCase()
          const sigGap = (sc.missingSignatures ?? []).some((m: any) => PARTIES.includes(roleOf(m)))
          const initGap = (sc.missingInitials ?? []).some((m: any) => PARTIES.includes(roleOf(m)))
          const bothPartiesExecuted =
            sc.allRequiredSignaturesPresent === true &&
            sc.allRequiredInitialsPresent === true &&
            !sigGap && !initGap

          if (!bothPartiesExecuted) {
            console.warn(
              `[v0] Listing agreement ${docRecord.id} not fully executed by agent + seller (signatures/initials incomplete) — listing NOT auto-created`
            )
          } else {
            // Executable also requires ALL required listing documents present
            // (state/federal/brokerage checklist), not just the signed agreement.
            const { auditListingDocuments } = await import("@/lib/compliance/required-documents")
            const docAudit = await auditListingDocuments(supabase as any, {
              brokerageId:     docRecord.brokerage_id,
              sellerContactId: docRecord.contact_id ?? null,
              stateCode:       baseExtracted.state ?? null,
            })

            if (docAudit.missing_blocking.length > 0) {
              console.warn(
                `[v0] Listing agreement ${docRecord.id} executed but required documents missing (${docAudit.missing_blocking.join(", ")}) — listing NOT auto-created`
              )
            } else {
              await triggerChainsForEvent({
                eventType: "compliance.listing_agreement_passed",
                brokerageId: docRecord.brokerage_id,
                contactId: docRecord.contact_id ?? null,
                metadata: {
                  document_id: docRecord.id,
                  extracted: baseExtracted,
                  signature_scan: signatureScan,
                  required_docs_audit: {
                    present: docAudit.present,
                    missing_warning: docAudit.missing_warning,
                  },
                },
              })
            }
          }
        } else if (classification.document_type === "purchase_agreement") {
          // Only auto-create transaction when there is an offer record but
          // no transaction yet; otherwise existing applyContractExtraction
          // path above updates the existing transaction.
          await triggerChainsForEvent({
            eventType: "compliance.executed_offer_passed",
            brokerageId: docRecord.brokerage_id,
            contactId: docRecord.contact_id ?? null,
            metadata: {
              document_id: docRecord.id,
              offer_id: classification.key_fields?.offer_id ?? null,
              extracted: baseExtracted,
              signature_scan: signatureScan,
            },
          })
        }
      } catch (chainErr) {
        console.error("[v0] Compliance-pass chain trigger failed:", chainErr)
      }
    }

    // Log activity (fire-and-forget)
    supabase.from("activities").insert({
      brokerage_id: docRecord?.brokerage_id ?? null,
      agent_id: docRecord?.brokerage_id ?? null, // best-effort
      contact_id: docRecord?.contact_id ?? null,
      activity_type: "document_action",
      title: `Document AI analysis: ${classification.document_type}`,
      description: `AI analysis complete: ${classification.document_type} (${Math.round(classification.confidence * 100)}% confidence)`,
      notes: JSON.stringify({ action: "analyzed", document_source: "client_documents", performed_by_type: "ai" }),
      status: "completed",
      entity_type: "contact",
    }).then(() => {}, () => {})

    return { success: true, classification, explanation: explanationResult.text, signatureScan }
  } catch (error) {
    console.error("AI processing error:", error)
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
  // AUTH GATE — previously returned every document for any caller-supplied
  // contact id with no tenant scope.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return []
  }

  const svc = createServiceClient()
  const { data: c } = await svc
    .from("contacts").select("brokerage_id").eq("id", contactId).maybeSingle()
  if (!c || c.brokerage_id !== ctx.brokerageId) {
    return []
  }

  const supabase = await createClient()
  const { data: documents } = await supabase
    .from("client_documents")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", ctx.brokerageId)
    .order("created_at", { ascending: false })

  return documents || []
}

export async function getDocumentWithAnalysis(documentId: string) {
  const supabase = await createClient()

  // Try client_documents first
  let document = null
  let extractionLog = null
  let docSource = "client_documents"

  const { data: clientDoc } = await supabase
    .from("client_documents")
    .select("*")
    .eq("id", documentId)
    .single()

  if (clientDoc) {
    document = clientDoc
  } else {
    // Try transaction_documents
    const { data: txDoc } = await supabase
      .from("transaction_documents")
      .select("*")
      .eq("id", documentId)
      .single()
    
    if (txDoc) {
      document = txDoc
      docSource = "transaction_documents"

      // For transaction documents, fetch extraction log
      const { data: log } = await supabase
        .from("document_extraction_log")
        .select("*")
        .eq("transaction_doc_id", documentId)
        .order("processed_at", { ascending: false })
        .limit(1)
        .single()
      
      extractionLog = log
    }
  }

  if (!document) {
    return { document: null, extractionLog: null, educationalOverlay: null }
  }

  // Get educational overlay from static function (not DB)
  const docType = document.doc_type ?? document.document_type ?? document.doc_category
  const educationalOverlay = await getEducationalOverlay(docType)

  // Log view activity (fire-and-forget)
  supabase.from("activities").insert({
    brokerage_id: document.brokerage_id ?? null,
    agent_id: document.brokerage_id ?? null, // best-effort
    contact_id: document.contact_id ?? null,
    activity_type: "document_action",
    title: "Document viewed",
    description: `Document viewed: ${document.doc_label ?? document.document_name ?? documentId}`,
    notes: JSON.stringify({ action: "viewed", document_source: docSource, performed_by_type: "client" }),
    status: "completed",
    entity_type: "contact",
  }).then(() => {}, () => {})

  return { document, extractionLog, educationalOverlay }
}

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
  const supabase = await createClient()

  // First: query state_compliance_requirements from DB
  const { data: dbRequirements } = await supabase
    .from("state_compliance_requirements")
    .select("*")
    .eq("state", state)
    .or(`document_type.eq.${documentType},document_type.is.null`)
    .eq("is_mandatory", true)

  const compliance = {
    passed: true,
    issues: [] as string[],
    warnings: [] as string[],
  }

  // If DB has requirements, use them
  if (dbRequirements && dbRequirements.length > 0) {
    for (const req of dbRequirements) {
      // Check requirement_category against keyFields
      if (req.requirement_category && !keyFields[req.requirement_category]) {
        compliance.issues.push(`Missing required ${state} requirement: ${req.requirement_name}`)
        compliance.passed = false
      }
      // Check timeline_days if applicable
      if (req.timeline_days && keyFields.inspection_period_days) {
        if (keyFields.inspection_period_days < req.timeline_days) {
          compliance.warnings.push(
            `${req.requirement_name}: ${keyFields.inspection_period_days} days is shorter than ${state} standard (${req.timeline_days} days)`
          )
        }
      }
    }
    return compliance
  }

  // Fall back to existing hardcoded logic if no rows found
  const requirements = stateRequirements[state]?.[documentType]

  if (!requirements) {
    return { passed: true, issues: [], warnings: [], note: "No specific state requirements found for this document type" }
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

export async function getEducationalOverlay(documentType: string) {
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
    .select("doc_category, document_type")
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
    const type = doc.document_type || doc.doc_category || "other"
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

  // Get document
  const { document, extractionLog } = await getDocumentWithAnalysis(documentId)

  if (!document) throw new Error("Document not found")

  const analysis = extractionLog

  // Generate answer using AI
  const result = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `You are a helpful real estate assistant. A client is asking about their ${document.doc_type ?? document.document_type ?? "document"}.

Document summary: ${analysis?.raw_text || "No summary available"}
Key fields: ${JSON.stringify(analysis?.extracted_fields || document.extracted_data || {})}

Client question: ${question}

Provide a clear, helpful answer in plain English. If you're not sure about something specific to their document, say so and suggest they ask their agent.`,
  })

  // Log activity (fire-and-forget)
  supabase.from("activities").insert({
    activity_type: "document_action",
    entity_type: "document",
    entity_id: documentId,
    metadata: { action: "question_asked", performed_by_type: "client", notes: `Asked question: ${question.substring(0, 100)}` },
  }).then(() => {}, () => {})

  return { answer: result.text }
}
