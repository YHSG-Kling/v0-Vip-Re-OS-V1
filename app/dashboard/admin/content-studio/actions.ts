"use server"
import { createClient } from "@/lib/supabase/server"
import { approveContentItem } from "@/lib/kernel/content-studio"
import { revalidatePath } from "next/cache"

async function authBrokerage(): Promise<{ brokerageId: string; userId: string } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id || !["admin", "broker", "broker_admin", "superadmin", "team_lead"].includes(u.user_type ?? "")) return null
  return { brokerageId: u.brokerage_id, userId: user.id }
}

export async function approveContentItemAction(id: string): Promise<{ ok: boolean; note?: string }> {
  const ctx = await authBrokerage()
  if (!ctx) return { ok: false, note: "Not authorized." }
  const r = await approveContentItem(ctx.brokerageId, id, ctx.userId)
  revalidatePath("/dashboard/admin/content-studio")
  return r
}
