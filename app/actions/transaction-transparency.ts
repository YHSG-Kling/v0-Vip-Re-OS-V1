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
  const { brokerageId, userId } = await getAgentContext()

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
    await supabase
      .from("transparency_updates")
      .insert({
        transaction_id: params.transactionId,
        update_type: "delay_notice",
        message: `Your closing may be impacted by ${params.impactDays} day(s) due to: ${params.reasons.join(", ")}. Your agent is actively managing this.`,
        is_visible_to_client: true,
        agent_id: userId,
      })
      .catch(() => {})

    await supabase
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

export async function markDelaysCommunicated(transactionId: string) {
  const supabase = await createClient()
  return supabase
    .from("timeline_transparency")
    .update({ communicated_to_client: true })
    .eq("transaction_id", transactionId)
}
