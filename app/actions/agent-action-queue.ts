"use server"

/**
 * Agent Action Queue — public reader.
 *
 * Single export getAgentActionQueue() returning the composed,
 * priority-ranked list. Disposition reuses Sprint 5's
 * dispositionPortalEventAction for portal_event source items; other
 * sources deep-link to their canonical resolution surface
 * (transactions / listings / CRM contact).
 */

import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { composeAgentActionQueue, type ComposedQueue } from "@/lib/agent-action-queue/composer"

export interface GetAgentActionQueueResult {
  success: boolean
  error?:  string
  queue?:  ComposedQueue
}

export async function getAgentActionQueue(params?: {
  limit?: number
}): Promise<GetAgentActionQueueResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // Resolve brokerage from users.user_type / brokerage_id (Sprint 1 pattern)
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) {
    return { success: false, error: "No brokerage on user" }
  }

  // Resolve agents.id from user.id (transactions/listings/contacts.agent_id
  // FKs target agents.id, not users.id — Sprint 6 e2e audit). The kernel
  // helper returns null when the caller has no agents row (broker / admin
  // / TC roles), in which case the deal-health source is skipped.
  const agentsId = await resolveAgentId(supabase, user.id)

  try {
    const queue = await composeAgentActionQueue(supabase, {
      agentUserId: user.id,
      agentsId,
      brokerageId: profile.brokerage_id as string,
      limit:       params?.limit ?? 12,
    })
    return { success: true, queue }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Compose failed" }
  }
}
