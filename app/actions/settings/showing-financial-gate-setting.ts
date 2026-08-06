"use server"

/**
 * app/actions/settings/showing-financial-gate-setting.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUYER FINANCIAL GATE, as a tenant choice (m377).
 *
 * OWNER RULING: "the gate should be included as a setting choice from the tenant
 * if they want to block the financial verification before setting or scheduling
 * a showing."
 *
 * enforceFinancialGate() has always been complete and was enforced nowhere. This
 * setting is what turns it on, per brokerage. It writes exactly one column,
 * brokerages.require_financial_verification_for_showings, which is read on the
 * booking paths by lib/buyer-execution/showing-financial-policy.
 *
 * The default is false and stays false until a human here changes it, because
 * flipping it on is a material live change: buyers who could book a showing a
 * minute ago cannot book one now. That decision belongs to the broker, not to a
 * migration and not to us — which is also why this action is role-gated rather
 * than merely brokerage-scoped. Brokerage scope alone would let any agent set
 * their whole firm's showing policy.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

async function resolveBrokerAdmin(): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) return { ok: false, error: profileError.message }
  if (!profile?.brokerage_id) return { ok: false, error: "No brokerage" }

  // A solo agent IS their own brokerage, so they set their own showing policy —
  // same carve-out the revenue-share setting makes, for the same reason.
  const svc = createServiceClient()
  const { data: brk, error: brkError } = await svc
    .from("brokerages")
    .select("plan_tier")
    .eq("id", profile.brokerage_id)
    .maybeSingle()
  if (brkError) return { ok: false, error: brkError.message }

  const isSolo = (brk as { plan_tier?: string } | null)?.plan_tier === "solo_agent"
  if (!isSolo && !["broker", "broker_admin", "admin", "superadmin"].includes(profile.user_type ?? "")) {
    return { ok: false, error: "Only a broker or admin can change how showings are gated." }
  }
  return { ok: true, brokerageId: profile.brokerage_id }
}

export async function getShowingFinancialGateSetting(): Promise<{
  ok: boolean
  required: boolean
  error?: string
}> {
  const ctx = await resolveBrokerAdmin()
  if (!ctx.ok) return { ok: false, required: false, error: ctx.error }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("brokerages")
    .select("require_financial_verification_for_showings")
    .eq("id", ctx.brokerageId)
    .maybeSingle()

  // Read, never discarded — supabase-js resolves a rejected read, so swallowing
  // this would render a failed load as a confident "off".
  if (error) return { ok: false, required: false, error: error.message }

  return {
    ok: true,
    required:
      (data as { require_financial_verification_for_showings?: boolean } | null)
        ?.require_financial_verification_for_showings === true,
  }
}

export async function setShowingFinancialGateRequired(
  required: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveBrokerAdmin()
  if (!ctx.ok) return { ok: false, error: ctx.error }

  const svc = createServiceClient()
  const { error } = await svc
    .from("brokerages")
    .update({
      require_financial_verification_for_showings: required,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ctx.brokerageId)

  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/settings")
  return { ok: true }
}
