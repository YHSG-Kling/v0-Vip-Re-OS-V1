// lib/billing/resolve-stripe-account.ts
// ═══════════════════════════════════════════════════════════════════════════
// THE Stripe credential resolver. One Stripe account per TENANT, one for the
// PLATFORM, nothing hardcoded, and a REFUSAL rather than a fallback whenever the
// right account cannot be named.
// ═══════════════════════════════════════════════════════════════════════════
//
// OWNER RULING (verbatim): "the stripe account will be per tenant and platform so
// no configuration should be hardcoded."
//
// ── THE SURVIVOR THIS REUSES, RATHER THAN A SECOND RESOLVER ────────────────
//
// This module does NOT walk `platform_credentials` itself. It calls
// `resolveScopedConnectionResult` in lib/connections/resolve-scoped.ts — the same
// cascade lib/providers/messaging/resolve-sms-provider.ts and lib/crm/sync.ts
// already run on (agent → team → brokerage → platform, most specific wins, and a
// tier that cannot be READ stops the walk instead of descending onto somebody
// else's credential). CLAUDE.md §6: two spellings of "which account is this
// actor's" would be a defect, and this repo has already paid for that once —
// see the tombstone at lib/providers/messaging/resolve-sms-provider.ts:175.
//
// What this module adds is the one thing that cascade must NOT do for money:
//
//   ── IT REFUSES TO DESCEND TO THE PLATFORM. ──
//
// The shared cascade ends at `{ ownerType: 'platform' }` by design — for SMS or
// IDX that last tier is a sane floor, because a text sent from the platform's
// number is still a text. For MONEY it is the defect: a brokerage with no Stripe
// credential must not have its vendor invoices settle into the PLATFORM's Stripe
// account. That is not a degraded feature, it is the platform collecting money it
// did not earn, from a customer it does not have, with a receipt naming the wrong
// merchant, a refund that lands in the wrong balance and a 1099 issued by the
// wrong entity. Nothing downstream can tell — a charge that succeeds looks
// identical whichever account it succeeded on.
//
// So `resolveTenantStripeAccount` takes the cascade's answer and rejects
// `ownerType === "platform"` outright, with a sentence naming what is missing.
// And `resolvePlatformStripeAccount` walks a cascade that contains ONLY the
// platform tier, so the reverse substitution — the platform's own invoice being
// charged to whichever tenant happened to be in context — is unrepresentable
// rather than merely avoided.
//
// ── WHERE THE TENANT COMES FROM ────────────────────────────────────────────
//
// CLAUDE.md §4: the tenant comes from the SESSION, never from a request body and
// never from a parameter. This module cannot read a session (it is called from
// cron routes and webhooks as well as actions), so it does the next honest thing:
// `TenantStripeContext` is documented as session-derived, every caller in this
// repo passes ids it obtained from the session or from a signature-verified
// webhook identity, and scripts/stripe-account-scope-simulator.ts asserts that no
// caller reaches it with an id taken off a request body. A body-supplied
// brokerageId selecting a Stripe account is the IDOR shape this repo has found
// repeatedly, and it is worse here than usual: it selects whose bank account
// receives the money.
//
// ── WHAT `mode` MEANS, AND WHY IT IS NOT A DETAIL ──────────────────────────
//
// A tenant can hold a Stripe relationship in two genuinely different shapes, and
// they authenticate differently:
//
//   direct   the tenant owns a Stripe ACCOUNT and its secret key is stored on the
//            credential row. The call is made AS them; no platform key involved.
//   connect  the tenant has an `acct_…` Connect account under the platform's
//            Connect platform (this is what
//            app/actions/connections/connection-center.ts :: startStripeConnect
//            writes today). The call is authenticated with the PLATFORM's key and
//            addressed with a `Stripe-Account` header.
//
// Both are "the tenant's account" in the sense the owner ruled on — the money is
// theirs — but a caller that treats a connect credential as a direct one sends the
// platform key with no `Stripe-Account` header and charges the platform. So the
// mode is returned, not inferred, and `secretKey` is always the key that actually
// signs the request.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { decryptSecret } from "@/lib/security/secret-crypto"
import { resolveScopedConnectionResult } from "@/lib/connections/resolve-scoped"
import {
  PLATFORM_WEBHOOK_ENV,
  webhookSecretFromConfig,
  type StripeAccountSide,
  type StripeWebhookEndpoint,
} from "./stripe-account-scope"

