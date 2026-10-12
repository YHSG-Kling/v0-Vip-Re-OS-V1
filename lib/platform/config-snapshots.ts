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

/** HOW a payload lands on a tenant (wave 140D; wave 140N made this THE ONE fill-absent
 *  implementation — lib/kernel/tenant-readiness.ts fillAbsentDefaults / applyAbsentSnapshotDefaults
 *  were merged onto this writer and deleted, their tombstone names this file).
 *  `replace`     — the staff "apply this snapshot" door's AUDITED OVERWRITE (app/actions/superadmin/
 *                  config-snapshots.ts, `overwrite: true`) and first provisioning onto an empty tenant:
 *                  every carried key is written; the keys the tenant already HELD come back in
 *                  `overwritten` so the audit row can name them (LAW 5).
 *  `fill_absent` — provisioning + readiness repair (lib/kernel/tenant-operating-baseline.ts) and the
 *                  staff door's DEFAULT: a key the tenant already holds is NEVER touched, only absent
 *                  (null / missing) keys are filled; the voice layer is skipped WHOLE when the tenant
 *                  has an ACTIVE brokerage voice; an existing feature override is never re-applied —
 *                  so a retry or a repair cannot overwrite a customization. The untouched keys come
 *                  back in `preserved`, the written ones in `filled`. */
export type SnapshotApplyMode = "replace" | "fill_absent"
export interface SnapshotApplyOptions { mode?: SnapshotApplyMode }

export interface SnapshotApplyResult {
  /** Sections that landed (`table`, or `table(filled k1,k2)` for a fill-absent write). */
  applied: string[]
  /** Sections refused — each write is READ; a refused section never reads as applied. */
  refused: string[]
  /** `<table>.<key>` the tenant held and a fill-absent apply left exactly as held. */
  preserved: string[]
  /** `<table>.<key>` written where the tenant held nothing (either mode). */
  filled: string[]
  /** `<table>.<key>` the tenant HELD and a replace-mode apply overwrote (always empty in fill-absent mode). */
  overwritten: string[]
}

/** PURE: the keys of `layer` the live row does NOT already hold. A live null / undefined is
 *  absent; any value the tenant holds — including "", 0 or false — is theirs and is kept. A
 *  payload key carrying null / undefined is never a fill (nothing to write).
 *  @proofSeam scripts/tenant-baseline-guard.ts asserts the rule directly (fill-absent never
 *  overwrites a customization). */
