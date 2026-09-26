// lib/branding/business-registration.ts
// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS REGISTRATION AS A BRANDING SETTING (wave 84, lane 84D — owner
// verbatim: "add the registration info needed for registration in as a branding
// setting so that info is pulled for registration.").
//
// ALREADY EXISTED — REUSED:
//   · the brokerage's IDENTITY lives on the `brokerages` row (name = the legal
//     name, dba, address / address_line2 / city / state / zip, phone, email,
//     website) and has ONE allow-listed writer,
//     app/actions/settings/brokerage-identity.ts updateBrokerageIdentity. The
//     registration card writes those columns THROUGH that writer (84D extended
//     its allow-list with website / phone / email, which had no settings writer
//     at all) — never a second copy of a name or an address.
//   · the step machine lib/voice/a2p-registration.ts (TrustHub secondary
//     customer profile → A2P trust product → brand → messaging service → number
//     attach → campaign; toll-free verification) and its pure derivation
//     deriveA2pProfile, which already filled blanks from the brokerage row and
//     the owner seat (wave 83D).
//
// WHAT THIS FILE ADDS: the facts ONLY carrier registration needs and no other
// record holds — the EIN, the legal entity type, the industry, the regions of
// operation, public/private status (+ stock listing when public), the SMS
// privacy / terms URLs, and the authorized representative (name, title, job
// position, e-mail, phone). They live under ONE key of an EXISTING jsonb,
// brokerage_settings.settings.business_registration, chosen over the two other
// branding stores on the LIVE row-level policies (2026-09-26):
//   · global_settings (the colours/font/logo the Branding page edits) —
//     SELECT is `brokerage_id = current_user_brokerage_id()`: EVERY seat in the
//     tenant, agents included, could read an EIN stored there.
//   · brokerage_brand_settings (the brand wizard's tagline/URLs) — flat columns,
//     no jsonb; an EIN column there would need m668 and the same audience.
//   · brokerage_settings — SELECT / UPDATE admit only is_brokerage_admin() on
//     the tenant (or platform admin). The EIN sits behind that.
// No migration: live brokerage_settings had 0 rows, so there is no legacy
// `a2p_business_profile` copy to carry over (checked before building).
//
// THE ONE READER is loadBusinessRegistrationSources below: the step machine
// (resolveA2pProfile), the hourly carrier loop, the port-in door, the A2P
// status card and the Branding card all read the registration through it.
//
// EIN HANDLING: stored as 9 digits; any value that leaves the server for a
// browser goes through maskEin (last four only); nothing here logs it.

// ── Vocabularies (Twilio TrustHub / TCR — Exa, 2026-09-26:
//    twilio.com/docs/trust-hub/trusthub-rest-api/api-create-secondary-customer-profile,
//    twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info) ────

/** customer_profile_business_information.business_type */
export const REGISTRATION_BUSINESS_TYPES = [
  "Limited Liability Corporation",
  "Corporation",
  "Partnership",
  "Sole Proprietorship",
  "Co-operative",
  "Non-profit Corporation",
] as const

/** customer_profile_business_information.business_industry — the full TrustHub list. */
export const REGISTRATION_INDUSTRIES = [
  "REAL_ESTATE", "AGRICULTURE", "AUTOMOTIVE", "BANKING", "CONSUMER", "EDUCATION", "ELECTRONICS", "ENERGY",
  "ENGINEERING", "FAST_MOVING_CONSUMER_GOODS", "FINANCIAL", "FINTECH", "FOOD_AND_BEVERAGE", "GOVERNMENT",
  "HEALTHCARE", "HOSPITALITY", "INSURANCE", "JEWELRY", "LEGAL", "MANUFACTURING", "MEDIA", "NOT_FOR_PROFIT",
  "OIL_AND_GAS", "ONLINE", "RAW_MATERIALS", "RELIGION", "RETAIL", "TECHNOLOGY", "TELECOMMUNICATIONS",
  "TRANSPORTATION", "TRAVEL",
] as const

/** customer_profile_business_information.business_regions_of_operation */
export const REGISTRATION_REGIONS = ["USA_AND_CANADA", "LATIN_AMERICA", "EUROPE", "ASIA", "AFRICA", "AUSTRALIA"] as const

/** us_a2p_messaging_profile_information.company_type */
export const REGISTRATION_COMPANY_TYPES = ["private", "public", "non-profit", "government"] as const

