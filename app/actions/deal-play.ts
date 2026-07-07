"use server"

// app/actions/deal-play.ts — the on-demand trigger for the Deal Play (the AI
// team working one listing visibly; lib/kernel/deal-play.ts). Caller must be an
// authenticated member of the listing's brokerage; everything staged is gated.

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { runDealPlay, type DealPlayResult } from "@/lib/kernel/deal-play"

export async function runDealPlayAction(listingId: string): Promise<DealPlayResult> {
  const zero = { reels: 0, channelsStaged: 0, openHousesProposed: 0, adsStaged: 0, handoffs: 0 }
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, reason: "Unauthorized", ...zero }
  const svc = createServiceClient()
  return runDealPlay(ctx.brokerageId, listingId, svc)
}
