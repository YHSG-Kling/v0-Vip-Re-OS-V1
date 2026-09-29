// lib/kernel/providers.ts
// LAYER 0 — provider resolution for the platform. Two tiers:
//
//   • PLATFORM (system-only): one vendor for the whole app, owned by the
//     platform. Superadmin may override the single vendor; there are NO
//     user/team/brokerage overrides. Per-agent ASSETS (avatar id, cloned
//     voice id) are applied downstream — only the VENDOR is platform-locked.
//     Types: ai, video, avatar, voice_clone, ai_voice, direct_mail.
//
//   • PER-TENANT (cascade): user → team → brokerage → superadmin → system
//     default. BYO credentials. Types: transaction, esign, email, sms, phone,
//     calendar, crm, accounting, social, payment.
//
// No side effects. Read-only.

import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveCallerIdentity } from "@/lib/auth/require-caller"
import { isPlatformStaffRole } from "@/lib/platform/platform-staff-roster"
import { DEFAULT_ESIGN_PROVIDER } from "@/lib/integrations/providers/catalog"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface ResolveProviderParams {
  providerType: string
  actorContext: {
    userId: string
    brokerageId: string
    teamId?: string
  }
}

export interface ResolvedProvider {
  providerKey: string
  config: Record<string, any>
  /** WHICH tier of the cascade answered — merged here 2026-08-31 from the orphaned
   *  documentary twin (lib/kernel/types.ts ProviderChoice, deleted; this is its survivor).
   *  'superadmin' is the DB's own scope_type spelling (provider_overrides), not the
   *  'superadmin_personal' the twin guessed; 'system_default' means no override row won. */
  scope: "user" | "team" | "brokerage" | "superadmin" | "system_default"
}

// ─── SYSTEM DEFAULTS ──────────────────────────────────────────────────────────
// The vendor used when no override applies. For PLATFORM types this is the
// platform-primary vendor (superadmin can override it); for PER-TENANT types
// it is the fallback when a tenant has not connected their own.

const SYSTEM_DEFAULTS: Record<string, string> = {
  // Per-tenant (BYO via cascade)
  email:        "sendgrid",
  sms:          "twilio",
  phone:        "twilio",
  social:       "buffer",
  calendar:     "google",
  payment:      "stripe",
  // The ONE e-sign default lives in lib/integrations/providers/catalog.ts (lane 89A: DocuSign,
  // embedded in the platform window; wave 88 had Google). Google, Dotloop and every API provider
  // stay selectable through provider_overrides — a selection always wins over the default.
  esign:        DEFAULT_ESIGN_PROVIDER,
  transaction:  "dotloop",
  crm:          "follow_up_boss",
  accounting:   "quickbooks",
  idx:          "idxbroker",   // IDX/MLS feed — subscriber connects their own
  // Platform (system-only). D-ID is the platform-primary video/avatar engine.
  ai:           "anthropic",
  video:        "did",
  avatar:       "did",
  voice_clone:  "elevenlabs",
  ai_voice:     "twilio",
  direct_mail:  "lob",
  scraper:      "apify",       // lead-source scraping — platform-funded keys
  enrichment:   "peopledata",  // skip-trace / contact enrichment — platform-funded
}

// Platform tier — locked to a single vendor chosen by the platform. No
// per-user/team/brokerage overrides; superadmin may swap the vendor.
//
// NOTE on `ai`: this governs the AI *vendor* (the platform AI gateway). It is a
// DIFFERENT axis from AI *model selection*. `resolveAIModel` (lib/kernel/
// ai-model.ts) legitimately routes/caps the model TIER per brokerage/team/user
// for cost governance — that operates within this single platform vendor and is
// not a vendor override, so it does not conflict with `ai` being system-only.
const SYSTEM_ONLY_TYPES = new Set([
  "ai",
  "video",
  "avatar",
  "voice_clone",
  "ai_voice",
  "direct_mail",
  "scraper",
  "enrichment",
])