export function absentKeys(existing: Record<string, unknown> | null | undefined, layer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(layer)) {
    if (v === undefined || v === null) continue
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
 *  `opts.mode` (default `replace`) — see SnapshotApplyMode. Every layer is READ before it is
 *  written, in both modes, and a refused read FAILS CLOSED for that layer: fill-absent could
 *  otherwise replace a customization, replace could not evidence what it overwrote.
 *  `appliedByUserId` lands on feature_access_overrides.created_by (FK users): a caller with
 *  no acting user passes a payload without `features` (lib/kernel/tenant-operating-baseline.ts
 *  resolves the AI-ISA system actor / first admin, else skips the layer, named). */
export async function applySnapshotPayload(
  payload: SnapshotPayload,
  targetBrokerageId: string,
  appliedByUserId: string,
  client?: Svc,
  opts: SnapshotApplyOptions = {},
): Promise<SnapshotApplyResult> {
  const svc = client ?? createServiceClient()
  const fillAbsent = opts.mode === "fill_absent"
  const applied: string[] = []
  // `applied` used to list every section whether or not its write landed — a
  // refused section read as applied to the operator. Each write is now READ and a
  // refusal is reported here instead of in `applied`.
  const refused: string[] = []
  const preserved: string[] = []
  const filled: string[] = []
  const overwritten: string[] = []
  const now = new Date().toISOString()
  /** Book each written key as filled (tenant held nothing) or overwritten (tenant held a value). */
  const book = (table: string, keys: readonly string[], absent: Record<string, unknown>) => {
    for (const k of keys) (k in absent ? filled : overwritten).push(`${table}.${k}`)
  }

  /** ONE-ROW-PER-BROKERAGE layers (global_settings, brokerage_brand_settings). Re-sanitized on
   *  apply (allow-list) so a tampered payload never writes a column the capture would not carry. */
  /** The write chains, one per table, spelled with the table LITERAL (the column census attributes a
   *  dynamic-key write to the table only when it can see the table name; `.from(table)` hid both). */
  const upsertKeyed = (table: "global_settings" | "brokerage_brand_settings", row: Record<string, unknown>) =>
    table === "global_settings"
      ? svc.from("global_settings").upsert(row, { onConflict: "brokerage_id" })
      : svc.from("brokerage_brand_settings").upsert(row, { onConflict: "brokerage_id" })
  const updateKeyed = (table: "global_settings" | "brokerage_brand_settings", patch: Record<string, unknown>) =>
    table === "global_settings"
      ? svc.from("global_settings").update(patch).eq("brokerage_id", targetBrokerageId).select("brokerage_id")
      : svc.from("brokerage_brand_settings").update(patch).eq("brokerage_id", targetBrokerageId).select("brokerage_id")
  const applyKeyedLayer = async (table: "global_settings" | "brokerage_brand_settings", rawLayer: Record<string, unknown>, allow: readonly string[]) => {
    const layer = pickFields(rawLayer, allow)
    const cols = Object.keys(layer)
    if (!cols.length) return
    const { data: existing, error: readErr } = await svc.from(table).select(cols.join(", ")).eq("brokerage_id", targetBrokerageId).maybeSingle()
    if (readErr) { refused.push(`${table} (read): ${readErr.message}`); return }
    const live = (existing ?? null) as Record<string, unknown> | null
    const absent = absentKeys(live, layer)
    if (!fillAbsent) {
      const replaceRow: Record<string, unknown> = { brokerage_id: targetBrokerageId, ...layer, updated_at: now }
      const { error } = await upsertKeyed(table, replaceRow)
      if (error) { refused.push(`${table}: ${error.message}`); return }
      applied.push(table)
      book(table, cols, absent)
      return
    }
    for (const k of cols) if (!(k in absent)) preserved.push(`${table}.${k}`)
    if (!Object.keys(absent).length) return
    if (!live) {
      const fillRow: Record<string, unknown> = { brokerage_id: targetBrokerageId, ...absent, updated_at: now }
      const { error } = await upsertKeyed(table, fillRow)
      if (error) { refused.push(`${table}: ${error.message}`); return }
    } else {
      const fillPatch: Record<string, unknown> = { ...absent, updated_at: now }
      const { data: rows, error } = await updateKeyed(table, fillPatch)
      if (error) { refused.push(`${table}: ${error.message}`); return }
      if ((rows ?? []).length === 0) { refused.push(`${table}: fill matched no row for ${targetBrokerageId}`); return }
    }
    applied.push(`${table}(filled ${Object.keys(absent).join(",")})`)
    book(table, Object.keys(absent), absent)
  }

  if (payload.global && Object.keys(payload.global).length) await applyKeyedLayer("global_settings", payload.global, SNAPSHOT_GLOBAL_FIELDS)
  if (payload.brand && Object.keys(payload.brand).length) await applyKeyedLayer("brokerage_brand_settings", payload.brand, SNAPSHOT_BRAND_FIELDS)
  if (payload.voice && Object.keys(payload.voice).length) {
    // brand_voice_profile has no single-column unique on brokerage_id (agent/team scoped too). The
    // ACTIVE brokerage-level row is the tenant's voice (what every reader and the readiness contract
    // use). fill-absent: an active voice exists → the layer is skipped WHOLE, nothing written (merged
    // from lane 140K's fillAbsentDefaults); none → one active row is inserted. replace: the brokerage-
    // level rows are cleared and the layer inserted; a refused clear skips the insert (two rows).
    const voice = pickFields(payload.voice as Record<string, any>, SNAPSHOT_VOICE_FIELDS)
    const voiceCols = Object.keys(voice)
    if (voiceCols.length) {
      const { data: liveVoice, error: voiceReadErr } = await svc.from("brand_voice_profile").select(["id", ...voiceCols].join(", ")).eq("brokerage_id", targetBrokerageId).is("agent_id", null).is("team_id", null).eq("is_active", true).limit(1).maybeSingle()
      if (voiceReadErr) refused.push(`brand_voice_profile (read): ${voiceReadErr.message}`)
      else if (fillAbsent && liveVoice) {
        for (const k of voiceCols) preserved.push(`brand_voice_profile.${k}`)
      } else {
        const { error: voiceClearErr } = fillAbsent
          ? { error: null }
          : await svc.from("brand_voice_profile").delete().eq("brokerage_id", targetBrokerageId).is("agent_id", null).is("team_id", null)
        if (voiceClearErr) refused.push(`brand_voice_profile (clear): ${voiceClearErr.message}`)
        else {
          const { error: voiceErr } = await svc.from("brand_voice_profile").insert({ brokerage_id: targetBrokerageId, ...voice, is_active: true, created_at: now, updated_at: now })
          if (voiceErr) refused.push(`brand_voice_profile: ${voiceErr.message}`)
          else {
            applied.push("brand_voice_profile")
            book("brand_voice_profile", voiceCols, absentKeys((liveVoice ?? null) as Record<string, unknown> | null, voice))
          }
        }
      }
    }
  }
  if (payload.site && Object.keys(payload.site).length) {
    // Defence-in-depth: re-sanitize on apply so a tampered payload can NEVER touch
    // identity/billing fields (name, slug, email, status, tier, ids) — only allow-listed
    // site-shaping fields are ever written to the brokerages row.
    let site = pickFields(payload.site as Record<string, any>, SNAPSHOT_SITE_FIELDS)
    const siteCols = Object.keys(site)
    if (siteCols.length) {
      const { data: liveSite, error: siteReadErr } = await svc.from("brokerages").select(siteCols.join(", ")).eq("id", targetBrokerageId).maybeSingle()
      if (siteReadErr) refused.push(`brokerage_site (read): ${siteReadErr.message}`)
      else {
        const absent = absentKeys((liveSite ?? null) as Record<string, unknown> | null, site)
        if (fillAbsent) {
          for (const k of siteCols) if (!(k in absent)) preserved.push(`brokerages.${k}`)
          site = absent
        }
        if (Object.keys(site).length) {
          const { data: siteRows, error: siteErr } = await svc.from("brokerages").update({ ...site, updated_at: now }).eq("id", targetBrokerageId).select("id")
          if (siteErr) refused.push(`brokerage_site: ${siteErr.message}`)
          else if ((siteRows ?? []).length === 0) refused.push(`brokerage_site: no brokerage ${targetBrokerageId}`)
          else {
            applied.push(fillAbsent ? `brokerage_site(filled ${Object.keys(site).join(",")})` : "brokerage_site")
            book("brokerages", Object.keys(site), absent)
          }
        }
      }
    }
  }
  if (payload.features?.length) {
    let featuresApplied = 0
    for (const f of payload.features) {
      const { data: liveOverride, error: ovReadErr } = await svc.from("feature_access_overrides").select("id").eq("brokerage_id", targetBrokerageId).eq("feature_key", f.feature_key).is("user_id", null).is("team_id", null).limit(1).maybeSingle()
      if (ovReadErr) { refused.push(`feature_override ${f.feature_key} (read): ${ovReadErr.message}`); continue }
      // An override the tenant already holds for this feature (granted, disabled, or
      // their own trial) is theirs — fill-absent never clears it.
      if (fillAbsent && liveOverride) { preserved.push(`feature_access_overrides.${f.feature_key}`); continue }
      if (!fillAbsent) {
        const { error: clearErr } = await svc.from("feature_access_overrides").delete().eq("brokerage_id", targetBrokerageId).eq("feature_key", f.feature_key).is("user_id", null).is("team_id", null)
        if (clearErr) { refused.push(`feature_override ${f.feature_key} (clear): ${clearErr.message}`); continue }
      }
      const { error: insErr } = await svc.from("feature_access_overrides").insert({
        brokerage_id: targetBrokerageId, feature_key: f.feature_key, override_type: f.override_type,
        trial_ends_at: f.override_type === "grant_trial" ? f.trial_ends_at : null, created_by: appliedByUserId,
      })
      if (insErr) { refused.push(`feature_override ${f.feature_key}: ${insErr.message}`); continue }
      featuresApplied++
      ;(liveOverride ? overwritten : filled).push(`feature_access_overrides.${f.feature_key}`)
    }
    if (featuresApplied > 0) applied.push(`feature_overrides(${featuresApplied}/${payload.features.length})`)
  }
  if (refused.length > 0) console.error(`[config-snapshots] apply to ${targetBrokerageId}: ${refused.length} section(s) refused — ${refused.join(" | ")}`)
  return { applied, refused, preserved, filled, overwritten }
}
