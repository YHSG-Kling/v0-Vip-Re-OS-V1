/**
 * Connection Manager — read-layer unifier for external provider connections.
 *
 * The platform stores third-party credentials across THREE tables that grew
 * independently and disagree on provider naming:
 *
 *   - platform_credentials   (brokerage/agent scope; OAuth + api_key; canonical
 *                             names like "idxbroker", "docusign", "gmail")
 *   - integration_credentials(brokerage scope; provider_name like "idx_broker",
 *                             "rentcast", "gohighlevel")
 *   - agent_api_credentials  (per-agent; service_name like "idx_broker", socials)
 *
 * This module does NOT migrate data. It provides one canonical naming scheme and
 * a single resolver that reads across all three tables in a defined precedence,
 * returning one normalized shape so dispatch-time callers (crons, webhooks,
 * server actions, provider clients) stop guessing which table/name to use.
 *
 * Precedence (most specific → least): agent_api_credentials → platform_credentials
 * (agent scope) → platform_credentials (brokerage scope) → integration_credentials.
 *
 * ─── A REFUSED READ IS NOT AN ABSENT ROW, AND THE PRECEDENCE STOPS ON ONE ────
 * This module used to answer two different facts with one value. All FOUR reads
 * below were written
 *
 *     const { data } = await svc.from(…)          // refused == empty
 *     if (data) return { … }
 *
 * and supabase-js RESOLVES a refused query rather than throwing, so a refusal
 * arrived as `data: null` — byte-for-byte how "no rows" arrives if you only
 * destructure `data`. The precedence walk then DESCENDED past it to the next
 * store. That is how one store's outage becomes another owner's credential: a
 * refused `agent_api_credentials` read did not stop the walk, it returned the
 * BROKERAGE's platform_credentials row instead, and every caller reads a hit as
 * an ordinary hit. Not a failure — a successful call made with somebody else's
 * account.
 *
 * `lib/connections/resolve-scoped.ts` fixed exactly this shape one layer up in
 * wave 19 and recorded THIS function as the half it could not reach. So the same
 * three states live here now:
 *
 *     connected      a credential resolved, in a named store
 *     not_connected  every store answered, and none of them has one
 *     unreadable     a store could not be READ, so nothing below it may be trusted
 *
 * `resolveConnectionResult` is the honest answer. `resolveConnection` is kept as
 * a thin projection for the callers that only ask "is there one" — see its
 * docstring for why `unreadable` maps to null there rather than throwing.
 *
 * Migration-safe, on a CLOSED SET: a read is allowed to fall through to the next
 * store when the error says something structural about the SCHEMA (that column /
 * that table is not there), and on nothing else. An unclassified failure — a
 * permission refusal, a timeout, an error with no code at all — is `unreadable`,
 * because guessing "probably pre-migration" on an unknown code is the same
 * collapse in a nicer coat.
 */

import { createServiceClient } from "@/lib/supabase/service"

/** canonical name → every alias that appears in any table for the same provider. */
const PROVIDER_ALIASES: Record<string, string[]> = {
  idxbroker:      ["idxbroker", "idx_broker", "idx"],
  gmail:          ["gmail", "google"],
  outlook:        ["outlook", "microsoft"],
  formsimplicity: ["formsimplicity", "form_simplicity"],
  brokermint:     ["brokermint", "broker_mint"],
  gohighlevel:    ["gohighlevel", "ghl"],
  realtor_com:    ["realtor_com", "realtorcom", "realtor.com"],
}

/** Normalize any provider string (from any table or UI) to its canonical name. */
export function canonicalProvider(name: string): string {
  const lc = (name ?? "").trim().toLowerCase()
  for (const [canon, aliases] of Object.entries(PROVIDER_ALIASES)) {
    if (aliases.includes(lc)) return canon
  }
  return lc
}

/** Every name a provider may be stored under, for cross-table `.in()` matching. */
export function aliasesFor(name: string): string[] {
  const canon = canonicalProvider(name)
  return PROVIDER_ALIASES[canon] ?? [canon]
}

export type ConnectionSource = "platform_credentials" | "integration_credentials" | "agent_api_credentials"

export interface ResolvedConnection {
  /** Canonical provider name. */
  provider: string
  source: ConnectionSource
  scope: "agent" | "brokerage"
  credentialId: string
  apiKey: string | null
  apiSecret: string | null
  accessToken: string | null
  refreshToken: string | null
  accountId: string | null
  accountName: string | null
  apiUrl: string | null
  config: Record<string, unknown>
  isActive: boolean
  /**
   * OAuth token expiry (ISO-8601) when the store carries one, else null.
   *
   * Selected so a CALLER can ask the connectivity agent whether a live
   * connection is about to lapse (deriveConnectivityStatus). Without it every
   * consumer saw only "connected / not connected" and an expiring token was
   * indistinguishable from a healthy one until the day it stopped working.
   */
  tokenExpiresAt: string | null
}

