"use server"

import { revalidatePath } from "next/cache"
// ★ ACT-AS WRITE SEAM ★ — every export resolves the acting db through the seam:
// writers via resolveWriteContext (read_only impersonation refused, grant
// re-validated at call time), readers via resolveActingContext. The role gate
// (getBrokerageId, below) evaluates the EFFECTIVE identity — the impersonated
// seat when platform staff act as the tenant — through that same db, so the
// investigator holds exactly the seat's authority. Before this, the gate read
// the RAW auth user's row (the staff row, NULL brokerage → refused) and the
// writes rode the cookie client, which tenant RLS silently zero-rowed under
// act-as.
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
import { selectableConnectionsForScope, candidateProvider } from "@/lib/connections/scope"
import { canonicalProvider } from "@/lib/integrations/connection-manager"
import { encryptSecret } from "@/lib/security/secret-crypto"
import { publicCredentialSelect } from "@/lib/security/credential-projection"
import { CONFIG_SECRET_KEYS } from "@/lib/connections/credential-secret"

/**
 * A brokerage credential AS THE BROWSER MAY SEE IT (wave 140, lane 140P). The secret columns
 * (`api_key`, `access_token`, `refresh_token` — sealed `enc:v1:` envelopes since 140H) are NOT
 * here: this type is the return value of a `"use server"` export, i.e. it is shipped to the
 * settings page in a browser that has no key and never needs the value. Each secret is
 * projected to a `*_configured` boolean, answered by the database (a NOT NULL filter), so the
 * ciphertext never even reaches the server process for this read. `config` is the row's
 * jsonb minus CONFIG_SECRET_KEYS (the Twilio auth_token / api_secret / client_secret that
 * some connectors keep inside it — lane 140H item 2).
 */
export type PlatformCredential = {
  id: string
  brokerage_id: string
  agent_user_id: string | null
  platform: string
  scope: string
  /** A stored (sealed) api_key exists — never the value, never its ciphertext. */
  api_key_configured: boolean
  /** A stored (sealed) access_token exists — never the value, never its ciphertext. */
  access_token_configured: boolean
  api_url: string | null
  token_expires_at: string | null
  account_id: string | null
  account_name: string | null
  is_active: boolean
  last_synced_at: string | null
  sync_error: string | null
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** PURE. The jsonb config with every CONFIG_SECRET_KEYS entry removed (the browser projection). */
function redactConfigSecrets(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if ((CONFIG_SECRET_KEYS as readonly string[]).includes(k)) continue
    out[k] = v
  }
  return out
}

export type ProviderOverride = {
  id: string
  scope_type: string
  scope_id: string | null
  provider_type: string
  provider_key: string
  config: Record<string, unknown>
  enabled: boolean
  created_at: string
  updated_at: string
}

/** The providers a BROKERAGE may connect, derived from the Connection OS.
 *  Deliberately computed, never restated — see upsertPlatformCredential.
 *
 *  ONE VOCABULARY (§6, wave 26): this used to walk domainsForScope() and index
 *  CONNECTOR_PROVIDERS by hand, which is the entire body of
 *  `selectableConnectionsForScope` (lib/connections/scope.ts:157) — the function
 *  that module's own comment calls "the UI source of truth" for a scope. Two
 *  computations of one answer, and the comment above already claimed the answer
 *  was never restated while restating it. Flattened from the survivor now, so a
 *  domain or provider added there cannot be admitted by one and refused by the
 *  other. */
function BROKERAGE_CONNECTABLE_PROVIDERS(): string[] {
  const byDomain = selectableConnectionsForScope("brokerage")
  return [...new Set(Object.values(byDomain).flat())].sort()
}

/** Roles allowed to see or change a brokerage's provider credentials.
 *  TENANT ADMIN GATE (kept inline, tenant credentials — deliberately no
 *  team_lead): 'superadmin' removed — dead as users.user_type (0 live rows);
 *  broker_owner added — storable seat that owns the brokerage. */
