// lib/platform/custom-domains.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHITE-LABEL CUSTOM DOMAINS — brokerage-tier tenants point www.theirbrokerage.com
// at their /site/[slug] storefront. This module is the server-side half:
//
//   1. PURE validation/normalization — domain syntax only, no scheme/path/port,
//      never *.vercel.app, never the platform's own hosts (env-derived — the
//      product domain is a setting, never hardcoded; see product-brand.ts).
//      Hosts are kept EXACT (lowercased, trailing dot stripped) — apex and www
//      are DISTINCT rows, we never fold one into the other.
//   2. Vercel Domains API client (fetch-based, edge-safe) — add / status /
//      remove against the project. MOCK-SAFE: without VERCEL_TOKEN +
//      VERCEL_PROJECT_ID every call returns { configured: false, instructions }
//      and rows stay 'pending_dns'; the tenant still gets Vercel's STANDARD
//      DNS targets (A 76.76.21.21 for apex, CNAME cname.vercel-dns.com for
//      subdomains) so nothing about the flow lies. When live, any challenge
//      records the API returns (e.g. _vercel TXT for cross-account claims)
//      are surfaced alongside the standard targets.
//
// DB truth lives in tenant_custom_domains (status: pending_dns → verifying →
// active | error | removed); the actions layer (app/actions/custom-domains.ts)
// owns the row lifecycle, this module owns validation + the Vercel wire.

import { DEFAULT_PRODUCT_BRAND } from "@/lib/platform/product-brand"

// ── DNS targets (Vercel's standard, documented targets) ──────────────────────

export const VERCEL_APEX_A_TARGET = "76.76.21.21"
export const VERCEL_CNAME_TARGET = "cname.vercel-dns.com"

export interface DnsRecordInstruction {
  type: "A" | "CNAME" | "TXT"
  /** The record NAME as the tenant types it at their DNS provider. */
  name: string
  value: string
  note: string
}

export interface VercelVerificationChallenge {
  type: string
  domain: string
  value: string
  reason?: string
}

// ── PURE: syntax validation + normalization ──────────────────────────────────

export type DomainValidation = { ok: true; domain: string } | { ok: false; error: string }

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * PURE. Normalize (lowercase, trim, strip one trailing dot) and validate a
 * bare hostname. We deliberately do NOT strip "www." — apex and www are
 * distinct hosts and distinct rows; the tenant connects each explicitly.
 */
export function validateCustomDomain(raw: string, reservedHosts: readonly string[] = []): DomainValidation {
  let d = (raw ?? "").trim().toLowerCase()
  if (d.endsWith(".")) d = d.slice(0, -1)
  if (!d) return { ok: false, error: "Enter a domain, e.g. www.yourbrokerage.com" }
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(d) || d.includes("://")) {
    return { ok: false, error: "Enter just the host — no https:// prefix" }
  }
  if (d.includes("/") || d.includes("?") || d.includes("#")) {
    return { ok: false, error: "Enter just the host — no path or query" }
  }
  if (d.includes(":")) return { ok: false, error: "Enter just the host — no port" }
  if (d.includes("@") || /\s/.test(d)) return { ok: false, error: "That doesn't look like a valid domain" }
  if (d.length > 253) return { ok: false, error: "Domain is too long" }

  const labels = d.split(".")
  if (labels.length < 2) return { ok: false, error: "Enter a full domain, e.g. yourbrokerage.com" }
  for (const label of labels) {
    if (!LABEL_RE.test(label)) return { ok: false, error: "That doesn't look like a valid domain" }
  }
  const tld = labels[labels.length - 1]
  if (!/[a-z]/.test(tld)) return { ok: false, error: "That doesn't look like a valid domain" }

  if (d === "vercel.app" || d.endsWith(".vercel.app")) {
    return { ok: false, error: "vercel.app domains can't be connected — use a domain you own" }
  }
  for (const reserved of reservedHosts) {
    const r = reserved.trim().toLowerCase()
    if (!r) continue
    if (d === r || d.endsWith(`.${r}`)) {
      return { ok: false, error: "That domain belongs to the platform — connect a domain you own" }
    }
  }
  return { ok: true, domain: d }
}