/** The owner scopes a Stripe credential can be resolved at. Narrower than
 *  ConnectionScope on purpose: vendors and contacts are leaf actors who are billed,
 *  they do not hold the merchant account a charge is made on. */
export type StripeOwnerScope = "platform" | "brokerage" | "team" | "agent"

export type StripeAccountMode = "direct" | "connect"

export interface ResolvedStripeAccount {
  side: StripeAccountSide
  ownerType: StripeOwnerScope
  ownerId: string
  mode: StripeAccountMode
  /** The key that SIGNS the request. For `connect` this is the platform's key. */
  secretKey: string
  /** `acct_…` to send as `Stripe-Account`, or null for a direct account. */
  connectedAccountId: string | null
  /** Signing secret for webhooks delivered FROM this account, or null when the
   *  credential stores none (the endpoint then cannot verify this account's
   *  deliveries — which is a refusal, never a pass). */
  webhookSecret: string | null
  credentialId: string | null
  /** TRUE when `secretKey` came from the platform's env var rather than a stored
   *  credential. Only ever true for `side === "platform"` — a tenant never falls
   *  back to env. */
  fromEnv: boolean
}

export type StripeAccountResolution =
  | { status: "resolved"; account: ResolvedStripeAccount }
  /** We looked, everything answered, and there is no credential for this owner. */
  | { status: "missing"; side: StripeAccountSide; message: string }
  /** We could NOT look. Distinct from missing on purpose — "nobody checked" must
   *  never render as "checked and fine" (CLAUDE.md §4). */
  | { status: "unreadable"; side: StripeAccountSide; message: string }

/** Session-derived tenant identity. NEVER assemble this from a request body. */
export interface TenantStripeContext {
  /** The brokerage from the session. Required — a tenant Stripe call with no
   *  tenant is a refusal, not a platform call. */
  brokerageId: string | null | undefined
  teamId?: string | null
  agentUserId?: string | null
}

const PLATFORM_OWNER_ID = "platform"

/** Narrow the shared cascade's ConnectionScope onto the four a Stripe merchant
 *  can be. Returns null for vendor/contact — they are billed, never the merchant. */
function asStripeOwnerScope(ownerType: string): StripeOwnerScope | null {
  return ownerType === "platform" || ownerType === "brokerage" || ownerType === "team" || ownerType === "agent"
    ? ownerType
    : null
}

/**
 * Decrypt a stored secret, FAIL-CLOSED.
 *
 * `decryptSecret` passes plaintext through and THROWS when the value is encrypted
 * and `SECRETS_ENCRYPTION_KEY` is absent. An uncaught throw here would surface as
 * a 500 at whichever of the callers happened to be first; worse, a `catch → null`
 * would read as "this credential has no key" and send the caller looking for a
 * fallback. So the failure is returned as a VALUE and classified as unreadable.
 */
function decryptOrNull(value: string | null | undefined): { ok: true; value: string | null } | { ok: false; detail: string } {
  try {
    return { ok: true, value: decryptSecret(value ?? null) }
  } catch (err) {
    return { ok: false, detail: (err as Error)?.message ?? "secret decryption failed" }
  }
}

/**
 * THE PLATFORM'S OWN STRIPE ACCOUNT.
 *
 * The cascade is called with an EMPTY context on purpose: `scopeCascade({})`
 * yields exactly `[{ ownerType: 'platform', ownerId: 'platform' }]`, and
 * `resolveScopedConnectionResult`'s legacy fallback is gated on
 * `ctx.brokerageId`, so nothing tenant-scoped can be reached from here even if a
 * caller had a tenant in hand. The wrong-account substitution is not guarded
 * against, it is unreachable.
 *
 * ENV IS THE PLATFORM'S CREDENTIAL OF LAST RESORT, and only the platform's — see
 * PLATFORM_ONLY_STRIPE_ENV in ./stripe-account-scope.ts for why that is the right
 * home for it. It is read only after the stored platform credential has been
 * looked for and found absent, so a `platform_credentials` row always wins.
 *
 * `unreadable` does NOT fall through to env. A platform row that exists and could
 * not be read may name a DIFFERENT account than a stale env key — that is the same
 * wrong-merchant defect one layer up, so the read failure is reported.
 */
