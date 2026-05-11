/**
 * Wizard-staging core — same packet-staging logic used by:
 *   - app/actions/wizard-staging.ts        (auth-resolved server action, called
 *                                            from /api/internal/ai-chat tools)
 *   - app/api/agent-assistant/tool-call    (ElevenLabs webhook — uses
 *                                            session.user_id + session.brokerage_id)
 *
 * The webhook is unauthenticated by design (ElevenLabs calls us with a shared
 * secret + session conversation id), so it can't use resolveWriteContext().
 * Both callers funnel through here with explicit brokerageId + userId.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type WizardPacketMode = "listing" | "offer"

export interface ListingIntake {
  address?: string
  city?: string
  state?: string
  zip?: string
  listPrice?: number
  sellerName?: string
  propertyType?: string
  notes?: string
}

export interface OfferIntake {
  contactId: string
  address?: string
  city?: string
  state?: string
  zip?: string
  offerPrice?: number
  financingType?: string
  earnestMoney?: number
  closingDate?: string
  notes?: string
}

export interface StagePacketCoreParams {
  brokerageId: string
  userId: string
  mode: WizardPacketMode
  intake: ListingIntake | OfferIntake
}

export interface StagePacketResult {
  success: boolean
  documentId?: string
  openUrl?: string
  error?: string
}

export async function stagePacketCore(
  params: StagePacketCoreParams,
): Promise<StagePacketResult> {
  const svc = createServiceClient()

  const documentType = params.mode === "listing" ? "listing_agreement" : "offer"
  const intakeJson = packIntakeForFormWizard(params)
  const agentMustComplete = computeAgentMustComplete(params)
  const stateCode = (params.intake.state ?? "").toUpperCase().slice(0, 2) || null

  const content = JSON.stringify({
    intake: intakeJson,
    filledPacket: {
      agentMustComplete,
      audit: {
        high_confidence_count: countConfidence(params, "high"),
        medium_confidence_count: countConfidence(params, "medium"),
        low_confidence_count: 0,
      },
    },
  })

  const metadata = {
    source: "voice_or_copilot_staging",
    staged_at: new Date().toISOString(),
    staged_by_user_id: params.userId,
    agent_must_complete: agentMustComplete,
    prefilled: intakeJson,
    findings: buildFindings(params),
  }

  const contactId = params.mode === "offer" ? (params.intake as OfferIntake).contactId : null

  const { data, error } = await svc
    .from("documents")
    .insert({
      brokerage_id: params.brokerageId,
      contact_id: contactId,
      document_type: documentType,
      status: "needs_agent_input",
      content,
      state_code: stateCode,
      metadata,
    })
    .select("id")
    .maybeSingle()

  if (error || !data) {
    return { success: false, error: error?.message ?? "Failed to stage packet" }
  }

  const openUrl =
    params.mode === "listing"
      ? `/dashboard/listings?packet=${data.id}`
      : `/contacts/${(params.intake as OfferIntake).contactId}/offers/new?packet=${data.id}`

  return { success: true, documentId: data.id, openUrl }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function packIntakeForFormWizard(
  params: StagePacketCoreParams,
): Record<string, { value: string }> {
  const wrap = (v: unknown): { value: string } => ({
    value: v == null ? "" : String(v),
  })

  if (params.mode === "listing") {
    const i = params.intake as ListingIntake
    return {
      propertyAddress: wrap(i.address),
      propertyCity: wrap(i.city),
      propertyState: wrap(i.state),
      propertyZip: wrap(i.zip),
      listPrice: wrap(i.listPrice),
      sellerName: wrap(i.sellerName),
      propertyType: wrap(i.propertyType),
      notes: wrap(i.notes),
    }
  }

  const i = params.intake as OfferIntake
  return {
    propertyAddress: wrap(i.address),
    propertyCity: wrap(i.city),
    propertyState: wrap(i.state),
    propertyZip: wrap(i.zip),
    offerPrice: wrap(i.offerPrice),
    financingType: wrap(i.financingType),
    earnestMoney: wrap(i.earnestMoney),
    closingDate: wrap(i.closingDate),
    notes: wrap(i.notes),
  }
}

function computeAgentMustComplete(params: StagePacketCoreParams): string[] {
  const missing: string[] = []
  if (!params.intake.address) missing.push("Property address")
  if (!params.intake.city) missing.push("City")
  if (!params.intake.state) missing.push("State")
  if (!params.intake.zip) missing.push("ZIP code")
  if (params.mode === "listing") {
    const i = params.intake as ListingIntake
    if (!i.listPrice) missing.push("List price")
    if (!i.sellerName) missing.push("Seller name(s)")
  } else {
    const i = params.intake as OfferIntake
    if (!i.offerPrice) missing.push("Offer price")
    if (!i.financingType) missing.push("Financing type")
  }
  return missing
}

function countConfidence(
  params: StagePacketCoreParams,
  level: "high" | "medium",
): number {
  let high = 0
  let med = 0
  if (params.intake.address) high++
  if (params.intake.city) high++
  if (params.intake.state) high++
  if (params.intake.zip) high++
  if (params.mode === "listing") {
    const i = params.intake as ListingIntake
    if (i.listPrice) med++
    if (i.sellerName) med++
  } else {
    const i = params.intake as OfferIntake
    if (i.offerPrice) med++
    if (i.earnestMoney) med++
  }
  return level === "high" ? high : med
}

function buildFindings(
  params: StagePacketCoreParams,
): Array<{ severity: "info" | "warning" | "blocker"; title: string; detail: string }> {
  const findings: Array<{ severity: "info" | "warning" | "blocker"; title: string; detail: string }> = [
    {
      severity: "info",
      title: "Staged from voice / copilot",
      detail:
        "This packet was pre-filled from your spoken or typed request. Review every field before sending for signature.",
    },
  ]
  if (params.mode === "listing" && !(params.intake as ListingIntake).listPrice) {
    findings.push({
      severity: "warning",
      title: "Missing list price",
      detail: "Add the list price before submitting to MLS.",
    })
  }
  if (params.mode === "offer" && !(params.intake as OfferIntake).offerPrice) {
    findings.push({
      severity: "warning",
      title: "Missing offer price",
      detail: "Add the offer amount before generating signing packet.",
    })
  }
  return findings
}
