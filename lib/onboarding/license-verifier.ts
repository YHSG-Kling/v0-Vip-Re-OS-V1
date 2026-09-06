// lib/onboarding/license-verifier.ts
// ============================================================
// SYSTEM: L11-S01 — License Verification Engine
// VIP Real Estate AI OS — Layer 11
// ============================================================
// Real-estate licenses are verified against the STATE regulator registry
// (there is no national real-estate license API — NIPR is insurance):
//   1. State registry ladder (lib/onboarding/license-lookup.ts)
//        scrape + AI-extract where the portal allows it, honest confidence.
//   2. AI document analysis fallback (uploaded license document).
//   3. Human review queue — the FLOOR. 'flagged' and 'needs_manual_review'
//      both land here; this engine never rejects an agent, only humans do.
// Non-blocking — called async after license submission.

import { createServiceClient } from "@/lib/supabase/service"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { KernelEvent } from "@/lib/kernel/events"
import type { EntityType } from "@/lib/kernel/types"
import { guardedGenerateText } from "@/lib/data-guard/guarded-generate"
import { logAIUsage } from "@/lib/ai/cost-tracking"
import { gateway } from "@ai-sdk/gateway"
import { verifyRealEstateLicense } from "@/lib/onboarding/license-lookup"

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
  method: "state_registry" | "ai_document_analysis" | "manual"
  /** canonical license_verifications.verification_method (CHECK-valid). */
  dbMethod: "state_registry_scrape" | "state_portal_manual" | "document_ai" | "manual"
  resultDetail: string
  /** 0-1 extraction confidence when a state-registry scrape ran. */
  confidence?: number
  /** Extracted registry evidence (goes into license_verifications.raw_response). */
  evidence?: Record<string, unknown>
  /** One-click state-portal link for the human reviewer. */
  portalUrl?: string
  /** Registry showed an adverse status (expired/revoked/…) — a real finding, humans decide. */
  flagged?: boolean
}

// ─── MAIN VERIFICATION FUNCTION ───────────────────────────────────────────────

export async function runLicenseVerification(
  params: LicenseVerificationParams
): Promise<VerificationResult> {
  const supabase = createServiceClient()

  try {
    // Attempt 1: state regulator registry (the real-estate license source of truth)
    const registryResult = await attemptStateRegistryVerification(supabase, params)
    if (registryResult.verified) {
      await handleVerificationSuccess(supabase, params, registryResult)
      return registryResult
    }

    if (registryResult.flagged) {
      // Adverse registry finding (expired/revoked/…): straight to the human
      // queue with the evidence — a document upload cannot override the state
      // registry, and this engine never rejects on its own.
      await handleVerificationFailure(supabase, params, registryResult, "failed")
      return registryResult
    }

    // Registry inconclusive (portal not scrapeable / not found / low confidence /
    // scrape or AI failure) — keep an honest audit row of the attempt, then fall
    // through to document analysis.
    await recordVerificationAttempt(supabase, params, registryResult, "inconclusive")

    // Attempt 2: AI document analysis fallback
    if (params.documentUrl) {
      const aiResult = await attemptAiDocumentAnalysis(params)
      // Carry the portal link forward so the reviewer always gets the one-click
      // state-portal link, whatever attempt escalated.
      aiResult.portalUrl = aiResult.portalUrl ?? registryResult.portalUrl
      if (aiResult.verified) {
        await handleVerificationSuccess(supabase, params, aiResult)
        return aiResult
      }

      // AI analysis inconclusive — mark for manual review
      await handleVerificationFailure(supabase, params, aiResult, "inconclusive")
      return aiResult
    }

    // No document uploaded — mark as pending manual review
    const manualResult: VerificationResult = {
      verified: false,
      method: "manual",
      dbMethod: "manual",
      resultDetail: `${registryResult.resultDetail} No document uploaded for AI analysis. Manual review required.`,
      portalUrl: registryResult.portalUrl,
      confidence: registryResult.confidence,
      evidence: registryResult.evidence,
    }
    await handleVerificationFailure(supabase, params, manualResult, "inconclusive")
    return manualResult
  } catch (error) {
    console.error("[L11-License] Verification error:", error)
    const errorResult: VerificationResult = {
      verified: false,
      method: "manual",
      dbMethod: "manual",
      resultDetail: `System error during verification: ${error instanceof Error ? error.message : "Unknown error"}`,
    }
    await handleVerificationFailure(supabase, params, errorResult, "inconclusive")
    return errorResult
  }
}