/** authorized_representative_1.job_position */
export const REGISTRATION_JOB_POSITIONS = ["Director", "GM", "VP", "CEO", "CFO", "General Counsel", "Other"] as const

/** The defaults a real-estate OS may state without asking: every tenant is a
 *  real-estate business operating on US numbers. Company type defaults to
 *  private (a publicly traded brokerage says so on the card — TCR error 30796
 *  is what a wrong 'public' earns). Nothing else is ever defaulted. */
export const REGISTRATION_DEFAULTS = {
  industry: "REAL_ESTATE",
  regionsOfOperation: "USA_AND_CANADA",
  companyType: "private",
  repJobPosition: "Director",
} as const

/** Where the tenant edits it — every "needs your input" message points here. */
export const BUSINESS_REGISTRATION_SETTINGS_PATH = "/settings/branding#business-registration" as const
export const BUSINESS_REGISTRATION_SETTINGS_LABEL = "Settings → Branding → Business registration" as const

/** The settings-jsonb key — the ONE store for registration-only facts. */
export const BUSINESS_REGISTRATION_SETTINGS_KEY = "business_registration" as const

/** Registration-only facts (brokerage_settings.settings.business_registration). */
export interface BusinessRegistration {
  /** 9 digits, no dash. */
  ein: string
  businessType: string
  industry: string
  regionsOfOperation: string
  companyType: string
  stockExchange: string
  stockTicker: string
  privacyPolicyUrl: string
  termsUrl: string
  socialMediaUrl: string
  repFirstName: string
  repLastName: string
  repTitle: string
  repJobPosition: string
  repEmail: string
  repPhone: string
  useCaseDescription: string
  updatedAt: string
}

const REGISTRATION_KEYS: ReadonlyArray<keyof BusinessRegistration> = [
  "ein", "businessType", "industry", "regionsOfOperation", "companyType", "stockExchange", "stockTicker",
  "privacyPolicyUrl", "termsUrl", "socialMediaUrl", "repFirstName", "repLastName", "repTitle", "repJobPosition",
  "repEmail", "repPhone", "useCaseDescription", "updatedAt",
]

const t = (v: unknown) => (typeof v === "string" ? v.trim() : "")

// ── EIN ──────────────────────────────────────────────────────────────────────

/** IRS campus prefixes that have never been ASSIGNED (irs.gov "How EINs are
 *  assigned and valid EIN prefixes"). A number starting with one is a typo. */
const UNASSIGNED_EIN_PREFIXES: readonly string[] = ["00", "07", "08", "09", "17", "18", "19", "28", "29", "49", "69", "70", "78", "79", "89", "96", "97"]

/** PURE: "12-3456789" / "123456789" → 9 digits, or a reason. Never echoes the value. */
export function normalizeEin(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = t(raw)
  if (!/^\d{2}-?\d{7}$/.test(s)) return { ok: false, error: "EIN must be 9 digits (XX-XXXXXXX)" }
  const digits = s.replace(/\D/g, "")
  if (UNASSIGNED_EIN_PREFIXES.includes(digits.slice(0, 2))) return { ok: false, error: `EIN prefix ${digits.slice(0, 2)} is not an IRS-assigned prefix — check the number on your IRS letter (CP 575)` }
  if (/^(\d)\1{8}$/.test(digits)) return { ok: false, error: "EIN cannot be one digit repeated" }
  return { ok: true, value: digits }
}

/** PURE: the only form of an EIN that may reach a browser or a log line. */
export function maskEin(ein: unknown): string {
  const d = t(ein).replace(/\D/g, "")
  return d.length >= 4 ? `••-•••${d.slice(-4)}` : ""
}

/** PURE: a derived profile draft made safe for a browser — the EIN masked,
 *  every other field as-is. Every server action that hands a draft to a card
 *  goes through this (the business-registration-branding proof enforces it). */
export function redactDraftForClient(draft: Record<string, string> | null | undefined): Record<string, string> {
  const out = { ...(draft ?? {}) }
  if (out.ein) out.ein = maskEin(out.ein)
  return out
}

// ── URLs, e-mail, phone ─────────────────────────────────────────────────────

