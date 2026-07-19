"use server"

// app/actions/tenant-sso.ts — ENTERPRISE SSO (SAML), tenant surface.
//
// Brokerage-tier feature: the brokerage connects its own identity provider
// (Okta, Entra ID, Google Workspace SAML…) so everyone on its email domain
// signs in through the company IdP. Row lifecycle in tenant_sso_connections
// (ONE row per brokerage — brokerage_id UNIQUE; email_domain globally UNIQUE):
//
//   pending  — row created/validated; provider not yet registered with
//              Supabase (e.g. service key not configured on this deployment)
//   active   — the Supabase Auth Admin API returned a provider id
//              (supabase_sso_provider_id set, activated_at stamped) — NEVER
//              set without that id
//   error    — captured honestly in error_detail; the flagship case is a
//              Supabase project without the SAML add-on (Pro plan + SAML
//              add-on required — the admin endpoints 404/403 there)
//   disabled — turned off by the tenant (Supabase provider delete
//              best-effort); row kept so reconfiguring is one click
//
// Gates: brokerage-admin types for writes (broker/admin write idiom); plan
// tier gated to Brokerage/Multi-Location (legacy non-canonical tiers fail
// OPEN, same rule as lib/kernel/tier-role-matrix). Audited via the tenant
// audit idiom (audit_log insert, entity_type 'tenant_sso_connection').
//
// PLUS one PUBLIC, unauthenticated action — checkSsoDomainAction(email) — for
// the login page: returns ONLY { ssoAvailable: boolean } for an ACTIVE
// connection matching the typed email's domain. It never returns domain
// lists, brokerage names, or error detail — no tenant enumeration surface.

import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { isCanonicalTier, TIER_ORDER, TIER_LABELS } from "@/lib/kernel/tier-role-matrix"
import {
  validateSsoEmailDomain,
  validateMetadataUrl,
  emailDomainOf,
  registerSsoProvider,
  getProviderStatus,
  removeSsoProvider,
  getSsoAdminConfig,
  samlAcsUrl,
  samlEntityId,
  SSO_NOT_CONFIGURED_NOTE,
  SAML_NOT_ENABLED_DETAIL,
} from "@/lib/platform/tenant-sso"

const ADMIN_TYPES = new Set(["broker", "broker_admin", "admin", "superadmin"])

// ── Gating helpers ───────────────────────────────────────────────────────────

/** Brokerage tier and up. Unknown/legacy tiers fail OPEN (matrix rule) so an
 *  un-backfilled legacy tenant isn't bricked out of a surface it can see. */
function tierAllowsSso(tier: string | null | undefined): boolean {
  if (!isCanonicalTier(tier)) return true
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf("brokerage")
}

const TIER_GATE_ERROR =
  `SSO / SAML is a ${TIER_LABELS.brokerage} / ${TIER_LABELS.multi_location} plan feature — ` +
  "password and magic-link sign-in stay available on every plan."

interface AdminGate {
  ok: true
  userId: string
  brokerageId: string
  tier: string | null
}

async function requireBrokerageAdmin(): Promise<AdminGate | { ok: false; error: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_TYPES.has(ctx.userType ?? "")) return { ok: false, error: "Forbidden — brokerage admin only" }
  const svc = createServiceClient()
  const { data: brk } = await svc
    .from("brokerages").select("plan_tier")
    .eq("id", ctx.brokerageId).maybeSingle()
  return {
    ok: true,
    userId: ctx.userId,
    brokerageId: ctx.brokerageId,
    tier: (brk as any)?.plan_tier ?? null,
  }
}

async function audit(svc: any, userId: string, action: string, entityId: string, after: Record<string, unknown>) {
  try {
    await svc.from("audit_log").insert({
      user_id: userId,
      action,
      entity_type: "tenant_sso_connection",
      entity_id: entityId,
      before: null,
      after,
    })
  } catch {
    /* audit is best-effort — never fail the user action on a log write */
  }
}