const CREDENTIAL_ADMIN_ROLES = ["admin", "broker", "broker_owner", "broker_admin"]

/**
 * Resolve the caller's brokerage AND enforce that they may administer its provider
 * credentials.
 *
 * This file previously had NO authorization on any export. platform_credentials holds
 * provider API keys, access tokens and account bindings, and provider_overrides decides
 * which provider each capability routes through — yet every producing agent in a
 * brokerage could read them, and upsertPlatformCredential / togglePlatformCredential /
 * upsertProviderOverride let them write. The surface is also reachable from the AGENT
 * navigation ("Settings → Integrations"), so this was not a theoretical path.
 *
 * Scope was never the problem — every query is already brokerage-scoped, so this was
 * never cross-tenant. It was privilege: credential administration is the broker's, not
 * an individual agent's. Same role set and fail-closed shape as the requireBrokerAdmin
 * used by the sibling provider-settings and global-settings actions.
 *
 * `role` is read alongside `user_type` because user_type is canonical but older rows
 * carry the value in role — matching how the rest of the codebase resolves this.
 */
async function getBrokerageId(supabase: { from: (table: string) => any }) {
  // The EFFECTIVE identity — getAgentContext re-validates any impersonation
  // grant on this call, and returns the impersonated seat's userId when
  // acting-as. The row read rides the caller's ACTING db (`supabase`): cookie
  // for a normal user (their own row, RLS-permitted), service under act-as so
  // the impersonated seat's row is readable.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId) throw new Error("Not authenticated")
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id, user_type, role")
    .eq("id", ctx.userId)
    .maybeSingle()
  if (profileError) throw new Error(`Could not resolve your profile: ${profileError.message}`)
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  const resolvedRole = String(
    (profile as { user_type?: string | null; role?: string | null }).user_type ??
      (profile as { role?: string | null }).role ??
      "",
  )
  if (!CREDENTIAL_ADMIN_ROLES.includes(resolvedRole)) {
    throw new Error("Forbidden: provider credentials are managed by your broker or admin")
  }

  return { userId: ctx.userId, brokerageId: profile.brokerage_id as string }
}

export async function getPlatformCredentials(): Promise<PlatformCredential[]> {
  const acting = await resolveActingContext()
  if (!acting.ok) throw new Error(acting.error)
  const supabase = acting.db
  const { brokerageId } = await getBrokerageId(supabase)

  // The NON-secret projection (lib/security/credential-projection.ts — spelled once per store), plus
  // two presence reads the database answers: which rows HAVE a sealed api_key / access_token. The
  // secret columns are never selected here (was `select("*")`, which shipped the envelopes to the browser).
  const base = supabase.from("platform_credentials").select(publicCredentialSelect("platform_credentials")).eq("owner_type", "brokerage").eq("owner_id", brokerageId).order("platform")
  const keyed = supabase.from("platform_credentials").select("id").eq("owner_type", "brokerage").eq("owner_id", brokerageId).not("api_key", "is", null)
  const tokened = supabase.from("platform_credentials").select("id").eq("owner_type", "brokerage").eq("owner_id", brokerageId).not("access_token", "is", null)
  const [{ data, error }, { data: keyedRows, error: keyedError }, { data: tokenedRows, error: tokenedError }] = await Promise.all([base, keyed, tokened])

  if (error) throw new Error(error.message)
  if (keyedError) throw new Error(keyedError.message)
  if (tokenedError) throw new Error(tokenedError.message)
  const hasKey = new Set(((keyedRows ?? []) as Array<{ id: string }>).map((r) => r.id))
  const hasToken = new Set(((tokenedRows ?? []) as Array<{ id: string }>).map((r) => r.id))
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    brokerage_id: row.brokerage_id as string,
    agent_user_id: (row.agent_user_id as string | null) ?? null,
    platform: row.platform as string,
    scope: (row.scope as string) ?? "brokerage",
    api_key_configured: hasKey.has(row.id as string),
    access_token_configured: hasToken.has(row.id as string),
    api_url: (row.api_url as string | null) ?? null,
    token_expires_at: (row.token_expires_at as string | null) ?? null,
    account_id: (row.account_id as string | null) ?? null,
    account_name: (row.account_name as string | null) ?? null,
    is_active: row.is_active === true,
    last_synced_at: (row.last_synced_at as string | null) ?? null,
    sync_error: (row.sync_error as string | null) ?? null,
    config: redactConfigSecrets(row.config),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }))
}