/**
 * The platform's OWN hosts — a tenant may never claim these. Env-derived
 * (NEXT_PUBLIC_APP_URL / Vercel deployment hosts) plus the product brand's
 * marketing origin (product-brand.ts is the product-domain source; its
 * DEFAULT ctaUrl is the only compiled-in candidate and is itself a setting).
 */
export function platformReservedHosts(): string[] {
  const out = new Set<string>(["localhost", "127.0.0.1"])
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null,
    DEFAULT_PRODUCT_BRAND.ctaUrl,
  ]
  for (const c of candidates) {
    if (!c) continue
    try {
      const h = new URL(c).hostname.toLowerCase()
      out.add(h)
      // Reserve the www/apex twin too — both point at the same property.
      out.add(h.startsWith("www.") ? h.slice(4) : `www.${h}`)
    } catch {
      /* unparseable env value — skip */
    }
  }
  return Array.from(out)
}

/** PURE: apex = exactly two labels (foo.com). Multi-label hosts get CNAME advice. */
export function isApexDomain(domain: string): boolean {
  return domain.split(".").length === 2
}

/**
 * PURE: the DNS records the tenant must create for this host. These are
 * Vercel's standard targets; when the Vercel API is live it may ADD challenge
 * records (surfaced separately from tenant_custom_domains.verification).
 */
export function dnsInstructionsFor(domain: string): DnsRecordInstruction[] {
  if (isApexDomain(domain)) {
    return [{
      type: "A",
      name: "@",
      value: VERCEL_APEX_A_TARGET,
      note: `Root/apex record for ${domain} (Vercel's standard apex target)`,
    }]
  }
  const [firstLabel] = domain.split(".")
  return [{
    type: "CNAME",
    name: firstLabel,
    value: VERCEL_CNAME_TARGET,
    note: `Subdomain record for ${domain} (Vercel's standard CNAME target)`,
  }]
}

// ── Vercel Domains API client (mock-safe) ────────────────────────────────────

export interface VercelDomainsConfig {
  configured: boolean
  token?: string
  projectId?: string
  teamId?: string
}

/** No existing Vercel API usage in the repo — canonical names are
 *  VERCEL_TOKEN + VERCEL_PROJECT_ID (+ optional VERCEL_TEAM_ID). */
export function getVercelDomainsConfig(): VercelDomainsConfig {
  const token = process.env.VERCEL_TOKEN?.trim()
  const projectId = process.env.VERCEL_PROJECT_ID?.trim()
  const teamId = process.env.VERCEL_TEAM_ID?.trim()
  if (!token || !projectId) return { configured: false }
  return { configured: true, token, projectId, teamId: teamId || undefined }
}

export const VERCEL_NOT_CONFIGURED_NOTE =
  "Automatic domain registration isn't configured on this deployment (VERCEL_TOKEN / VERCEL_PROJECT_ID are not set). " +
  "The domain stays in Pending DNS: set the standard DNS records shown, and a platform operator must also add the domain " +
  "to the Vercel project before it can go live."

export type VercelDomainResult =
  | { configured: false; instructions: string }
  | {
      configured: true
      ok: boolean
      /** Vercel considers the domain verified (attached + ownership proven). */
      verified: boolean
      /** Extra challenge records Vercel wants (e.g. _vercel TXT). */
      challenges: VercelVerificationChallenge[]
      /** Vercel error code when !ok (e.g. domain_taken, not_found). */
      errorCode: string | null
      error: string | null
    }

const VERCEL_API = "https://api.vercel.com"

function vercelUrl(cfg: VercelDomainsConfig, path: string): string {
  const qs = cfg.teamId ? `?teamId=${encodeURIComponent(cfg.teamId)}` : ""
  return `${VERCEL_API}${path}${qs}`
}