export interface ResolveConnectionInput {
  brokerageId: string
  provider: string
  /** users.id — used for platform_credentials agent-scoped rows. */
  agentUserId?: string
  /** agents.id — used for agent_api_credentials rows. */
  agentId?: string
}

/**
 * THE DISCRIMINATED ANSWER. "We looked in every store and there is none" and "we
 * could not look" are opposite facts about a tenant, and a caller that has to
 * decide whether to dispatch a campaign, spend against a vendor or tell a user
 * "you are not connected" needs to be able to tell them apart. `unreadable`
 * names the STORE that could not be read, so a caller can say WHERE rather than
 * just "something went wrong".
 */
export type ConnectionResolutionResult =
  | { status: "connected"; connection: ResolvedConnection }
  | { status: "not_connected" }
  | {
      status: "unreadable"
      /** Which of the three credential stores refused. */
      store: ConnectionSource
      /** The precedence tier that store was being read at when it refused. */
      scope: "agent" | "brokerage"
      detail: string
    }

/**
 * The ONLY error codes that are allowed to mean "this shape does not exist on
 * this deployment yet, keep descending".
 *
 *   42703  undefined_column   — a selected column is not migrated in yet
 *   42P01  undefined_table    — the store itself is not there yet
 *   PGRST204 / PGRST205       — PostgREST cannot find that column / that table
 *
 * Deliberately the SAME closed set `lib/connections/resolve-scoped.ts` uses, for
 * the same reason: everything else is `unreadable`, INCLUDING an error with no
 * code at all. `42501` (insufficient_privilege) is a refusal, a timeout is a
 * refusal, and an unrecognised failure is — as far as this module can honestly
 * say — a refusal too. The unknown falls on the fail-closed side of the line.
 */
const SCHEMA_ABSENT_CODES = new Set(["42703", "42P01", "PGRST204", "PGRST205"])

/**
 * What a populated `error` from ONE credential store means. Named rather than
 * inlined on the signature below so the return type carries no brace — a proof
 * that slices a function body by "the first `{` after the parameter list" would
 * otherwise read the return type and report an empty body.
 */
type StoreErrorClass = { status: "schema_absent" | "unreadable"; detail: string }

/**
 * Classify a populated `error` from ONE credential store. Only ever called when
 * `error` is truthy, so there is no "found"/"absent" here — those are read off
 * `data` at the call site, AFTER the error has been inspected on its own.
 */
function classifyStoreError(
  store: ConnectionSource,
  error: { code?: string | null; message?: string | null },
): StoreErrorClass {
  const code = error?.code ?? null
  const detail = `${store}: ${code ?? "no-code"}: ${error?.message ?? "unknown read error"}`
  if (code && SCHEMA_ABSENT_CODES.has(code)) return { status: "schema_absent", detail }
  return { status: "unreadable", detail }
}

/**
 * Resolve a single provider connection for a brokerage (optionally agent-scoped),
 * reading across all three credential tables, HONESTLY. Most-specific store wins;
 * a store that cannot be READ stops the walk instead of handing back a
 * less-specific owner's credential.
 *
 * Never throws — it returns `unreadable` instead, so the failure is a value a
 * caller can branch on rather than an exception six call sites would have to
 * learn to catch.
 */
