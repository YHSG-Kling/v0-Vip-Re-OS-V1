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
// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
function isApexDomain(domain: string): boolean {
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

// ── PER-PROVIDER DNS GUIDES (wave 141G) ──────────────────────────────────────
//
// Owner ruling (wave 141): VIPAgents does NOT sell, register or host domains. The
// tenant connects a domain THEY own at THEIR DNS provider (GoDaddy, Cloudflare,
// Namecheap, Squarespace Domains, any other DNS). The VALUES are identical at every
// provider (the standard targets above); what differs is the console path, the
// name convention and the provider-specific trap that makes verification fail.
// Pure: a guide is derived from the host + the provider key, never stored.

export const DNS_PROVIDERS = ["godaddy", "cloudflare", "namecheap", "squarespace", "other"] as const
type DnsProviderKey = (typeof DNS_PROVIDERS)[number]

export interface DnsProviderGuide {
  provider: DnsProviderKey
  label: string
  /** Where in that console the records are entered. */
  consolePath: string
  /** Ordered steps for THIS host at THIS provider. */
  steps: string[]
  /** The records exactly as that console expects them (name convention applied). */
  records: DnsRecordInstruction[]
  /** Provider traps that keep a correct value from verifying. */
  cautions: string[]
}

const DNS_PROVIDER_LABELS: Record<DnsProviderKey, string> = {
  godaddy: "GoDaddy",
  cloudflare: "Cloudflare",
  namecheap: "Namecheap",
  squarespace: "Squarespace Domains",
  other: "Another DNS provider",
}

/**
 * PURE: the console-specific guide for connecting `domain` at `provider`. Values come
 * from dnsInstructionsFor (one source); every guide carries at least one step, the
 * exact record(s), and the provider's known trap. An unknown provider key gets the
 * generic guide — never a refusal, the tenant can always read the raw records.
 */
export function dnsProviderGuide(provider: string | null | undefined, domain: string): DnsProviderGuide {
  const key: DnsProviderKey = (DNS_PROVIDERS as readonly string[]).includes(provider ?? "") ? (provider as DnsProviderKey) : "other"
  const base = dnsInstructionsFor(domain)
  const apex = isApexDomain(domain)
  const rec = base[0]
  const hostLabel = apex ? "@" : rec.name
  const records: DnsRecordInstruction[] = base.map((r) => ({ ...r, name: apex ? "@" : r.name }))
  const typeWord = rec.type === "A" ? "an A record" : "a CNAME record"
  const ttlStep = "Leave TTL at the provider default (or 1 hour) and save."
  const existingStep = `If a record already exists for "${hostLabel}" (a parked page, a forwarding rule or a previous site), edit it to the value below — don't add a second one.`

  switch (key) {
    case "godaddy":
      return {
        provider: key, label: DNS_PROVIDER_LABELS[key],
        consolePath: "GoDaddy → My Products → Domains → (your domain) → DNS → Manage DNS",
        steps: [
          `Open Manage DNS for ${domain.split(".").slice(-2).join(".")} and choose Add New Record.`,
          `Add ${typeWord} with Name "${hostLabel}" and the Value shown below.`,
          existingStep, ttlStep,
        ],
        records,
        cautions: [
          "Turn OFF Domain Forwarding for this host — a forwarding rule overrides the record and verification never completes.",
          "GoDaddy's default \"Parked\" A record for @ must be replaced, not kept alongside the new one.",
        ],
      }
    case "cloudflare":
      return {
        provider: key, label: DNS_PROVIDER_LABELS[key],
        consolePath: "Cloudflare dashboard → (your domain) → DNS → Records",
        steps: [
          "Click Add record.",
          `Choose ${rec.type}, set Name to "${hostLabel}" and Target/Content to the value below.`,
          "Set Proxy status to DNS only (the grey cloud), then Save.",
          existingStep,
        ],
        records,
        cautions: [
          "The record MUST be DNS only (grey cloud). A proxied (orange cloud) record hides the target, so verification and the SSL certificate cannot complete.",
          "If SSL/TLS mode is Full (strict) for other hosts, leave it — this host is served by the platform's own certificate once verified.",
        ],
      }
    case "namecheap":
      return {
        provider: key, label: DNS_PROVIDER_LABELS[key],
        consolePath: "Namecheap → Domain List → Manage → Advanced DNS → Host Records",
        steps: [
          "Confirm Nameservers (Domain tab) is Namecheap BasicDNS or Namecheap Web Hosting DNS — if the domain uses custom nameservers, add the record at THAT DNS host instead.",
          `Add New Record: Type ${rec.type}${rec.type === "A" ? " Record" : " Record"}, Host "${hostLabel}", Value as shown below.`,
          existingStep, ttlStep,
        ],
        records,
        cautions: [
          "Remove any URL Redirect Record for the same host — a redirect record and the new record cannot coexist.",
          "Namecheap's default parking CNAME for www must be replaced when you connect www.",
        ],
      }
    case "squarespace":
      return {
        provider: key, label: DNS_PROVIDER_LABELS[key],
        consolePath: "Squarespace → Domains → (your domain) → DNS → DNS Settings → Custom records",
        steps: [
          "Open Custom records and click Add record.",
          `Set Host to "${hostLabel}", Type to ${rec.type}, and Data to the value below, then Save.`,
          existingStep,
        ],
        records,
        cautions: [
          "If this domain was pointed at a Squarespace website, delete Squarespace's own preset records for the same host (the Squarespace defaults block the new record).",
          "Domain forwarding in Squarespace must be off for this host.",
        ],
      }
    default:
      return {
        provider: "other", label: DNS_PROVIDER_LABELS.other,
        consolePath: "Your DNS provider's DNS / zone / host-records page for the domain",
        steps: [
          `Add ${typeWord} for ${apex ? "the root (shown as @, blank, or the bare domain depending on the provider)" : `the host "${hostLabel}"`} with the value below.`,
          existingStep, ttlStep,
          "If your provider proxies or forwards traffic (a CDN or redirect feature), turn it off for this host.",
        ],
        records,
        cautions: ["Only one record may exist for this host name; replace any parked, forwarding or previous-site record."],
      }
  }
}

// ── DNS PROBE — immediate, fail-closed feedback (wave 141G) ──────────────────
//
// The tenant sets a record and wants to know NOW whether it is visible, not after
// a day. The probe asks public DNS for the host's A / CNAME and compares against
// the standard targets. It is FEEDBACK, never the verdict: only the routing layer's
// verified flag flips a row to active (nextCustomDomainStatus). FAIL CLOSED: a
// resolver that cannot answer (timeout, SERVFAIL, no resolver in this runtime)
// reports checked:false + matches:false with its reason — never "looks fine".

/** File-local by design (the proof types its fixture structurally) — the seam is the `resolver` option. */
interface DnsProbeResolver {
  resolve4(host: string): Promise<string[]>
  resolveCname(host: string): Promise<string[]>
}

export interface DnsProbe {
  /** false = the lookup itself could not run (not "no record") — fail closed. */
  checked: boolean
  /** true only when an observed record carries a standard target. */
  matches: boolean
  observed: { a: string[]; cname: string[] }
  expected: DnsRecordInstruction
  /** Tenant-safe sentence (names the host and the expected value, never a provider or an env key). */
  reason: string
  checkedAt: string
}

/** Error codes that mean "the name has no such record", which is an ANSWER, not a failure. */
const DNS_NO_RECORD_CODES: ReadonlySet<string> = new Set(["ENODATA", "ENOTFOUND", "ENOTIMP"])

async function defaultDnsResolver(): Promise<DnsProbeResolver | null> {
  try {
    const { promises } = await import("node:dns")
    return { resolve4: (h) => promises.resolve4(h), resolveCname: (h) => promises.resolveCname(h) }
  } catch {
    return null // edge / unsupported runtime — the caller fails closed
  }
}

export async function probeDomainDns(
  domain: string,
  opts: { resolver?: DnsProbeResolver; now?: Date } = {},
): Promise<DnsProbe> {
  const expected = dnsInstructionsFor(domain)[0]
  const checkedAt = (opts.now ?? new Date()).toISOString()
  const resolver = opts.resolver ?? (await defaultDnsResolver())
  const empty = { a: [] as string[], cname: [] as string[] }
  if (!resolver) {
    return { checked: false, matches: false, observed: empty, expected, reason: `The DNS check could not run from here — the ${expected.type} record for ${domain} was not verified.`, checkedAt }
  }
  type Look = { ok: true; v: string[] } | { ok: false; code: string }
  const look = async (p: Promise<string[]>): Promise<Look> => {
    try { return { ok: true, v: (await p).map((s) => String(s).toLowerCase().replace(/\.$/, "")) } }
    catch (e) { return { ok: false, code: String((e as { code?: string })?.code ?? "lookup_failed") } }
  }
  const [cname, a] = await Promise.all([look(resolver.resolveCname(domain)), look(resolver.resolve4(domain))])
  const observed = { a: a.ok ? a.v : [], cname: cname.ok ? cname.v : [] }
  const lookupBroken = !a.ok && !cname.ok && !(DNS_NO_RECORD_CODES.has(a.code) && DNS_NO_RECORD_CODES.has(cname.code))
  if (lookupBroken) {
    return { checked: false, matches: false, observed, expected, reason: `DNS for ${domain} could not be read right now — try the check again in a minute. Nothing was changed.`, checkedAt }
  }
  // Either standard target satisfies routing (a CNAME to the platform, or the apex A target).
  const matches = observed.cname.includes(VERCEL_CNAME_TARGET) || observed.a.includes(VERCEL_APEX_A_TARGET)
  if (matches) {
    return { checked: true, matches: true, observed, expected, reason: `The DNS record for ${domain} is visible and points at the platform.`, checkedAt }
  }
  const seen = [...observed.cname.map((v) => `CNAME ${v}`), ...observed.a.map((v) => `A ${v}`)]
  const reason = seen.length === 0
    ? `No DNS record is visible yet for ${domain}. Add the ${expected.type} record (${expected.name} → ${expected.value}) at your provider; changes usually show within minutes, sometimes up to a few hours.`
    : `${domain} currently resolves to ${seen.join(", ")} — it needs ${expected.type} ${expected.name} → ${expected.value}. Replace the existing record at your provider, then check again.`
  return { checked: true, matches: false, observed, expected, reason, checkedAt }
}

// ── THE ROW STATE MACHINE (wave 141G) — one transition table, pure ───────────
//
// tenant_custom_domains.status (live CHECK): pending_dns → verifying → active |
// error | removed. The actions layer used to inline every transition; the table is
// here so the lifecycle is PROVABLE and so nothing but a verified signal can reach
// `active` (fail closed: routing unavailable never promotes).

/** @proofSeam the proof walks the whole status × signal table and holds it to the live CHECK vocabulary */
export const CUSTOM_DOMAIN_STATUSES = ["pending_dns", "verifying", "active", "error", "removed"] as const
export type CustomDomainStatus = (typeof CUSTOM_DOMAIN_STATUSES)[number]

export type CustomDomainSignal =
  | "attach_ok_verified"   // attached to the project and already verified
  | "attach_ok_unverified" // attached; DNS / challenge still outstanding
  | "attach_failed"        // the routing layer refused the attach
  | "check_verified"       // a status check saw the domain verified
  | "check_unverified"     // a status check saw it attached but not verified
  | "check_failed"         // the status check itself was refused
  | "routing_unavailable"  // no routing layer configured — nothing can be verified
  | "remove"               // the tenant detached it
  | "revive"               // the tenant re-added a removed host

export function nextCustomDomainStatus(current: CustomDomainStatus, signal: CustomDomainSignal): CustomDomainStatus {
  if (current === "removed") return signal === "revive" ? "pending_dns" : "removed"
  switch (signal) {
    case "attach_ok_verified":
    case "check_verified":      return "active"
    case "attach_ok_unverified": return "pending_dns"
    case "check_unverified":    return "verifying"
    case "attach_failed":
    case "check_failed":        return "error"
    case "remove":              return "removed"
    case "routing_unavailable": return current // never promotes, never demotes — nothing was learned
    case "revive":              return current // only meaningful from removed
  }
}

/** The statuses a CONNECT may leave a row in — exactly the set reachable from pending_dns by an
 *  attach signal (or no routing): the immediate post-condition the action re-reads for. The proof
 *  DERIVES this from the table above and refuses a drift. */
export const CONNECT_POST_CONDITION_STATUSES: ReadonlySet<CustomDomainStatus> = new Set(["pending_dns", "active", "error"])

// ── TENANT-SAFE MESSAGES (wave 141G) ─────────────────────────────────────────
//
// The routing layer's raw error (code + message) is PLATFORM evidence: it stays in
// tenant_custom_domains.error_detail / verification.error_code for staff and the
// self-heal ledger. The tenant sees a capability sentence — no provider name, no
// API code, no env key, no credential (wave 141 PROVIDER VISIBILITY ruling).

const TENANT_DOMAIN_MESSAGES: Record<string, string> = {
  domain_taken:          "This domain is attached to another account. If you own it, remove it there (or ask whoever set it up to), then check again.",
  domain_already_in_use: "This domain is attached to another account. If you own it, remove it there (or ask whoever set it up to), then check again.",
  conflict:              "This domain is attached to another account. If you own it, remove it there (or ask whoever set it up to), then check again.",
  invalid_domain:        "This domain can't be connected as entered. Check the spelling and that it's a domain you own.",
  bad_request:           "This domain can't be connected as entered. Check the spelling and that it's a domain you own.",
  forbidden:             "This domain can't be connected from this workspace. If you believe you own it, contact support.",
  not_found:             "The domain isn't attached to routing yet — run Check status to attach it again.",
  network_error:         "The routing service couldn't be reached — nothing changed. Try again in a few minutes; the platform team has been notified.",
}
const TENANT_DOMAIN_MESSAGE_PENDING  = "Verification isn't complete yet. Confirm the DNS record below at your provider, then check again."
const TENANT_DOMAIN_MESSAGE_ERROR    = "Verification hit a problem on the routing side — nothing changed. Try Check status again in a few minutes; the platform team has been notified."
const TENANT_DOMAIN_MESSAGE_ACTIVE   = "Live — this domain serves your website."

/**
 * PURE. The one sentence a tenant sees for a row's state. `errorCode` is the routing layer's
 * code (stored, never shown); an unknown code in status 'error' gets the generic error line.
 * Output NEVER contains a provider name, an env key, an HTTP code or a credential.
 */
export function tenantFacingDomainMessage(status: string, errorCode?: string | null): string {
  if (status === "active") return TENANT_DOMAIN_MESSAGE_ACTIVE
  const code = (errorCode ?? "").trim().toLowerCase()
  // Declared further down (beside the routing client) — resolved at call time, never at module load.
  if (code === "routing_unavailable") return ROUTING_UNAVAILABLE_TENANT_NOTE
  if (code && TENANT_DOMAIN_MESSAGES[code]) return TENANT_DOMAIN_MESSAGES[code]
  if (status === "error") return TENANT_DOMAIN_MESSAGE_ERROR
  return TENANT_DOMAIN_MESSAGE_PENDING
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

/**
 * STAFF / SYSTEM note (wave 141G) — names the env keys so an operator can fix the deployment.
 * NEVER shown to a tenant (wave 141 ruling: a tenant sees sanitized capability status only,
 * never internal provider configuration). "Attachment", not "registration": the platform never
 * registers, sells or hosts a domain — it attaches a domain the tenant owns to the routing layer.
 * Module-private since wave 141G: its only reader is this module's `instructions` field (the
 * actions layer forwards ROUTING_UNAVAILABLE_TENANT_NOTE instead); the proof reads it from source.
 */
const VERCEL_NOT_CONFIGURED_NOTE =
  "Automatic domain attachment isn't configured on this deployment (VERCEL_TOKEN / VERCEL_PROJECT_ID are not set). " +
  "The domain stays in Pending DNS: the tenant sets the standard DNS records shown, and a platform operator must also " +
  "attach the domain to the Vercel project before it can go live."

/** TENANT note for the same state — capability status only, no provider, no env key, no credential. */
export const ROUTING_UNAVAILABLE_TENANT_NOTE =
  "Custom-domain routing isn't switched on for this workspace yet. Your website stays live at its platform address; " +
  "the DNS records below are the right ones and will take effect once routing is enabled — nothing to redo."

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

/** The ONE Vercel control-plane egress — through the connector gateway (wave 139, lane 139B: was a
 *  raw fetch published as "infrastructure, outside the rails"; being infrastructure is no technical
 *  reason to skip the single egress). The gateway adds the timeout, the GET retry, and the outcome
 *  row (Vercel's derived health; platform scope — the Vercel account is the platform's). A transport failure
 *  (no status) still rejects, exactly as the bare fetch did, so callers' `.catch` paths hold. */
async function vercelFetch(
  cfg: VercelDomainsConfig,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector({
    connector: "vercel", url: vercelUrl(cfg, path),
    method: (init?.method ?? "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    auth: { style: "bearer", token: cfg.token ?? "" }, // callers gate on cfg.configured first
    ...(init?.body !== undefined ? { body: init.body } : {}),
  })
  if (res.status == null) throw new Error(res.error ?? "Vercel API unreachable")
  return { status: res.status, json: (res.ok ? res.data : res.errorBody) ?? {} }
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

// ── Rail outcomes → the governed manager bus + the self-heal ledger ──────────
//
// The actions layer (app/actions/custom-domains.ts) owns the row LIFECYCLE, so it
// reports the transitions; this module owns the EMISSION so the custom-domain rail
// has one bus voice. Everything here is best-effort (dynamic imports, swallowed
// failures) — reporting never fails the user action or the Vercel wire.

export type CustomDomainOutcome = "connected" | "verified" | "error"

/**
 * Report a custom-domain transition onto the governed bus (+ ledger the failure)
 * AND the kernel event ledger (wave 141G — lane B's rule: validate → execute →
 * IMMEDIATE post-condition → emit event → owner/service picks up).
 *
 *   connected (post-condition passed on add) → KernelEvent.CUSTOM_DOMAIN_CONNECTED
 *     only — the tenant just clicked and sees the result; a feed line would be noise.
 *   verified (status→active) → 'custom_domain_verified' (feed_only, registered in
 *     SIGNAL_REGISTRY): Data Steward (tenant_custom_domains owner) announces the
 *     completed state change to the Campaign Orchestrator (brand owner)
 *     + KernelEvent.CUSTOM_DOMAIN_VERIFIED (read by the tenant webhook catalogue's
 *     website.domain_verified).
 *   error → 'custom_domain_error' (feed_only alert): the human fixes DNS/ownership
 *     at their DNS provider — nothing in-OS can change third-party DNS. The Vercel
 *     API failure ALSO ledgers self_heal_events (flow 'custom_domain_vercel',
 *     connector domain) so recurring wire failures surface to platform staff
 *     + KernelEvent.CUSTOM_DOMAIN_ERROR.
 *
 * Both signals are idempotent per open (domain row) via the bus dedupe.
 * `announce: false` = ledger only (e.g. a failed detach on remove — the row is
 * already 'removed'; there is no state change worth a feed line).
 */
export async function reportCustomDomainOutcome(params: {
  brokerageId: string
  domainRowId: string
  domain: string
  outcome: CustomDomainOutcome
  /** Which wire call failed/succeeded — for the ledger detail. */
  phase: "add" | "verify" | "remove"
  /** The row status AFTER the post-condition re-read (carried on the kernel event). */
  status?: string | null
  /** The immediate DNS probe verdict, when one ran. */
  dns?: Pick<DnsProbe, "checked" | "matches"> | null
  errorCode?: string | null
  errorDetail?: string | null
  /** users.id of the human who clicked (lifecycle_events.actor_user_id). */
  actorUserId?: string | null
  /** The verified client the command writes through (emitKernelEvent client seam). */
  client?: unknown
  announce?: boolean
}): Promise<void> {
  // THE KERNEL EVENT — an audit row with lineage (auditOnly: the reactor has no rule; the
  // readers are the tenant webhook catalogue and the bus lines below). Raw provider text
  // never rides the event: the code is enough for staff to find the ledger row.
  try {
    const [{ emitKernelEvent }, { KernelEvent }] = await Promise.all([
      import("@/lib/kernel/emit"),
      import("@/lib/kernel/events"),
    ])
    const event = params.outcome === "connected" ? KernelEvent.CUSTOM_DOMAIN_CONNECTED
      : params.outcome === "verified" ? KernelEvent.CUSTOM_DOMAIN_VERIFIED
      : KernelEvent.CUSTOM_DOMAIN_ERROR
    await emitKernelEvent({
      event,
      brokerageId: params.brokerageId,
      entityType: "tenant_custom_domain",
      entityId: params.domainRowId,
      actorUserId: params.actorUserId ?? null,
      source: params.actorUserId ? "ui" : "system",
      metadata: {
        domain: params.domain,
        status: params.status ?? null,
        phase: params.phase,
        outcome: params.outcome,
        error_code: params.errorCode ?? null,
        dns_checked: params.dns?.checked ?? null,
        dns_matches: params.dns?.matches ?? null,
      },
      dedupeKey: `${params.outcome}:${params.phase}:${params.status ?? ""}`,
      dedupeWindowSec: 5,
      auditOnly: true,
      client: params.client,
    })
  } catch { /* the event ledger is additive — the row transition already landed */ }

  if (params.outcome !== "connected" && params.announce !== false) {
    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      await publishManagerSignal({
        brokerageId: params.brokerageId,
        fromManager: "data_steward",
        toManager: "campaign_orchestrator", // m618: survivor of the retired marketing_agent seat
        signalType: params.outcome === "verified" ? "custom_domain_verified" : "custom_domain_error",
        message: params.outcome === "verified"
          ? `Custom domain ${params.domain} is verified and LIVE — the white-label site now serves on it.`
          : `Custom domain ${params.domain} hit a verification error` +
            `${params.errorDetail ? `: ${params.errorDetail.slice(0, 200)}` : ""} — ` +
            `check the DNS records under Settings → Branding, then run Check status again.`,
        entityType: "tenant_custom_domain",
        entityId: params.domainRowId,
        payload: {
          domain: params.domain,
          outcome: params.outcome,
          phase: params.phase,
          error_code: params.errorCode ?? null,
          error_detail: params.errorDetail ? params.errorDetail.slice(0, 300) : null,
        },
      })
    } catch { /* visibility is best-effort — the row transition already landed */ }
  }
  if (params.outcome === "error") {
    try {
      const [{ recordSelfHeal }, { createServiceClient }] = await Promise.all([
        import("@/lib/kernel/self-heal-ledger"),
        import("@/lib/supabase/service"),
      ])
      await recordSelfHeal(createServiceClient(), {
        brokerageId: params.brokerageId,
        domain: "connector",
        subject: `custom_domain_vercel:${params.domain}`,
        action: "verify_custom_domain",
        // Announced errors route the human in via the feed alert; a silent
        // (announce:false) failure is recorded as a plain failure.
        outcome: params.announce !== false ? "escalated" : "failed",
        detail: {
          flow: "custom_domain_vercel",
          domain: params.domain,
          phase: params.phase,
          error_code: params.errorCode ?? null,
          error_detail: params.errorDetail ? params.errorDetail.slice(0, 300) : null,
        },
      })
    } catch { /* the ledger is additive — never fail the action on it */ }
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