export async function getProviderOverrides(): Promise<ProviderOverride[]> {
  const acting = await resolveActingContext()
  if (!acting.ok) throw new Error(acting.error)
  const supabase = acting.db
  const { brokerageId } = await getBrokerageId(supabase)

  const { data, error } = await supabase
    .from("provider_overrides")
    .select("id, scope_type, scope_id, provider_type, provider_key, config, enabled, created_at, updated_at")
    .eq("scope_type", "brokerage")
    .eq("scope_id", brokerageId)
    .order("provider_type")

  if (error) throw new Error(error.message)
  return (data ?? []) as ProviderOverride[]
}

/** Tenant-side provider overrides this action refuses outright, regardless of
 *  what the caller submits. Wave 69 owner ruling (verbatim): "rentcast is
 *  platform provided but idx is for tenant connected... the setting page
 *  should only allow them to setup their idx connection." RentCast is a
 *  PLATFORM credential (RENTCAST_API_KEY) selected by derived resolver logic
 *  — never a tenant-chosen MLS provider. Fail closed here too, not only in
 *  the UI select list (integrations-client.tsx PROVIDER_KEYS_BY_TYPE), so a
 *  direct call to this "use server" export can't re-open the option the UI
 *  removed. Survivor: lib/buyer-search/listing-source-order.ts::resolveActiveListingSources. */
const REFUSED_PROVIDER_OVERRIDES: Record<string, string[]> = {
  mls: ["rentcast"],
}

export async function upsertProviderOverride(params: {
  provider_type: string
  provider_key: string
  config?: Record<string, unknown>
  enabled?: boolean
}): Promise<{ success: boolean; error?: string }> {
  if (REFUSED_PROVIDER_OVERRIDES[params.provider_type]?.includes(params.provider_key)) {
    return {
      success: false,
      error: `"${params.provider_key}" is platform-managed and cannot be set as a tenant ${params.provider_type} override — see lib/buyer-search/listing-source-order.ts`,
    }
  }

  // ACT-AS WRITE SEAM — read_only refused; the write rides the acting db.
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { success: false, error: ctx.error }
  const supabase = ctx.db
  const { brokerageId } = await getBrokerageId(supabase)

  const { error } = await supabase
    .from("provider_overrides")
    .upsert(
      {
        scope_type:   "brokerage",
        scope_id:     brokerageId,
        provider_type: params.provider_type,
        provider_key:  params.provider_key,
        config:        params.config ?? {},
        enabled:       params.enabled ?? true,
        updated_at:    new Date().toISOString(),
      },
      { onConflict: "scope_type,scope_id,provider_type" }
    )

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/integrations")
  return { success: true }
}

