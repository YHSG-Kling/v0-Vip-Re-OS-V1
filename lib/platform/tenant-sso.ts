import "server-only"

// lib/platform/tenant-sso.ts
// ─────────────────────────────────────────────────────────────────────────────
// ENTERPRISE SSO (SAML) — brokerage-tier tenants connect their identity
// provider (Okta, Entra ID, Google Workspace SAML…) so their agents sign in
// with the brokerage's own IdP instead of passwords. This module is the
// server-side half:
//
//   1. PURE validation — email-domain syntax (bare domain, no scheme/@/path),
//      refusal of PUBLIC email providers (gmail/yahoo/outlook/…) with honest
//      copy (SSO binds a COMPANY domain to a company IdP — a public inbox
//      domain can never be claimed by one tenant), and metadata-URL checks
//      (https only — IdP metadata carries the signing certificate; we never
//      fetch it over plaintext).
//   2. Supabase Auth Admin SSO API client (fetch-based) — register / status /
//      remove against {SUPABASE_URL}/auth/v1/admin/sso/providers with the
//      service-role key. HONEST CAPABILITY BOUNDARY: Supabase SAML SSO
//      requires a Pro-plan project WITH the SAML 2.0 add-on enabled. On a
//      project without it the admin endpoints 404/403 — we surface that as
//      status 'error' + SAML_NOT_ENABLED_DETAIL, never a fake 'active'.
//      A row goes 'active' ONLY when the Admin API returns a provider id.
//
// DB truth lives in tenant_sso_connections (one row per brokerage —
// brokerage_id UNIQUE, email_domain globally UNIQUE; status: pending →
// active | disabled | error). The actions layer (app/actions/tenant-sso.ts)
// owns the row lifecycle, this module owns validation + the Supabase wire.

// ── PURE: email-domain validation ────────────────────────────────────────────

export type SsoDomainValidation = { ok: true; domain: string } | { ok: false; error: string }

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Public consumer email providers — an SSO connection claims every login on
 * its domain, so a shared public domain can never belong to one brokerage.
 */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "ymail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com",
])

export const PUBLIC_DOMAIN_ERROR = (domain: string) =>
  `${domain} is a public email provider — SSO connects your brokerage's OWN identity provider to a domain ` +
  "your company controls (e.g. yourbrokerage.com). Everyone on a public domain would be claimed by your " +
  "connection, so public inbox domains can't be used."

/**
 * PURE. Normalize (lowercase, trim, strip a leading "@" and one trailing dot)
 * and validate a bare email domain, refusing public providers.
 */
export function validateSsoEmailDomain(raw: string): SsoDomainValidation {
  let d = (raw ?? "").trim().toLowerCase()
  if (d.startsWith("@")) d = d.slice(1)
  if (d.endsWith(".")) d = d.slice(0, -1)
  if (!d) return { ok: false, error: "Enter your email domain, e.g. yourbrokerage.com" }
  if (d.includes("://") || d.includes("/") || d.includes("?") || d.includes("#")) {
    return { ok: false, error: "Enter just the domain — no https:// prefix or path" }
  }
  if (d.includes("@")) return { ok: false, error: "Enter just the domain part — the text after the @ in your email" }
  if (d.includes(":") || /\s/.test(d)) return { ok: false, error: "That doesn't look like a valid email domain" }
  if (d.length > 253) return { ok: false, error: "Domain is too long" }

  const labels = d.split(".")
  if (labels.length < 2) return { ok: false, error: "Enter a full domain, e.g. yourbrokerage.com" }
  for (const label of labels) {
    if (!LABEL_RE.test(label)) return { ok: false, error: "That doesn't look like a valid email domain" }
  }
  if (!/[a-z]/.test(labels[labels.length - 1])) {
    return { ok: false, error: "That doesn't look like a valid email domain" }
  }
  if (PUBLIC_EMAIL_DOMAINS.has(d)) return { ok: false, error: PUBLIC_DOMAIN_ERROR(d) }
  return { ok: true, domain: d }
}

// ── PURE: metadata-URL validation ────────────────────────────────────────────

export type MetadataUrlValidation = { ok: true; url: string } | { ok: false; error: string }

/**
 * PURE. The IdP's SAML metadata URL — https only (it carries the IdP signing
 * certificate; Supabase fetches it server-side, plaintext is never OK).
 */
export function validateMetadataUrl(raw: string): MetadataUrlValidation {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return { ok: false, error: "Enter your identity provider's SAML metadata URL" }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL" }
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Metadata URL must be https:// — SAML metadata carries your IdP's signing certificate" }
  }
  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    return { ok: false, error: "That doesn't look like a valid metadata URL" }
  }
  return { ok: true, url: parsed.toString() }
}

// ── PURE: extract a login email's domain (for the public availability check) ─

export function emailDomainOf(email: string): string | null {
  const at = (email ?? "").trim().toLowerCase().lastIndexOf("@")
  if (at <= 0) return null
  const domain = (email ?? "").trim().toLowerCase().slice(at + 1)
  return domain && domain.includes(".") ? domain : null
}

// ── SP endpoints — composed from the project env, shown in setup steps ───────

function supabaseUrlBase(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  if (!url) return null
  return url.replace(/\/+$/, "")
}

/** The Assertion Consumer Service URL the tenant pastes into their IdP. */
export function samlAcsUrl(): string | null {
  const base = supabaseUrlBase()
  return base ? `${base}/auth/v1/sso/saml/acs` : null
}

/** The SP Entity ID (also the SP metadata URL) the tenant pastes into their IdP. */
export function samlEntityId(): string | null {
  const base = supabaseUrlBase()
  return base ? `${base}/auth/v1/sso/saml/metadata` : null
}