export async function resolvePlatformStripeAccount(
  endpoint: StripeWebhookEndpoint = "tenant_billing",
): Promise<StripeAccountResolution> {
  const envHookName = PLATFORM_WEBHOOK_ENV[endpoint]
  const envHook = process.env[envHookName] ?? null
  const result = await resolveScopedConnectionResult("stripe", {})

  if (result.status === "unreadable") {
    return {
      status: "unreadable",
      side: "platform",
      message:
        `The platform's Stripe credential could not be read (${result.detail}). Refusing to fall back to STRIPE_SECRET_KEY: ` +
        `a stored platform credential may name a different Stripe account than the environment does, and charging the wrong one is a wrong invoice.`,
    }
  }

  if (result.status === "connected") {
    const conn = result.connection
    if (conn.ownerType !== "platform") {
      // Unreachable by construction (the cascade above contains only the platform
      // tier) and therefore exactly the assertion worth keeping: if the cascade
      // ever changes shape, this refuses instead of silently charging a tenant.
      return {
        status: "unreadable",
        side: "platform",
        message:
          `The platform Stripe lookup resolved a '${conn.ownerType}'-owned credential (${conn.ownerId}). ` +
          `Refusing: the platform's own billing must never run on a tenant's Stripe account.`,
      }
    }
    const key = decryptOrNull(conn.apiKey ?? conn.accessToken)
    if (!key.ok) {
      return { status: "unreadable", side: "platform", message: `The platform's stored Stripe key could not be decrypted (${key.detail}).` }
    }
    const hook = decryptOrNull(webhookSecretFromConfig(conn.config, endpoint))
    if (key.value) {
      return {
        status: "resolved",
        account: {
          side: "platform",
          ownerType: "platform",
          ownerId: PLATFORM_OWNER_ID,
          mode: "direct",
          secretKey: key.value,
          connectedAccountId: null,
          webhookSecret: (hook.ok ? hook.value : null) ?? envHook,
          credentialId: conn.credentialId,
          fromEnv: false,
        },
      }
    }
    // A platform row with no secret key is not a platform account — fall to env,
    // which by definition names the same party, and carry the row's webhook secret.
    const envKey = process.env.STRIPE_SECRET_KEY
    if (envKey) {
      return {
        status: "resolved",
        account: {
          side: "platform",
          ownerType: "platform",
          ownerId: PLATFORM_OWNER_ID,
          mode: "direct",
          secretKey: envKey,
          connectedAccountId: null,
          webhookSecret: (hook.ok ? hook.value : null) ?? envHook,
          credentialId: conn.credentialId,
          fromEnv: true,
        },
      }
    }
    return {
      status: "missing",
      side: "platform",
      message:
        `The platform's Stripe credential row (${conn.credentialId}) stores no secret key, and STRIPE_SECRET_KEY is unset. ` +
        `Add the platform's Stripe secret key to that credential, or set STRIPE_SECRET_KEY.`,
    }
  }

  // not_connected — no stored platform credential. Env is the platform's own home.
  const envKey = process.env.STRIPE_SECRET_KEY
  if (envKey) {
    return {
      status: "resolved",
      account: {
        side: "platform",
        ownerType: "platform",
        ownerId: PLATFORM_OWNER_ID,
        mode: "direct",
        secretKey: envKey,
        connectedAccountId: null,
        webhookSecret: envHook,
        credentialId: null,
        fromEnv: true,
      },
    }
  }
  return {
    status: "missing",
    side: "platform",
    message:
      "No Stripe account is configured for the PLATFORM: there is no active platform-owned row in platform_credentials " +
      "(owner_type='platform', platform='stripe') and STRIPE_SECRET_KEY is unset. Platform billing — signup checkout, " +
      "subscription activation, AI overage and vendor marketplace tiers — cannot run until one of the two exists.",
  }
}

/**
 * A TENANT'S OWN STRIPE ACCOUNT — agent, then team, then brokerage. Never the
 * platform's, and never an environment variable.
 *
 * The three refusals, all of which return a sentence naming what is missing:
 *
 *   · no tenant in context     — a tenant-side charge with no tenant is not a
 *                                platform charge; it is a bug in the caller.
 *   · cascade landed on platform — the tenant has no credential of their own and
 *                                the shared cascade fell to the product's account.
 *                                THIS is the money defect this function exists for.
 *   · unreadable tier          — we could not look, so nothing may be charged.
 */
