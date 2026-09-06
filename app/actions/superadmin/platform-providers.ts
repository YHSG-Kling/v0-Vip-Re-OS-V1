"use server"

// app/actions/superadmin/platform-providers.ts
// ─────────────────────────────────────────────────────────────────────────────
// Superadmin PLATFORM PROVIDER CONFIG — the write surface the runtime read pipelines were waiting on.
// Toggles ENABLEMENT of the platform-funded channels (direct_mail → Lob, video → D-ID) by writing
// provider_overrides at scope_type='superadmin'. Tenant-connected providers (email/calendar/sms/phone)
// are deliberately NOT here — see the scope note in lib/platform/platform-providers.ts. Superadmin-gated,
// validated (fail closed), audited to superadmin_audit_log.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"
import {
  getPlatformProviderConfig, setPlatformProviderOverride, validatePlatformProvider, PLATFORM_PROVIDER_SPEC,
  type PlatformProviderState, type PlatformProviderSpec,
} from "@/lib/platform/platform-providers"

async function requireSuperadmin(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const isSuper = isPlatformSuperadminIdentity((data as any)?.user_type, (data as any)?.platform_role)
  if (!isSuper) return { ok: false, error: "Forbidden — superadmin only" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "" }
}

export async function getPlatformProvidersAction(): Promise<
  | { ok: true; spec: PlatformProviderSpec[]; state: PlatformProviderState[] }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  return { ok: true, spec: PLATFORM_PROVIDER_SPEC, state: await getPlatformProviderConfig() }
}

export async function setPlatformProviderAction(params: { providerType: string; providerKey?: string; enabled: boolean }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  // FAIL CLOSED before any write. setPlatformProviderOverride refuses an unknown
  // provider_type but used to silently REPLACE a wrong providerKey with the fixed
  // platform vendor and report ok — so `{ video, heygen, true }` returned success
  // while the row said `did`. validatePlatformProvider refuses both an unknown
  // channel and a mismatched vendor with the reason, and the audit row below is
  // then only written for a write that actually happened.
  const valid = validatePlatformProvider(params.providerType, params.providerKey ?? "")
  if (!valid.ok) return { ok: false, error: valid.error ?? "Not a platform-configurable provider" }
  const svc = createServiceClient()
  const r = await setPlatformProviderOverride(svc, params)
  if (!r.ok) return r

  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: auth.userId, actor_email: auth.email,
      action: "platform_provider_update", target_type: "provider_overrides", target_id: null,
      details: params, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[platform-providers] audit failed:", err) }

  revalidatePath("/dashboard/superadmin/platform")
  return { ok: true }
}
