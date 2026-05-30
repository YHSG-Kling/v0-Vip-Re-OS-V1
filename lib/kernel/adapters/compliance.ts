import { evaluateOutbound } from "@/lib/kernel/compliance"
import type {
  ActorRole,
  ComplianceResult,
  JourneyType,
  KernelContact,
  MessageType,
  Persona,
} from "@/lib/kernel/types"

type LegacyJourneyType = "buyer" | "seller" | "marketing"

export interface EvaluateKernelOutboundParams {
  actorContext: {
    userId: string
    role?: string
    brokerageId: string
    teamId?: string
  }
  journeyType?: LegacyJourneyType
  persona?: string
  messageType?: string
  content: string
  contact?: Partial<KernelContact> & {
    id?: string
    status?: string
    dnc_status?: boolean
    tcpa_consent?: boolean
    isa_reengage_allowed?: boolean
  }
}

const VALID_ROLES: ActorRole[] = [
  "superadmin",
  "broker",
  "admin",
  "team_lead",
  "agent",
  "isa",
  "tc",
  "compliance_officer",
  "vendor",
  "lender",
  "title_agent",
  "contact",
  "system",
]

const VALID_MESSAGE_TYPES: MessageType[] = [
  "email",
  "sms",
  "social",
  "phone",
  "in_app",
  "ai",
  "direct_mail",
]

const VALID_PERSONAS: Persona[] = [
  "first_time",
  "relocated",
  "luxury",
  "fsbo",
  "probate",
  "upsize",
  "downsize",
  "military",
  "divorce",
  "senior",
  "expired",
  "foreclosure",
  "other",
]

function normalizeRole(role?: string): ActorRole {
  return VALID_ROLES.includes(role as ActorRole) ? (role as ActorRole) : "agent"
}

function normalizeJourneyType(journeyType?: LegacyJourneyType): JourneyType {
  if (!journeyType) return "buyer"
  return journeyType === "marketing" ? "seller" : journeyType
}

function normalizeMessageType(messageType?: string): MessageType {
  return VALID_MESSAGE_TYPES.includes(messageType as MessageType)
    ? (messageType as MessageType)
    : "email"
}

function normalizePersona(persona?: string): Persona {
  return VALID_PERSONAS.includes(persona as Persona) ? (persona as Persona) : "other"
}

function normalizeContact(contact?: EvaluateKernelOutboundParams["contact"]): KernelContact {
  return {
    id: contact?.id ?? "",
    first_name: contact?.first_name ?? "",
    last_name: contact?.last_name ?? "",
    email: contact?.email,
    phone: contact?.phone,
    contact_type: contact?.contact_type ?? "buyer",
    persona: normalizePersona(contact?.persona),
    buyer_stage: contact?.buyer_stage,
    lifecycle_state: contact?.lifecycle_state,
    status: contact?.status,
    tcpa_consent: contact?.tcpa_consent ?? true,
    tcpa_consent_date: contact?.tcpa_consent_date,
    tcpa_marked_by: contact?.tcpa_marked_by,
    tcpa_marked_at: contact?.tcpa_marked_at,
    isa_reengage_allowed: contact?.isa_reengage_allowed ?? false,
    isa_reengage_set_at: contact?.isa_reengage_set_at,
    isa_reengage_marked_by: contact?.isa_reengage_marked_by,
    dnc_status: contact?.dnc_status ?? false,
    stop_comment: contact?.stop_comment,
    stop_contact_date: contact?.stop_contact_date,
    stop_contact_by: contact?.stop_contact_by,
    brokerage_id: contact?.brokerage_id,
    team_id: contact?.team_id,
    agent_id: contact?.agent_id,
  }
}

export async function evaluateKernelOutbound(
  params: EvaluateKernelOutboundParams
): Promise<ComplianceResult> {
  return evaluateOutbound({
    actorContext: {
      userId: params.actorContext.userId,
      role: normalizeRole(params.actorContext.role),
      brokerageId: params.actorContext.brokerageId,
      teamId: params.actorContext.teamId,
    },
    journeyType: normalizeJourneyType(params.journeyType),
    persona: normalizePersona(params.persona),
    messageType: normalizeMessageType(params.messageType),
    content: params.content,
    contact: normalizeContact(params.contact),
  })
}

export function isComplianceBlocked(result: ComplianceResult): boolean {
  return !result.allowed
}

export function getComplianceReason(result: ComplianceResult): string | undefined {
  return result.blockedReason ?? result.violations[0]
}