/** PURE: an absolute http(s) URL with a dotted host (RFC 1738 §3.3 as Twilio asks). */
export function isHttpUrl(raw: unknown): boolean {
  const s = t(raw)
  if (!/^https?:\/\//i.test(s)) return false
  try {
    const u = new URL(s)
    return (u.protocol === "http:" || u.protocol === "https:") && /\.[a-z]{2,}$/i.test(u.hostname)
  } catch {
    return false
  }
}

export function isEmail(raw: unknown): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t(raw))
}

/** PURE: a US phone as E.164 (+1XXXXXXXXXX), or null when it is not one. */
export function normalizeUsPhone(raw: unknown): string | null {
  const d = t(raw).replace(/\D/g, "")
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d
  return ten.length === 10 && /^[2-9]/.test(ten) ? `+1${ten}` : null
}

// ── Read (PURE) ──────────────────────────────────────────────────────────────

/** PURE: the registration record out of a brokerage_settings.settings jsonb —
 *  known keys, strings only; anything else is ignored. */
export function readBusinessRegistration(settings: unknown): Partial<BusinessRegistration> {
  const rec = (settings && typeof settings === "object" ? (settings as Record<string, unknown>)[BUSINESS_REGISTRATION_SETTINGS_KEY] : null) ?? null
  const out: Partial<BusinessRegistration> = {}
  if (!rec || typeof rec !== "object") return out
  for (const k of REGISTRATION_KEYS) {
    const v = t((rec as Record<string, unknown>)[k])
    if (v) out[k] = v
  }
  return out
}

// ── Validate a card save (PURE) ──────────────────────────────────────────────

export type RegistrationInput = Partial<Record<Exclude<keyof BusinessRegistration, "updatedAt">, string>>

/**
 * PURE: validate what the Business registration card sends, merged over what
 * is already on file. An EIN left BLANK keeps the one on file (the card only
 * ever shows the masked form, so it cannot send the old value back); any other
 * blank clears that field. Every problem is listed at once.
 */
export function validateBusinessRegistrationInput(
  raw: RegistrationInput | null | undefined,
  existing: Partial<BusinessRegistration>,
  now: Date = new Date(),
): { ok: true; value: Partial<BusinessRegistration> } | { ok: false; errors: string[] } {
  const r = (raw ?? {}) as Record<string, unknown>
  const errors: string[] = []
  const value: Partial<BusinessRegistration> = {}
  const set = (k: keyof BusinessRegistration, v: string) => { if (v) value[k] = v }

  const einRaw = t(r.ein)
  if (einRaw) {
    const e = normalizeEin(einRaw)
    if (e.ok) set("ein", e.value)
    else errors.push(e.error)
  } else if (existing.ein) set("ein", existing.ein)

  const oneOf = (k: keyof BusinessRegistration, list: readonly string[], label: string) => {
    const v = t(r[k])
    if (!v) return
    if (!list.includes(v)) errors.push(`${label} must be one of: ${list.join(", ")}`)
    else set(k, v)
  }
  oneOf("businessType", REGISTRATION_BUSINESS_TYPES, "Business type")
  oneOf("industry", REGISTRATION_INDUSTRIES, "Industry")
  oneOf("regionsOfOperation", REGISTRATION_REGIONS, "Regions of operation")
  oneOf("companyType", REGISTRATION_COMPANY_TYPES, "Company type")
  oneOf("repJobPosition", REGISTRATION_JOB_POSITIONS, "Representative job position")

  // A public company registers its listing; anyone else must NOT send one
  // (Twilio: omit stock_* unless company_type is public — error 30796).
  if (value.companyType === "public") {
    const ex = t(r.stockExchange).toUpperCase()
    const tk = t(r.stockTicker).toUpperCase()
    if (!/^[A-Z]{2,8}$/.test(ex)) errors.push("Stock exchange is required for a public company (e.g. NASDAQ, NYSE)")
    else set("stockExchange", ex)
    if (!/^[A-Z0-9.\-]{1,10}$/.test(tk)) errors.push("Stock ticker is required for a public company")
    else set("stockTicker", tk)
  }

  for (const [k, label] of [["privacyPolicyUrl", "Privacy policy URL"], ["termsUrl", "Terms & conditions URL"], ["socialMediaUrl", "Social media profile URL"]] as const) {
    const v = t(r[k])
    if (!v) continue
    if (!isHttpUrl(v)) errors.push(`${label} must be a full web address starting with https://`)
    else set(k, v.slice(0, 300))
  }

  set("repFirstName", t(r.repFirstName).slice(0, 60))
  set("repLastName", t(r.repLastName).slice(0, 60))
  set("repTitle", t(r.repTitle).slice(0, 80))
  const repEmail = t(r.repEmail)
  if (repEmail) {
    if (!isEmail(repEmail)) errors.push("Representative e-mail must be a valid address")
    else set("repEmail", repEmail.toLowerCase().slice(0, 120))
  }
  const repPhone = t(r.repPhone)
  if (repPhone) {
    const p = normalizeUsPhone(repPhone)
    if (!p) errors.push("Representative phone must be a 10-digit US number")
    else set("repPhone", p)
  }
  set("useCaseDescription", t(r.useCaseDescription).slice(0, 400))

  if (errors.length) return { ok: false, errors }
  value.updatedAt = now.toISOString()
  return { ok: true, value }
}

