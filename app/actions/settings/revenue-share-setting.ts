"use server"

// Revenue-share opt-in setting — a broker toggles whether their brokerage offers agent-to-agent
// (downline) revenue share. When off, the commission waterfall's revenue-share step is skipped and the
// command-center revenue-share board is hidden. Broker/admin only.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

async function resolveBrokerAdmin(): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: profile } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return { ok: false, error: "No brokerage" }
  if (!["broker", "broker_admin", "admin", "superadmin"].includes(profile.user_type ?? "")) {
    return { ok: false, error: "Only a broker or admin can change this setting" }
  }
  return { ok: true, brokerageId: profile.brokerage_id }
}

export async function getRevenueShareSetting(): Promise<{ ok: boolean; enabled: boolean; error?: string }> {
  const ctx = await resolveBrokerAdmin()
  if (!ctx.ok) return { ok: false, enabled: false, error: ctx.error }
  const svc = createServiceClient()
  const { data } = await svc.from("brokerages").select("revenue_share_enabled").eq("id", ctx.brokerageId).maybeSingle()
  return { ok: true, enabled: !!(data as any)?.revenue_share_enabled }
}

export async function setRevenueShareEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveBrokerAdmin()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const svc = createServiceClient()
  const { error } = await svc.from("brokerages").update({ revenue_share_enabled: enabled }).eq("id", ctx.brokerageId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