export async function resolveTenantStripeAccount(
  ctx: TenantStripeContext,
  endpoint: StripeWebhookEndpoint = "tenant_billing",
): Promise<StripeAccountResolution> {
  if (!ctx.brokerageId) {
    return {
      status: "missing",
      side: "tenant",
      message:
        "No tenant in context, so no tenant Stripe account can be resolved. Refusing: a tenant-side charge with no tenant " +
        "must not be made on the platform's Stripe account. The brokerage must come from the session (CLAUDE.md §4).",
    }
  }

  const result = await resolveScopedConnectionResult("stripe", {
    agentUserId: ctx.agentUserId ?? null,
    teamId: ctx.teamId ?? null,
    brokerageId: ctx.brokerageId,
  })

  if (result.status === "unreadable") {
    return {
      status: "unreadable",
      side: "tenant",
      message:
        `The Stripe credential for ${result.ownerType ?? "the legacy credential store"}` +
        `${result.ownerId ? ` ${result.ownerId}` : ""} could not be read (${result.detail}). ` +
        `Refusing to charge anything: an unread tier may hold this tenant's own account, and descending past it would settle their money into someone else's.`,
    }
  }

  if (result.status === "not_connected") {
    return {
      status: "missing",
      side: "tenant",
      message: tenantMissingMessage(ctx.brokerageId),
    }
  }

  const conn = result.connection

  // ── THE FAIL-CLOSED CORE ─────────────────────────────────────────────────
  // The shared cascade's last tier is the PLATFORM. For every other consumer that
  // is a sane floor. For money it is the wrong merchant, so it is a refusal.
  if (conn.ownerType === "platform") {
    return {
      status: "missing",
      side: "tenant",
      message: tenantMissingMessage(ctx.brokerageId),
    }
  }

  const ownerType = asStripeOwnerScope(conn.ownerType)
  if (!ownerType) {
    return {
      status: "missing",
      side: "tenant",
      message:
        `The Stripe credential resolved for brokerage ${ctx.brokerageId} is owned by a '${conn.ownerType}' (${conn.ownerId}), ` +
        `which is a party this product BILLS rather than one that holds a merchant account. Refusing.`,
    }
  }

  const key = decryptOrNull(conn.apiKey ?? conn.accessToken)
  if (!key.ok) {
    return {
      status: "unreadable",
      side: "tenant",
      message: `The Stripe key stored for ${ownerType} ${conn.ownerId} could not be decrypted (${key.detail}). Refusing to charge anything.`,
    }
  }
  const hookRead = decryptOrNull(webhookSecretFromConfig(conn.config, endpoint))
  const webhookSecret = hookRead.ok ? hookRead.value : null

  // DIRECT: the tenant owns the Stripe account and its key signs the call.
  if (key.value) {
    return {
      status: "resolved",
      account: {
        side: "tenant",
        ownerType,
        ownerId: conn.ownerId,
        mode: "direct",
        secretKey: key.value,
        connectedAccountId: conn.accountId ?? null,
        webhookSecret,
        credentialId: conn.credentialId,
        fromEnv: false,
      },
    }
  }

  // CONNECT: an `acct_…` under the platform's Connect platform. The money is the
  // tenant's; the request is signed with the PLATFORM's key and addressed with a
  // Stripe-Account header. If the platform key cannot be resolved, the tenant's
  // charge cannot be made either — and that propagates as a refusal rather than
  // becoming an unaddressed platform charge.
  if (conn.accountId && conn.accountId.startsWith("acct_")) {
    const platform = await resolvePlatformStripeAccount(endpoint)
    if (platform.status !== "resolved") {
      return {
        status: platform.status,
        side: "tenant",
        message:
          `${ownerType} ${conn.ownerId} banks through Stripe Connect account ${conn.accountId}, which is addressed with the ` +
          `platform's key — and that key is unavailable: ${platform.message}`,
      }
    }
    return {
      status: "resolved",
      account: {
        side: "tenant",
        ownerType,
        ownerId: conn.ownerId,
        mode: "connect",
        secretKey: platform.account.secretKey,
        connectedAccountId: conn.accountId,
        webhookSecret,
        credentialId: conn.credentialId,
        fromEnv: platform.account.fromEnv,
      },
    }
  }

  return {
    status: "missing",
    side: "tenant",
    message:
      `The Stripe credential for ${ownerType} ${conn.ownerId} (row ${conn.credentialId}) carries neither a secret key nor a ` +
      `Connect account id, so there is nothing to make a charge with. Reconnect Stripe in Settings → Connections. ` +
      `Refusing rather than falling back to the platform's Stripe account.`,
  }
}

