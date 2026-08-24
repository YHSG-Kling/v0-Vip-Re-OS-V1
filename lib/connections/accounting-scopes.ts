// lib/connections/accounting-scopes.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE scope-aware ACCOUNTING-connection layer. Every level of the hierarchy
// (platform | brokerage | team | agent | vendor) gets its QuickBooks and/or
// Stripe story from THIS matrix — the five settings surfaces, the field-spec
// gating, and the finance export lanes all read it, so the offering can never
// drift per level again.
//
// It rides the EXISTING rails end to end — no new OAuth plumbing:
//   • Tokens live in platform_credentials keyed by (owner_type, owner_id,
//     platform) — the m102/m104 owner model. The EXISTING
//     /api/integrations/oauth/quickbooks route resolves the connecting user's
//     scope (connectionScopeForUserType) and stores owner-scoped.
//   • The PLATFORM's own books use the DISTINCT storage key
//     'platform_quickbooks' (the m273 idiom for company-owned credentials):
//     the tenant scope-cascade falls back to owner_type='platform' for every
//     brokerage, so storing the company's QBO under 'quickbooks' would let a
//     tenant with no connection resolve — and write into — the COMPANY's
//     books. A distinct key makes that leak impossible by construction.
//   • Accounting EXPORTS never cascade: a team export reads the TEAM's token
//     with an exact (owner_type='team', owner_id=<team>) match — it can never
//     fall through to the brokerage's (or anyone else's) company. That is the
//     anti-leak contract loadScopedQuickBooksCredential enforces.
//
// HONESTY CONTRACT (offering matrix): a connector is "connectable" only when a
// real connect flow exists for that scope; "managed-elsewhere" when the
// capability exists but is not a per-actor credential (platform/brokerage
// Stripe = the billing spine); "not-offered" is a documented VERDICT (teams
// and agents have no Stripe billing/payout flow today — a Connect button
// would mint a dead credential), never a dead button.
//
// Pure sections (matrix + owner resolution) are unit-tested by
// scripts/accounting-scopes-simulator.ts; the live sections take a service
// client as a parameter (same idiom as lib/connections/vendor-quickbooks.ts,
// which is refactored onto the shared QBO helpers below).

import type { createServiceClient } from "@/lib/supabase/service"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

type ServiceClient = ReturnType<typeof createServiceClient>

// ─── Scope model (pure) ──────────────────────────────────────────────────────

/** Accounting-capable owner scopes. `contact` is deliberately absent — contacts
 *  are leaf actors with no books in the app. */
export type AccountingScope = "platform" | "brokerage" | "team" | "agent" | "vendor"

export type AccountingConnector = "quickbooks" | "stripe"

export const ACCOUNTING_SCOPES: readonly AccountingScope[] = [
  "platform", "brokerage", "team", "agent", "vendor",
]

/** The one OAuth start path every QuickBooks connect button uses. The route
 *  derives the owner scope from the LOGGED-IN user's role server-side
 *  (connectionScopeForUserType), so the same path is correct at every level. */
export const QUICKBOOKS_OAUTH_START = "/api/integrations/oauth/quickbooks"

/** Sentinel owner id for the platform's own row (m273 idiom). */
export const PLATFORM_OWNER_ID = "platform"

/** DISTINCT platform_credentials.platform key for the COMPANY's own books —
 *  never the tenant 'quickbooks' key (see header: cascade leak-proofing). */
export const PLATFORM_BOOKS_STORAGE_KEY = "platform_quickbooks"

/** Pure: the platform_credentials.platform key a scope's QuickBooks tokens are
 *  stored under. Tenant-side scopes share 'quickbooks' (rows differ by owner);
 *  the platform's own books use the distinct company key. */
export function quickbooksStorageKey(scope: AccountingScope): string {
  return scope === "platform" ? PLATFORM_BOOKS_STORAGE_KEY : "quickbooks"
}

export type AccountingOfferingStatus = "connectable" | "managed-elsewhere" | "not-offered"

export interface AccountingOffering {
  status: AccountingOfferingStatus
  /** Real connect surface for "connectable"; informational link for
   *  "managed-elsewhere"; null for "not-offered". */
  connectPath: string | null
  /** The documented, honest reason for the status — rendered verbatim on the
   *  settings card for managed/not-offered rows. */
  verdict: string
}

/**
 * THE per-level offering matrix (single source of truth).
 *
 * Stripe audit (2026-07, round 36): the only Stripe Connect CONSUMER in the
 * codebase is the vendor payment lane (app/actions/vendor-payments.ts pays
 * vendor invoices through their Connect account). createStripeTransfer
 * (app/actions/external-services.ts) has no callers; teams never bill clients
 * through the platform and agent commission disbursement rides the CDA /
 * brokerage rails. So team + agent Stripe are honest not-offered verdicts,
 * not dead Connect buttons.
 */
