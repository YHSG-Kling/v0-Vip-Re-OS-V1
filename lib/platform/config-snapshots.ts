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

/** Fields that must NEVER appear in a snapshot (defence-in-depth for the test + reviewers).
 *  `zapier_api_key` stays listed after m678 DROPS the column (lane 89E): the list guards the
 *  payload, not the schema, and a re-added column of that name must still never travel. */
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

/** HOW a payload lands on a tenant (wave 140D).
 *  `replace`     — the staff "apply this snapshot" door: every carried key is written (the
 *                  historical behaviour; app/actions/superadmin/config-snapshots.ts).
 *  `fill_absent` — provisioning + readiness repair (lib/kernel/tenant-operating-baseline.ts):
 *                  a key the tenant already holds is NEVER touched, only absent (null /
 *                  missing) keys are filled, so a retry or a repair cannot overwrite a
 *                  customization. The untouched keys come back in `preserved`. */
export type SnapshotApplyMode = "replace" | "fill_absent"
export interface SnapshotApplyOptions { mode?: SnapshotApplyMode }

/** PURE: the keys of `layer` the live row does NOT already hold. A live null / undefined is
 *  absent; any value the tenant holds — including "", 0 or false — is theirs and is kept.
 *  @proofSeam scripts/tenant-baseline-guard.ts asserts the rule directly (fill-absent never
 *  overwrites a customization). */
export function absentKeys(existing: Record<string, unknown> | null | undefined, layer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(layer)) {
    if (v === undefined) continue
    const cur = existing ? existing[k] : undefined
    if (cur === null || cur === undefined) out[k] = v
  }
  return out
}

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

/** Apply a snapshot payload to a target tenant (service client; caller gates + audits).
 *  `opts.mode` (default `replace`) — see SnapshotApplyMode; `preserved` names the
 *  `<table>.<key>` values a fill-absent apply left exactly as the tenant holds them. */
