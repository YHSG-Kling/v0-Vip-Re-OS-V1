// lib/onboarding/license-verifier.ts
// ============================================================
// SYSTEM: L11-S01 — License Verification Engine
// VIP Real Estate AI OS — Layer 11
// ============================================================
// Handles NIPR API lookup with AI document analysis fallback.
// Non-blocking — called async after license submission.

import { createServiceClient } from "@/lib/supabase/service"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { KernelEvent } from "@/lib/kernel/events"
import type { EntityType } from "@/lib/kernel/types"
import { generateText } from "ai"
import { gateway } from "@ai-sdk/gateway"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface LicenseVerificationParams {
  agentLicenseId: string
  agentId: string
  brokerageId: string
  onboardingId: string
  licenseNumber: string
  licenseState: string
  documentUrl?: string
}

interface VerificationResult {
  verified: boolean
  method: "nipr" | "ai_document_analysis" | "manual"
  resultDetail: string
}

// ─── MAIN VERIFICATION FUNCTION ───────────────────────────────────────────────

export async function runLicenseVerification(
  params: LicenseVerificationParams
): Promise<VerificationResult> {
  const supabase = createServiceClient()

  try {
    // Attempt 1: NIPR API lookup
    const niprResult = await attemptNiprVerification(params)
    if (niprResult.verified) {
      await handleVerificationSuccess(supabase, params, niprResult)
      return niprResult
    }

    // Attempt 2: AI document analysis fallback
    if (params.documentUrl) {
      const aiResult = await attemptAiDocumentAnalysis(params)
      if (aiResult.verified) {
        await handleVerificationSuccess(supabase, params, aiResult)
        return aiResult
      }

      // AI analysis failed — log and mark for manual review
      await handleVerificationFailure(supabase, params, aiResult)
      return aiResult
    }

    // No document uploaded — mark as pending manual review
    const manualResult: VerificationResult = {
      verified: false,
      method: "manual",
      resultDetail: "No document uploaded for AI analysis. Manual review required.",
    }
    await handleVerificationFailure(supabase, params, manualResult)
    return manualResult
  } catch (error) {
    console.error("[L11-License] Verification error:", error)
    const errorResult: VerificationResult = {
      verified: false,
      method: "manual",
      resultDetail: `System error during verification: ${error instanceof Error ? error.message : "Unknown error"}`,
    }
    await handleVerificationFailure(supabase, params, errorResult)
    return errorResult
  }
}

// ─── NIPR API VERIFICATION ────────────────────────────────────────────────────

async function attemptNiprVerification(
  params: LicenseVerificationParams
): Promise<VerificationResult> {
  // TODO: Integrate with actual NIPR API when credentials are available
  // NIPR API requires organization registration and API key
  // For now, return unverified to trigger AI fallback

  console.log(`[L11-License] NIPR lookup for ${params.licenseNumber} in ${params.licenseState}`)

  // Placeholder: NIPR integration not yet configured
  return {
    verified: false,
    method: "nipr",
    resultDetail: "NIPR API integration pending. Falling back to document analysis.",
  }
}

// ─── AI DOCUMENT ANALYSIS ─────────────────────────────────────────────────────