export async function upsertPlatformCredential(params: {
  platform: string
  scope?: string
  api_key?: string
  api_url?: string
  account_id?: string
  account_name?: string
  config?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string }> {
  // ACT-AS WRITE SEAM — read_only refused; the credential write rides the acting db.
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { success: false, error: ctx.error }
  const supabase = ctx.db
  const { brokerageId } = await getBrokerageId(supabase)

  // The form takes `platform` as FREE TEXT and wrote it straight into a
  // CHECK-constrained column, so a near-miss came back as a raw Postgres
  // constraint string that does not say which platforms are valid.
  //
  // The allow-list is NOT restated here. lib/connections/scope.ts is the
  // Connection OS single source of truth for what a scope may connect ("the UI
  // selector, write-side gating, and dispatch resolvers all read from here so
  // the allow-lists never drift apart again"), so this derives from it. A
  // second hand-kept list next to it is exactly the drift this file is meant to
  // prevent — a provider must be decided in scope.ts (and owned in
  // lib/providers/tenancy-matrix.ts), never by being typed into this box.
  const canonical = canonicalProvider(params.platform)
  const allowed = BROKERAGE_CONNECTABLE_PROVIDERS()
  if (!allowed.includes(canonical)) {
    // A provider we have BUILT but not switched on answers differently from one
    // we have never heard of — otherwise a broker asking for Xero or WordPress
    // gets a flat "not connectable" and we lose the request.
    const candidate = candidateProvider(canonical)
    if (candidate) {
      return {
        success: false,
        error:
          `'${params.platform}' is supported but not enabled yet — ${candidate.blockedBy} ` +
          `Ask your platform admin to turn it on; the integration itself is already built.`,
      }
    }
    return {
      success: false,
      error: `'${params.platform}' is not a connectable provider. Connectable: ${allowed.join(", ")}`,
    }
  }

  // Owner-keyed update-or-insert. The unique key is (owner_type, owner_id,
  // platform) and it is REAL — VERIFIED LIVE, not assumed: m104 created it as
  // `platform_credentials_owner_uniq`, a PARTIAL UNIQUE INDEX
  // `WHERE owner_type IS NOT NULL`, and a duplicate insert is refused with 23505.
  // It is spelled out here because it lives in pg_index and NOT in pg_constraint:
  // a check that dumps pg_constraint for this table sees only the two FKs and the
  // three CHECKs, reads the key as absent, and reports this comment as a lie. It
  // is not. A concurrent OAuth callback racing this read-then-write cannot
  // duplicate the credential — the second writer gets 23505, not a second row.
  const credRow = {
    brokerage_id:  brokerageId,
    owner_type:    "brokerage",
    owner_id:      brokerageId,
    platform:      params.platform,
    scope:         params.scope ?? "brokerage",
    // Sealed at the write (wave 140H). `undefined` stays undefined — an update that omits api_key keeps the
    // stored key (supabase-js drops the field); it is never turned into null and destroyed.
    api_key:       encryptSecret(params.api_key),
    api_url:       params.api_url ?? null,
    account_id:    params.account_id ?? null,
    account_name:  params.account_name ?? null,
    config:        params.config ?? {},
    is_active:     true,
    updated_at:    new Date().toISOString(),
  }
  const { data: existingCred } = await supabase
    .from("platform_credentials")
    .select("id").eq("owner_type", "brokerage").eq("owner_id", brokerageId).eq("platform", params.platform).maybeSingle()
  const { error } = existingCred
    ? await supabase.from("platform_credentials").update(credRow).eq("id", existingCred.id)
    : await supabase.from("platform_credentials").insert(credRow)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/integrations")
  return { success: true }
}

export async function togglePlatformCredential(
  id: string,
  isActive: boolean
): Promise<{ success: boolean; error?: string }> {
  // ACT-AS WRITE SEAM — read_only refused; the toggle rides the acting db.
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { success: false, error: ctx.error }
  const supabase = ctx.db
  const { brokerageId } = await getBrokerageId(supabase)

  // Zero rows toggled is a refusal (wrong id / other tenant), not success.
  const { data: toggled, error } = await supabase
    .from("platform_credentials")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_type", "brokerage")
    .eq("owner_id", brokerageId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!toggled || toggled.length === 0) {
    return { success: false, error: "That credential is not in your brokerage" }
  }
  revalidatePath("/dashboard/settings/integrations")
  return { success: true }
}