export async function resolveConnectionResult(
  input: ResolveConnectionInput
): Promise<ConnectionResolutionResult> {
  // Which read we are inside, so a THROW can name the store the same way a
  // resolved refusal does.
  let stage: ConnectionSource = "agent_api_credentials"
  let stageScope: "agent" | "brokerage" = "agent"
  try {
    const svc = createServiceClient()
    const canon = canonicalProvider(input.provider)
    const aliases = aliasesFor(canon)

    // 1. agent_api_credentials (per-agent, most specific)
    if (input.agentId) {
      stage = "agent_api_credentials"
      stageScope = "agent"
      const { data, error } = await svc
        .from("agent_api_credentials")
        .select("id, api_key, api_secret, access_token, refresh_token, config, is_active, token_expires_at")
        .eq("agent_id", input.agentId)
        .in("service_name", aliases)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle()
      // The error is inspected FIRST and on its own. Reading `data` while an
      // error is still unread is how a refusal becomes an absence.
      if (error) {
        const c = classifyStoreError("agent_api_credentials", error)
        if (c.status === "unreadable") {
          // STOP. Do NOT descend. This agent's OWN key may well be in the store
          // we just failed to read, and continuing hands back the brokerage's or
          // the platform's row as if it were theirs.
          return { status: "unreadable", store: "agent_api_credentials", scope: "agent", detail: c.detail }
        }
        // schema_absent — this store's shape is not on this deployment, so it has
        // nothing to say. Only that continues the walk.
      } else if (data) {
        return {
          status: "connected",
          connection: {
            provider: canon, source: "agent_api_credentials", scope: "agent", credentialId: data.id,
            apiKey: data.api_key ?? null, apiSecret: data.api_secret ?? null,
            accessToken: data.access_token ?? null, refreshToken: data.refresh_token ?? null,
            accountId: null, accountName: null, apiUrl: null,
            config: (data.config as Record<string, unknown>) ?? {}, isActive: true,
            tokenExpiresAt: data.token_expires_at ?? null,
          },
        }
      }
    }

    // 2 + 3. platform_credentials — agent scope first, then brokerage scope.
    for (const scope of ["agent", "brokerage"] as const) {
      if (scope === "agent" && !input.agentUserId) continue
      stage = "platform_credentials"
      stageScope = scope
      let q = svc
        .from("platform_credentials")
        .select("id, api_key, access_token, refresh_token, account_id, account_name, api_url, config, is_active, token_expires_at")
        .eq("brokerage_id", input.brokerageId)
        .in("platform", aliases)
        .eq("scope", scope)
        .eq("is_active", true)
      if (scope === "agent") q = q.eq("agent_user_id", input.agentUserId!)
      const { data, error } = await q.limit(1).maybeSingle()
      if (error) {
        const c = classifyStoreError("platform_credentials", error)
        if (c.status === "unreadable") {
          return { status: "unreadable", store: "platform_credentials", scope, detail: c.detail }
        }
      } else if (data) {
        return {
          status: "connected",
          connection: {
            provider: canon, source: "platform_credentials", scope, credentialId: data.id,
            apiKey: data.api_key ?? null, apiSecret: null,
            accessToken: data.access_token ?? null, refreshToken: data.refresh_token ?? null,
            accountId: data.account_id ?? null, accountName: data.account_name ?? null,
            apiUrl: data.api_url ?? null,
            config: (data.config as Record<string, unknown>) ?? {}, isActive: true,
            tokenExpiresAt: data.token_expires_at ?? null,
          },
        }
      }
    }

    // 4. integration_credentials (brokerage-wide, simplest shape)
    stage = "integration_credentials"
    stageScope = "brokerage"
    const { data, error } = await svc
      .from("integration_credentials")
      .select("id, api_key, api_secret, webhook_url, is_active")
      .eq("brokerage_id", input.brokerageId)
      .in("provider_name", aliases)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    if (error) {
      const c = classifyStoreError("integration_credentials", error)
      if (c.status === "unreadable") {
        return { status: "unreadable", store: "integration_credentials", scope: "brokerage", detail: c.detail }
      }
    } else if (data) {
      return {
        status: "connected",
        connection: {
          provider: canon, source: "integration_credentials", scope: "brokerage", credentialId: data.id,
          apiKey: data.api_key ?? null, apiSecret: data.api_secret ?? null,
          accessToken: null, refreshToken: null, accountId: null, accountName: null,
          apiUrl: data.webhook_url ?? null,
          config: {}, isActive: true,
          // integration_credentials carries no expiry column — a static key store.
          tokenExpiresAt: null,
        },
      }
    }

    return { status: "not_connected" }
  } catch (err) {
    // A THROW is a real failure — a dead client, a transport error, a service
    // client that could not be constructed. A missing column does NOT throw: it
    // comes back as a classified `error` above. So this is `unreadable`, never a
    // silent fall-through to the next store.
    return {
      status: "unreadable",
      store: stage,
      scope: stageScope,
      detail: `${stage}: read threw for ${input.provider} — ${(err as Error)?.message ?? "unknown error"}`,
    }
  }
}

/**
 * Resolve a single provider connection for a brokerage (optionally agent-scoped),
 * reading across all three credential tables. Returns null if none is active.
 *
 * COMPATIBILITY PROJECTION over `resolveConnectionResult`, and it maps
 * `unreadable` to **null** deliberately — the same ruling `resolveScopedConnection`
 * made one layer up, for the same reasons:
 *
 *   · Every existing caller reads null as "not connected" and takes a fallback it
 *     has already thought through — an honest "not connected" badge, a skipped
 *     probe, a capability reported as not operable. Making this THROW on
 *     `unreadable` would push an uncaught exception into a cron route and two
 *     capability resolvers whose own docstrings promise they never throw, and
 *     would be silently swallowed by the two `.catch(() => null)` sites that used
 *     to sit in vibe.ts. A behaviour change nobody reviewed, dressed as a fix.
 *
 *   · null is also the fail-CLOSED answer for this shape. The alternative was
 *     never "keep working" — it was "keep working with somebody else's
 *     credential", which is what the descent used to do and what stopping on a
 *     refusal now prevents.
 *
 * The one behaviour that DID change for these callers is the one being fixed: an
 * unreadable store now yields null instead of quietly falling through to the
 * brokerage's or the platform's row. Callers that must tell "none" from "could
 * not look" — starting with the Vibe CTV dispatcher and the legacy fallback in
 * `lib/connections/resolve-scoped.ts` — call `resolveConnectionResult` directly.
 */
export async function resolveConnection(
  input: ResolveConnectionInput
): Promise<ResolvedConnection | null> {
  const result = await resolveConnectionResult(input)
  return result.status === "connected" ? result.connection : null
}
