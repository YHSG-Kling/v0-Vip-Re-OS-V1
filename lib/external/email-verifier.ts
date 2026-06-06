/**
 * lib/external/email-verifier.ts
 *
 * Tiered email verification — cheap → expensive. Drives the canonical `email_verified` flag the
 * AI-ISA channel resolver gates on, without burning the PDL email-validate budget on every email.
 *
 *   Tier 1 (free, ~0ms)    — RFC 5322 syntax + disposable/role-account hostlist sanity.
 *   Tier 2 (free, ~50-200ms) — DNS MX lookup; an address whose domain has no MX cannot receive mail.
 *   Tier 3 ($0.01)          — PeopleDataLabs email/validate (lib/external/peopledata-client
 *                              validateEmailViaPeopleData). Authoritative; only called when Tier 1+2
 *                              pass and the caller asks for it (deep=true).
 *
 * The cascade short-circuits at the first FAIL — a syntactically invalid address never hits DNS,
 * a domain with no MX never hits PDL. Cost is bounded; speed scales with the question being asked.
 */
import { promises as dns } from "node:dns"

const DISPOSABLE_DOMAINS = new Set<string>([
  "mailinator.com", "10minutemail.com", "guerrillamail.com", "yopmail.com",
  "trashmail.com", "tempmail.com", "throwawaymail.com", "fakeinbox.com",
  "discard.email", "getnada.com", "dispostable.com",
])
const ROLE_LOCAL_PARTS = new Set<string>([
  "info", "support", "sales", "admin", "contact", "hello", "marketing",
  "office", "team", "billing", "no-reply", "noreply", "postmaster", "webmaster",
])
// RFC 5322 — pragmatic regex: local-part chars + @ + dot-separated domain labels.
const SYNTAX_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/

export interface EmailVerificationResult {
  /** Final verdict: the address is fit to receive mail and worth contacting. */
  verified:        boolean
  /** Highest tier reached before a verdict was returned (1=syntax, 2=MX, 3=PDL). */
  tier:            1 | 2 | 3
  /** Sub-reason when verified=false. */
  reason:          string | null
  /** Coarse classification surfaced by Tier 1/2 alone. */
  isRoleAccount?:  boolean
  isDisposable?:   boolean
  /** True when the domain has at least one MX record. */
  hasMx?:          boolean
  /** When deep=true and Tier 3 ran, the underlying PDL response is here for audit. */
  pdl?:            unknown
  /** Approximate USD spend on this call (0 for Tier 1+2, ~0.01 if Tier 3 ran). */
  cost:            number
}

/** Pure: Tier 1 only — RFC sanity + disposable/role hostlist. No I/O. */
export function checkEmailSyntax(email: string): EmailVerificationResult {
  const e = (email ?? "").trim().toLowerCase()
  if (!e || !SYNTAX_RE.test(e)) {
    return { verified: false, tier: 1, reason: "Invalid email syntax (RFC 5322)", cost: 0 }
  }
  const [local, domain] = e.split("@")
  const isDisposable  = DISPOSABLE_DOMAINS.has(domain)
  const isRoleAccount = ROLE_LOCAL_PARTS.has(local)
  if (isDisposable) {
    return { verified: false, tier: 1, reason: "Disposable email domain", isDisposable, cost: 0 }
  }
  // Role accounts are deliverable but not personal — caller decides; flag, don't reject at Tier 1.
  return { verified: true, tier: 1, reason: null, isRoleAccount, isDisposable: false, cost: 0 }
}

/** Tier 2 — Tier 1 + DNS MX lookup. Free, ~50-200ms. */
export async function checkEmailMx(email: string): Promise<EmailVerificationResult> {
  const t1 = checkEmailSyntax(email)
  if (!t1.verified) return t1  // syntax/disposable fail short-circuits
  const domain = email.trim().toLowerCase().split("@")[1]
  try {
    const mx = await dns.resolveMx(domain)
    const hasMx = Array.isArray(mx) && mx.length > 0
    if (!hasMx) return { ...t1, verified: false, tier: 2, reason: "Domain has no MX record", hasMx: false }
    return { ...t1, tier: 2, hasMx: true }
  } catch (err) {
    return { ...t1, verified: false, tier: 2, reason: `MX lookup failed: ${err instanceof Error ? err.message : String(err)}`, hasMx: false }
  }
}

/** Tier 3 — Tier 1 + Tier 2 + PDL email/validate (authoritative). ~$0.01 per call. */
export async function verifyEmailDeep(email: string): Promise<EmailVerificationResult> {
  const t2 = await checkEmailMx(email)
  if (!t2.verified) return t2  // already failed — don't waste PDL budget
  const { validateEmailViaPeopleData } = await import("./peopledata-client")
  const { data, cost } = await validateEmailViaPeopleData(email)
  if (!data) return { ...t2, tier: 3, cost: t2.cost + cost, reason: "PDL email-validate returned no data" }
  return {
    ...t2,
    tier: 3,
    verified: data.isVerified,
    reason: data.isVerified ? null : (data.reason ?? data.status ?? "PDL marked address not verified"),
    isRoleAccount: data.isRoleAccount ?? t2.isRoleAccount,
    isDisposable:  data.isDisposable  ?? t2.isDisposable,
    pdl: data.raw,
    cost: t2.cost + cost,
  }
}