export const ACCOUNTING_OFFERINGS: Record<AccountingScope, Record<AccountingConnector, AccountingOffering>> = {
  platform: {
    quickbooks: {
      status: "connectable",
      connectPath: QUICKBOOKS_OAUTH_START,
      verdict:
        "The platform's own company books. Stored under the distinct 'platform_quickbooks' key so the tenant credential cascade can never resolve the company's QuickBooks.",
    },
    stripe: {
      status: "managed-elsewhere",
      connectPath: "/dashboard/superadmin/plans",
      verdict:
        "Stripe IS the platform's billing spine (tier publishing, subscriptions, stripe-drift cron), and the PLATFORM's own account is one of the two the owner ruled on — resolved by lib/billing/resolve-stripe-account.ts from a platform-owned platform_credentials row, with STRIPE_SECRET_KEY as the platform's own floor. It is administered from Superadmin → Plans rather than offered as a connection card here, because there is exactly one of it.",
    },
  },
  brokerage: {
    quickbooks: {
      status: "connectable",
      connectPath: QUICKBOOKS_OAUTH_START,
      verdict: "Brokerage books: commission + expense sync via Settings → Accounting.",
    },
    stripe: {
      status: "managed-elsewhere",
      connectPath: "/settings/billing",
      // CORRECTED. This said "There is no brokerage-owned Stripe credential to
      // connect", which the owner ruling replaced: "the stripe account will be
      // per tenant and platform". A brokerage HAS its own Stripe account, and it
      // is the merchant on every path where the brokerage collects or pays —
      // vendor package fees, vendor job bills, client payments, agent payouts.
      // The card here still points at Settings → Billing because THIS surface is
      // about the brokerage's books as a billing CUSTOMER of the platform; the
      // brokerage's own merchant account is connected in Settings → Connections
      // (app/actions/connections/connection-center.ts :: startStripeConnect).
      verdict:
        "Two different Stripe relationships, and this card is the first: as a billing CUSTOMER the brokerage pays the platform on the PLATFORM's account (subscription + metered usage) — Settings → Billing. Separately the brokerage has its OWN Stripe account, connected in Settings → Connections, which is the merchant on money the brokerage collects or pays; lib/billing/resolve-stripe-account.ts resolves it per tenant and REFUSES rather than settling that money into the platform's account.",
    },
  },
  team: {
    quickbooks: {
      status: "connectable",
      connectPath: QUICKBOOKS_OAUTH_START,
      verdict:
        "Team books: the team lead connects the team's QuickBooks company; monthly team P&L rows export there (lib/finance/scoped-accounting-export.ts).",
    },
    stripe: {
      status: "not-offered",
      connectPath: null,
      verdict:
        "Not offered — no team billing flow: teams do not bill clients or receive payouts through the platform (no transfer consumer reads a team Connect account), so a Connect button would create a dead credential.",
    },
  },
  agent: {
    quickbooks: {
      status: "connectable",
      connectPath: QUICKBOOKS_OAUTH_START,
      verdict:
        "The agent's personal books: closed commission records export to their own QuickBooks company (lib/finance/scoped-accounting-export.ts).",
    },
    stripe: {
      status: "not-offered",
      connectPath: null,
      verdict:
        "Not offered — no agent payout flow consumes an agent Connect account today (commission disbursement rides the CDA/brokerage rails; createStripeTransfer has no callers). Offered the day a real agent payout lane exists.",
    },
  },
  vendor: {
    quickbooks: {
      status: "connectable",
      connectPath: QUICKBOOKS_OAUTH_START,
      verdict: "Vendor books: vendor invoices sync into the vendor's own QuickBooks company.",
    },
    stripe: {
      status: "connectable",
      // Stripe is CONNECT onboarding (never a pasted key) — the vendor earnings
      // surface hosts initiateStripeConnectOnboarding (lib/connections/vendor-stripe.ts).
      connectPath: "/vendor/earnings",
      verdict: "Stripe Connect payouts: the vendor payment lane pays invoices through the vendor's Connect account.",
    },
  },
}

/** Pure: full offering row for a scope. */
export function accountingOfferingsForScope(scope: AccountingScope): Record<AccountingConnector, AccountingOffering> {
  return ACCOUNTING_OFFERINGS[scope]
}

/** Pure: is this connector actually connectable at this scope? (Field-spec /
 *  UI gating reads this — the single yes/no that keeps buttons honest.) */
