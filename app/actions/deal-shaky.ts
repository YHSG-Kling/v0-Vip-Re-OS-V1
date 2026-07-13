"use server"

/**
 * app/actions/deal-shaky.ts — the "deal feels shaky" flag (concierge
 * micro-detail; l49-s01). The agent's gut overrides earned trust: while
 * flagged, the doc kernel SUSPENDS every autonomy grant for this file
 * (derived dates go back to human proposals) and the flag itself lands on
 * the ledger. Clearing it restores normal cadence. Tenant-gated.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function getDealShakyAction(input: { transactionId: string }): Promise<
  { ok: true; shaky: boolean } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: me } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const svc = createServiceClient()
  const { data: tx } = await svc.from("transactions")
    .select("deal_shaky, brokerage_id").eq("id", input.transactionId).maybeSingle()
  if (!tx || (tx as any).brokerage_id !== (me as any)?.brokerage_id) return { ok: false, error: "Transaction not found" }
  return { ok: true, shaky: !!(tx as any).deal_shaky }
}

export async function setDealShakyAction(input: {
  transactionId: string
  shaky: boolean
}): Promise<{ ok: true; shaky: boolean } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: me } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = (me as any)?.brokerage_id as string | null
  if (!brokerageId) return { ok: false, error: "No brokerage" }

  const svc = createServiceClient()
  const { data: tx } = await svc.from("transactions")
    .select("id, brokerage_id").eq("id", input.transactionId).maybeSingle()
  if (!tx || (tx as any).brokerage_id !== brokerageId) return { ok: false, error: "Transaction not found" }

  const { error } = await svc.from("transactions")
    .update({ deal_shaky: input.shaky }).eq("id", input.transactionId)
  if (error) return { ok: false, error: error.message }

  await svc.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type: "transaction",
    entity_id: input.transactionId,
    event_type: input.shaky ? "deal_marked_shaky" : "deal_shaky_cleared",
    actor_user_id: user.id,
    metadata: { by: user.id },
  }).then(() => {}, () => {})

  return { ok: true, shaky: input.shaky }
}