async function attemptAiDocumentAnalysis(
  params: LicenseVerificationParams
): Promise<VerificationResult> {
  if (!params.documentUrl) {
    return {
      verified: false,
      method: "ai_document_analysis",
      resultDetail: "No document URL provided for analysis.",
    }
  }

  try {
    console.log(`[L11-License] Starting AI document analysis for license ${params.licenseNumber}`)

    const prompt = `You are analyzing a real estate license document image. Extract and verify the following information:

1. License Number
2. State of Issue
3. Expiry Date
4. Licensee Name
5. License Type (Salesperson, Broker, or Broker-Associate)

Document URL: ${params.documentUrl}
Expected License Number: ${params.licenseNumber}
Expected State: ${params.licenseState}

Return your analysis as JSON in this exact format:
{
  "extracted_license_number": "string or null",
  "extracted_state": "string or null",
  "extracted_expiry_date": "YYYY-MM-DD or null",
  "extracted_name": "string or null",
  "extracted_license_type": "string or null",
  "license_number_match": true/false,
  "state_match": true/false,
  "is_expired": true/false,
  "confidence_score": 0.0-1.0,
  "verification_notes": "string describing any issues or confirmations"
}

Be conservative — if you cannot clearly read or verify information, mark it as null and explain in verification_notes.`

    const { text } = await generateText({
      model: gateway("anthropic/claude-sonnet-4"),
      prompt,
      maxOutputTokens: 1000,
    })

    // Parse AI response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return {
        verified: false,
        method: "ai_document_analysis",
        resultDetail: "AI response did not contain valid JSON. Manual review required.",
      }
    }

    const analysis = JSON.parse(jsonMatch[0])

    // Verification logic
    const isValid =
      analysis.license_number_match === true &&
      analysis.state_match === true &&
      analysis.is_expired === false &&
      analysis.confidence_score >= 0.8

    return {
      verified: isValid,
      method: "ai_document_analysis",
      resultDetail: isValid
        ? `License verified via AI analysis. Confidence: ${(analysis.confidence_score * 100).toFixed(0)}%. ${analysis.verification_notes}`
        : `AI analysis inconclusive. ${analysis.verification_notes}. Manual review recommended.`,
    }
  } catch (error) {
    console.error("[L11-License] AI analysis error:", error)
    return {
      verified: false,
      method: "ai_document_analysis",
      resultDetail: `AI analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    }
  }
}

// ─── SUCCESS HANDLER ──────────────────────────────────────────────────────────

async function handleVerificationSuccess(
  supabase: ReturnType<typeof createServiceClient>,
  params: LicenseVerificationParams,
  result: VerificationResult
) {
  const now = new Date().toISOString()

  // Update agent_licenses record
  await supabase
    .from("agent_licenses")
    .update({
      verification_status: "verified",
      verified_at: now,
      notes: result.resultDetail,
      updated_at: now,
    })
    .eq("id", params.agentLicenseId)

  // Insert license_verifications record
  await supabase.from("license_verifications").insert({
    brokerage_id: params.brokerageId,
    agent_license_id: params.agentLicenseId,
    method: result.method,
    result: "pass",
    result_detail: result.resultDetail,
    verified_at: now,
  })

  // Fire kernel event
  await processKernelEvent({
    event: KernelEvent.AGENT_LICENSE_VERIFIED,
    brokerageId: params.brokerageId,
    entityType: "agent_onboarding_machine",
    entityId: params.onboardingId,
  })

  // Transition lifecycle
  await transitionLifecycle({
    brokerageId: params.brokerageId,
    entityType: "agent_onboarding_machine" as EntityType,
    entityId: params.onboardingId,
    fromState: "license_submitted",
    toState: "license_verified",
    actorUserId: params.agentId,
    eventType: "license_verified",
    metadata: {
      license_id: params.agentLicenseId,
      verification_method: result.method,
    },
  })

  console.log(`[L11-License] License ${params.licenseNumber} verified successfully via ${result.method}`)
}

// ─── FAILURE HANDLER ──────────────────────────────────────────────────────────

async function handleVerificationFailure(
  supabase: ReturnType<typeof createServiceClient>,
  params: LicenseVerificationParams,
  result: VerificationResult
) {
  const now = new Date().toISOString()

  // Update agent_licenses record — mark as pending_review, NOT rejected
  await supabase
    .from("agent_licenses")
    .update({
      verification_status: "pending_review",
      notes: result.resultDetail,
      updated_at: now,
    })
    .eq("id", params.agentLicenseId)

  // Insert license_verifications record
  await supabase.from("license_verifications").insert({
    brokerage_id: params.brokerageId,
    agent_license_id: params.agentLicenseId,
    method: result.method,
    result: "fail",
    result_detail: result.resultDetail,
    verified_at: now,
  })

  // Fire kernel event for failed verification
  await processKernelEvent({
    event: KernelEvent.AGENT_LICENSE_FAILED,
    brokerageId: params.brokerageId,
    entityType: "agent_onboarding_machine",
    entityId: params.onboardingId,
  })

  console.log(`[L11-License] License ${params.licenseNumber} verification failed: ${result.resultDetail}`)
}
