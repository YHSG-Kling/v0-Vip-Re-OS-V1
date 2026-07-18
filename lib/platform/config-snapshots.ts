// lib/platform/config-snapshots.ts
// ─────────────────────────────────────────────────────────────────────────────
// TENANT CONFIG SNAPSHOTS — capture a tenant's brand + voice + feature enablement as a
// reusable template and apply it to other tenants. All writes are service-client
// (cross-tenant); callers gate + audit. The capture layer is allow-list-based so a
// snapshot can NEVER carry a secret (smtp_password, *_api_key, from_email) between tenants.

import { createServiceClient } from "@/lib/supabase/service"
import { normalizeOverrideType } from "@/lib/kernel/override-vocab"

// ── ALLOW-LISTS — the ONLY fields a snapshot may carry per table. Anything not here
//    (all credentials/SMTP/API keys, ids, brokerage_id, timestamps) is never captured. ──
export const SNAPSHOT_GLOBAL_FIELDS = ["app_name", "app_logo_url", "primary_color", "secondary_color", "font_family", "date_format", "timezone", "currency_symbol"] as const
export const SNAPSHOT_BRAND_FIELDS = ["tagline", "website_url", "facebook_url", "instagram_url", "linkedin_url", "email_signature_html", "letterhead_html", "accent_color", "heading_size", "body_text_size"] as const
export const SNAPSHOT_VOICE_FIELDS = ["tone", "formality_level", "key_brand_messages", "prohibited_words", "preferred_words", "tagline", "mission_statement", "custom_instructions", "style", "brand_personality", "target_audience", "content_guidelines", "writing_style_notes", "tone_examples"] as const
// SITE layer — brokerages-row fields that shape the tenant's public /site/[slug] website.
// Applying these makes a freshly provisioned tenant's day-one site come up fully branded.
export const SNAPSHOT_SITE_FIELDS = ["about_text", "bio_text", "primary_color", "recruiting_pitch", "recruiting_value_props", "offers_cda", "widget_enabled", "farm_mail_enabled"] as const

/** Fields that must NEVER appear in a snapshot (defence-in-depth for the test + reviewers). */
export const SNAPSHOT_FORBIDDEN_FIELDS = ["smtp_password", "smtp_username", "smtp_host", "smtp_port", "ghl_api_key", "zapier_api_key", "airtable_api_key", "from_email", "from_name", "created_by_user_id"] as const
/** brokerages identity/billing fields the site layer must NEVER carry or touch on apply. */
export const SNAPSHOT_SITE_FORBIDDEN_FIELDS = ["id", "name", "slug", "email", "phone", "status", "plan_tier", "subscription_tier", "onboarding_status", "twilio_subaccount_sid", "billing_metadata", "trial_ends_at", "logo_url"] as const

export interface SnapshotFeature { feature_key: string; override_type: "grant_trial" | "disable"; trial_ends_at: string | null }
export interface SnapshotPayload {
  global?: Record<string, unknown>
  brand?: Record<string, unknown>
  voice?: Record<string, unknown>
  /** Allow-listed brokerages fields that shape the public /site/[slug] website. */
  site?: Record<string, unknown>
  features?: SnapshotFeature[]
  /** Optional tier hint shown when provisioning a new subscriber from this snapshot (jsonb metadata — never applied to the row). */
  recommendedTier?: string
}

/** PURE: keep only allow-listed, defined keys — the guarantee that no secret is captured. */
export function pickFields(row: Record<string, any> | null | undefined, allow: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!row) return out
  for (const k of allow) if (row[k] !== undefined && row[k] !== null) out[k] = row[k]
  return out
}

/** PURE: does a captured payload leak any forbidden (secret) field at any layer?
 *  Also flags brokerage identity/billing fields (name/slug/email/tier/status/ids)
 *  smuggled into the site layer — those must never move between tenants. */
export function payloadLeaksSecret(payload: SnapshotPayload): boolean {
  const layers = [payload.global, payload.brand, payload.voice, payload.site]
  if (layers.some((l) => l && SNAPSHOT_FORBIDDEN_FIELDS.some((f) => f in (l as object)))) return true
  return !!payload.site && SNAPSHOT_SITE_FORBIDDEN_FIELDS.some((f) => f in (payload.site as object))
}

type Svc = ReturnType<typeof createServiceClient>

