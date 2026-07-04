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
// Two axes are configurable at the platform tier:
//   • CHANNEL ENABLEMENT (direct_mail, video) — turn a platform channel on/off for every tenant.
//   • PLATFORM DEFAULT VENDOR (email, sms, phone) — the vendor a brokerage INHERITS when it hasn't set its
//     own (the BYO-cascade fallback). System-only vendors (video=D-ID, voice_clone=ElevenLabs) stay locked
//     by design and are NOT vendor-swappable here.

import { createServiceClient } from "@/lib/supabase/service"

/** All platform provider rows share this sentinel scope_id so the UNIQUE (scope_type, scope_id, provider_type)
 *  dedupes to exactly one row per provider_type — which resolveProvider's .maybeSingle() requires. */
export const PLATFORM_SCOPE_ID = "00000000-0000-0000-0000-000000000000"

export type PlatformProviderKind = "channel" | "default"

export interface PlatformProviderSpec {
  providerType: string
  label: string
  kind: PlatformProviderKind
  /** For 'default' vendors: the selectable vendor keys. For 'channel': the fixed vendor (informational). */
  options: string[]
}

/** The catalog of what a superadmin can configure at the platform tier. */
export const PLATFORM_PROVIDER_SPEC: PlatformProviderSpec[] = [
  { providerType: "direct_mail", label: "Direct mail (Lob)", kind: "channel", options: ["lob"] },
  { providerType: "video", label: "Video / avatar (D-ID)", kind: "channel", options: ["did"] },
  { providerType: "email", label: "Default email sender", kind: "default", options: ["sendgrid", "mailgun", "resend", "ses", "postmark"] },
  { providerType: "sms", label: "Default SMS", kind: "default", options: ["twilio", "telnyx", "bandwidth"] },
  { providerType: "phone", label: "Default voice / phone", kind: "default", options: ["twilio", "telnyx", "bandwidth"] },
]

const SPEC_BY_TYPE = new Map(PLATFORM_PROVIDER_SPEC.map((s) => [s.providerType, s]))

/** PURE: is this provider_type configurable at the platform tier, and (for defaults) is the vendor valid? */
export function validatePlatformProvider(providerType: string, providerKey: string): { ok: boolean; error?: string } {
  const spec = SPEC_BY_TYPE.get(providerType)
  if (!spec) return { ok: false, error: `"${providerType}" is not a platform-configurable provider` }
  if (!providerKey?.trim()) return { ok: false, error: "A provider key is required" }
  if (spec.kind === "default" && !spec.options.includes(providerKey)) return { ok: false, error: `"${providerKey}" is not a valid ${spec.label} vendor` }
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
  // Return the full spec, defaulting to the system fallback when unset.
  return PLATFORM_PROVIDER_SPEC.map((s) => byType.get(s.providerType) ?? { providerType: s.providerType, providerKey: s.options[0], enabled: s.kind === "default" })
}

/** Write a platform provider override (superadmin-scope, sentinel scope_id). Upsert → one row per type. */
export async function setPlatformProviderOverride(svc: Svc, params: { providerType: string; providerKey: string; enabled: boolean }): Promise<{ ok: boolean; error?: string }> {
  const v = validatePlatformProvider(params.providerType, params.providerKey)
  if (!v.ok) return { ok: false, error: v.error }
  const { error } = await svc.from("provider_overrides").upsert({
    scope_type: "superadmin", scope_id: PLATFORM_SCOPE_ID,
    provider_type: params.providerType, provider_key: params.providerKey.trim(),
    enabled: params.enabled, updated_at: new Date().toISOString(),
  }, { onConflict: "scope_type,scope_id,provider_type" })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