export function isAccountingConnectorOffered(scope: AccountingScope, connector: AccountingConnector): boolean {
  return ACCOUNTING_OFFERINGS[scope][connector].status === "connectable"
}

export interface AccountingOwnerIds {
  brokerageId?: string | null
  teamId?: string | null
  /** auth user id — agent-scope rows are keyed by the USER id (what the OAuth
   *  route writes: owner_type='agent', owner_id=<auth user id>). */
  agentUserId?: string | null
  vendorId?: string | null
}

/** Pure: resolve the owning entity id for a scope. Null when the actor lacks
 *  the required anchor (e.g. team scope without a team). NO cross-scope
 *  fallback — an unresolvable owner is an honest null, never someone else's id. */
export function resolveAccountingOwner(
  scope: AccountingScope,
  ids: AccountingOwnerIds,
): { ownerType: AccountingScope; ownerId: string } | null {
  const pick =
    scope === "platform" ? PLATFORM_OWNER_ID
    : scope === "brokerage" ? ids.brokerageId
    : scope === "team" ? ids.teamId
    : scope === "agent" ? ids.agentUserId
    : ids.vendorId
  return pick ? { ownerType: scope, ownerId: pick } : null
}

/** Pure: the EXACT-match filter an accounting read/write uses. Exported so the
 *  simulator can prove no two scopes ever share a filter (no token leakage). */
export function accountingOwnerFilter(
  scope: AccountingScope,
  ownerId: string,
): { owner_type: string; owner_id: string; platform: string } {
  return { owner_type: scope, owner_id: ownerId, platform: quickbooksStorageKey(scope) }
}

// ─── Live: scoped QuickBooks credential (generalizes vendor-quickbooks) ──────

const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
const QBO_API_BASE = "https://quickbooks.api.intuit.com/v3/company"

export interface ScopedQuickBooksCredential {
  id: string
  scope: AccountingScope
  ownerId: string
  accessToken: string
  refreshToken: string
  realmId: string
  tokenExpiresAt: string | null
  accountName: string | null
}

/**
 * Load ONE scope's QuickBooks credential by EXACT owner match — deliberately
 * NOT resolveScopedConnection: accounting exports must never cascade to a
 * different owner's company (a team token can never serve a brokerage export
 * and vice versa). Returns null when not connected / inactive / unusable.
 */
export async function loadScopedQuickBooksCredential(
  svc: ServiceClient,
  scope: AccountingScope,
  ownerId: string,
): Promise<ScopedQuickBooksCredential | null> {
  const filter = accountingOwnerFilter(scope, ownerId)
  const { data } = await svc
    .from("platform_credentials")
    .select("id, access_token, refresh_token, account_id, account_name, token_expires_at, config, is_active")
    .eq("owner_type", filter.owner_type)
    .eq("owner_id", filter.owner_id)
    .eq("platform", filter.platform)
    .maybeSingle()

  if (!data || data.is_active === false) return null
  const config = (data.config ?? {}) as Record<string, unknown>
  // Token columns are canonical; older QBO rows kept tokens in `config` (same
  // tolerance as lib/finance/accounting-egress.ts).
  const accessToken = (data.access_token as string | null) ?? (config.access_token as string | undefined) ?? null
  const refreshToken = (data.refresh_token as string | null) ?? (config.refresh_token as string | undefined) ?? ""
  const realmId =
    (data.account_id as string | null) ??
    (config.realm_id as string | undefined) ??
    (config.realmId as string | undefined) ??
    null
  if (!accessToken || !realmId) return null
  return {
    id: data.id as string,
    scope,
    ownerId,
    accessToken,
    refreshToken,
    realmId,
    tokenExpiresAt: (data.token_expires_at as string | null) ?? null,
    accountName: (data.account_name as string | null) ?? null,
  }
}

/** Refresh the access token when near expiry and persist the new set on the
 *  SAME owner-scoped row. Returns the live access token. Throws on failure. */
