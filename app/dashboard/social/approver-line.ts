// app/dashboard/social/approver-line.ts
//
// The WORDS for contract C5's answer on the social screens (wave 146, lane 146H — owner ruling 9: "the tenants
// approve their own ads/posts … assets"; brokerage approval only where tenant policy or a recorded legal
// requirement imposes it). The decision itself is lib/kernel/approval-authority.ts approverFor (lane 146E); this
// module only says it in the viewer's terms, so the Create Post dialog and the AI composer stop asserting
// "broker approval" when the hierarchy says the agent approves their own post.
//
// Pure: no I/O, no secrets, no ids rendered — only who, never which user id.

import type { ApproverDecision } from "@/lib/kernel/approval-authority"

/** One sentence naming who approves the viewer's post. A refusal is worded as a refusal (fail closed). */
export function describeApprover(decision: ApproverDecision, viewerUserId: string): string {
  if (!decision.ok) return `Who approves this post could not be determined (${decision.reason}) — it will wait for review.`
  if (decision.brokerageApprovalRequired) {
    const why = decision.basis === "legal_requirement"
      ? "a legal requirement your brokerage has recorded"
      : decision.basis === "policy_unreadable"
        ? "its approval policy could not be read, so review is required"
        : "your brokerage's approval policy"
    return `Your brokerage approves posts before they publish (${why}).`
  }
  if (decision.tier === "owner_agent" && decision.primaryUserIds.includes(viewerUserId)) {
    return "You approve your own posts. Your team lead and brokerage admins may also review them."
  }
  if (decision.tier === "team_lead") return decision.primaryUserIds.includes(viewerUserId) ? "You approve your team's posts as its team lead." : "Your team lead approves this post."
  if (decision.tier === "tenant_admin" || decision.tier === "tenant_principal") {
    return decision.primaryUserIds.includes(viewerUserId) ? "You approve this post as a brokerage admin." : "Your brokerage's admins approve this post."
  }
  return decision.reason
}
