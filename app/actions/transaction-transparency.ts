"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function logTransactionDelay(params: {
  transactionId: string
  delays: string[]
  reasons: string[]
  impactDays: number
  notifyClient?: boolean
}) {
  const supabase = await createClient()
  const { brokerageId, agentId } = await getAgentContext()

  const { data, error } = await supabase
    .from("timeline_transparency")
    .upsert(
      {
        transaction_id: params.transactionId,
        brokerage_id: brokerageId,
        delays: params.delays,
        reason_for_delays: params.reasons,
        impact_on_closing: params.impactDays,
        communicated_to_client: params.notifyClient ?? false,
      },
      { onConflict: "transaction_id" },
    )
    .select()
    .single()

  if (error) return { success: false, error: error.message }

  if (params.notifyClient) {
    // The delay row is saved either way; only the client-facing update needs an
    // agent to sign it, and transparency_updates.agent_id will not take a null.
    if (!agentId) {
      return { success: true, delay: data, error: "Delay saved, but no agent profile on this account — the client was not notified." }
    }

    const { error: updateError } = await supabase
      .from("transparency_updates")
      .insert({
        transaction_id: params.transactionId,
        update_type: "delay_notice",
        message: `Your closing may be impacted by ${params.impactDays} day(s) due to: ${params.reasons.join(", ")}. Your agent is actively managing this.`,
        is_visible_to_client: true,
        agent_id: agentId,
      })
    if (updateError) {
      return { success: true, delay: data, error: `Delay saved, but the client notice failed: ${updateError.message}` }
    }

    void supabase
      .from("timeline_transparency")
      .update({ communicated_to_client: true })
      .eq("transaction_id", params.transactionId)
  }

  return { success: true, delay: data }
}

export async function getTransactionDelays(transactionId: string) {
  const supabase = await createClient()

  const [{ data: delays }, { data: updates }] = await Promise.all([
    supabase
      .from("timeline_transparency")
      .select("*")
      .eq("transaction_id", transactionId)
      .maybeSingle(),
    supabase
      .from("transparency_updates")
      .select("id, update_type, message, is_visible_to_client, created_at")
      .eq("transaction_id", transactionId)
      .order("created_at", { ascending: false })
      .limit(10),
  ])

  return { delays, updates: updates ?? [] }
}

/**
 * Mark a transaction's logged delays as having been communicated to the client.
 *
 * NOT a duplicate of the `void supabase…update(…)` inside `logTransactionDelay`
 * above, even though the write is the same: that one only fires when a delay is
 * being logged *and* `notifyClient` is set. This is the standalone case — the
 * agent phoned the client about a delay that was already on file. That is a real
 * distinct operation, so it is kept rather than folded in.
 *
 * 🚨 It had NO auth gate, NO tenant scope, and returned the raw PostgREST
 * response. `communicated_to_client` is a COMPLIANCE ASSERTION — the record of
 * whether the client was actually told their closing is slipping. An ungated
 * write keyed on nothing but `transaction_id` let that record be flipped to true
 * for any transaction, which is the one thing a transparency ledger must not
 * allow: it does not hide a delay, it manufactures proof that the delay was
 * disclosed.
 */
export async function markDelaysCommunicated(transactionId: string) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("timeline_transparency")
    .update({ communicated_to_client: true })
    .eq("transaction_id", transactionId)
    // Tenant anchor — logTransactionDelay always stamps brokerage_id on this row.
    .eq("brokerage_id", ctx.brokerageId)
    .select("transaction_id")

  if (error) return { success: false, error: error.message }
  // Zero rows means there is no delay record for this transaction in the caller's
  // brokerage. Claiming success would assert a disclosure against nothing.
  if (!data?.length) return { success: false, error: "No delay record found for this transaction" }

  return { success: true }
}
