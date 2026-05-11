"use server"

/**
 * Wizard Staging — voice entry point. Called from the ElevenLabs tool-call
 * webhook at /api/agent-assistant/tool-call (which is unauthenticated by
 * design — auth is via shared secret + conversation session attribution).
 *
 * Same logic as app/actions/wizard-staging.ts but takes brokerageId + userId
 * explicitly because there's no Supabase auth cookie on the webhook request.
 */

import {
  stagePacketCore,
  type ListingIntake,
  type OfferIntake,
  type StagePacketResult,
  type WizardPacketMode,
} from "@/lib/wizard-staging/core"

export interface StageWizardPacketAsAgentParams {
  brokerageId: string
  userId: string
  mode: WizardPacketMode
  intake: ListingIntake | OfferIntake
}

export async function stageWizardPacketAsAgent(
  params: StageWizardPacketAsAgentParams,
): Promise<StagePacketResult> {
  return stagePacketCore({
    brokerageId: params.brokerageId,
    userId: params.userId,
    mode: params.mode,
    intake: params.intake,
  })
}