// ── Supabase Auth Admin SSO API client (mock-safe) ───────────────────────────

export type SsoAdminConfig =
  | { configured: false }
  | { configured: true; url: string; serviceKey: string }

export function getSsoAdminConfig(): SsoAdminConfig {
  const url = supabaseUrlBase()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceKey) return { configured: false }
  return { configured: true, url, serviceKey }
}

export const SSO_NOT_CONFIGURED_NOTE =
  "SSO provider registration isn't configured on this deployment (NEXT_PUBLIC_SUPABASE_URL / " +
  "SUPABASE_SERVICE_ROLE_KEY are not set). The connection stays Pending — a platform operator " +
  "must complete registration before SSO logins can work."

/** The honest boundary: SAML lives behind Supabase's Pro plan + SAML add-on. */
export const SAML_NOT_ENABLED_DETAIL =
  "SAML is not enabled on this Supabase project (Pro plan + SAML add-on required)"

export type SsoAdminResult =
  | { configured: false; instructions: string }
  | { configured: true; ok: true; providerId: string }
  | {
      configured: true
      ok: false
      /** The admin SSO endpoints 404/403 on plans without the SAML add-on. */
      samlNotEnabled: boolean
      errorCode: string | null
      error: string
    }

async function adminFetch(
  cfg: { url: string; serviceKey: string },
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${cfg.url}/auth/v1/admin/sso/providers${path}`, {
    method: init?.method ?? "GET",
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

function adminErrorMessage(json: any, status: number): string {
  const msg = json?.msg ?? json?.message ?? json?.error_description ?? json?.error
  return msg ? String(msg) : `Supabase Auth Admin API error (${status})`
}

/**
 * POST /auth/v1/admin/sso/providers — register a SAML provider for the domain.
 * Returns the provider id ONLY when Supabase actually created it — the row
 * goes 'active' on that id and never otherwise.
 */
export async function registerSsoProvider(params: {
  metadataUrl: string
  emailDomain: string
}): Promise<SsoAdminResult> {
  const cfg = getSsoAdminConfig()
  if (!cfg.configured) return { configured: false, instructions: SSO_NOT_CONFIGURED_NOTE }
  try {
    const { status, json } = await adminFetch(cfg, "", {
      method: "POST",
      body: {
        type: "saml",
        metadata_url: params.metadataUrl,
        domains: [params.emailDomain],
      },
    })
    // Plans without the SAML add-on 404 (endpoint hidden) or 403 the admin
    // SSO surface — the ONE honest reading is "SAML isn't enabled here".
    if (status === 404 || status === 403) {
      return { configured: true, ok: false, samlNotEnabled: true, errorCode: `http_${status}`, error: SAML_NOT_ENABLED_DETAIL }
    }
    if (status >= 400) {
      return {
        configured: true, ok: false, samlNotEnabled: false,
        errorCode: `http_${status}`,
        error: adminErrorMessage(json, status),
      }
    }
    const providerId = json?.id ? String(json.id) : null
    if (!providerId) {
      return {
        configured: true, ok: false, samlNotEnabled: false,
        errorCode: "no_provider_id",
        error: "Supabase accepted the request but returned no provider id — the connection was not activated.",
      }
    }
    return { configured: true, ok: true, providerId }
  } catch (e) {
    return {
      configured: true, ok: false, samlNotEnabled: false,
      errorCode: "network_error",
      error: e instanceof Error ? e.message : "Could not reach the Supabase Auth Admin API",
    }
  }
}

/** GET /auth/v1/admin/sso/providers/{id} — does the provider still exist? */
export async function getProviderStatus(providerId: string): Promise<SsoAdminResult> {
  const cfg = getSsoAdminConfig()
  if (!cfg.configured) return { configured: false, instructions: SSO_NOT_CONFIGURED_NOTE }
  try {
    const { status, json } = await adminFetch(cfg, `/${encodeURIComponent(providerId)}`)
    if (status === 404 || status === 403) {
      // Could be a deleted provider OR the add-on turned off — either way the
      // provider is not answering; the caller records error, not active.
      return { configured: true, ok: false, samlNotEnabled: true, errorCode: `http_${status}`, error: SAML_NOT_ENABLED_DETAIL }
    }
    if (status >= 400) {
      return {
        configured: true, ok: false, samlNotEnabled: false,
        errorCode: `http_${status}`,
        error: adminErrorMessage(json, status),
      }
    }
    const id = json?.id ? String(json.id) : null
    if (!id) {
      return {
        configured: true, ok: false, samlNotEnabled: false,
        errorCode: "no_provider_id",
        error: "Provider not found on the Supabase project",
      }
    }
    return { configured: true, ok: true, providerId: id }
  } catch (e) {
    return {
      configured: true, ok: false, samlNotEnabled: false,
      errorCode: "network_error",
      error: e instanceof Error ? e.message : "Could not reach the Supabase Auth Admin API",
    }
  }
}

/** DELETE /auth/v1/admin/sso/providers/{id} — best-effort on disable. */
export async function removeSsoProvider(
  providerId: string,
): Promise<{ configured: boolean; ok: boolean; error: string | null }> {
  const cfg = getSsoAdminConfig()
  if (!cfg.configured) return { configured: false, ok: true, error: null }
  try {
    const { status, json } = await adminFetch(cfg, `/${encodeURIComponent(providerId)}`, { method: "DELETE" })
    if (status === 404) return { configured: true, ok: true, error: null } // already gone
    if (status >= 400) {
      return { configured: true, ok: false, error: adminErrorMessage(json, status) }
    }
    return { configured: true, ok: true, error: null }
  } catch (e) {
    return {
      configured: true, ok: false,
      error: e instanceof Error ? e.message : "Could not reach the Supabase Auth Admin API",
    }
  }
}
