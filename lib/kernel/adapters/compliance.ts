import { evaluateOutbound } from "@/lib/kernel/compliance"
import type { ComplianceResult } from "@/lib/kernel/types"

type RawJourneyType = "buyer" | "seller" | "marketing"

export interface EvaluateKernelOutboundParams {
  actorContext: {
    userId: string
    role: any
    brokerageId: string
    teamId?: string
  }
  journeyType: RawJourneyType
  persona: string
  messageType: "email" | "sms" | "social" | "phone" | "in_app" | "ai" | "direct_mail"
  content: string
  contact: {
    id: string
    status?: string
    dnc_status?: boolean
    tcpa_consent?: boolean
    isa_reengage_allowed?: boolean
  }
}

function normalizeJourneyType(journeyType: RawJourneyType): "buyer" | "seller" {
  return journeyType === "marketing" ? "seller" : journeyType
}

export async function evaluateKernelOutbound(
  params: EvaluateKernelOutboundParams
): Promise<ComplianceResult> {
  return evaluateOutbound({
    actorContext: params.actorContext,
    journeyType: normalizeJourneyType(params.journeyType),
    persona: params.persona as any,
    messageType: params.messageType,
    content: params.content,
    contact: {
      id: params.contact.id,
      status: params.contact.status,
      dnc_status: params.contact.dnc_status ?? false,
      tcpa_consent: params.contact.tcpa_consent ?? true,
      isa_reengage_allowed: params.contact.isa_reengage_allowed ?? false,
    },
  })
}

export function isComplianceBlocked(result: ComplianceResult): boolean {
  return result.violations.length > 0
}

export function getComplianceReason(result: ComplianceResult): string | undefined {
  return result.violations[0]
}