export async function applySnapshotPayload(
  payload: SnapshotPayload,
  targetBrokerageId: string,
  appliedByUserId: string,
  client?: Svc,
  opts: SnapshotApplyOptions = {},
): Promise<{ applied: string[]; refused: string[]; preserved: string[] }> {
  const svc = client ?? createServiceClient()
  const fillAbsent = opts.mode === "fill_absent"
  const applied: string[] = []
  // `applied` used to list every section whether or not its write landed — a
  // refused section read as applied to the operator. Each write is now READ and a
  // refusal is reported here instead of in `applied`.
  const refused: string[] = []
  const preserved: string[] = []
  const now = new Date().toISOString()

  /** ONE-ROW-PER-BROKERAGE layers (global_settings, brokerage_brand_settings): replace =
   *  upsert the whole layer; fill-absent = read the live row, write only what it lacks. */
  const applyKeyedLayer = async (table: "global_settings" | "brokerage_brand_settings", layer: Record<string, unknown>, allow: readonly string[]) => {
    if (!fillAbsent) {
      const { error } = await svc.from(table).upsert({ brokerage_id: targetBrokerageId, ...layer, updated_at: now }, { onConflict: "brokerage_id" })
      if (error) refused.push(`${table}: ${error.message}`)
      else applied.push(table)
      return
    }
    const cols = allow.filter((k) => k in layer)
    const { data: existing, error: readErr } = await svc.from(table).select(cols.join(", ")).eq("brokerage_id", targetBrokerageId).maybeSingle()
    // FAIL CLOSED: a refused read is never "no row yet" — writing the layer over it could replace a customization.
    if (readErr) { refused.push(`${table} (read): ${readErr.message}`); return }
    if (!existing) {
      const { error } = await svc.from(table).upsert({ brokerage_id: targetBrokerageId, ...layer, updated_at: now }, { onConflict: "brokerage_id" })
      if (error) refused.push(`${table}: ${error.message}`)
      else applied.push(table)
      return
    }
    const fill = absentKeys(existing as unknown as Record<string, unknown>, layer)
    for (const k of cols) if (!(k in fill)) preserved.push(`${table}.${k}`)
    if (!Object.keys(fill).length) return
    const { data: rows, error } = await svc.from(table).update({ ...fill, updated_at: now }).eq("brokerage_id", targetBrokerageId).select("brokerage_id")
    if (error) refused.push(`${table}: ${error.message}`)
    else if ((rows ?? []).length === 0) refused.push(`${table}: fill matched no row for ${targetBrokerageId}`)
    else applied.push(`${table}(filled ${Object.keys(fill).join(",")})`)
  }

  if (payload.global && Object.keys(payload.global).length) await applyKeyedLayer("global_settings", payload.global, SNAPSHOT_GLOBAL_FIELDS)
  if (payload.brand && Object.keys(payload.brand).length) await applyKeyedLayer("brokerage_brand_settings", payload.brand, SNAPSHOT_BRAND_FIELDS)
  if (payload.voice && Object.keys(payload.voice).length) {
    // brand_voice_profile has no single-column unique on brokerage_id (agent/team scoped too),
    // so replace the brokerage-level row explicitly. A refused clear skips the insert
    // (it would leave two brokerage-level voice rows).
    const voiceCols = SNAPSHOT_VOICE_FIELDS.filter((k) => k in (payload.voice as object))
    const { data: liveVoice, error: voiceReadErr } = fillAbsent
      ? await svc.from("brand_voice_profile").select(["id", ...voiceCols].join(", ")).eq("brokerage_id", targetBrokerageId).is("agent_id", null).is("team_id", null).limit(1).maybeSingle()
      : { data: null, error: null }
    if (voiceReadErr) refused.push(`brand_voice_profile (read): ${voiceReadErr.message}`)
    else if (fillAbsent && liveVoice) {
      const fill = absentKeys(liveVoice as unknown as Record<string, unknown>, payload.voice)
      for (const k of voiceCols) if (!(k in fill)) preserved.push(`brand_voice_profile.${k}`)
      if (Object.keys(fill).length) {
        const { data: rows, error: voiceErr } = await svc.from("brand_voice_profile").update({ ...fill, updated_at: now }).eq("id", (liveVoice as unknown as { id: string }).id).eq("brokerage_id", targetBrokerageId).select("id")
        if (voiceErr) refused.push(`brand_voice_profile: ${voiceErr.message}`)
        else if ((rows ?? []).length === 0) refused.push(`brand_voice_profile: fill matched no row for ${targetBrokerageId}`)
        else applied.push(`brand_voice_profile(filled ${Object.keys(fill).join(",")})`)
      }
    } else {
      const { error: voiceClearErr } = fillAbsent
        ? { error: null }
        : await svc.from("brand_voice_profile").delete().eq("brokerage_id", targetBrokerageId).is("agent_id", null).is("team_id", null)
      if (voiceClearErr) refused.push(`brand_voice_profile (clear): ${voiceClearErr.message}`)
      else {
        const { error: voiceErr } = await svc.from("brand_voice_profile").insert({ brokerage_id: targetBrokerageId, ...payload.voice, is_active: true, created_at: now, updated_at: now })
        if (voiceErr) refused.push(`brand_voice_profile: ${voiceErr.message}`)
        else applied.push("brand_voice_profile")
      }
    }
  }
  if (payload.site && Object.keys(payload.site).length) {
    // Defence-in-depth: re-sanitize on apply so a tampered payload can NEVER touch
    // identity/billing fields (name, slug, email, status, tier, ids) — only allow-listed
    // site-shaping fields are ever written to the brokerages row.
    let site = pickFields(payload.site as Record<string, any>, SNAPSHOT_SITE_FIELDS)
    let siteReadRefused = false
    if (fillAbsent && Object.keys(site).length) {
      const cols = Object.keys(site)
      const { data: liveSite, error: siteReadErr } = await svc.from("brokerages").select(cols.join(", ")).eq("id", targetBrokerageId).maybeSingle()
      if (siteReadErr) { refused.push(`brokerage_site (read): ${siteReadErr.message}`); siteReadRefused = true }
      else {
        site = absentKeys((liveSite ?? null) as Record<string, unknown> | null, site)
        for (const k of cols) if (!(k in site)) preserved.push(`brokerages.${k}`)
      }
    }
    if (!siteReadRefused && Object.keys(site).length) {
      const { data: siteRows, error: siteErr } = await svc.from("brokerages").update({ ...site, updated_at: now }).eq("id", targetBrokerageId).select("id")
      if (siteErr) refused.push(`brokerage_site: ${siteErr.message}`)
      else if ((siteRows ?? []).length === 0) refused.push(`brokerage_site: no brokerage ${targetBrokerageId}`)
      else applied.push(fillAbsent ? `brokerage_site(filled ${Object.keys(site).join(",")})` : "brokerage_site")
    }
  }
  if (payload.features?.length) {
    let featuresApplied = 0
    for (const f of payload.features) {
      if (fillAbsent) {
        // An override the tenant already holds for this feature (granted, disabled, or
        // their own trial) is theirs — fill-absent never clears it.
        const { data: liveOverride, error: ovReadErr } = await svc.from("feature_access_overrides").select("id").eq("brokerage_id", targetBrokerageId).eq("feature_key", f.feature_key).is("user_id", null).is("team_id", null).limit(1).maybeSingle()
        if (ovReadErr) { refused.push(`feature_override ${f.feature_key} (read): ${ovReadErr.message}`); continue }
        if (liveOverride) { preserved.push(`feature_access_overrides.${f.feature_key}`); continue }
      } else {
        const { error: clearErr } = await svc.from("feature_access_overrides").delete().eq("brokerage_id", targetBrokerageId).eq("feature_key", f.feature_key).is("user_id", null).is("team_id", null)
        if (clearErr) { refused.push(`feature_override ${f.feature_key} (clear): ${clearErr.message}`); continue }
      }
      const { error: insErr } = await svc.from("feature_access_overrides").insert({
        brokerage_id: targetBrokerageId, feature_key: f.feature_key, override_type: f.override_type,
        trial_ends_at: f.override_type === "grant_trial" ? f.trial_ends_at : null, created_by: appliedByUserId,
      })
      if (insErr) { refused.push(`feature_override ${f.feature_key}: ${insErr.message}`); continue }
      featuresApplied++
    }
    if (featuresApplied > 0) applied.push(`feature_overrides(${featuresApplied}/${payload.features.length})`)
  }
  if (refused.length > 0) console.error(`[config-snapshots] apply to ${targetBrokerageId}: ${refused.length} section(s) refused — ${refused.join(" | ")}`)
  return { applied, refused, preserved }
}