/** Build a snapshot payload from a source tenant — allow-listed brand/voice + feature overrides. */
export async function buildSnapshotPayload(sourceBrokerageId: string, client?: Svc): Promise<SnapshotPayload> {
  const svc = client ?? createServiceClient()
  const [{ data: gs }, { data: bs }, { data: bv }, { data: brk }, { data: overrides }] = await Promise.all([
    svc.from("global_settings").select("*").eq("brokerage_id", sourceBrokerageId).maybeSingle(),
    svc.from("brokerage_brand_settings").select("*").eq("brokerage_id", sourceBrokerageId).maybeSingle(),
    svc.from("brand_voice_profile").select("*").eq("brokerage_id", sourceBrokerageId).is("agent_id", null).is("team_id", null).maybeSingle(),
    svc.from("brokerages").select("*").eq("id", sourceBrokerageId).maybeSingle(),
    svc.from("feature_access_overrides").select("feature_key, override_type, trial_ends_at").eq("brokerage_id", sourceBrokerageId).is("user_id", null).is("team_id", null),
  ])
  return {
    global: pickFields(gs as any, SNAPSHOT_GLOBAL_FIELDS),
    brand: pickFields(bs as any, SNAPSHOT_BRAND_FIELDS),
    voice: pickFields(bv as any, SNAPSHOT_VOICE_FIELDS),
    site: pickFields(brk as any, SNAPSHOT_SITE_FIELDS),
    features: ((overrides ?? []) as any[])
      .map((o) => ({ feature_key: o.feature_key, override_type: normalizeOverrideType(o.override_type), trial_ends_at: o.trial_ends_at }))
      .filter((o): o is SnapshotFeature => o.override_type !== null),
  }
}

/** Apply a snapshot payload to a target tenant (service client; caller gates + audits). */
export async function applySnapshotPayload(
  payload: SnapshotPayload,
  targetBrokerageId: string,
  appliedByUserId: string,
  client?: Svc,
): Promise<{ applied: string[] }> {
  const svc = client ?? createServiceClient()
  const applied: string[] = []
  const now = new Date().toISOString()

  if (payload.global && Object.keys(payload.global).length) {
    await svc.from("global_settings").upsert({ brokerage_id: targetBrokerageId, ...payload.global, updated_at: now }, { onConflict: "brokerage_id" })
    applied.push("global_settings")
  }
  if (payload.brand && Object.keys(payload.brand).length) {
    await svc.from("brokerage_brand_settings").upsert({ brokerage_id: targetBrokerageId, ...payload.brand, updated_at: now }, { onConflict: "brokerage_id" })
    applied.push("brokerage_brand_settings")
  }
  if (payload.voice && Object.keys(payload.voice).length) {
    // brand_voice_profile has no single-column unique on brokerage_id (agent/team scoped too),
    // so replace the brokerage-level row explicitly.
    await svc.from("brand_voice_profile").delete().eq("brokerage_id", targetBrokerageId).is("agent_id", null).is("team_id", null)
    await svc.from("brand_voice_profile").insert({ brokerage_id: targetBrokerageId, ...payload.voice, is_active: true, created_at: now, updated_at: now })
    applied.push("brand_voice_profile")
  }
  if (payload.site && Object.keys(payload.site).length) {
    // Defence-in-depth: re-sanitize on apply so a tampered payload can NEVER touch
    // identity/billing fields (name, slug, email, status, tier, ids) — only allow-listed
    // site-shaping fields are ever written to the brokerages row.
    const site = pickFields(payload.site as Record<string, any>, SNAPSHOT_SITE_FIELDS)
    if (Object.keys(site).length) {
      await svc.from("brokerages").update({ ...site, updated_at: now }).eq("id", targetBrokerageId)
      applied.push("brokerage_site")
    }
  }
  if (payload.features?.length) {
    for (const f of payload.features) {
      await svc.from("feature_access_overrides").delete().eq("brokerage_id", targetBrokerageId).eq("feature_key", f.feature_key).is("user_id", null).is("team_id", null)
      await svc.from("feature_access_overrides").insert({
        brokerage_id: targetBrokerageId, feature_key: f.feature_key, override_type: f.override_type,
        trial_ends_at: f.override_type === "grant_trial" ? f.trial_ends_at : null, created_by: appliedByUserId,
      })
    }
    applied.push(`feature_overrides(${payload.features.length})`)
  }
  return { applied }
}
