"use server"
import { createClient } from "@/lib/supabase/server"
import { approveCampaignItem, approveCampaignPlay, type CampaignChannel } from "@/lib/kernel/campaign-center"
import { revalidatePath } from "next/cache"

async function authBrokerage(): Promise<{ brokerageId: string; userId: string } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id || !["admin", "broker", "superadmin"].includes(u.user_type ?? "")) return null
  return { brokerageId: u.brokerage_id, userId: user.id }
}

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