export async function ensureFreshQuickBooksToken(
  svc: ServiceClient,
  cred: ScopedQuickBooksCredential,
): Promise<string> {
  const exp = cred.tokenExpiresAt ? Date.parse(cred.tokenExpiresAt) : NaN
  const nearExpiry = !Number.isNaN(exp) && exp <= Date.now() + 5 * 60_000
  if (!nearExpiry || !cred.refreshToken) return cred.accessToken

  const clientId = process.env.QUICKBOOKS_CLIENT_ID
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error("QuickBooks app credentials not configured (QUICKBOOKS_CLIENT_ID/SECRET)")
  }

  const tokenUrl = new URL(INTUIT_TOKEN_URL)
  const res = await callConnector<{ access_token: string; refresh_token: string; expires_in: number }>({
    connector: "quickbooks-oauth",
    baseUrl: tokenUrl.origin,
    path: tokenUrl.pathname,
    method: "POST",
    auth: { style: "basic", username: clientId, password: clientSecret },
    bodyType: "form",
    body: { grant_type: "refresh_token", refresh_token: cred.refreshToken },
  })
  if (!res.ok || !res.data) {
    throw new Error(`QuickBooks token refresh failed (${res.status ?? "—"}): ${res.error ?? ""}`)
  }
  const tokenExpiresAt = new Date(Date.now() + (res.data.expires_in ?? 3600) * 1000).toISOString()
  await svc
    .from("platform_credentials")
    .update({
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token,
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", cred.id)
  return res.data.access_token
}

/** Single egress choke point for QBO API calls (Bearer, via the connector-gateway). */
export async function qboRequest<T>(args: {
  accessToken: string
  realmId: string
  method: "GET" | "POST"
  path: string
  body?: unknown
}): Promise<T> {
  const res = await callConnector<T>({
    connector: "quickbooks",
    baseUrl: `${QBO_API_BASE}/${args.realmId}`,
    path: args.path,
    method: args.method,
    body: args.body,
    auth: { style: "bearer", token: args.accessToken },
  })
  if (!res.ok || res.data == null) {
    throw new Error(`QuickBooks ${args.method} ${args.path.split("?")[0]} failed (${res.status ?? "—"}): ${res.error ?? ""}`)
  }
  return res.data
}

/** Find a QBO Customer by display name, creating it when absent. Returns the Customer Id. */
export async function findOrCreateQboCustomer(args: {
  accessToken: string
  realmId: string
  displayName: string
  email?: string | null
}): Promise<string> {
  // QBO query syntax escapes single quotes by doubling them.
  const name = args.displayName.trim().slice(0, 100) || "Client"
  const escaped = name.replace(/'/g, "''")
  const query = `select Id from Customer where DisplayName = '${escaped}'`
  const found = await qboRequest<{ QueryResponse?: { Customer?: Array<{ Id: string }> } }>({
    accessToken: args.accessToken,
    realmId: args.realmId,
    method: "GET",
    path: `/query?query=${encodeURIComponent(query)}&minorversion=73`,
  })
  const existing = found.QueryResponse?.Customer?.[0]?.Id
  if (existing) return existing

  const created = await qboRequest<{ Customer: { Id: string } }>({
    accessToken: args.accessToken,
    realmId: args.realmId,
    method: "POST",
    path: "/customer?minorversion=73",
    body: {
      DisplayName: name,
      ...(args.email ? { PrimaryEmailAddr: { Address: args.email } } : {}),
    },
  })
  return created.Customer.Id
}

// ─── Live: per-scope connection status (drives the five settings cards) ──────

export interface ScopedAccountingStatus {
  scope: AccountingScope
  ownerId: string
  quickbooks: { offering: AccountingOffering; connected: boolean; realmId: string | null; accountName: string | null }
  stripe: { offering: AccountingOffering; connected: boolean; accountId: string | null; onboardingComplete: boolean }
}

/** Read one owner's accounting connections by EXACT owner match (no cascade —
 *  the status a card shows is that owner's own state, never an inherited one). */
export async function readScopedAccounting(
  svc: ServiceClient,
  scope: AccountingScope,
  ownerId: string,
): Promise<ScopedAccountingStatus> {
  const offerings = ACCOUNTING_OFFERINGS[scope]

  const qb = await loadScopedQuickBooksCredential(svc, scope, ownerId)

  let stripeAccountId: string | null = null
  let stripeOnboarded = false
  if (offerings.stripe.status === "connectable") {
    const { data } = await svc
      .from("platform_credentials")
      .select("account_id, config, is_active")
      .eq("owner_type", scope)
      .eq("owner_id", ownerId)
      .eq("platform", "stripe")
      .maybeSingle()
    if (data && data.is_active !== false) {
      stripeAccountId = (data.account_id as string | null) ?? null
      stripeOnboarded = ((data.config ?? {}) as Record<string, unknown>).stripe_onboarding_complete === true
    }
  }

  return {
    scope,
    ownerId,
    quickbooks: {
      offering: offerings.quickbooks,
      connected: !!qb,
      realmId: qb?.realmId ?? null,
      accountName: qb?.accountName ?? null,
    },
    stripe: {
      offering: offerings.stripe,
      connected: !!stripeAccountId,
      accountId: stripeAccountId,
      onboardingComplete: stripeOnboarded,
    },
  }
}
