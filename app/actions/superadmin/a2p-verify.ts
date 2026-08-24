"use server"

// app/actions/superadmin/a2p-verify.ts
// ─────────────────────────────────────────────────────────────────────────────
// PRE-PRODUCTION A2P VERIFICATION — one click runs the ENTIRE ISV registration
// chain against the LIVE Twilio account with Mock=true on the BrandRegistration
// (Twilio's documented integration-test path: real TrustHub bundles + a mock
// brand/campaign, no TCR filing, no fees). Providers-gated + audited. The
// chosen tenant needs a subaccount + a saved business profile — honest errors
// name exactly what's missing. Run once per environment before go-live.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { platformStaffCan, resolvePlatformRoleIdentity } from "@/lib/platform/platform-staff-roster"
import { runA2pRegistration, describeA2pState, nextA2pStep } from "@/lib/voice/a2p-registration"

async function requireProviders(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = resolvePlatformRoleIdentity((data as any)?.user_type, (data as any)?.platform_role)
  if (!platformStaffCan(role, "providers")) return { ok: false, error: "Forbidden — platform providers access required" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "" }
}

export async function verifyA2pPipelineMockAction(brokerageId: string): Promise<{
  ok: boolean; statusLine: string; nextStep: string; error?: string
}> {
  const auth = await requireProviders()
  if (!auth.ok) return { ok: false, statusLine: "", nextStep: "", error: auth.error }
  if (!/^[0-9a-f-]{36}$/i.test(brokerageId)) return { ok: false, statusLine: "", nextStep: "", error: "Enter a valid brokerage id (uuid)" }

  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id, name").eq("id", brokerageId).maybeSingle()
  if (!brk) return { ok: false, statusLine: "", nextStep: "", error: "Brokerage not found" }

  const r = await runA2pRegistration(svc, brokerageId, { mock: true })

  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: auth.userId, actor_email: auth.email,
      action: "a2p_pipeline.mock_verified", target_type: "brokerage", target_id: brokerageId,
      details: { advancedTo: r.advancedTo, ok: r.ok, error: r.error ?? null, mock: true },
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[a2p-verify audit] failed:", err) }

  return {
    ok: r.ok,
    statusLine: `${(brk as any).name}: ${describeA2pState(r.state)} (MOCK run — no real TCR filing)`,
    nextStep: nextA2pStep(r.state),
    error: r.error,
  }
}