// ─── STATE REGISTRY VERIFICATION ──────────────────────────────────────────────

async function attemptStateRegistryVerification(
  supabase: ReturnType<typeof createServiceClient>,
  params: LicenseVerificationParams
): Promise<VerificationResult> {
  console.log(
    `[L11-License] State-registry lookup for ${params.licenseNumber} in ${params.licenseState}`
  )

  // Best-effort last name (some state portals search by name) — never blocking.
  let lastName: string | undefined
  {
    const { data: agentRow, error } = await supabase
      .from("agents")
      .select("user_id, users ( last_name )")
      .eq("id", params.agentId)
      .maybeSingle()
    if (error) {
      console.warn("[L11-License] lastName lookup failed (non-blocking):", error.message)
    } else {
      const usersRel = (agentRow as any)?.users
      const userRow = Array.isArray(usersRel) ? usersRel[0] : usersRel
      lastName = userRow?.last_name ?? undefined
    }
  }

  const verdict = await verifyRealEstateLicense({
    state: params.licenseState,
    licenseNumber: params.licenseNumber,
    lastName,
    brokerageId: params.brokerageId,
  })

  if (verdict.status === "verified") {
    return {
      verified: true,
      method: "state_registry",
      dbMethod: "state_registry_scrape",
      resultDetail:
        `Verified against ${verdict.evidence.boardName}: status "${verdict.evidence.licenseStatus}"` +
        (verdict.evidence.expirationDate ? `, expires ${verdict.evidence.expirationDate}` : "") +
        `. Confidence ${(verdict.evidence.confidence * 100).toFixed(0)}%.`,
      confidence: verdict.evidence.confidence,
      evidence: { ...verdict.evidence },
      portalUrl: verdict.evidence.sourceUrl,
    }
  }

  if (verdict.status === "flagged") {
    return {
      verified: false,
      flagged: true,
      method: "state_registry",
      dbMethod: "state_registry_scrape",
      resultDetail:
        `State registry (${verdict.evidence.boardName}) shows status ` +
        `"${verdict.evidence.licenseStatus}" for this license (${verdict.reason}). ` +
        `Human review required — not auto-rejected.`,
      confidence: verdict.evidence.confidence,
      evidence: { ...verdict.evidence },
      portalUrl: verdict.portalUrl,
    }
  }

  // needs_manual_review
  return {
    verified: false,
    method: "state_registry",
    dbMethod: verdict.method === "state_portal_manual" ? "state_portal_manual" : "state_registry_scrape",
    resultDetail:
      verdict.method === "state_portal_manual"
        ? `The ${params.licenseState} portal cannot be verified automatically (${verdict.reason}).`
        : `State-registry lookup inconclusive (${verdict.reason}).`,
    confidence: verdict.evidence?.confidence,
    evidence: verdict.evidence ? { ...verdict.evidence } : undefined,
    portalUrl: verdict.portalUrl,
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
      dbMethod: "document_ai",
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

    const { text, usage } = await guardedGenerateText({
      model: gateway("anthropic/claude-sonnet-4"),
      prompt,
      maxOutputTokens: 1000,
    })

    // ── THE LEDGER (CLAUDE.md §5) ────────────────────────────────────────────
    // guardedGenerateText is a DATA-GUARD chokepoint, not a billing one: it
    // redacts the prompt and then calls the raw SDK, so being on it satisfies
    // data-guard-guard and says NOTHING about ai_tool_usage. This call ran a
    // real model on the platform's own credentials and booked nothing, and
    // ai_tool_usage feeds meter_readings.ai_tokens and the overage projection —
    // a wrong number there is a wrong invoice.
    //
    // ROUTED WAS NOT AN OPTION HERE. generateTextRouted books, but it picks the
    // model from AI_TASK_ROUTING and ignores the caller's, so converting would
    // change WHICH MODEL READS A LICENCE DOCUMENT. Booking beside the existing
    // call keeps the model this call site already pinned; the ledger changes and
    // the spend does not. This is the same shape the ai-spend-booked guard's own
    // positive control demonstrates as `booked`.
    //
    // 'claude-sonnet' is the BILLING IDENTITY, not the gateway string: the live
    // CHECK ai_tool_usage_model_is_priceable refuses 'anthropic/claude-sonnet-4'
    // and admits 'claude-sonnet', because calculateCost prices off that key.
    // TENANT FROM THE CALLER'S ALREADY-RESOLVED PARAMS (§4) — params.brokerageId
    // is the onboarding tenant, never a request body.
    await logAIUsage({
      userId:       null,
      brokerageId:  params.brokerageId,
      agentId:      params.agentId,
      model:        "claude-sonnet",
      inputTokens:  usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      feature:      "license_document_analysis",
    })

    // Parse AI response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return {
        verified: false,
        method: "ai_document_analysis",
        dbMethod: "document_ai",
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
      dbMethod: "document_ai",
      confidence: typeof analysis.confidence_score === "number" ? analysis.confidence_score : undefined,
      evidence: analysis,
      resultDetail: isValid
        ? `License verified via AI analysis. Confidence: ${(analysis.confidence_score * 100).toFixed(0)}%. ${analysis.verification_notes}`
        : `AI analysis inconclusive. ${analysis.verification_notes}. Manual review recommended.`,
    }
  } catch (error) {
    console.error("[L11-License] AI analysis error:", error)
    return {
      verified: false,
      method: "ai_document_analysis",
      dbMethod: "document_ai",
      resultDetail: `AI analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    }
  }
}

// ─── AUDIT ROW FOR A NON-TERMINAL ATTEMPT ─────────────────────────────────────

/**
 * Record an attempt that did not settle the verification (registry inconclusive
 * before the document fallback runs) so the reviewer sees the full ladder.
 */
async function recordVerificationAttempt(
  supabase: ReturnType<typeof createServiceClient>,
  params: LicenseVerificationParams,
  result: VerificationResult,
  verificationResult: "inconclusive" | "failed"
) {
  const { error } = await supabase.from("license_verifications").insert({
    brokerage_id: params.brokerageId,
    license_id: params.agentLicenseId,
    verification_method: result.dbMethod,
    verification_result: verificationResult,
    confidence_score: result.confidence ?? null,
    failure_reasons: [result.resultDetail],
    raw_response: {
      detail: result.resultDetail,
      evidence: result.evidence ?? null,
      portal_url: result.portalUrl ?? null,
    },
  })
  if (error) {
    console.error("[L11-License] failed to record verification attempt:", error.message)
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
  {
    const { error } = await supabase
      .from("agent_licenses")
      .update({
        verification_status: "verified",
        verified_at: now,
        updated_at: now,
      })
      .eq("id", params.agentLicenseId)
    if (error) console.error("[L11-License] agent_licenses update failed:", error.message)
  }

  // Insert license_verifications record (canonical columns + CHECK-valid values)
  {
    const { error } = await supabase.from("license_verifications").insert({
      brokerage_id: params.brokerageId,
      license_id: params.agentLicenseId,
      verification_method: result.dbMethod,
      verification_result: "passed",
      confidence_score: result.confidence ?? null,
      raw_response: {
        detail: result.resultDetail,
        evidence: result.evidence ?? null,
        portal_url: result.portalUrl ?? null,
      },
    })
    if (error) console.error("[L11-License] license_verifications insert failed:", error.message)
  }

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
      verification_method: result.dbMethod,
    },
  })

  console.log(`[L11-License] License ${params.licenseNumber} verified successfully via ${result.dbMethod}`)
}

// ─── FAILURE / ESCALATION HANDLER ─────────────────────────────────────────────

async function handleVerificationFailure(
  supabase: ReturnType<typeof createServiceClient>,
  params: LicenseVerificationParams,
  result: VerificationResult,
  verificationResult: "failed" | "inconclusive"
) {
  const now = new Date().toISOString()

  // Update agent_licenses record — mark as pending_review, NOT rejected
  {
    const { error } = await supabase
      .from("agent_licenses")
      .update({
        verification_status: "pending", // CHECK: unverified|pending|verified|failed (no pending_review)
        updated_at: now,
      })
      .eq("id", params.agentLicenseId)
    if (error) console.error("[L11-License] agent_licenses update failed:", error.message)
  }

  // Insert license_verifications record (canonical columns + CHECK-valid values).
  // 'failed' is reserved for a real adverse registry finding ('flagged');
  // everything the ladder couldn't settle is honestly 'inconclusive'.
  {
    const { error } = await supabase.from("license_verifications").insert({
      brokerage_id: params.brokerageId,
      license_id: params.agentLicenseId,
      verification_method: result.dbMethod,
      verification_result: verificationResult,
      confidence_score: result.confidence ?? null,
      failure_reasons: [result.resultDetail],
      raw_response: {
        detail: result.resultDetail,
        evidence: result.evidence ?? null,
        portal_url: result.portalUrl ?? null,
        flagged: result.flagged === true,
      },
    })
    if (error) console.error("[L11-License] license_verifications insert failed:", error.message)
  }

  // Fire kernel event for failed verification
  await processKernelEvent({
    event: KernelEvent.AGENT_LICENSE_FAILED,
    brokerageId: params.brokerageId,
    entityType: "agent_onboarding_machine",
    entityId: params.onboardingId,
  })

  // Hand the un-clearable verification to the humans who CAN clear it — the brokerage's compliance
  // officers + admins. Without this the license sat in "pending" with a failed record and nobody was
  // told, so the agent's onboarding silently stalled. Managers working together: the License Verifier
  // escalates to Compliance/Admin for manual review instead of dropping it. The body carries the
  // one-click state-portal link so the reviewer can check the registry themselves. Best-effort.
  try {
    const { data: reviewers, error } = await supabase
      .from("users")
      .select("id")
      .eq("brokerage_id", params.brokerageId)
      .in("user_type", ["compliance_officer", "admin", "broker"])
    if (error) throw error
    const portalLine = result.portalUrl ? ` Check the state portal: ${result.portalUrl}` : ""
    for (const r of reviewers ?? []) {
      const { error: notifError } = await supabase.from("notifications").insert({
        user_id:     r.id,
        brokerage_id: params.brokerageId,
        type:        "license_manual_review_required",
        title:       result.flagged ? "License flagged by state registry" : "License needs manual review",
        body:        `Auto-verification couldn't clear a ${params.licenseState} license (#${params.licenseNumber}). ${result.resultDetail}${portalLine}`,
        entity_type: "agent_license",
        entity_id:   params.agentLicenseId,
        priority:    "high",
        channel:     "in_app",
      })
      if (notifError) console.error("[L11-License] reviewer notification failed:", notifError.message)
    }
  } catch (e) {
    console.error("[L11-License] failed to notify reviewers:", e)
  }

  console.log(`[L11-License] License ${params.licenseNumber} escalated to manual review: ${result.resultDetail}`)
}