// ── The authorized representative's fallback: the owner seat ─────────────────

/** The finance-admin roster, most senior first — the person who can sign for
 *  the brokerage. Moved here from lib/voice/a2p-registration.ts (wave 84D) so
 *  the one reader below owns it. */
export const REPRESENTATIVE_ORDER = ["broker_owner", "broker", "broker_admin", "admin"] as const

export interface RepresentativeSeat { user_type?: string | null; first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null }

/** PURE: the most senior representative seat, or null. */
export function pickRepresentative<T extends RepresentativeSeat>(seats: ReadonlyArray<T> | null | undefined): T | null {
  const rank = (s: RepresentativeSeat) => { const i = (REPRESENTATIVE_ORDER as readonly string[]).indexOf(String(s.user_type ?? "")); return i < 0 ? 99 : i }
  return [...(seats ?? [])].sort((a, z) => rank(a) - rank(z))[0] ?? null
}

/** PURE: a business title for a seat that typed none (TrustHub `business_title` is free text). */
export function repTitleForUserType(userType: string | null | undefined): string {
  switch (userType) {
    case "broker_owner": return "Broker / Owner"
    case "broker": return "Managing Broker"
    case "broker_admin": return "Brokerage Administrator"
    case "admin": return "Office Administrator"
    default: return ""
  }
}

// ── THE ONE READER (impure) ──────────────────────────────────────────────────

export interface BrokerageIdentityRow {
  name?: string | null; dba?: string | null
  address?: string | null; address_line2?: string | null; city?: string | null; state?: string | null; zip?: string | null
  phone?: string | null; email?: string | null; website?: string | null; slug?: string | null
}

export type BusinessRegistrationSources =
  | { ok: true; settingsRowId: string | null; settings: Record<string, unknown>; registration: Partial<BusinessRegistration>; brokerage: BrokerageIdentityRow | null; owner: RepresentativeSeat | null }
  | { ok: false; error: string }

/**
 * Read everything registration is filed from: the registration record (the
 * branding setting), the brokerage's identity row and the representative seat.
 * A refused settings read is a REFUSAL (never "incomplete, please type it"); a
 * refused brokerage / seat read degrades to "not on file" so the missing list
 * names those fields instead of filing on a guess.
 */
export async function loadBusinessRegistrationSources(svc: any, brokerageId: string): Promise<BusinessRegistrationSources> {
  const [bsRes, bRes, oRes] = await Promise.all([
    svc.from("brokerage_settings").select("id, settings").eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("brokerages").select("name, dba, address, address_line2, city, state, zip, phone, email, website, slug").eq("id", brokerageId).maybeSingle(),
    svc.from("users").select("first_name, last_name, email, phone, user_type").eq("brokerage_id", brokerageId).in("user_type", [...REPRESENTATIVE_ORDER]).is("deleted_at", null).limit(20),
  ])
  if (bsRes?.error) return { ok: false, error: `business registration could not be read (${bsRes.error.message})` }
  const settings = (((bsRes?.data as any)?.settings ?? {}) || {}) as Record<string, unknown>
  return {
    ok: true,
    settingsRowId: (bsRes?.data as any)?.id ?? null,
    settings,
    registration: readBusinessRegistration(settings),
    brokerage: bRes?.error ? null : ((bRes?.data as BrokerageIdentityRow | null) ?? null),
    owner: oRes?.error ? null : pickRepresentative((Array.isArray(oRes?.data) ? oRes.data : []) as RepresentativeSeat[]),
  }
}
