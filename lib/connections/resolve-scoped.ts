// lib/connections/resolve-scoped.ts
// THE unified connection resolver. Walks the ownership cascade (agent → team → brokerage →
// platform, or vendor/contact → platform) and returns the first active credential, reading
// the owner-scoped credential store by the new (owner_type, owner_id) scope. Falls back to the
// legacy connection-manager so it works BEFORE and AFTER the m102 owner-scope migration.
//
// ─── A REFUSED READ IS NOT AN ABSENT ROW, AND THE CASCADE STOPS ON ONE ───────
// This module used to answer three different facts with one value:
//
//     if (error || !data) return null          // refused == empty
//     } catch { return null }                  // thrown == empty
//
// and the cascade loop then DESCENDED past that null to the next owner. That is
// how one tier's outage becomes another tier's credential: if the agent-tier read
// is REFUSED rather than empty, the loop kept walking and returned the team's, the
// brokerage's, or the PLATFORM'S credential — a successful call made with somebody
// else's account, indistinguishable from a normal hit at every one of the twelve
// call sites. An agent's text from another number, a financial write in the wrong
// ledger, a signature request from the wrong account.
//
// So resolution now reports three states, not two:
//
//     connected      a credential resolved, at a named owner
//     not_connected  every tier answered, and none of them has one
//     unreadable     a tier could not be READ, so nothing below it may be trusted
//
// `resolveScopedConnectionResult` is the honest answer. `resolveScopedConnection`
// is a thin compatibility wrapper for the callers that only ask "is there one".
//
// Migration-safe: the owner_type/owner_id read is still allowed to fall through when
// those columns don't exist yet, but ONLY on the Postgres/PostgREST codes that mean
// exactly "this column or table is not there" — never on an unclassified failure.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { canonicalProvider, aliasesFor, resolveConnection, type ResolvedConnection } from "@/lib/integrations/connection-manager"
import { scopeCascade, type ScopeContext, type ConnectionScope } from "./scope"

export interface ScopedConnection extends ResolvedConnection {
  ownerType: ConnectionScope
  ownerId: string
}

/**
 * THE DISCRIMINATED ANSWER. "We looked and there is none" and "we could not look"
 * are opposite facts about a tenant, and a caller that has to decide whether to
 * spend money, send a text, or write to a ledger needs to be able to tell them
 * apart. `unreadable` names the owner tier that could not be read, so a caller can
 * say WHERE rather than just "something went wrong".
 */
export type ScopedConnectionResult =
  | { status: "connected"; connection: ScopedConnection }
  | { status: "not_connected" }
  | {
      status: "unreadable"
      /** The owner tier whose read failed, or null when the LEGACY path failed. */
      ownerType: ConnectionScope | null
      ownerId: string | null
      detail: string
    }

/**
 * What ONE owner's credential read found.
 *
 * `absent` and `schema_absent` both mean "this tier has nothing to say" and the
 * cascade continues past them. `unreadable` means the tier could not be consulted
 * at all, and the cascade STOPS — see `resolveScopedConnectionResult`.
 */
type OwnerCredentialRead =
  | { status: "found"; connection: ScopedConnection }
  | { status: "absent" }
  | { status: "schema_absent"; detail: string }
  | { status: "unreadable"; detail: string }

/**
 * The ONLY error codes that are allowed to mean "this shape does not exist yet,
 * fall through to the legacy path".
 *
 * These are Postgres SQLSTATEs and PostgREST's own schema-cache codes, and they
 * say something structural about the SCHEMA rather than about this request:
 *
 *   42703  undefined_column        — the owner-scope columns are not migrated in yet
 *   42P01  undefined_table         — the store itself is not there yet
 *   PGRST204 / PGRST205            — PostgREST cannot find that column / that table
 *
 * Everything else is `unreadable`, INCLUDING an error with no code at all. That
 * asymmetry is the whole point: `42501` (insufficient_privilege) is a refusal, a
 * timeout is a refusal, and an unrecognised failure is — as far as this resolver
 * can honestly say — a refusal too. Guessing "probably pre-migration" on an
 * unknown code is exactly the collapse this module is being fixed for, so the
 * unknown falls on the fail-closed side of the line.
 */
