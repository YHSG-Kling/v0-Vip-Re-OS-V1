import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import type { BrandVoiceResult } from "@/lib/kernel/brand-voice"

type RawJourneyType = "buyer" | "seller" | "marketing"

export interface ApplyKernelBrandVoiceParams {
  brokerageId: string
  teamId?: string
  actorUserId?: string
  actorRole: string
  journeyType: RawJourneyType
  persona: string
  messageType: string
  content: string
}

function normalizeJourneyType(journeyType: RawJourneyType): "buyer" | "seller" {
  return journeyType === "marketing" ? "seller" : journeyType
}

export async function applyKernelBrandVoice(
  params: ApplyKernelBrandVoiceParams
): Promise<BrandVoiceResult> {
  return applyBrandVoice({
    brokerageId: params.brokerageId,
    teamId: params.teamId,
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    journeyType: normalizeJourneyType(params.journeyType),
    persona: params.persona,
    messageType: params.messageType,
    content: params.content,
  })
}

export function isBrandVoiceBlocked(result: BrandVoiceResult): boolean {
  return result.violations.length > 0
}