async function vercelFetch(
  cfg: VercelDomainsConfig,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  const res = await fetch(vercelUrl(cfg, path), {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

function parseChallenges(raw: any): VercelVerificationChallenge[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c) => c && typeof c === "object")
    .map((c) => ({
      type: String(c.type ?? "TXT"),
      domain: String(c.domain ?? ""),
      value: String(c.value ?? ""),
      reason: c.reason ? String(c.reason) : undefined,
    }))
    .filter((c) => c.domain && c.value)
}

/** POST /v10/projects/{id}/domains — attach the domain to the project. */
export async function addDomainToProject(domain: string): Promise<VercelDomainResult> {
  const cfg = getVercelDomainsConfig()
  if (!cfg.configured) return { configured: false, instructions: VERCEL_NOT_CONFIGURED_NOTE }
  try {
    const { status, json } = await vercelFetch(cfg, `/v10/projects/${cfg.projectId}/domains`, {
      method: "POST",
      body: { name: domain },
    })
    if (status >= 400) {
      const code = json?.error?.code ? String(json.error.code) : `http_${status}`
      // "already added to this project" is success-shaped — fall through to a status read.
      if (code === "domain_already_in_use" || code === "conflict") {
        return getDomainStatus(domain)
      }
      return {
        configured: true, ok: false, verified: false, challenges: [],
        errorCode: code,
        error: json?.error?.message ? String(json.error.message) : `Vercel API error (${status})`,
      }
    }
    return {
      configured: true, ok: true,
      verified: json?.verified === true,
      challenges: parseChallenges(json?.verification),
      errorCode: null, error: null,
    }
  } catch (e) {
    return {
      configured: true, ok: false, verified: false, challenges: [],
      errorCode: "network_error",
      error: e instanceof Error ? e.message : "Could not reach the Vercel API",
    }
  }
}

/**
 * GET /v9/projects/{id}/domains/{domain} — verified flag + open challenges.
 * When challenges are pending we also POST …/verify (best-effort) so a
 * check-now click can complete verification in one round trip.
 */
export async function getDomainStatus(domain: string): Promise<VercelDomainResult> {
  const cfg = getVercelDomainsConfig()
  if (!cfg.configured) return { configured: false, instructions: VERCEL_NOT_CONFIGURED_NOTE }
  try {
    const base = `/v9/projects/${cfg.projectId}/domains/${encodeURIComponent(domain)}`
    let { status, json } = await vercelFetch(cfg, base)
    if (status === 404) {
      return {
        configured: true, ok: false, verified: false, challenges: [],
        errorCode: "not_found",
        error: "Domain is not attached to the Vercel project",
      }
    }
    if (status >= 400) {
      return {
        configured: true, ok: false, verified: false, challenges: [],
        errorCode: json?.error?.code ? String(json.error.code) : `http_${status}`,
        error: json?.error?.message ? String(json.error.message) : `Vercel API error (${status})`,
      }
    }
    let verified = json?.verified === true
    let challenges = parseChallenges(json?.verification)
    if (!verified && challenges.length > 0) {
      // Nudge verification — Vercel re-checks the challenge records on demand.
      const attempt = await vercelFetch(cfg, `${base}/verify`, { method: "POST" }).catch(() => null)
      if (attempt && attempt.status < 400) {
        verified = attempt.json?.verified === true
        challenges = parseChallenges(attempt.json?.verification)
      }
    }
    return { configured: true, ok: true, verified, challenges, errorCode: null, error: null }
  } catch (e) {
    return {
      configured: true, ok: false, verified: false, challenges: [],
      errorCode: "network_error",
      error: e instanceof Error ? e.message : "Could not reach the Vercel API",
    }
  }
}

/** DELETE /v9/projects/{id}/domains/{domain} — detach (best-effort on remove). */
export async function removeDomainFromProject(
  domain: string,
): Promise<{ configured: boolean; ok: boolean; error: string | null }> {
  const cfg = getVercelDomainsConfig()
  if (!cfg.configured) return { configured: false, ok: true, error: null }
  try {
    const { status, json } = await vercelFetch(
      cfg,
      `/v9/projects/${cfg.projectId}/domains/${encodeURIComponent(domain)}`,
      { method: "DELETE" },
    )
    if (status === 404) return { configured: true, ok: true, error: null } // already gone
    if (status >= 400) {
      return {
        configured: true, ok: false,
        error: json?.error?.message ? String(json.error.message) : `Vercel API error (${status})`,
      }
    }
    return { configured: true, ok: true, error: null }
  } catch (e) {
    return { configured: true, ok: false, error: e instanceof Error ? e.message : "Could not reach the Vercel API" }
  }
}