// ── View types ───────────────────────────────────────────────────────────────

export interface SsoConnectionView {
  id: string
  emailDomain: string
  metadataUrl: string
  providerType: string
  status: string
  /** True once Supabase returned a provider id (the only path to 'active'). */
  providerRegistered: boolean
  errorDetail: string | null
  activatedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface SsoPanel {
  tierAllowed: boolean
  tierLabel: string
  canManage: boolean
  /** Service-role key present — provider registration can actually run. */
  adminConfigured: boolean
  /** Honest note shown when registration can't run on this deployment. */
  unconfiguredNote: string | null
  /** SP endpoints for the tenant's IdP setup (null when env is unset). */
  acsUrl: string | null
  entityId: string | null
  connection: SsoConnectionView | null
}

const ROW_COLUMNS =
  "id, brokerage_id, email_domain, provider_type, supabase_sso_provider_id, metadata_url, status, error_detail, created_by, created_at, updated_at, activated_at"

function rowToView(row: any): SsoConnectionView {
  return {
    id: String(row.id),
    emailDomain: String(row.email_domain),
    metadataUrl: String(row.metadata_url ?? ""),
    providerType: String(row.provider_type ?? "saml"),
    status: String(row.status),
    providerRegistered: !!row.supabase_sso_provider_id,
    errorDetail: row.error_detail ?? null,
    activatedAt: row.activated_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

// ── READ: the settings-card panel ────────────────────────────────────────────

export async function getSsoPanel(): Promise<
  { ok: true; panel: SsoPanel } | { ok: false; error: string }
> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()

  const [{ data: brk }, { data: row }] = await Promise.all([
    svc.from("brokerages").select("plan_tier").eq("id", ctx.brokerageId).maybeSingle(),
    svc.from("tenant_sso_connections").select(ROW_COLUMNS)
      .eq("brokerage_id", ctx.brokerageId).maybeSingle(),
  ])

  const tier = (brk as any)?.plan_tier ?? null
  const configured = getSsoAdminConfig().configured
  return {
    ok: true,
    panel: {
      tierAllowed: tierAllowsSso(tier),
      tierLabel: isCanonicalTier(tier) ? TIER_LABELS[tier] : "your current",
      canManage: ADMIN_TYPES.has(ctx.userType ?? ""),
      adminConfigured: configured,
      unconfiguredNote: configured ? null : SSO_NOT_CONFIGURED_NOTE,
      acsUrl: samlAcsUrl(),
      entityId: samlEntityId(),
      connection: row ? rowToView(row) : null,
    },
  }
}

// ── CONFIGURE (create or reconfigure) ────────────────────────────────────────

export async function configureSsoAction(rawEmailDomain: string, rawMetadataUrl: string): Promise<
  { ok: true; connection: SsoConnectionView } | { ok: false; error: string }
> {
  const gate = await requireBrokerageAdmin()
  if (!gate.ok) return gate
  if (!tierAllowsSso(gate.tier)) return { ok: false, error: TIER_GATE_ERROR }

  const domainCheck = validateSsoEmailDomain(rawEmailDomain)
  if (!domainCheck.ok) return { ok: false, error: domainCheck.error }
  const urlCheck = validateMetadataUrl(rawMetadataUrl)
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error }
  const emailDomain = domainCheck.domain
  const metadataUrl = urlCheck.url

  const svc = createServiceClient()

  // email_domain is globally UNIQUE — refuse a domain already claimed by
  // another workspace (one IdP owns one email domain, platform-wide).
  const { data: claimed } = await svc.from("tenant_sso_connections")
    .select("id, brokerage_id").eq("email_domain", emailDomain).maybeSingle()
  if (claimed && (claimed as any).brokerage_id !== gate.brokerageId) {
    return { ok: false, error: "That email domain is already connected to another workspace." }
  }

  // brokerage_id is UNIQUE — one connection per brokerage; reconfigure in place.
  const { data: existing } = await svc.from("tenant_sso_connections")
    .select(ROW_COLUMNS).eq("brokerage_id", gate.brokerageId).maybeSingle()

  // Reconfiguring away from an already-registered provider: detach the old
  // one first (best-effort) so Supabase doesn't hold a stale domain claim.
  const oldProviderId = (existing as any)?.supabase_sso_provider_id as string | null | undefined
  if (oldProviderId) {
    await removeSsoProvider(oldProviderId)
  }

  const nowIso = new Date().toISOString()
  let row: any
  if (existing) {
    const { data, error } = await svc.from("tenant_sso_connections")
      .update({
        email_domain: emailDomain,
        metadata_url: metadataUrl,
        provider_type: "saml",
        supabase_sso_provider_id: null,
        status: "pending",
        error_detail: null,
        activated_at: null,
        updated_at: nowIso,
      })
      .eq("id", (existing as any).id)
      .select(ROW_COLUMNS).single()
    if (error) return { ok: false, error: error.message }
    row = data
  } else {
    const { data, error } = await svc.from("tenant_sso_connections")
      .insert({
        brokerage_id: gate.brokerageId,
        email_domain: emailDomain,
        metadata_url: metadataUrl,
        provider_type: "saml",
        status: "pending",
        created_by: gate.userId,
      })
      .select(ROW_COLUMNS).single()
    if (error) {
      if ((error as any).code === "23505") {
        return { ok: false, error: "That email domain is already connected to another workspace." }
      }
      return { ok: false, error: error.message }
    }
    row = data
  }

  // Register with the Supabase Auth Admin API. 'active' ONLY on a returned
  // provider id — a plan without the SAML add-on lands in 'error' with the
  // honest detail, and a deployment without the service key stays 'pending'.
  const result = await registerSsoProvider({ metadataUrl, emailDomain })
  if (!result.configured) {
    // MOCK-SAFE: row stays 'pending'; the panel carries the unconfigured note.
  } else if (result.ok) {
    const { data } = await svc.from("tenant_sso_connections")
      .update({
        status: "active",
        supabase_sso_provider_id: result.providerId,
        error_detail: null,
        activated_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", row.id).select(ROW_COLUMNS).single()
    row = data ?? { ...row, status: "active", supabase_sso_provider_id: result.providerId }
  } else {
    const detail = result.samlNotEnabled ? SAML_NOT_ENABLED_DETAIL : result.error
    const { data } = await svc.from("tenant_sso_connections")
      .update({ status: "error", error_detail: detail, updated_at: nowIso })
      .eq("id", row.id).select(ROW_COLUMNS).single()
    row = data ?? { ...row, status: "error", error_detail: detail }
  }

  await audit(svc, gate.userId, "sso_connection_configured", String(row.id), {
    brokerage_id: gate.brokerageId,
    email_domain: emailDomain,
    status: row.status,
    admin_configured: result.configured,
    provider_registered: !!row.supabase_sso_provider_id,
  })
  revalidatePath("/settings/users")
  return { ok: true, connection: rowToView(row) }
}

// ── CHECK STATUS (re-read the provider from the Admin API) ───────────────────

export async function checkSsoStatusAction(): Promise<
  { ok: true; connection: SsoConnectionView } | { ok: false; error: string }
> {
  const gate = await requireBrokerageAdmin()
  if (!gate.ok) return gate

  const svc = createServiceClient()
  const { data: existing } = await svc.from("tenant_sso_connections")
    .select(ROW_COLUMNS).eq("brokerage_id", gate.brokerageId).maybeSingle()
  if (!existing) return { ok: false, error: "No SSO connection configured" }

  const nowIso = new Date().toISOString()
  const providerId = (existing as any).supabase_sso_provider_id as string | null

  // Never registered (pending on an unconfigured deployment, or a prior
  // error) → try registration again; a check-now click is a retry.
  if (!providerId) {
    return configureSsoAction((existing as any).email_domain, (existing as any).metadata_url)
  }

  const result = await getProviderStatus(providerId)
  if (!result.configured) {
    // MOCK-SAFE: no service key — the row honestly stays where it is.
    return { ok: true, connection: rowToView(existing) }
  }

  let patch: Record<string, unknown>
  if (result.ok) {
    patch = {
      status: "active",
      error_detail: null,
      activated_at: (existing as any).activated_at ?? nowIso,
      updated_at: nowIso,
    }
  } else {
    patch = {
      status: "error",
      error_detail: result.samlNotEnabled ? SAML_NOT_ENABLED_DETAIL : result.error,
      updated_at: nowIso,
    }
  }

  const { data: updated, error: upErr } = await svc.from("tenant_sso_connections")
    .update(patch).eq("id", (existing as any).id).select(ROW_COLUMNS).single()
  if (upErr) return { ok: false, error: upErr.message }

  if (patch.status !== (existing as any).status) {
    await audit(svc, gate.userId, "sso_connection_status_checked", String((existing as any).id), {
      brokerage_id: gate.brokerageId,
      email_domain: (existing as any).email_domain,
      status: patch.status,
    })
  }
  revalidatePath("/settings/users")
  return { ok: true, connection: rowToView(updated) }
}

// ── DISABLE ──────────────────────────────────────────────────────────────────

export async function disableSsoAction(): Promise<
  { ok: true; connection: SsoConnectionView } | { ok: false; error: string }
> {
  const gate = await requireBrokerageAdmin()
  if (!gate.ok) return gate

  const svc = createServiceClient()
  const { data: existing } = await svc.from("tenant_sso_connections")
    .select(ROW_COLUMNS).eq("brokerage_id", gate.brokerageId).maybeSingle()
  if (!existing) return { ok: false, error: "No SSO connection configured" }

  // Supabase provider delete is best-effort — the row goes 'disabled' either
  // way so the login page stops offering SSO for the domain immediately.
  const providerId = (existing as any).supabase_sso_provider_id as string | null
  let detachError: string | null = null
  if (providerId) {
    const removal = await removeSsoProvider(providerId)
    if (removal.configured && !removal.ok) detachError = removal.error
  }

  const { data: updated, error } = await svc.from("tenant_sso_connections")
    .update({
      status: "disabled",
      supabase_sso_provider_id: null,
      error_detail: detachError ? `Disabled locally; Supabase provider removal failed: ${detachError}` : null,
      activated_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", (existing as any).id)
    .select(ROW_COLUMNS).single()
  if (error) return { ok: false, error: error.message }

  await audit(svc, gate.userId, "sso_connection_disabled", String((existing as any).id), {
    brokerage_id: gate.brokerageId,
    email_domain: (existing as any).email_domain,
    provider_detached: !detachError,
  })
  revalidatePath("/settings/users")
  return { ok: true, connection: rowToView(updated) }
}

// ── PUBLIC: does this email's domain have SSO? (login page) ──────────────────

/**
 * UNAUTHENTICATED by design — the login page calls it before any session
 * exists. Returns ONLY a boolean for an ACTIVE connection on the email's
 * exact domain: no domain lists, no brokerage identity, no status detail —
 * nothing that enumerates tenants. Every failure path is a quiet `false`.
 */
export async function checkSsoDomainAction(email: string): Promise<{ ssoAvailable: boolean }> {
  try {
    const domain = emailDomainOf(email)
    if (!domain) return { ssoAvailable: false }
    const svc = createServiceClient()
    const { data } = await svc.from("tenant_sso_connections")
      .select("id")
      .eq("email_domain", domain)
      .eq("status", "active")
      .maybeSingle()
    return { ssoAvailable: !!data }
  } catch {
    return { ssoAvailable: false }
  }
}
