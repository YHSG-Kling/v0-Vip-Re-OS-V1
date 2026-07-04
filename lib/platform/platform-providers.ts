// lib/platform/platform-providers.ts
//
// PLATFORM PROVIDER CONFIG — the missing WRITE surface for platform-wide integration providers. The runtime
// pipelines already READ platform config from provider_overrides at scope_type='superadmin' — resolveProvider
// (lib/kernel/providers.ts) uses a superadmin row as the platform-default/vendor, and getSystemProviderStatus
// gates direct_mail/video channel enablement on it — but NOTHING could write those rows (saveProviderOverride
// hard-codes scope_type='brokerage'; setPlatformVideoProvider is a no-op). So platform provider config could
// only be seeded by hand-run SQL. This is that write surface: one audited superadmin action lights up the
// whole already-live read path.
//
// SCOPE (corrected): the ONLY things that are genuinely platform-level here are the PLATFORM-FUNDED CHANNELS
// whose enablement the read side actually gates — direct_mail (Lob) and video (D-ID). Everything a TENANT
// brings itself — email, calendar, SMS, phone — is per-tenant (connected via the tenant's own OAuth/keys in
// the connection center), NOT a platform default, so it is intentionally absent here. Provider API KEYS
// (D-ID, ElevenLabs, Lob, Stripe, Twilio, …) are set as Vercel environment variables, never entered in the
// app — this surface only toggles ENABLEMENT, never captures a secret.

import { createServiceClient } from "@/lib/supabase/service"

/** All platform provider rows share this sentinel scope_id so the UNIQUE (scope_type, scope_id, provider_type)
 *  dedupes to exactly one row per provider_type — which resolveProvider's .maybeSingle() requires. */
export const PLATFORM_SCOPE_ID = "00000000-0000-0000-0000-000000000000"

export interface PlatformProviderSpec {
  providerType: string
  label: string
  /** The fixed platform-funded vendor for this channel (informational — the key lives in Vercel env). */
  vendor: string
  /** Plain-English what enabling/disabling this channel does platform-wide. */
  note: string
}

/**
 * The catalog of platform-funded CHANNELS a superadmin can enable/disable for every tenant. Only these two
 * are (a) platform-level (platform-funded vendor) and (b) actually gated by the runtime read side
 * (getSystemProviderStatus). Tenant-connected providers (email/calendar/SMS/phone) are NOT here.
 */
export const PLATFORM_PROVIDER_SPEC: PlatformProviderSpec[] = [
  { providerType: "direct_mail", label: "Direct mail", vendor: "lob", note: "Lets tenants send AI-generated postcards/letters (Lob). Off = no direct-mail channel anywhere." },
  { providerType: "video", label: "Video / avatar", vendor: "did", note: "Lets tenants render D-ID avatar + explainer videos. Off = no platform video channel anywhere." },
]

const SPEC_BY_TYPE = new Map(PLATFORM_PROVIDER_SPEC.map((s) => [s.providerType, s]))

/** PURE: is this provider_type a platform-configurable channel? (Vendor is fixed + funded via Vercel env.) */
export function validatePlatformProvider(providerType: string, providerKey: string): { ok: boolean; error?: string } {
  const spec = SPEC_BY_TYPE.get(providerType)
  if (!spec) return { ok: false, error: `"${providerType}" is not a platform-configurable channel (tenant providers like email/calendar are connected per-tenant)` }
  if (providerKey && providerKey !== spec.vendor) return { ok: false, error: `${spec.label} is platform-funded to ${spec.vendor}; the key is set in Vercel, not here` }
  return { ok: true }
}

export interface PlatformProviderState { providerType: string; providerKey: string; enabled: boolean }
type Svc = ReturnType<typeof createServiceClient>

/** Read the current platform provider config (the superadmin-scope rows). */
export async function getPlatformProviderConfig(client?: Svc): Promise<PlatformProviderState[]> {
  const svc = client ?? createServiceClient()
  const { data } = await svc.from("provider_overrides")
    .select("provider_type, provider_key, enabled").eq("scope_type", "superadmin")
  const byType = new Map<string, PlatformProviderState>()
  for (const r of (data ?? []) as any[]) byType.set(r.provider_type, { providerType: r.provider_type, providerKey: r.provider_key, enabled: r.enabled })
  // Return the full spec; a channel with no row is OFF by default (opt-in enablement).
  return PLATFORM_PROVIDER_SPEC.map((s) => byType.get(s.providerType) ?? { providerType: s.providerType, providerKey: s.vendor, enabled: false })
}

/** Enable/disable a platform channel (superadmin-scope, sentinel scope_id). Upsert → one row per type.
 *  The vendor is fixed (funded via Vercel env) — callers only toggle `enabled`. */
export async function setPlatformProviderOverride(svc: Svc, params: { providerType: string; providerKey?: string; enabled: boolean }): Promise<{ ok: boolean; error?: string }> {
  const spec = SPEC_BY_TYPE.get(params.providerType)
  if (!spec) return { ok: false, error: `"${params.providerType}" is not a platform-configurable channel` }
  const vendor = spec.vendor // the key stays the platform-funded vendor; never a user-entered secret
  const { error } = await svc.from("provider_overrides").upsert({
    scope_type: "superadmin", scope_id: PLATFORM_SCOPE_ID,
    provider_type: params.providerType, provider_key: vendor,
    enabled: params.enabled, updated_at: new Date().toISOString(),
  }, { onConflict: "scope_type,scope_id,provider_type" })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