/**
 * The avatar / avatar-video provider types, whose answer is ALWAYS D-ID (owner, wave 87:
 * "d-id is always first and the perferred"). lib/marketing/video-provider-resolver.ts and
 * lib/providers/dispatch.ts already coerce a non-D-ID answer at their call sites; the
 * registry now refuses to GIVE one, so no future caller can read another vendor first.
 */
const AVATAR_PROVIDER_TYPES = new Set(["video", "avatar"])
function avatarProviderKeyAllowed(providerType: string, key: string): boolean {
  if (key === SYSTEM_DEFAULTS[providerType]) return true
  return providerType === "video" && key === "upload"
}

// ─── RESOLVE PROVIDER ─────────────────────────────────────────────────────────

/** The narrow client surface the core reads through (service client, or a test double). */
export type ProviderReadClient = Pick<SupabaseClient, "from">

type OverrideRow = { provider_key: string; config: unknown }

/**
 * THE CORE (lane 86C). Walks the cascade through the client it is handed, and pins every
 * tenant-scoped tier to `actorContext.brokerageId` before trusting it.
 *
 * WHY. provider_overrides has ONE select policy, `po_select = is_platform_admin()` (live,
 * 2026-09-27). Through the COOKIE client the pre-86C resolver therefore read NOTHING for every
 * caller who is not platform staff — a signed-in broker's own BYO override, the platform's
 * superadmin vendor choice written by lib/platform/platform-providers.ts, all of it — and for
 * every sessionless caller (crons through lib/providers/dispatch.ts, the voice webhook's stage
 * creators). It "resolved" to the system default every time: degraded, never refused. The
 * table is platform CONFIG, so it is read with the SERVICE client, and the tenant comes from
 * the caller's verified context:
 *   · the session door (resolveProvider without a client) proves the session belongs to
 *     `actorContext.brokerageId` (or is platform staff) BEFORE it binds the service client;
 *   · the sessionless door is lib/kernel/tenant-config-reads.ts (server-only), whose callers
 *     pass a tenant they read from a verified row (webhook session, cron row).
 *
 * The pins the service client needs (the policy never supplied them): a USER-scope row is
 * read only when that user belongs to the brokerage, a TEAM-scope row only when the team does.
 * The dispatch layer's `userId: params.userId ?? params.brokerageId` fallback (a brokerages id
 * in a users slot) therefore reads no user tier rather than a row keyed by a foreign-class id.
 * Every refused read is logged with the tier it cost — a refusal is not "no override".
 */