/** ONE sentence for "this tenant has no Stripe account", used by both the
 *  not_connected branch and the fell-through-to-platform branch — they are the
 *  same fact about the tenant, and two wordings would be two spellings of it. */
function tenantMissingMessage(brokerageId: string): string {
  return (
    `Brokerage ${brokerageId} has no active Stripe credential of its own (nothing at agent, team or brokerage scope in ` +
    `platform_credentials with platform='stripe'). REFUSING rather than charging the platform's Stripe account: the money ` +
    `on this path belongs to the tenant, and settling it into the product's account would issue a receipt naming the wrong ` +
    `merchant, refund from the wrong balance, and put the amount on the wrong entity's books. Connect Stripe in ` +
    `Settings → Connections.`
  )
}

/**
 * Every TENANT-owned Stripe credential that stores a webhook signing secret.
 *
 * Read by lib/billing/stripe-webhook-secrets.ts, which cannot use the cascade
 * above: a webhook arrives with no session and no tenant, so the tenant is
 * established by WHICH SECRET VERIFIES THE SIGNATURE. That is the one identity
 * claim on an unauthenticated request this repo will accept, because it is
 * cryptographic rather than asserted.
 *
 * Returns a discriminated result for the same reason everything else here does:
 * an unreadable credential store must not read as "no tenants have webhooks".
 */
export type TenantWebhookCredentials =
  | { status: "ok"; rows: Array<{ ownerType: StripeOwnerScope; ownerId: string; credentialId: string; webhookSecret: string; secretKey: string | null }>; scanned: number; capped: boolean }
  | { status: "unreadable"; message: string }

/** How many tenant credential rows one webhook delivery will consider. Published
 *  rather than silent: past this, a delivery from an unlisted tenant is REFUSED
 *  (400), which is honest, not dropped, which would not be. */
export const TENANT_WEBHOOK_CANDIDATE_LIMIT = 500

export async function readTenantStripeWebhookCredentials(
  endpoint: StripeWebhookEndpoint = "tenant_billing",
): Promise<TenantWebhookCredentials> {
  try {
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("platform_credentials")
      .select("id, owner_type, owner_id, api_key, access_token, config")
      .eq("platform", "stripe")
      .eq("is_active", true)
      .in("owner_type", ["brokerage", "team", "agent"])
      .limit(TENANT_WEBHOOK_CANDIDATE_LIMIT)
    // supabase-js RESOLVES a refusal — read the error FIRST and on its own.
    if (error) {
      return { status: "unreadable", message: `${error.code ?? "no-code"}: ${error.message ?? "credential read failed"}` }
    }
    const rows = (data ?? []) as Array<{
      id: string; owner_type: string | null; owner_id: string | null
      api_key: string | null; access_token: string | null; config: Record<string, unknown> | null
    }>
    const out: Array<{ ownerType: StripeOwnerScope; ownerId: string; credentialId: string; webhookSecret: string; secretKey: string | null }> = []
    for (const row of rows) {
      const ownerType = asStripeOwnerScope(row.owner_type ?? "")
      if (!ownerType || ownerType === "platform" || !row.owner_id) continue
      const hook = decryptOrNull(webhookSecretFromConfig(row.config, endpoint))
      if (!hook.ok || !hook.value) continue
      const key = decryptOrNull(row.api_key ?? row.access_token)
      out.push({
        ownerType,
        ownerId: row.owner_id,
        credentialId: row.id,
        webhookSecret: hook.value,
        secretKey: key.ok ? key.value : null,
      })
    }
    return { status: "ok", rows: out, scanned: rows.length, capped: rows.length >= TENANT_WEBHOOK_CANDIDATE_LIMIT }
  } catch (err) {
    return { status: "unreadable", message: `tenant credential read threw — ${(err as Error)?.message ?? "unknown error"}` }
  }
}
