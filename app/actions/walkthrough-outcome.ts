"use server"

/**
 * app/actions/walkthrough-outcome.ts — the walkthrough-outcome flow
 * (forgotten-items #38): three buttons on the deal file, three different
 * processes. Tenant-gated; assignee NOT-NULL contract honored (deal's
 * agent → caller's agents row → honest refusal); client line addressed
 * via the addressing memory.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAddressing } from "@/lib/kernel/addressing"
import { recordWalkthroughOutcome, type WalkthroughOutcome } from "@/lib/transactions/walkthrough-outcome"

export async function setWalkthroughOutcomeAction(input: {
  transactionId: string
  outcome: WalkthroughOutcome
}): Promise<{ ok: true; tasksCreated: number; flaggedShaky: boolean } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: me } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = (me as any)?.brokerage_id as string | null
  if (!brokerageId) return { ok: false, error: "No brokerage" }

  const svc = createServiceClient()
  const { data: tx } = await svc.from("transactions")
    .select("id, brokerage_id, agent_id, buyer_contact_id, contact_id")
    .eq("id", input.transactionId).maybeSingle()
  if (!tx || (tx as any).brokerage_id !== brokerageId) return { ok: false, error: "Transaction not found" }

  let assigneeAgentId = (tx as any).agent_id as string | null
  if (!assigneeAgentId) {
    const { data: mine } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
    assigneeAgentId = (mine as any)?.id ?? null
  }
  if (!assigneeAgentId) return { ok: false, error: "No agent to assign the follow-up to" }

  let addressAs = "there"
  const contactId = (tx as any).buyer_contact_id ?? (tx as any).contact_id
  if (contactId) {
    const { data: c } = await svc.from("contacts")
      .select("first_name, last_name, preferred_name, salutation_style").eq("id", contactId).maybeSingle()
    if (c) addressAs = resolveAddressing({
      firstName: (c as any).first_name, lastName: (c as any).last_name,
      preferredName: (c as any).preferred_name, namePronunciation: null,
      salutationStyle: (c as any).salutation_style,
    }).addressAs
  }

  const r = await recordWalkthroughOutcome(svc, {
    transactionId: input.transactionId, brokerageId,
    outcome: input.outcome, actorUserId: user.id, addressAs, assigneeAgentId,
  })
  return { ok: true, ...r }
}