const SCHEMA_ABSENT_CODES = new Set(["42703", "42P01", "PGRST204", "PGRST205"])

function classifyReadError(error: { code?: string | null; message?: string | null }): OwnerCredentialRead {
  const code = error?.code ?? null
  const detail = `${code ?? "no-code"}: ${error?.message ?? "unknown read error"}`
  if (code && SCHEMA_ABSENT_CODES.has(code)) return { status: "schema_absent", detail }
  return { status: "unreadable", detail }
}

/**
 * Read ONE owner's active credential for a provider by owner scope.
 *
 * The three outcomes are kept apart on purpose. supabase-js RESOLVES a refused
 * query — a refusal arrives as a populated `error` with `data` null, which is
 * byte-for-byte how "no rows" arrives if you only destructure `data`. So `error`
 * is inspected FIRST and on its own, and only a genuinely empty result is
 * reported as `absent`.
 */
async function readOwnerCredential(
  ownerType: ConnectionScope,
  ownerId: string,
  provider: string,
): Promise<OwnerCredentialRead> {
  try {
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("platform_credentials")
      .select("id, platform, api_key, access_token, refresh_token, account_id, account_name, api_url, config, is_active, token_expires_at")
      .eq("owner_type", ownerType)
      .eq("owner_id", ownerId)
      .in("platform", aliasesFor(provider))
      .eq("is_active", true)
      .order("last_tested_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    // A refusal and an absence are SEPARATE answers, and the error is read FIRST
    // and on its own. Collapsing them into `error || !data` is the defect.
    if (error) return classifyReadError(error)
    if (!data) return { status: "absent" }
    return {
      status: "found",
      connection: {
        provider: canonicalProvider(data.platform),
        source: "platform_credentials",
        scope: ownerType === "agent" ? "agent" : "brokerage",
        credentialId: data.id,
        apiKey: data.api_key ?? null,
        apiSecret: null,
        accessToken: data.access_token ?? null,
        refreshToken: data.refresh_token ?? null,
        accountId: data.account_id ?? null,
        accountName: data.account_name ?? null,
        apiUrl: data.api_url ?? null,
        config: (data.config as Record<string, unknown>) ?? {},
        isActive: true,
        // Carried so a caller can ask the connectivity agent whether this owner's
        // token is about to lapse — the owner-scoped cascade must not be the one
        // path that loses the expiry signal.
        tokenExpiresAt: data.token_expires_at ?? null,
        ownerType,
        ownerId,
      },
    }
  } catch (err) {
    // A THROW is a real failure — a dead client, a transport error, a service
    // client that could not be constructed. It used to be swallowed here behind a
    // note about a missing column, but a missing column does NOT throw: it comes
    // back as a classified `error` above. So this is `unreadable`, never a silent
    // fall-through.
    return {
      status: "unreadable",
      detail: `credential read threw for ${ownerType}:${ownerId} — ${(err as Error)?.message ?? "unknown error"}`,
    }
  }
}

/**
 * Resolve a provider connection across the full ownership cascade, HONESTLY.
 * Most-specific owner wins; a tier that cannot be read stops the walk.
 *
 * Never throws — it returns `unreadable` instead, which is the point: the failure
 * is a value a caller can branch on rather than an exception twelve call sites
 * would have to learn to catch.
 */
export async function resolveScopedConnectionResult(
  provider: string,
  ctx: ScopeContext & { agentId?: string | null },
): Promise<ScopedConnectionResult> {
  // 1. New owner-scope cascade (agent → team → brokerage → platform, or vendor/contact → platform).
  for (const owner of scopeCascade(ctx)) {
    const read = await readOwnerCredential(owner.ownerType, owner.ownerId, provider)
    if (read.status === "found") return { status: "connected", connection: read.connection }
    if (read.status === "unreadable") {
      // STOP. Do NOT descend. A tier we could not read may well hold this actor's
      // own credential, and continuing would hand back a LESS specific owner's —
      // the team's, the brokerage's, or the product's own platform account — as if
      // it were theirs. Every caller reads a hit as a normal hit, so that is not a
      // visible failure, it is a silent substitution of one tenant's account for
      // another's. Refusing here costs one call; descending costs the wrong one.
      return { status: "unreadable", ownerType: owner.ownerType, ownerId: owner.ownerId, detail: read.detail }
    }
    // `absent` (no row) and `schema_absent` (the owner-scope shape is not migrated
    // in yet) both mean this tier genuinely has nothing to say. Only those two
    // continue the walk.
  }

  // 2. Legacy fallback — connection-manager (agent + brokerage credential stores). This
  //    keeps every existing connection working until m102 backfill + writes are in place.
  if (ctx.brokerageId) {
    let legacy: ResolvedConnection | null
    try {
      legacy = await resolveConnection({
        brokerageId: ctx.brokerageId,
        provider,
        agentUserId: ctx.agentUserId ?? undefined,
        agentId: ctx.agentId ?? undefined,
      })
    } catch (err) {
      // Used to be `.catch(() => null)`, which turned a dead legacy store into
      // "this tenant has no connection". LIMITATION, stated rather than papered
      // over: `resolveConnection` itself destructures only `data`, so a REFUSED
      // legacy read still reaches us as an honest-looking null and cannot be
      // distinguished here. Fixing that means changing connection-manager.ts,
      // which is outside this module. A throw is the part this file CAN report.
      return {
        status: "unreadable",
        ownerType: null,
        ownerId: null,
        detail: `legacy credential resolution threw for ${provider} — ${(err as Error)?.message ?? "unknown error"}`,
      }
    }
    if (legacy) {
      const ownerType: ConnectionScope = legacy.scope === "agent" ? "agent" : "brokerage"
      const ownerId = ownerType === "agent" ? (ctx.agentUserId ?? "") : ctx.brokerageId
      return { status: "connected", connection: { ...legacy, ownerType, ownerId } }
    }
  }

  return { status: "not_connected" }
}

/**
 * Resolve a provider connection for an actor across the full ownership cascade. Most-specific
 * owner wins. Never throws — returns null when nothing is connected at any scope.
 *
 * COMPATIBILITY WRAPPER over `resolveScopedConnectionResult`, and it maps
 * `unreadable` to **null** deliberately:
 *
 *   · Every existing caller of this function reads null as "not connected" and
 *     takes a fallback it has already thought through — a platform env key, an
 *     honest refusal, a logged skip. Making the wrapper THROW on `unreadable`
 *     would turn one tier's outage into an uncaught exception inside SMS dispatch,
 *     e-sign, accounting egress and CRM sync, none of which have a handler for it.
 *     That is a behaviour change nobody reviewed, dressed as a bug fix.
 *
 *   · null is also the fail-CLOSED answer for this shape. The alternative is not
 *     "keep working" — it is "keep working with somebody else's credential", which
 *     is what the cascade used to do and what stopping on a refusal now prevents.
 *
 * The one behaviour that DID change for these callers is the one being fixed: an
 * unreadable AGENT tier now yields null instead of quietly falling through to the
 * team's, the brokerage's or the platform's credential. Callers that need to tell
 * "none" from "could not look" — starting with the RentCast eligibility gate —
 * call `resolveScopedConnectionResult` directly.
 */
export async function resolveScopedConnection(
  provider: string,
  ctx: ScopeContext & { agentId?: string | null },
): Promise<ScopedConnection | null> {
  const result = await resolveScopedConnectionResult(provider, ctx)
  return result.status === "connected" ? result.connection : null
}
