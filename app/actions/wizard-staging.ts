"use server"

/**
 * Wizard Staging server action — auth-resolved entry point used by the typed
 * AI Copilot (/api/internal/ai-chat tools `stage_listing_packet` /
 * `stage_offer_packet`).
 *
 * The actual packet shaping + insert lives in lib/wizard-staging/core.ts so
 * the ElevenLabs voice webhook (which has session-scoped context, not auth)
 * can share the exact same logic via stageWizardPacketAsAgent.
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import {
  stagePacketCore,
  type ListingIntake,
  type OfferIntake,
  type StagePacketResult,
} from "@/lib/wizard-staging/core"

export type {
  ListingIntake,
  OfferIntake,
  StagePacketResult as StageWizardPacketResult,
} from "@/lib/wizard-staging/core"

interface StageListingParams {
  mode: "listing"
  intake: ListingIntake
}

interface StageOfferParams {
  mode: "offer"
  intake: OfferIntake
}

export async function stageWizardPacket(
  params: StageListingParams | StageOfferParams,
): Promise<StagePacketResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }

  return stagePacketCore({
    brokerageId: ctx.brokerageId,
    userId: ctx.userId,
    mode: params.mode,
    intake: params.intake,
  })
}