export async function resolveProviderCore(
  client: ProviderReadClient,
  params: ResolveProviderParams,
): Promise<ResolvedProvider> {
  const { providerType, actorContext } = params
  const systemDefault = SYSTEM_DEFAULTS[providerType] ?? providerType

  const readOverride = async (
    scope: "user" | "team" | "brokerage" | "superadmin",
    scopeId: string | null,
  ): Promise<OverrideRow | null> => {
    let q = client
      .from("provider_overrides")
      .select("provider_key, config")
      .eq("provider_type", providerType)
      .eq("scope_type", scope)
      .eq("enabled", true)
    // scope_type='superadmin' rows have no scoped UUID — match on type alone.
    if (scope !== "superadmin") q = q.eq("scope_id", scopeId as string)
    const { data, error } = await q.maybeSingle()
    if (error) {
      console.error(`[providers] ${scope} override read for ${providerType} refused — that tier is skipped:`, error.message)
      return null
    }
    return (data as OverrideRow | null) ?? null
  }
  const answer = (row: OverrideRow, scope: ResolvedProvider["scope"]): ResolvedProvider => ({
    providerKey: row.provider_key,
    config: (row.config as Record<string, any>) ?? {},
    scope,
  })

  // Platform tier: superadmin override (single vendor for the whole app) or
  // the system default. The per-user/team/brokerage cascade does not apply.
  if (SYSTEM_ONLY_TYPES.has(providerType)) {
    const platformOverride = await readOverride("superadmin", null)
    if (platformOverride) {
      // D-ID IS ALWAYS FIRST (owner, wave 87: "d-id is always first and the
      // perferred"). The avatar/video vendor is D-ID; an override row naming any
      // other vendor for these types (a stale 'heygen', a 'simli' written by hand)
      // is not honoured by the registry itself — the answer is D-ID, and 'upload'
      // (agent-provided footage, no avatar render) is the one other video key.
      if (AVATAR_PROVIDER_TYPES.has(providerType) && !avatarProviderKeyAllowed(providerType, platformOverride.provider_key)) {
        console.error(`[providers] superadmin override '${platformOverride.provider_key}' for ${providerType} ignored — D-ID is always first`)
        return { providerKey: systemDefault, config: {}, scope: "system_default" }
      }
      return answer(platformOverride, "superadmin")
    }
    return { providerKey: systemDefault, config: {}, scope: "system_default" }
  }

  const brokerageId = actorContext.brokerageId
  const belongs = async (table: "users" | "teams", id: string | undefined): Promise<boolean> => {
    if (!id || !brokerageId) return false
    const { data, error } = await client.from(table).select("id").eq("id", id).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) {
      console.error(`[providers] ${table} tenant check refused — that tier is skipped:`, error.message)
      return false
    }
    return !!data
  }

  // ── 1. User personal override (the user must be in this tenant) ───────────
  if (await belongs("users", actorContext.userId)) {
    const userOverride = await readOverride("user", actorContext.userId)
    if (userOverride) return answer(userOverride, "user")
  }

  // ── 2. Team override (the team must be in this tenant) ────────────────────
  if (await belongs("teams", actorContext.teamId)) {
    const teamOverride = await readOverride("team", actorContext.teamId as string)
    if (teamOverride) return answer(teamOverride, "team")
  }

  // ── 3. Brokerage override ─────────────────────────────────────────────────
  if (brokerageId) {
    const brokerageOverride = await readOverride("brokerage", brokerageId)
    if (brokerageOverride) return answer(brokerageOverride, "brokerage")
  }

  // ── 4. Superadmin override ────────────────────────────────────────────────
  const superadminOverride = await readOverride("superadmin", null)
  if (superadminOverride) return answer(superadminOverride, "superadmin")

  // ── 5. System default ─────────────────────────────────────────────────────
  return { providerKey: systemDefault, config: {}, scope: "system_default" }
}

/**
 * The SESSION door. With `opts.client` the caller has already verified the tenant and chosen
 * the client (dispatch passes the service client). Without one, the cookie session must belong
 * to `actorContext.brokerageId` — or be platform staff — before the service client is bound;
 * otherwise nothing tenant-scoped is read and the answer is the system default, which is what
 * the RLS-empty read returned before 86C, now said out loud.
 */
export async function resolveProvider(
  params: ResolveProviderParams,
  opts?: { client?: ProviderReadClient },
): Promise<ResolvedProvider> {
  if (opts?.client) return resolveProviderCore(opts.client, params)

  const systemDefault = SYSTEM_DEFAULTS[params.providerType] ?? params.providerType
  const caller = await resolveCallerIdentity().catch(() => null)
  const sameTenant = !!caller?.ok && !!caller.brokerageId && caller.brokerageId === params.actorContext.brokerageId
  const staff = !!caller?.ok && isPlatformStaffRole(caller.platformRole)
  if (!sameTenant && !staff) {
    console.warn(
      `[providers] ${params.providerType}: no session for brokerage ${params.actorContext.brokerageId || "(none)"} — ` +
      "tenant overrides NOT read; a sessionless caller uses lib/kernel/tenant-config-reads.ts resolveTenantProvider",
    )
    return { providerKey: systemDefault, config: {}, scope: "system_default" }
  }
  return resolveProviderCore(createServiceClient(), params)
}
