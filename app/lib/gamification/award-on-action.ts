"use server"

import { addPoints } from "@/app/actions/gamification"
import { createClient } from "@/lib/supabase/server"
import type { PointReason } from "@/lib/gamification/award-points"

// Maps the spec's action keys to the canonical POINT_VALUES keys
// (lib/gamification/award-points.ts). addPoints routes through the atomic
// award RPC and then checks badges, so no separate awardBadge call is needed.
//
// FIVE OF THESE USED TO POINT AT "ONBOARDING_STEP_COMPLETED" — a completed
// showing, a follow-up, a social post, a training and an open house were all
// booked as onboarding steps worth 10 points, because those were the only keys
// that existed. The ledger's `reason` column is the audit trail for why an agent
// has the points they have, and it read "ONBOARDING_STEP_COMPLETED" for work that
// had nothing to do with onboarding. Each now has its own key and its own value.
const ACTION_MAP: Record<string, PointReason> = {
  showing_completed:  "SHOWING_COMPLETED",
  offer_submitted:    "OFFER_SUBMITTED",
  deal_closed:        "LISTING_CLOSED",
  referral_received:  "REFERRAL_CREATED",
  review_received:    "VENDOR_REVIEW_WRITTEN",
  followup_completed: "FOLLOWUP_SENT",
  social_posted:      "SOCIAL_POST_PUBLISHED",
  training_completed: "TRAINING_COMPLETED",
  open_house_hosted:  "OPEN_HOUSE_HOSTED",
} as const

/**
 * RESOLVE, NEVER SUBSTITUTE. Two of the five live call sites hand this function a
 * `users.id`, not an `agents.id`: app/components/dashboard/listings/showings/
 * confirmed-showings-list.tsx:111 and app/crm/contacts/[contactId]/offers/components/
 * offer-initiation-flow.tsx:967 both pass their `agentUserId` prop. agents.id and
 * users.id are DISJOINT id spaces, so a completed showing and a submitted offer —
 * two of the actions the Motivation page advertises points for — have never awarded
 * a single point; the read they triggered simply found no agents row.
 *
 * This looks the id up in both places and takes whichever one it IS. It never
 * assumes: the agents.id lookup is tried first, and the users.id lookup only when
 * that finds nothing, so the two spaces are never conflated. The same idiom already
 * exists at app/actions/agents.ts:getAgentStats. RLS confines both reads to the
 * caller's own brokerage.
 */
async function resolveAgentId(id: string): Promise<string | null> {
  const supabase = await createClient()

  const { data: byAgentId, error: agentErr } = await supabase
    .from("agents").select("id").eq("id", id).maybeSingle()
  if (agentErr) {
    console.error(`[awardPointsForAction] could not look up agent ${id}: ${agentErr.message}`)
    return null
  }
  if (byAgentId?.id) return byAgentId.id

  const { data: byUserId, error: userErr } = await supabase
    .from("agents").select("id").eq("user_id", id).maybeSingle()
  if (userErr) {
    console.error(`[awardPointsForAction] could not look up the agent record for user ${id}: ${userErr.message}`)
    return null
  }
  return byUserId?.id ?? null
}

/**
 * Fire-and-forget gamification hook.
 * Call with .catch(()=>{}) — never awaited on the hot path.
 *
 * @param agentOrUserId  The acting agent's agents.id, or the users.id it hangs off
 * @param actionKey  One of the action keys defined above
 */
export async function awardPointsForAction(
  agentOrUserId: string,
  actionKey: keyof typeof ACTION_MAP,
): Promise<void> {
  if (!agentOrUserId) return
  const pointType = ACTION_MAP[actionKey]
  if (!pointType) return

  const agentId = await resolveAgentId(agentOrUserId)
  if (!agentId) {
    console.error(`[awardPointsForAction] ${actionKey} earned no points: ${agentOrUserId} is neither an agents.id nor a user with an agent record`)
    return
  }

  const result = await addPoints(agentId, pointType)
  if (!result.ok) {
    // Fire-and-forget is not the same as silent: the award is not retried, but a
    // refusal that leaves an agent's points short is written down.
    console.error(`[awardPointsForAction] ${actionKey} earned no points for agent ${agentId}: ${result.error}`)
  }
}
