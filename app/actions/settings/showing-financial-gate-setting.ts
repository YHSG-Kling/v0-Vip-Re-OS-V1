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

import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
// ★ ACT-AS WRITE SEAM ★ — the gate resolves the EFFECTIVE identity (the
// impersonated seat under act-as, never the raw staff row with its NULL
// brokerage). The finance predicate is unchanged and is evaluated on that
// impersonated identity; the setter refuses read_only grants before the
// service-client write, which this gate alone protects.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"

async function resolveBrokerAdmin(
  mode: "read" | "write",
): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  const acting = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!acting.ok) return { ok: false, error: acting.error ?? "Unauthenticated" }
  if (!acting.brokerageId) return { ok: false, error: "No brokerage" }

  // A solo agent IS their own brokerage, so they set their own showing policy —
  // same carve-out the revenue-share setting makes, for the same reason.
  const svc = createServiceClient()
  const { data: brk, error: brkError } = await svc
    .from("brokerages")
    .select("plan_tier")
    .eq("id", acting.brokerageId)
    .maybeSingle()
  if (brkError) return { ok: false, error: brkError.message }

  const isSolo = (brk as { plan_tier?: string } | null)?.plan_tier === "solo_agent"
  // BROKERAGE-WIDE MONEY (m472). The ONE finance roster — the same set
  // public.is_brokerage_finance_admin() carries — so the app cannot admit where
  // RLS refuses. It EXCLUDES team_lead by the owner's ruling, and it ADDS
  // broker_owner, which the local literal omitted: the person who OWNS the
  // brokerage was refused by the gate guarding their own brokerage's setting.
  // Evaluated on the IMPERSONATED identity's user_type when acting-as.
  if (!isSolo && !isBrokerageFinanceAdmin({ user_type: acting.userType })) {
    return { ok: false, error: "Only a broker or admin can change how showings are gated." }
  }
  return { ok: true, brokerageId: acting.brokerageId }
}

export async function getShowingFinancialGateSetting(): Promise<{
  ok: boolean
  required: boolean
  error?: string
}> {
  const ctx = await resolveBrokerAdmin("read")
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
  const ctx = await resolveBrokerAdmin("write")
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
