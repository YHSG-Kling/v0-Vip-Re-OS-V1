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

export type PlatformCredential = {
  id: string
  brokerage_id: string
  agent_user_id: string | null
  platform: string
  scope: string
  access_token: string | null
  api_key: string | null
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

  const { data, error } = await supabase
    .from("platform_credentials")
    .select("*")
    .eq("owner_type", "brokerage")
    .eq("owner_id", brokerageId)
    .order("platform")

  if (error) throw new Error(error.message)
  return (data ?? []) as PlatformCredential[]
}

export async function getProviderOverrides(): Promise<ProviderOverride[]> {
  const acting = await resolveActingContext()
  if (!acting.ok) throw new Error(acting.error)
  const supabase = acting.db
  const { brokerageId } = await getBrokerageId(supabase)

  const { data, error } = await supabase
    .from("provider_overrides")
    .select("*")
    .eq("scope_type", "brokerage")
    .eq("scope_id", brokerageId)
    .order("provider_type")

  if (error) throw new Error(error.message)
  return (data ?? []) as ProviderOverride[]
}

export async function upsertProviderOverride(params: {
  provider_type: string
  provider_key: string
  config?: Record<string, unknown>
  enabled?: boolean
}): Promise<{ success: boolean; error?: string }> {
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
    api_key:       params.api_key ?? null,
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
