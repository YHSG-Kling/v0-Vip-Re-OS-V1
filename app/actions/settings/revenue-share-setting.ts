"use server"

// Revenue-share opt-in setting — a broker toggles whether their brokerage offers agent-to-agent
// (downline) revenue share. When off, the commission waterfall's revenue-share step is skipped and the
// command-center revenue-share board is hidden. Broker/admin only.

import { createServiceClient } from "@/lib/supabase/service"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
// ★ ACT-AS WRITE SEAM ★ — the gate resolves the EFFECTIVE identity (the
// impersonated seat under act-as, never the raw staff row with its NULL
// brokerage). The finance predicate is unchanged and is evaluated on that
// impersonated identity; the setter additionally refuses read_only grants
// before the service-client write, which this gate alone protects.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"

async function resolveBrokerAdmin(
  mode: "read" | "write",
): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  const acting = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!acting.ok) return { ok: false, error: acting.error ?? "Unauthenticated" }
  if (!acting.brokerageId) return { ok: false, error: "No brokerage" }
  // A solo agent runs their own one-person shop, so they control their own revenue-share offering too —
  // allow the solo-tier owner in addition to broker/admin roles.
  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("plan_tier").eq("id", acting.brokerageId).maybeSingle()
  const isSolo = (brk as any)?.plan_tier === "solo_agent"
  // BROKERAGE-WIDE MONEY (m472). The ONE finance roster — the same set
  // public.is_brokerage_finance_admin() carries — so the app cannot admit where
  // RLS refuses. It EXCLUDES team_lead by the owner's ruling, and it ADDS
  // broker_owner, which the local literal omitted: the person who OWNS the
  // brokerage was refused by the gate guarding their own brokerage's setting.
  // Evaluated on the IMPERSONATED identity's user_type when acting-as.
  if (!isSolo && !isBrokerageFinanceAdmin({ user_type: acting.userType })) {
    return { ok: false, error: "Only a broker or admin can change this setting" }
  }
  return { ok: true, brokerageId: acting.brokerageId }
}

export async function getRevenueShareSetting(): Promise<{ ok: boolean; enabled: boolean; error?: string }> {
  const ctx = await resolveBrokerAdmin("read")
  if (!ctx.ok) return { ok: false, enabled: false, error: ctx.error }
  const svc = createServiceClient()
  const { data } = await svc.from("brokerages").select("revenue_share_enabled").eq("id", ctx.brokerageId).maybeSingle()
  return { ok: true, enabled: !!(data as any)?.revenue_share_enabled }
}

export async function setRevenueShareEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  // "write": read_only impersonation is refused inside the gate.
  const ctx = await resolveBrokerAdmin("write")
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const svc = createServiceClient()
  const { error } = await svc.from("brokerages").update({ revenue_share_enabled: enabled }).eq("id", ctx.brokerageId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
