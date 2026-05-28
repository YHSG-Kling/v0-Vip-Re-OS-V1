/**
 * User-type Brief — orchestrator.
 *
 * Single entry point that routes to the right per-user_type generator and
 * returns a uniform `UserTypeBrief` shape. The TodaysFocusCard component
 * consumes this with no per-user_type branching.
 *
 * Caching: each generator caches per-day in `ai_daily_briefings` keyed by
 * (agent_id, briefing_date). The `agent_id` column in that table is
 * legacy-named — we use it as the user_id key for ALL user_types.
 */

import type { UserTypeBrief } from "./types"
import { generateBrokerBrief } from "./broker"
import { generateTeamLeadBrief, isTeamLead } from "./team-lead"
import {
  generateTcBrief,
  generateComplianceBrief,
  generateLenderBrief,
  generateVendorBrief,
} from "./tc-compliance-lender-vendor"

export type { UserTypeBrief, BriefPriority, BriefMetric, Severity } from "./types"
export { isTeamLead } from "./team-lead"

interface GenerateBriefInput {
  userType: string
  userId: string
  brokerageId: string | null
  forceRegenerate?: boolean
}

export async function generateUserTypeBrief(input: GenerateBriefInput): Promise<UserTypeBrief> {
  const { userType, userId, brokerageId, forceRegenerate } = input

  // Agents use the existing daily-briefing-generator (richer agent-specific
  // logic). The new generators here cover the remaining staff user_types.
  // Team leads (agents who lead a team) get an extended brief with team data.
  switch (userType) {
    case "agent": {
      // If this agent leads a team, swap in the team-lead brief (agent
      // signals + team-level pipeline + member coaching cues)
      if (brokerageId && (await isTeamLead(userId, brokerageId))) {
        return generateTeamLeadBrief({ userId, brokerageId, forceRegenerate })
      }

      // Reuse existing rich agent generator — wraps in the new shape
      const { generateDailyBriefing } = await import("@/lib/intelligence/daily-briefing-generator")
      const agent = await generateDailyBriefing(userId, brokerageId ?? "", forceRegenerate ?? false)
      return {
        userId: agent.agent_id,
        userType: "agent",
        brokerageId: agent.brokerage_id,
        briefingDate: agent.briefing_date,
        summary: agent.summary,
        priorities: (agent.top_priority_actions ?? []).map((p, i) => ({
          id: `agent-priority-${i}`,
          title: p.action,
          body: p.context,
          severity:
            p.priority === "high" ? "high" : p.priority === "medium" ? "medium" : "low",
          ctas: buildAgentPriorityCtas(p),
        })),
        metrics: [
          { label: "Hot leads", value: agent.hot_leads?.length ?? 0, href: "/crm?filter=hot" },
          { label: "Deals at risk", value: agent.deals_at_risk?.length ?? 0, href: "/dashboard/transactions?risk=high" },
          { label: "Tasks overdue", value: agent.tasks_overdue ?? 0, href: "/dashboard/overdue" },
        ],
        generatedAt: agent.generated_at,
      }
    }

    case "broker":
    case "broker_admin":
    case "admin":
      if (!brokerageId) {
        return emptyBrief(userId, userType, brokerageId)
      }
      return generateBrokerBrief({ userId, brokerageId, forceRegenerate })

    case "tc":
    case "TC":
    case "transaction_coordinator":
      if (!brokerageId) return emptyBrief(userId, userType, brokerageId)
      return generateTcBrief({ userId, brokerageId, forceRegenerate })

    case "compliance_officer":
      if (!brokerageId) return emptyBrief(userId, userType, brokerageId)
      return generateComplianceBrief({ userId, brokerageId, forceRegenerate })

    case "lender":
      if (!brokerageId) return emptyBrief(userId, userType, brokerageId)
      return generateLenderBrief({ userId, brokerageId, forceRegenerate })

    case "vendor":
      if (!brokerageId) return emptyBrief(userId, userType, brokerageId)
      return generateVendorBrief({ userId, brokerageId, forceRegenerate })

    case "contact":
      // Contact briefs are persona-specific (buyer / seller / lifetime) and
      // surface in the contact portal, not the staff dashboard. Return an
      // empty brief here; portal-side renders the persona dashboard directly.
      return emptyBrief(userId, "contact", brokerageId)

    default:
      return emptyBrief(userId, userType, brokerageId)
  }
}

function emptyBrief(userId: string, userType: string, brokerageId: string | null): UserTypeBrief {
  return {
    userId,
    userType,
    brokerageId,
    briefingDate: new Date().toISOString().slice(0, 10),
    summary: "",
    priorities: [],
    metrics: [],
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Translate AI-emitted priority entity refs into CTAs the agent can click.
 * Each CTA carries either an `href` (Link navigation) or a deep-link with
 * `?action=…` query so the destination page knows which sheet to open.
 */
function buildAgentPriorityCtas(p: {
  entity_type?: string | null
  entity_id?: string | null
  action_type?: string | null
}) {
  if (!p.entity_id || !p.entity_type) return []

  const id = p.entity_id
  switch (p.action_type) {
    case "draft_followup":
      return [
        { label: "Draft message", href: `/crm?contact=${id}&action=draft_followup` },
        { label: "Open contact", href: `/crm?contact=${id}` },
      ]
    case "schedule_appointment":
      return [
        { label: "Schedule", href: `/crm?contact=${id}&action=schedule_appointment` },
        { label: "Open contact", href: `/crm?contact=${id}` },
      ]
    case "open_contact":
      return [{ label: "Open contact", href: `/crm?contact=${id}` }]
    case "view_lead":
      return [{ label: "View lead", href: `/leads/${id}` }]
    case "view_transaction":
      return [{ label: "Open transaction", href: `/dashboard/transactions/${id}` }]
    case "view_listing":
      return [{ label: "Open listing", href: `/dashboard/listings/${id}` }]
    case "complete_task":
      return [{ label: "Complete task", href: `/dashboard/tasks/${id}` }]
    default:
      // Fallback by entity type when AI didn't pick action_type
      if (p.entity_type === "contact") return [{ label: "Open contact", href: `/crm?contact=${id}` }]
      if (p.entity_type === "transaction") return [{ label: "Open transaction", href: `/dashboard/transactions/${id}` }]
      if (p.entity_type === "listing") return [{ label: "Open listing", href: `/dashboard/listings/${id}` }]
      return []
  }
}
