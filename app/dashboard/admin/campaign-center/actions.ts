"use server"
import { approveCampaignItem, approveCampaignPlay, type CampaignChannel } from "@/lib/kernel/campaign-center"
import { revalidatePath } from "next/cache"
import { authTenantAdminBrokerage as authBrokerage } from "@/lib/auth/require-caller"

// TOMBSTONE: local authBrokerage merged onto lib/auth/require-caller.ts
// authTenantAdminBrokerage (imported above as `authBrokerage`) — §1/§6 SAME
// BODY census round 3, 2026-09-09.

export async function approveCampaignItemAction(channel: CampaignChannel, id: string): Promise<{ ok: boolean; note?: string }> {
  const ctx = await authBrokerage()
  if (!ctx) return { ok: false, note: "Not authorized." }
  const r = await approveCampaignItem(ctx.brokerageId, channel, id, ctx.userId)
  revalidatePath("/dashboard/admin/campaign-center")
  return r
}

export async function approveCampaignPlayAction(play: string): Promise<{ approved: number; needsAttention: number }> {
  const ctx = await authBrokerage()
  if (!ctx) return { approved: 0, needsAttention: 0 }
  const r = await approveCampaignPlay(ctx.brokerageId, play, ctx.userId)
  revalidatePath("/dashboard/admin/campaign-center")
  return r
}
