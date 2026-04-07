import type { ActorContext, ActorRole } from "@/lib/kernel/types"

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

export function buildActorContext(input: {
  userId: string
  brokerageId: string
  role?: string
  teamId?: string
}): ActorContext {
  const role = VALID_ROLES.includes(input.role as ActorRole)
    ? (input.role as ActorRole)
    : "agent"

  return {
    userId: input.userId,
    brokerageId: input.brokerageId,
    role,
    teamId: input.teamId,
  }
}
