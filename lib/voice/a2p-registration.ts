// lib/voice/a2p-registration.ts
// ─────────────────────────────────────────────────────────────────────────────
// A2P 10DLC AUTO-REGISTRATION — carrier compliance as a product feature, not a
// tenant chore. US carriers require every business number texting consumers to
// be registered (brand + campaign); unregistered traffic gets filtered or
// blocked as volume grows. The platform promise is "AI answers your phone",
// not "go file with The Campaign Registry" — so registration is a STEP MACHINE
// the platform walks for each tenant via Twilio's ISV APIs (TrustHub customer
// profile → A2P trust product → brand → messaging service → number attach →
// campaign), with progress persisted on platform_credentials ('twilio_a2p',
// config jsonb) so every step is idempotent and resumable. Twilio reviews
// brands/campaigns asynchronously (hours-days) — status is polled on each
// call, never fabricated. Prerequisite: the tenant's REAL business profile
// (legal name, EIN, address, contact) — validated pure, honest missing-field
// list, nothing submitted until complete.

// ── The business profile (what carriers require) ─────────────────────────────

export interface A2pBusinessProfile {
  legalName: string
  ein: string
  website: string
  street: string
  city: string
  region: string
  postalCode: string
  contactFirstName: string
  contactLastName: string
  contactEmail: string
  contactPhone: string
  /** REQUIRED on every campaign since June 30, 2026 — submissions without
   *  them hard-400 (contract-verified against Twilio's current docs). */
  privacyPolicyUrl: string
  termsUrl: string
  /** Human-readable description of the texting use (goes on the campaign). */
  useCaseDescription: string
}

export type A2pProfileValidation = { ok: true; value: A2pBusinessProfile } | { ok: false; missing: string[] }

const REQUIRED: Array<[keyof A2pBusinessProfile, string]> = [
  ["legalName", "Legal business name"],
  ["ein", "EIN (federal tax ID)"],
  ["website", "Business website"],
  ["street", "Street address"],
  ["city", "City"],
  ["region", "State"],
  ["postalCode", "ZIP code"],
  ["contactFirstName", "Contact first name"],
  ["contactLastName", "Contact last name"],
  ["contactEmail", "Contact email"],
  ["contactPhone", "Contact phone"],
  ["privacyPolicyUrl", "Privacy policy URL"],
  ["termsUrl", "Terms & conditions URL"],
]

/** PURE: validate the tenant's business profile — an honest missing list, and
 *  nothing is submitted to carriers until every required field is present. */
export function validateA2pProfile(raw: any): A2pProfileValidation {
  const r = raw ?? {}
  const missing: string[] = []
  const get = (k: string) => (typeof r[k] === "string" ? r[k].trim() : "")
  for (const [key, label] of REQUIRED) {
    if (!get(key)) missing.push(label)
  }
  const ein = get("ein").replace(/\D/g, "")
  if (get("ein") && ein.length !== 9) missing.push("EIN must be 9 digits")
  if (get("contactEmail") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(get("contactEmail"))) missing.push("Contact email must be valid")
  if (get("website") && !/^https?:\/\//.test(get("website"))) missing.push("Website must start with http(s)://")
  for (const k of ["privacyPolicyUrl", "termsUrl"] as const) {
    if (get(k) && !/^https?:\/\//.test(get(k))) missing.push(`${k === "privacyPolicyUrl" ? "Privacy policy" : "Terms"} URL must start with http(s)://`)
  }
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    value: {
      legalName: get("legalName").slice(0, 100),
      ein,
      website: get("website").slice(0, 200),
      street: get("street").slice(0, 100),
      city: get("city").slice(0, 60),
      region: get("region").slice(0, 30),
      postalCode: get("postalCode").slice(0, 12),
      contactFirstName: get("contactFirstName").slice(0, 60),
      contactLastName: get("contactLastName").slice(0, 60),
      contactEmail: get("contactEmail").slice(0, 120),
      contactPhone: get("contactPhone").slice(0, 24),
      privacyPolicyUrl: get("privacyPolicyUrl").slice(0, 300),
      termsUrl: get("termsUrl").slice(0, 300),
      useCaseDescription: (get("useCaseDescription") || "Real estate brokerage: appointment confirmations, showing reminders, and replies to client-initiated conversations.").slice(0, 400),
    },
  }
}

// ── The profile, DERIVED from what the tenant already told us (wave 83D) ──────
// Owner: "the person picks a number or ports and auto business listing
// approval." Every tenant already has a brokerages row (name, address, phone,
// e-mail, website, storefront slug) and an owner seat (users: name, e-mail,
// phone). Asking the tenant to retype those into a registration form was the
// "chore" the header above promised to remove. So: what the tenant TYPED wins
// field by field; every blank is filled from the brokerage's own record; only
// what no record holds is asked for — in practice the EIN, and the privacy /
// terms URLs when the website has none on file. Nothing is invented: the EIN is
// never guessed, a URL is never fabricated (the platform-hosted storefront is
// used as the website only because it IS the tenant's live site —
// tenantWebsitePath, wave 81D).

export interface A2pProfileSources {
  saved?: Record<string, unknown> | null
  brokerage?: { name?: string | null; address?: string | null; city?: string | null; state?: string | null; zip?: string | null; phone?: string | null; email?: string | null; website?: string | null; slug?: string | null } | null
  owner?: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null } | null
  /** NEXT_PUBLIC_APP_URL — the storefront's origin (no trailing slash). */
  appUrl?: string | null
}

/** Owner-seat preference for the authorized representative — the finance-admin
 *  roster, most senior first (the person who can sign for the brokerage). */
const REPRESENTATIVE_ORDER = ["broker_owner", "broker", "broker_admin", "admin"] as const

/** PURE: merge typed-over-derived, then validate. Returns the merged draft too
 *  so the settings card can pre-fill every field it already knows. */
export function deriveA2pProfile(src: A2pProfileSources): { validation: A2pProfileValidation; draft: Record<string, string>; derivedKeys: string[] } {
  const saved = (src.saved ?? {}) as Record<string, unknown>
  const b = src.brokerage ?? {}
  const o = src.owner ?? {}
  const t = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  const site = t(b.website) ? (/^https?:\/\//.test(t(b.website)) ? t(b.website) : `https://${t(b.website)}`) : (t(src.appUrl) && t(b.slug) ? `${t(src.appUrl).replace(/\/$/, "")}/site/${t(b.slug)}` : "")
  const derived: Record<string, string> = {
    legalName: t(b.name),
    website: site,
    street: t(b.address),
    city: t(b.city),
    region: t(b.state),
    postalCode: t(b.zip),
    contactFirstName: t(o.first_name),
    contactLastName: t(o.last_name),
    contactEmail: t(o.email) || t(b.email),
    contactPhone: t(o.phone) || t(b.phone),
  }
  const draft: Record<string, string> = {}
  const derivedKeys: string[] = []
  for (const [key] of REQUIRED) {
    const typed = t(saved[key])
    if (typed) draft[key] = typed
    else if (derived[key]) { draft[key] = derived[key]; derivedKeys.push(key) }
  }
  if (t(saved.useCaseDescription)) draft.useCaseDescription = t(saved.useCaseDescription)
  return { validation: validateA2pProfile(draft), draft, derivedKeys }
}

/**
 * IMPURE: read the saved profile + the brokerage row + the owner seat,
 * derive, and — when the merged profile is COMPLETE and differs from what is
 * saved — persist it, so every later reader (the step machine, the superadmin
 * A2P board) sees the same profile the filing used. Refused reads are
 * refusals (an unreadable profile is never "incomplete, please type it").
 */
export async function resolveA2pProfile(svc: any, brokerageId: string, opts: { persist?: boolean } = {}): Promise<A2pProfileValidation & { draft?: Record<string, string>; derivedKeys?: string[] }> {
  const [bsRes, bRes, oRes] = await Promise.all([
    svc.from("brokerage_settings").select("id, settings").eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("brokerages").select("name, address, city, state, zip, phone, email, website, slug").eq("id", brokerageId).maybeSingle(),
    svc.from("users").select("first_name, last_name, email, phone, user_type").eq("brokerage_id", brokerageId).in("user_type", [...REPRESENTATIVE_ORDER]).is("deleted_at", null).limit(20),
  ])
  if (bsRes?.error) return { ok: false, missing: [`business profile could not be read (${bsRes.error.message})`] }
  const settings = ((bsRes?.data as any)?.settings ?? {}) as Record<string, any>
  const owners = (Array.isArray(oRes?.data) ? oRes.data : []) as Array<{ user_type?: string; first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null }>
  const owner = [...owners].sort((a, z) => REPRESENTATIVE_ORDER.indexOf(a.user_type as any) - REPRESENTATIVE_ORDER.indexOf(z.user_type as any))[0] ?? null
  const { validation, draft, derivedKeys } = deriveA2pProfile({
    saved: settings.a2p_business_profile ?? null,
    brokerage: bRes?.error ? null : (bRes?.data as any) ?? null,
    owner: oRes?.error ? null : owner,
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null,
  })
  // A READ caller (the status card, a read_only act-as grant) passes persist: false.
  if (validation.ok && derivedKeys.length > 0 && opts.persist !== false) {
    const next = { ...settings, a2p_business_profile: validation.value, a2p_profile_derived_keys: derivedKeys }
    const rowId = (bsRes?.data as any)?.id
    const write = rowId
      ? await svc.from("brokerage_settings").update({ settings: next, updated_at: new Date().toISOString() }).eq("id", rowId).eq("brokerage_id", brokerageId)
      : await svc.from("brokerage_settings").insert({ brokerage_id: brokerageId, settings: next })
    if (write?.error) console.warn(`[a2p] derived profile NOT persisted for ${brokerageId} (filing continues on the derived copy):`, write.error.message)
  }
  return { ...validation, draft, derivedKeys }
}

// ── The step machine ──────────────────────────────────────────────────────────

export const A2P_STEPS = [
  "customer_profile", // TrustHub secondary customer profile (business identity)
  "trust_product",    // A2P messaging trust product bundle
  "brand",            // BrandRegistration (The Campaign Registry, async review)
  "messaging_service",// Messaging Service in the tenant's subaccount
  "number_attached",  // tenant number(s) pooled into the service
  "campaign",         // UsAppToPerson campaign (async review)
] as const
export type A2pStep = (typeof A2P_STEPS)[number]

export interface A2pState {
  customer_profile_sid?: string
  trust_product_sid?: string
  brand_sid?: string
  brand_status?: string
  messaging_service_sid?: string
  number_attached?: boolean
  campaign_sid?: string
  campaign_status?: string
  last_error?: string | null
  updated_at?: string
  // ── Voice integrity (CNAM + SHAKEN/STIR) — the step APPENDED after campaign
  // approval. Same store (platform_credentials 'twilio_a2p' config jsonb), same
  // TrustHub customer profile; statuses are Twilio's own bundle statuses
  // (draft | pending-review | in-review | twilio-rejected | twilio-approved),
  // POLLED on every run, never assumed. voice_integrity_error is kept SEPARATE
  // from last_error so assessA2pStall's failed-registration detection
  // (lib/platform/provider-posture) never fires on a caller-ID hiccup.
  cnam_trust_product_sid?: string
  cnam_status?: string
  shaken_trust_product_sid?: string
  shaken_status?: string
  voice_integrity_error?: string | null
  // ── Toll-free verification (wave 81D) — the 8xx lane; same store. Status
  // is Twilio's own (PENDING_REVIEW | IN_REVIEW | TWILIO_APPROVED |
  // TWILIO_REJECTED), polled by sid; tollfree_error is kept SEPARATE from
  // last_error for the same reason voice_integrity_error is.
  tollfree_verification_sid?: string
  tollfree_status?: string
  tollfree_error?: string | null
  // ── Wave 83D: every active number SID pooled into the messaging service.
  // number_attached was a one-shot boolean, so a number bought (or a port that
  // completed) AFTER the first attach never joined the campaign's sender pool;
  // the runner now attaches any active SID missing from this list on every run.
  attached_number_sids?: string[]
  /** Wave 83D: the last phase the hourly loop announced
   *  (lib/voice/carrier-registration-loop.ts carrierRegistrationPhase) — the
   *  loop rings the tenant only when this CHANGES. */
  loop_phase?: string
}

/** Wave 83D: persist the loop's announced phase on the same state row. Loads
 *  fresh (never a stale snapshot) so it cannot clobber a runner's save. */
export async function recordLoopPhase(svc: any, brokerageId: string, phase: string): Promise<boolean> {
  const ref = await loadA2pState(svc, brokerageId)
  const state = ref.state
  return saveA2pState(svc, brokerageId, ref, { ...state, loop_phase: phase })
}

/** Twilio BrandRegistration statuses (twilio.com/docs/messaging/compliance/
 *  a2p-10dlc, 2026-09-26): PENDING | IN_REVIEW (manual vetting, 7+ business
 *  days) | APPROVED | FAILED | SUSPENDED. Terminal = no further review. */
const BRAND_TERMINAL: readonly string[] = ["APPROVED", "FAILED", "SUSPENDED"]
const BRAND_REJECTED: readonly string[] = ["FAILED", "SUSPENDED"]

/** PURE: the next step to run given persisted state (resumable, idempotent). */
export function nextA2pStep(s: A2pState): A2pStep | "done" {
  if (!s.customer_profile_sid) return "customer_profile"
  if (!s.trust_product_sid) return "trust_product"
  if (!s.brand_sid) return "brand"
  if (!s.messaging_service_sid) return "messaging_service"
  if (!s.number_attached) return "number_attached"
  if (!s.campaign_sid) return "campaign"
  return "done"
}

/** PURE: one honest status line for the settings card. */
export function describeA2pState(s: A2pState): string {
  const step = nextA2pStep(s)
  if (step === "done") {
    const c = (s.campaign_status ?? "").toUpperCase()
    if (c === "VERIFIED" || c === "APPROVED") return "Registered — carrier-verified texting is active."
    if (c === "FAILED") return `Campaign review failed${s.last_error ? `: ${s.last_error}` : ""} — fix the profile and re-run.`
    return `Submitted — campaign under carrier review (${s.campaign_status ?? "pending"}). This normally takes hours to a few days.`
  }
  if (s.brand_sid && BRAND_REJECTED.includes((s.brand_status ?? "").toUpperCase())) {
    return `Brand review ${(s.brand_status ?? "").toUpperCase()}${s.last_error ? `: ${s.last_error}` : ""} — the business profile needs correcting.`
  }
  if (step === "brand" || (s.brand_sid && !BRAND_TERMINAL.includes((s.brand_status ?? "").toUpperCase()))) {
    return `Brand ${s.brand_sid ? `under review (${s.brand_status ?? "pending"})` : "not yet submitted"} — registration resumes automatically.`
  }
  return `In progress — next step: ${step.replace(/_/g, " ")}.${s.last_error ? ` Last error: ${s.last_error}` : ""}`
}

// ── The runner (impure — Twilio ISV APIs via the connector gateway) ──────────

const TRUSTHUB = "https://trusthub.twilio.com"
const MESSAGING = "https://messaging.twilio.com"
// Twilio's published policy SIDs (constant across all accounts) —
// CONTRACT-VERIFIED against Twilio's current docs: RNdfbf… is the SECONDARY
// customer-profile policy (the standard/EIN path); RN806dd… is the STARTER
// (sole-prop) policy and would fail evaluation for an EIN registration.
const SECONDARY_PROFILE_POLICY = "RNdfbf3fae0e1107f8aded0e7cead80bf5"
const A2P_TRUST_POLICY = "QE2c6890da8086d771620e9b13fadeba0b"

type Creds = { accountSid: string; authToken: string }

/** The Twilio REST call the step machine makes — the connector gateway in
 *  production. Wave 83D: an INJECTABLE seam (CarrierRunDeps.transport) so the
 *  business-registration-loop proof walks the REAL step machine tick by tick
 *  against a simulated TrustHub / Messaging API instead of asserting source. */
export type TwilioTransport = <T = any>(req: { creds: Creds; baseUrl: string; path: string; method: "GET" | "POST"; body?: Record<string, unknown> }) =>
  Promise<{ ok: boolean; status?: number | null; data?: T | null; error?: string | null }>

const connectorTransport: TwilioTransport = async <T = any>(req: { creds: Creds; baseUrl: string; path: string; method: "GET" | "POST"; body?: Record<string, unknown> }) => {
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  return callConnector<T>({
    connector: "twilio", baseUrl: req.baseUrl, path: req.path, method: req.method,
    ...(req.body ? { bodyType: "form" as const, body: req.body } : {}),
    auth: { style: "basic", username: req.creds.accountSid, password: req.creds.authToken },
  })
}

/** Injectable dependencies for the runners (production passes none). */
export interface CarrierRunDeps {
  transport?: TwilioTransport
  /** Master creds (default: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN). */
  master?: Creds | null
  /** Tenant creds (default: lib/voice/twilio-tenancy resolveTenantTwilioCreds). */
  tenantCreds?: (svc: any, brokerageId: string) => Promise<(Creds & { tier: string }) | null>
}

function bindTwilio(deps?: CarrierRunDeps) {
  const transport = deps?.transport ?? connectorTransport
  return async <T = any>(creds: Creds, baseUrl: string, path: string, method: "GET" | "POST", body?: Record<string, unknown>) =>
    transport<T>({ creds, baseUrl, path, method, ...(body ? { body } : {}) })
}

/** The production-bound caller for the voice-integrity lane (no deps seam there). */
const twilio = bindTwilio()

function masterCreds(deps?: CarrierRunDeps): Creds | null {
  if (deps && "master" in deps) return deps.master ?? null
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  return sid && token ? { accountSid: sid, authToken: token } : null
}

async function tenantCredsFor(svc: any, brokerageId: string, deps?: CarrierRunDeps) {
  if (deps?.tenantCreds) return deps.tenantCreds(svc, brokerageId)
  const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  return resolveTenantTwilioCreds(svc, brokerageId)
}

/** Load the persisted A2P state row (platform_credentials 'twilio_a2p'). */
export async function loadA2pState(svc: any, brokerageId: string): Promise<{ rowId: string | null; state: A2pState }> {
  const { data, error } = await svc.from("platform_credentials")
    .select("id, config").eq("brokerage_id", brokerageId)
    .eq("platform", "twilio_a2p").eq("is_active", true).maybeSingle()
  // Wave 83D — FAIL CLOSED. A refused read used to come back as an EMPTY state
  // with rowId null, so the next save INSERTED a second twilio_a2p row and the
  // machine re-filed from step one (a duplicate TrustHub profile + brand fee).
  // With the hourly loop driving it that would repeat every hour; throw instead.
  if (error) throw new Error(`carrier registration state could not be read (${error.message}) — nothing was filed`)
  return { rowId: (data as any)?.id ?? null, state: ((data as any)?.config ?? {}) as A2pState }
}

/**
 * Persist the A2P state. NOT best-effort: this row IS the OS's memory of the
 * brand/campaign registration with the carrier. Both writes dropped their result,
 * and supabase-js resolves a rejected write, so a failed save left the tenant's
 * registration progress silently un-recorded — the next read would re-derive an
 * earlier state and the operator would be told to redo a step that had already
 * been submitted. Returns whether it landed so callers can stop pretending.
 */
async function saveA2pState(svc: any, brokerageId: string, ref: { rowId: string | null }, state: A2pState): Promise<boolean> {
  const config = { ...state, updated_at: new Date().toISOString() }
  if (ref.rowId) {
    const { error } = await svc.from("platform_credentials").update({ config }).eq("id", ref.rowId)
    if (error) {
      console.error(`[a2p] state NOT saved for brokerage ${brokerageId}:`, error.message)
      return false
    }
  } else {
    // Wave 83D — the new row's id is carried back on `ref`. Before, rowId stayed
    // null for the whole first run, so EVERY step's save INSERTED another
    // twilio_a2p row (profile, trust product, brand … each on its own row) and
    // the next load's .maybeSingle() hit several rows. Found by the
    // business-registration-loop proof's first tick.
    const { data, error } = await svc.from("platform_credentials").insert({
      brokerage_id: brokerageId, platform: "twilio_a2p",
      owner_type: "brokerage", owner_id: brokerageId, is_active: true, config,
    }).select("id").maybeSingle()
    if (error) {
      console.error(`[a2p] state NOT created for brokerage ${brokerageId}:`, error.message)
      return false
    }
    ref.rowId = (data as any)?.id ?? null
  }
  return true
}

export interface A2pRunResult {
  ok: boolean
  state: A2pState
  advancedTo: A2pStep | "done"
  error?: string
}

/**
 * Advance the tenant's A2P registration as far as it can go right now.
 * Idempotent + resumable: completed steps are skipped (their sids persist);
 * async carrier reviews (brand/campaign) are POLLED, never assumed. Any
 * Twilio validation error is persisted verbatim so the tenant sees exactly
 * what the carrier registry rejected. opts.mock uses Twilio's Mock-brand API
 * (BrandRegistrations Mock=true) — the documented way to exercise the WHOLE
 * ISV chain end-to-end without a real TCR filing (pre-production verification).
 */
export async function runA2pRegistration(svc: any, brokerageId: string, opts?: { mock?: boolean; deps?: CarrierRunDeps }): Promise<A2pRunResult> {
  const twilio = bindTwilio(opts?.deps)
  const ref = await loadA2pState(svc, brokerageId)
  const state = ref.state
  const fail = async (error: string): Promise<A2pRunResult> => {
    const s = { ...state, last_error: error.slice(0, 400) }
    await saveA2pState(svc, brokerageId, ref, s)
    return { ok: false, state: s, advancedTo: nextA2pStep(s), error }
  }

  // Prerequisites: business profile (derived from the brokerage's own profile
  // where the tenant typed nothing — wave 83D) + master + subaccount creds.
  const profileV = await resolveA2pProfile(svc, brokerageId)
  if (!profileV.ok) return fail(`Business profile incomplete — missing: ${profileV.missing.join(", ")}`)
  const profile = profileV.value

  const master = masterCreds(opts?.deps)
  if (!master) return fail("Twilio master account not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN)")

  const sub = await tenantCredsFor(svc, brokerageId, opts?.deps)
  if (!sub || sub.tier === "master") return fail("Tenant has no Twilio subaccount yet — provision a phone number first")

  // Walk as many steps as possible in one call.
  for (let guard = 0; guard < 8; guard++) {
    const step = nextA2pStep(state)
    if (step === "done") break

    if (step === "customer_profile") {
      // Secondary customer profile: shell → business info + rep + address docs → evaluate → submit.
      const shell = await twilio<{ sid?: string }>(master, TRUSTHUB, "/v1/CustomerProfiles", "POST", {
        FriendlyName: `${profile.legalName} — A2P`, Email: profile.contactEmail, PolicySid: SECONDARY_PROFILE_POLICY,
      })
      if (!shell.ok || !shell.data?.sid) return fail(`Customer profile create failed: ${shell.error ?? shell.status}`)
      const cpSid = shell.data.sid

      const biz = await twilio<{ sid?: string }>(master, TRUSTHUB, "/v1/EndUsers", "POST", {
        FriendlyName: `${profile.legalName} business info`,
        Type: "customer_profile_business_information",
        Attributes: JSON.stringify({
          business_name: profile.legalName, business_identity: "direct_customer",
          business_type: "Limited Liability Corporation", business_industry: "REAL_ESTATE",
          business_registration_identifier: "EIN", business_registration_number: profile.ein,
          business_regions_of_operation: "USA_AND_CANADA", website_url: profile.website,
        }),
      })
      if (!biz.ok || !biz.data?.sid) return fail(`Business info failed: ${biz.error ?? biz.status}`)

      const rep = await twilio<{ sid?: string }>(master, TRUSTHUB, "/v1/EndUsers", "POST", {
        FriendlyName: `${profile.legalName} rep`,
        Type: "authorized_representative_1",
        Attributes: JSON.stringify({
          first_name: profile.contactFirstName, last_name: profile.contactLastName,
          email: profile.contactEmail, phone_number: profile.contactPhone,
          business_title: "Broker", job_position: "Director",
        }),
      })
      if (!rep.ok || !rep.data?.sid) return fail(`Authorized rep failed: ${rep.error ?? rep.status}`)

      const addr = await twilio<{ sid?: string }>(master, "https://api.twilio.com", `/2010-04-01/Accounts/${master.accountSid}/Addresses.json`, "POST", {
        CustomerName: profile.legalName, Street: profile.street, City: profile.city,
        Region: profile.region, PostalCode: profile.postalCode, IsoCountry: "US",
      })
      if (!addr.ok || !addr.data?.sid) return fail(`Address failed: ${addr.error ?? addr.status}`)
      const doc = await twilio<{ sid?: string }>(master, TRUSTHUB, "/v1/SupportingDocuments", "POST", {
        FriendlyName: `${profile.legalName} address`, Type: "customer_profile_address",
        Attributes: JSON.stringify({ address_sids: addr.data.sid }),
      })
      if (!doc.ok || !doc.data?.sid) return fail(`Address document failed: ${doc.error ?? doc.status}`)

      for (const objectSid of [biz.data.sid, rep.data.sid, doc.data.sid]) {
        const assign = await twilio(master, TRUSTHUB, `/v1/CustomerProfiles/${cpSid}/EntityAssignments`, "POST", { ObjectSid: objectSid })
        if (!assign.ok) return fail(`Profile assignment failed: ${assign.error ?? assign.status}`)
      }
      const evalR = await twilio<{ status?: string }>(master, TRUSTHUB, `/v1/CustomerProfiles/${cpSid}/Evaluations`, "POST", { PolicySid: SECONDARY_PROFILE_POLICY })
      if (!evalR.ok || evalR.data?.status !== "compliant") return fail(`Customer profile not compliant — check the business profile fields (Twilio: ${evalR.error ?? evalR.data?.status ?? "noncompliant"})`)
      const submit = await twilio(master, TRUSTHUB, `/v1/CustomerProfiles/${cpSid}`, "POST", { Status: "pending-review" })
      if (!submit.ok) return fail(`Customer profile submit failed: ${submit.error ?? submit.status}`)
      state.customer_profile_sid = cpSid
      state.last_error = null
      await saveA2pState(svc, brokerageId, ref, state)
      continue
    }

    if (step === "trust_product") {
      const shell = await twilio<{ sid?: string }>(master, TRUSTHUB, "/v1/TrustProducts", "POST", {
        FriendlyName: `${profile.legalName} — A2P trust`, Email: profile.contactEmail, PolicySid: A2P_TRUST_POLICY,
      })
      if (!shell.ok || !shell.data?.sid) return fail(`Trust product create failed: ${shell.error ?? shell.status}`)
      const tpSid = shell.data.sid
      const msgProfile = await twilio<{ sid?: string }>(master, TRUSTHUB, "/v1/EndUsers", "POST", {
        FriendlyName: `${profile.legalName} messaging profile`,
        Type: "us_a2p_messaging_profile_information",
        Attributes: JSON.stringify({ company_type: "private" }),
      })
      if (!msgProfile.ok || !msgProfile.data?.sid) return fail(`Messaging profile failed: ${msgProfile.error ?? msgProfile.status}`)
      for (const objectSid of [state.customer_profile_sid!, msgProfile.data.sid]) {
        const assign = await twilio(master, TRUSTHUB, `/v1/TrustProducts/${tpSid}/EntityAssignments`, "POST", { ObjectSid: objectSid })
        if (!assign.ok) return fail(`Trust assignment failed: ${assign.error ?? assign.status}`)
      }
      const evalR = await twilio<{ status?: string }>(master, TRUSTHUB, `/v1/TrustProducts/${tpSid}/Evaluations`, "POST", { PolicySid: A2P_TRUST_POLICY })
      if (!evalR.ok || evalR.data?.status !== "compliant") return fail(`A2P trust product not compliant (Twilio: ${evalR.error ?? evalR.data?.status ?? "noncompliant"})`)
      const submit = await twilio(master, TRUSTHUB, `/v1/TrustProducts/${tpSid}`, "POST", { Status: "pending-review" })
      if (!submit.ok) return fail(`Trust product submit failed: ${submit.error ?? submit.status}`)
      state.trust_product_sid = tpSid
      await saveA2pState(svc, brokerageId, ref, state)
      continue
    }

    if (step === "brand") {
      const brand = await twilio<{ sid?: string; status?: string }>(master, MESSAGING, "/v1/a2p/BrandRegistrations", "POST", {
        CustomerProfileBundleSid: state.customer_profile_sid!,
        A2PProfileBundleSid: state.trust_product_sid!,
        ...(opts?.mock ? { Mock: true } : {}),
      })
      if (!brand.ok || !brand.data?.sid) return fail(`Brand registration failed: ${brand.error ?? brand.status}`)
      state.brand_sid = brand.data.sid
      state.brand_status = brand.data.status ?? "PENDING"
      await saveA2pState(svc, brokerageId, ref, state)
      continue
    }

    if (step === "messaging_service") {
      // Brand must clear review before the campaign; poll it here.
      const brand = await twilio<{ status?: string; failure_reason?: string }>(master, MESSAGING, `/v1/a2p/BrandRegistrations/${state.brand_sid}`, "GET")
      state.brand_status = brand.data?.status ?? state.brand_status
      if ((state.brand_status ?? "").toUpperCase() === "FAILED") {
        return fail(`Brand review FAILED: ${brand.data?.failure_reason ?? "see Twilio console"} — fix the business profile and re-run`)
      }
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")
      const ms = await twilio<{ sid?: string }>({ accountSid: sub.accountSid, authToken: sub.authToken }, MESSAGING, "/v1/Services", "POST", {
        FriendlyName: `${profile.legalName} — texting`,
        ...(appUrl ? { InboundRequestUrl: `${appUrl}/api/providers/inbound`, InboundMethod: "POST" } : {}),
      })
      if (!ms.ok || !ms.data?.sid) return fail(`Messaging service create failed: ${ms.error ?? ms.status}`)
      state.messaging_service_sid = ms.data.sid
      await saveA2pState(svc, brokerageId, ref, state)
      continue
    }

    if (step === "number_attached") {
      const { data: numbers } = await svc.from("tenant_phone_numbers")
        .select("twilio_number_sid").eq("brokerage_id", brokerageId).eq("is_active", true)
        .not("twilio_number_sid", "is", null).limit(10)
      const sids = ((numbers ?? []) as any[]).map((n) => n.twilio_number_sid).filter(Boolean)
      if (sids.length === 0) return fail("No active tenant numbers to attach — provision a number first")
      for (const phoneSid of sids) {
        const attach = await twilio({ accountSid: sub.accountSid, authToken: sub.authToken }, MESSAGING, `/v1/Services/${state.messaging_service_sid}/PhoneNumbers`, "POST", { PhoneNumberSid: phoneSid })
        // 409/already-attached is fine — idempotent.
        if (!attach.ok && attach.status !== 409) return fail(`Number attach failed: ${attach.error ?? attach.status}`)
      }
      state.number_attached = true
      state.attached_number_sids = sids
      await saveA2pState(svc, brokerageId, ref, state)
      continue
    }

    if (step === "campaign") {
      // Wave 83D — RE-POLL the brand here. Before this, the brand was read only
      // inside the messaging_service step (once); every later run landed on
      // this step, saw the STALE "PENDING", and returned the honest pause below
      // before the end-of-run poll could execute — so the campaign was never
      // filed, not even by the human button. Found by the business-registration
      // loop proof walking the real machine tick by tick.
      if (!BRAND_TERMINAL.includes((state.brand_status ?? "").toUpperCase())) {
        const brand = await twilio<{ status?: string; failure_reason?: string }>(master, MESSAGING, `/v1/a2p/BrandRegistrations/${state.brand_sid}`, "GET")
        if (brand.ok && brand.data?.status) state.brand_status = brand.data.status
        if (brand.ok && brand.data?.failure_reason) state.last_error = String(brand.data.failure_reason).slice(0, 400)
      }
      if (BRAND_REJECTED.includes((state.brand_status ?? "").toUpperCase())) {
        // Wave 83D: a FAILED / SUSPENDED brand used to sit here as an "honest
        // pause" with last_error cleared — forever, with nothing telling the
        // tenant. It is a needs-input state: name it.
        return fail(`Brand review ${(state.brand_status ?? "").toUpperCase()}${state.last_error ? ` (${state.last_error})` : ""} — correct the business profile (legal name / EIN / address must match the IRS record), then the brand must be re-submitted by platform support (automatic brand re-submission is not built)`)
      }
      if ((state.brand_status ?? "").toUpperCase() !== "APPROVED") {
        // Honest pause: the campaign can't be filed until the brand clears.
        state.last_error = null
        await saveA2pState(svc, brokerageId, ref, state)
        return { ok: true, state, advancedTo: "campaign" }
      }
      // CONTRACT-VERIFIED (Twilio Usa2p resource docs, July 2026):
      // MessageSamples is an ARRAY (2–5 samples, 20–1024 chars each — one
      // sample hard-fails); PrivacyPolicyUrl + TermsAndConditionsUrl are
      // REQUIRED since June 30, 2026 (400 without them); keyword opt-in
      // declared → OptInMessage + OptInKeywords required; SubscriberOptIn /
      // AgeGated / DirectLending are explicit booleans.
      const campaign = await twilio<{ sid?: string; campaign_status?: string }>(
        { accountSid: sub.accountSid, authToken: sub.authToken }, MESSAGING,
        `/v1/Services/${state.messaging_service_sid}/Compliance/Usa2p`, "POST", {
          BrandRegistrationSid: state.brand_sid!,
          Description: profile.useCaseDescription,
          MessageFlow: "Contacts opt in by texting or calling the office first, submitting a web form with consent language, or signing in at an open house with express written consent. Consent language and records are retained. Every message honors opt-out; STOP is processed immediately.",
          MessageSamples: [
            "Hi {first name}, confirming your showing at {address} tomorrow at {time}. Reply C to confirm or R to reschedule. Reply STOP to opt out.",
            `Hi {first name}, this is ${profile.legalName}. The open house at {address} starts at {time} — see you there! Reply STOP to opt out.`,
          ],
          UsAppToPersonUsecase: "LOW_VOLUME",
          HasEmbeddedLinks: true,
          HasEmbeddedPhone: true,
          SubscriberOptIn: true,
          AgeGated: false,
          DirectLending: false,
          OptInMessage: `${profile.legalName}: You're opted in to appointment and listing updates (up to 4 msgs/mo). Msg&data rates may apply. Reply HELP for help, STOP to opt out.`,
          OptInKeywords: ["START", "YES", "UNSTOP"],
          PrivacyPolicyUrl: profile.privacyPolicyUrl,
          TermsAndConditionsUrl: profile.termsUrl,
        })
      if (!campaign.ok || !campaign.data?.sid) return fail(`Campaign create failed: ${campaign.error ?? campaign.status}`)
      state.campaign_sid = campaign.data.sid
      state.campaign_status = campaign.data.campaign_status ?? "PENDING"
      state.last_error = null
      await saveA2pState(svc, brokerageId, ref, state)
      continue
    }
  }

  // Poll async reviews on every run so the status line stays honest. Wave 83D:
  // poll the brand while it is NOT terminal — the old `=== "PENDING"` test
  // never re-read a brand in IN_REVIEW (TCR manual vetting, 7+ business days),
  // so such a tenant's campaign could never be filed.
  if (state.brand_sid && !BRAND_TERMINAL.includes((state.brand_status ?? "").toUpperCase())) {
    const brand = await twilio<{ status?: string }>(master, MESSAGING, `/v1/a2p/BrandRegistrations/${state.brand_sid}`, "GET")
    if (brand.ok && brand.data?.status) state.brand_status = brand.data.status
  }
  // Wave 83D: numbers that arrived AFTER the first attach (a second purchase, a
  // completed port) join the messaging service's sender pool too.
  if (state.messaging_service_sid && state.number_attached) {
    const { data: live, error: liveErr } = await svc.from("tenant_phone_numbers")
      .select("twilio_number_sid, phone_number").eq("brokerage_id", brokerageId).eq("is_active", true)
      .not("twilio_number_sid", "is", null).limit(10)
    if (!liveErr) {
      const have = new Set(state.attached_number_sids ?? [])
      const fresh = ((live ?? []) as any[]).filter((n) => n.twilio_number_sid && !have.has(n.twilio_number_sid) && !isTollFreeNumber(n.phone_number)).map((n) => n.twilio_number_sid as string)
      for (const phoneSid of fresh) {
        const attach = await twilio({ accountSid: sub.accountSid, authToken: sub.authToken }, MESSAGING, `/v1/Services/${state.messaging_service_sid}/PhoneNumbers`, "POST", { PhoneNumberSid: phoneSid })
        if (!attach.ok && attach.status !== 409) return fail(`Number attach failed: ${attach.error ?? attach.status}`)
        have.add(phoneSid)
      }
      state.attached_number_sids = [...have]
    }
  }
  if (state.campaign_sid && !["VERIFIED", "APPROVED", "FAILED"].includes((state.campaign_status ?? "").toUpperCase())) {
    // Poll by the campaign's OWN sid (returned at creation) — never a constant.
    const c = await twilio<{ campaign_status?: string }>({ accountSid: sub.accountSid, authToken: sub.authToken }, MESSAGING,
      `/v1/Services/${state.messaging_service_sid}/Compliance/Usa2p/${state.campaign_sid}`, "GET")
    if (c.ok && c.data?.campaign_status) state.campaign_status = c.data.campaign_status
  }
  await saveA2pState(svc, brokerageId, ref, state)
  return { ok: true, state, advancedTo: nextA2pStep(state) }
}

// ── Voice integrity: CNAM + SHAKEN/STIR (appended step, after campaign) ──────
// Carriers now label unsigned/unnamed business calls "Spam Likely" — the voice
// twin of unregistered SMS. Both registrations ride the SAME TrustHub customer
// profile the A2P machine already filed, so this is an APPENDED step of the
// same machine, persisted in the same platform_credentials 'twilio_a2p' jsonb:
//   CNAM         — TrustProduct (policy RNf3db…) + 'cnam_information' EndUser
//                  (cnam_display_name, 15-char carrier cap) + number assignment
//   SHAKEN/STIR  — TrustProduct (policy RN7a97…) + number assignment (no extra
//                  end user; the customer profile IS the identity)
// CONTRACT-VERIFIED against Twilio's current docs (July 2026): both policy SIDs
// are Twilio-published constants; numbers must be ChannelEndpointAssigned to
// the CUSTOMER PROFILE before a trust product will accept them; bundles are
// evaluated then submitted (Status pending-review) and reviewed async — status
// is polled by bundle sid on every run, never fabricated. Unlike the brand,
// TrustHub has NO Mock flag here, so opts.mock stops BEFORE submission and
// leaves the bundle in Twilio's real 'draft' status — an honest mock state; a
// later real run resumes by submitting the drafts. Without master creds the
// runner fails honestly ("not configured") — nothing is ever marked registered.

const CNAM_TRUST_POLICY = "RNf3db3cd1fe25fcfd3c3ded065c8fea53"
const SHAKEN_TRUST_POLICY = "RN7a97559effdf62d00f4298208492a5ea"
/** Carrier CNAM display-name cap (15 characters). */
export const CNAM_DISPLAY_NAME_MAX = 15

export type VoiceIntegrityStep = "cnam" | "shaken"

/** PURE: voice integrity registers only AFTER the campaign clears review. */
export function a2pCampaignApproved(s: A2pState): boolean {
  const st = (s.campaign_status ?? "").toUpperCase()
  return !!s.campaign_sid && (st === "VERIFIED" || st === "APPROVED")
}

/** PURE: the next voice-integrity step given persisted state (resumable). */
export function nextVoiceIntegrityStep(s: A2pState): VoiceIntegrityStep | "done" {
  if (!s.cnam_trust_product_sid) return "cnam"
  if (!s.shaken_trust_product_sid) return "shaken"
  return "done"
}

/** PURE: one honest status line for the board/settings. */
export function describeVoiceIntegrityState(s: A2pState): string {
  if (!a2pCampaignApproved(s)) return "Awaiting A2P campaign approval — CNAM and SHAKEN/STIR register afterward on the same TrustHub profile."
  const part = (label: string, sid?: string, status?: string) =>
    `${label} ${sid ? (status ?? "pending-review") : "not filed"}`
  const line = `${part("CNAM", s.cnam_trust_product_sid, s.cnam_status)} · ${part("SHAKEN/STIR", s.shaken_trust_product_sid, s.shaken_status)}`
  return s.voice_integrity_error ? `${line} — last error: ${s.voice_integrity_error}` : line
}

export interface VoiceIntegrityRunResult {
  ok: boolean
  state: A2pState
  advancedTo: VoiceIntegrityStep | "done"
  error?: string
}

/** Idempotent: assign each PN to a bundle, skipping ones already assigned. */
async function assignNumbersToBundle(master: Creds, bundlePath: string, phoneSids: string[]): Promise<string | null> {
  const existing = await twilio<{ results?: Array<{ channel_endpoint_sid?: string }> }>(
    master, TRUSTHUB, `${bundlePath}/ChannelEndpointAssignments?PageSize=1000`, "GET")
  const have = new Set(((existing.ok ? existing.data?.results : null) ?? []).map((r) => r.channel_endpoint_sid).filter(Boolean))
  for (const pn of phoneSids) {
    if (have.has(pn)) continue
    const r = await twilio(master, TRUSTHUB, `${bundlePath}/ChannelEndpointAssignments`, "POST", {
      ChannelEndpointType: "phone-number", ChannelEndpointSid: pn,
    })
    // 409/already-assigned is fine — idempotent.
    if (!r.ok && r.status !== 409) return `Number assignment failed on ${bundlePath.split("/").slice(-1)[0]}: ${r.error ?? r.status}`
  }
  return null
}

/**
 * Register CNAM + SHAKEN/STIR for a tenant whose A2P campaign is approved.
 * Resumable and idempotent exactly like runA2pRegistration: completed bundles
 * are skipped (sids persist in the SAME twilio_a2p jsonb), drafts left by a
 * mock run are submitted on the next real run, and async reviews are polled.
 */
export async function runVoiceIntegrityRegistration(svc: any, brokerageId: string, opts?: { mock?: boolean }): Promise<VoiceIntegrityRunResult> {
  const ref = await loadA2pState(svc, brokerageId)
  const state = ref.state
  const fail = async (error: string): Promise<VoiceIntegrityRunResult> => {
    const s = { ...state, voice_integrity_error: error.slice(0, 400) }
    await saveA2pState(svc, brokerageId, ref, s)
    return { ok: false, state: s, advancedTo: nextVoiceIntegrityStep(s), error }
  }

  if (!a2pCampaignApproved(state)) return fail("A2P campaign not yet carrier-approved — voice integrity (CNAM + SHAKEN/STIR) registers AFTER campaign approval")
  if (!state.customer_profile_sid) return fail("No TrustHub customer profile on file — run A2P registration first")

  const profileV = await resolveA2pProfile(svc, brokerageId)
  if (!profileV.ok) return fail(`Business profile incomplete — missing: ${profileV.missing.join(", ")}`)
  const profile = profileV.value

  const masterSid = process.env.TWILIO_ACCOUNT_SID
  const masterToken = process.env.TWILIO_AUTH_TOKEN
  if (!masterSid || !masterToken) return fail("Twilio master account not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN) — nothing was filed")
  const master: Creds = { accountSid: masterSid, authToken: masterToken }

  const { data: numbers } = await svc.from("tenant_phone_numbers")
    .select("twilio_number_sid").eq("brokerage_id", brokerageId).eq("is_active", true)
    .not("twilio_number_sid", "is", null).limit(10)
  const phoneSids = ((numbers ?? []) as any[]).map((n) => n.twilio_number_sid).filter(Boolean) as string[]
  if (phoneSids.length === 0) return fail("No active tenant numbers to register — provision a number first")

  // Prerequisite: numbers must belong to the CUSTOMER PROFILE before either
  // trust product will accept them (Twilio eligibility rule).
  const cpAssignErr = await assignNumbersToBundle(master, `/v1/CustomerProfiles/${state.customer_profile_sid}`, phoneSids)
  if (cpAssignErr) return fail(cpAssignErr)

  const registerBundle = async (
    kind: VoiceIntegrityStep,
    policySid: string,
    extraEntitySids: string[],
  ): Promise<{ sid: string; status: string } | { error: string }> => {
    const label = kind === "cnam" ? "CNAM" : "SHAKEN/STIR"
    const shell = await twilio<{ sid?: string; status?: string }>(master, TRUSTHUB, "/v1/TrustProducts", "POST", {
      FriendlyName: `${profile.legalName} — ${label}`, Email: profile.contactEmail, PolicySid: policySid,
    })
    if (!shell.ok || !shell.data?.sid) return { error: `${label} trust product create failed: ${shell.error ?? shell.status}` }
    const tpSid = shell.data.sid
    for (const objectSid of [state.customer_profile_sid!, ...extraEntitySids]) {
      const assign = await twilio(master, TRUSTHUB, `/v1/TrustProducts/${tpSid}/EntityAssignments`, "POST", { ObjectSid: objectSid })
      if (!assign.ok) return { error: `${label} assignment failed: ${assign.error ?? assign.status}` }
    }
    const numErr = await assignNumbersToBundle(master, `/v1/TrustProducts/${tpSid}`, phoneSids)
    if (numErr) return { error: numErr }
    const evalR = await twilio<{ status?: string }>(master, TRUSTHUB, `/v1/TrustProducts/${tpSid}/Evaluations`, "POST", { PolicySid: policySid })
    if (!evalR.ok || evalR.data?.status !== "compliant") return { error: `${label} bundle not compliant (Twilio: ${evalR.error ?? evalR.data?.status ?? "noncompliant"})` }
    if (opts?.mock) return { sid: tpSid, status: "draft" } // honest mock: real bundle, NOT submitted
    const submit = await twilio<{ status?: string }>(master, TRUSTHUB, `/v1/TrustProducts/${tpSid}`, "POST", { Status: "pending-review" })
    if (!submit.ok) return { error: `${label} submit failed: ${submit.error ?? submit.status}` }
    return { sid: tpSid, status: submit.data?.status ?? "pending-review" }
  }

  // ── CNAM ──
  if (!state.cnam_trust_product_sid) {
    const endUser = await twilio<{ sid?: string }>(master, TRUSTHUB, "/v1/EndUsers", "POST", {
      FriendlyName: `${profile.legalName} caller ID`,
      Type: "cnam_information",
      Attributes: JSON.stringify({ cnam_display_name: profile.legalName.slice(0, CNAM_DISPLAY_NAME_MAX).trim() }),
    })
    if (!endUser.ok || !endUser.data?.sid) return fail(`CNAM display-name end user failed: ${endUser.error ?? endUser.status}`)
    const r = await registerBundle("cnam", CNAM_TRUST_POLICY, [endUser.data.sid])
    if ("error" in r) return fail(r.error)
    state.cnam_trust_product_sid = r.sid
    state.cnam_status = r.status
    state.voice_integrity_error = null
    await saveA2pState(svc, brokerageId, ref, state)
  }

  // ── SHAKEN/STIR ──
  if (!state.shaken_trust_product_sid) {
    const r = await registerBundle("shaken", SHAKEN_TRUST_POLICY, [])
    if ("error" in r) return fail(r.error)
    state.shaken_trust_product_sid = r.sid
    state.shaken_status = r.status
    state.voice_integrity_error = null
    await saveA2pState(svc, brokerageId, ref, state)
  }

  // Drafts left by a mock run: submit on a real run; then poll async reviews
  // so the board's status stays honest (terminal: twilio-approved/-rejected).
  const bundles: Array<[VoiceIntegrityStep, string, "cnam_status" | "shaken_status"]> = [
    ["cnam", state.cnam_trust_product_sid!, "cnam_status"],
    ["shaken", state.shaken_trust_product_sid!, "shaken_status"],
  ]
  for (const [kind, sid, key] of bundles) {
    if (!opts?.mock && (state[key] ?? "draft") === "draft") {
      const submit = await twilio<{ status?: string }>(master, TRUSTHUB, `/v1/TrustProducts/${sid}`, "POST", { Status: "pending-review" })
      if (!submit.ok) return fail(`${kind === "cnam" ? "CNAM" : "SHAKEN/STIR"} submit failed: ${submit.error ?? submit.status}`)
      state[key] = submit.data?.status ?? "pending-review"
    } else if (!["twilio-approved", "twilio-rejected", "draft"].includes(state[key] ?? "")) {
      const poll = await twilio<{ status?: string }>(master, TRUSTHUB, `/v1/TrustProducts/${sid}`, "GET")
      if (poll.ok && poll.data?.status) state[key] = poll.data.status
    }
  }
  state.voice_integrity_error = null
  await saveA2pState(svc, brokerageId, ref, state)
  return { ok: true, state, advancedTo: nextVoiceIntegrityStep(state) }
}

// ── TOLL-FREE VERIFICATION (wave 81D) ────────────────────────────────────────
// A toll-free number (8xx) is NOT registered through 10DLC — it is VERIFIED
// through Twilio's Tollfree Verifications resource
// (POST https://messaging.twilio.com/v1/Tollfree/Verifications; Exa,
// 2026-09-24: unverified toll-free traffic is BLOCKED since 2023-11-08 /
// 2024-01-31; statuses PENDING_REVIEW → IN_REVIEW → TWILIO_APPROVED |
// TWILIO_REJECTED, polled by sid). Same business profile, same
// platform_credentials 'twilio_a2p' jsonb, same honesty: nothing is marked
// verified that Twilio did not say.

const TOLLFREE_PREFIXES = ["800", "833", "844", "855", "866", "877", "888"] as const

/** PURE: is this E.164 (or 10/11-digit) number a US toll-free number? */
export function isTollFreeNumber(phone: string | null | undefined): boolean {
  const d = (phone ?? "").replace(/\D/g, "")
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d
  return ten.length === 10 && (TOLLFREE_PREFIXES as readonly string[]).includes(ten.slice(0, 3))
}

// Module-private (wave 81 integration, opposite-missing C3): no importer existed; the
// terminal list below is its reader, so a status outside the vocabulary cannot be terminal.
type TollfreeStatus = "PENDING_REVIEW" | "IN_REVIEW" | "TWILIO_APPROVED" | "TWILIO_REJECTED"
const TOLLFREE_TERMINAL: readonly TollfreeStatus[] = ["TWILIO_APPROVED", "TWILIO_REJECTED"]

/** PURE: one honest status line for the toll-free lane. */
export function describeTollfreeState(s: A2pState): string {
  if (!s.tollfree_verification_sid) return `Toll-free verification not yet submitted.${s.tollfree_error ? ` Last error: ${s.tollfree_error}` : ""}`
  const st = (s.tollfree_status ?? "PENDING_REVIEW").toUpperCase()
  if (st === "TWILIO_APPROVED") return "Toll-free number verified — carrier-approved texting is active."
  if (st === "TWILIO_REJECTED") return `Toll-free verification REJECTED${s.tollfree_error ? `: ${s.tollfree_error}` : ""} — fix the profile / opt-in evidence and resubmit.`
  return `Toll-free verification under carrier review (${st}). Sending is restricted until approved.`
}

export interface TollfreeRunResult { ok: boolean; state: A2pState; status: string | null; error?: string }

/**
 * Submit (once) and poll the toll-free verification for the tenant's toll-free
 * number(s). Idempotent: an existing verification sid is polled, never
 * re-filed. Needs the SAME complete business profile the 10DLC machine needs.
 */
export async function runTollfreeVerification(svc: any, brokerageId: string, opts?: { mock?: boolean; deps?: CarrierRunDeps }): Promise<TollfreeRunResult> {
  const twilio = bindTwilio(opts?.deps)
  const ref = await loadA2pState(svc, brokerageId)
  const state = ref.state
  const fail = async (error: string): Promise<TollfreeRunResult> => {
    const s = { ...state, tollfree_error: error.slice(0, 400) }
    await saveA2pState(svc, brokerageId, ref, s)
    return { ok: false, state: s, status: s.tollfree_status ?? null, error }
  }

  const profileV = await resolveA2pProfile(svc, brokerageId)
  if (!profileV.ok) return fail(`Business profile incomplete — missing: ${profileV.missing.join(", ")}`)
  const profile = profileV.value

  const creds = await tenantCredsFor(svc, brokerageId, opts?.deps)
  if (!creds) return fail("Twilio not configured for this tenant — nothing was filed")

  // Poll an existing verification by its own sid (never a constant).
  if (state.tollfree_verification_sid) {
    if (!TOLLFREE_TERMINAL.includes((state.tollfree_status ?? "").toUpperCase() as TollfreeStatus)) {
      const poll = await twilio<{ status?: string; rejection_reason?: string }>({ accountSid: creds.accountSid, authToken: creds.authToken }, MESSAGING, `/v1/Tollfree/Verifications/${state.tollfree_verification_sid}`, "GET")
      if (poll.ok && poll.data?.status) {
        state.tollfree_status = poll.data.status
        if (poll.data.status.toUpperCase() === "TWILIO_REJECTED") state.tollfree_error = (poll.data.rejection_reason ?? "rejected — see Twilio console").slice(0, 400)
      }
    }
    await saveA2pState(svc, brokerageId, ref, state)
    return { ok: true, state, status: state.tollfree_status ?? null }
  }

  const { data: numbers } = await svc.from("tenant_phone_numbers")
    .select("phone_number, twilio_number_sid").eq("brokerage_id", brokerageId).eq("is_active", true)
    .not("twilio_number_sid", "is", null).limit(10)
  const tollFree = ((numbers ?? []) as Array<{ phone_number: string; twilio_number_sid: string }>).find((n) => isTollFreeNumber(n.phone_number))
  if (!tollFree) return fail("No active toll-free number to verify — provision one first")

  if (opts?.mock) {
    // Honest mock: the form is validated and nothing is filed; state records
    // the intent so a later real run submits.
    state.tollfree_error = null
    await saveA2pState(svc, brokerageId, ref, state)
    return { ok: true, state, status: null }
  }

  // CONTRACT (Twilio Tollfree Verifications, 2026-09-24 docs): business identity
  // + contact + opt-in evidence + use case + samples + volume + the number's SID;
  // Privacy/Terms URLs and the EIN (BusinessRegistrationNumber/Authority) are
  // required for every business type but SOLE_PROPRIETOR.
  const created = await twilio<{ sid?: string; status?: string }>({ accountSid: creds.accountSid, authToken: creds.authToken }, MESSAGING, "/v1/Tollfree/Verifications", "POST", {
    BusinessName: profile.legalName,
    BusinessWebsite: profile.website,
    BusinessStreetAddress: profile.street,
    BusinessCity: profile.city,
    BusinessStateProvinceRegion: profile.region,
    BusinessPostalCode: profile.postalCode,
    BusinessCountry: "US",
    BusinessContactFirstName: profile.contactFirstName,
    BusinessContactLastName: profile.contactLastName,
    BusinessContactEmail: profile.contactEmail,
    BusinessContactPhone: profile.contactPhone,
    NotificationEmail: profile.contactEmail,
    UseCaseCategories: ["CUSTOMER_CARE", "ACCOUNT_NOTIFICATIONS"],
    UseCaseSummary: profile.useCaseDescription,
    ProductionMessageSample: `Hi {first name}, this is ${profile.legalName}. Confirming your showing at {address} tomorrow at {time}. Reply C to confirm or R to reschedule. Reply STOP to opt out.`,
    OptInImageUrls: [profile.website],
    OptInType: "WEB_FORM",
    MessageVolume: "1,000",
    TollfreePhoneNumberSid: tollFree.twilio_number_sid,
    PrivacyPolicyUrl: profile.privacyPolicyUrl,
    TermsAndConditionsUrl: profile.termsUrl,
    BusinessRegistrationNumber: profile.ein,
    BusinessRegistrationAuthority: "EIN",
    BusinessRegistrationCountry: "US",
    BusinessType: "PRIVATE_PROFIT",
    OptInKeywords: ["START", "YES"],
    HelpMessageSample: `${profile.legalName}: reply HELP for help or STOP to opt out. Msg&data rates may apply.`,
    OptInConfirmationMessage: `${profile.legalName}: You're opted in to appointment and listing updates. Msg&data rates may apply. Reply HELP for help, STOP to opt out.`,
  })
  if (!created.ok || !created.data?.sid) return fail(`Toll-free verification submit failed: ${created.error ?? created.status}`)
  state.tollfree_verification_sid = created.data.sid
  state.tollfree_status = created.data.status ?? "PENDING_REVIEW"
  state.tollfree_error = null
  await saveA2pState(svc, brokerageId, ref, state)
  return { ok: true, state, status: state.tollfree_status }
}

// ── AUTOMATIC KICK-OFF AFTER A PURCHASE / PORT-IN (wave 81D) ─────────────────
// Owner: "automatic registering business after phone number purchase/port over
// so can use the phone/test feature." Until this wave the step machine ran only
// when a human pressed "Run / resume registration". Now the number pipeline
// (lib/voice/number-provisioning.ts provisionNumber) and the port-in door
// (app/actions/phone-provisioning.ts manuallyAddAgentPhone) call this the
// moment a number lands: best-effort, NEVER blocks or undoes the purchase,
// audited on phone_number_events, and HONEST when the business profile is
// incomplete — it says which fields the tenant still owes instead of pretending
// a registration is under way.

export interface CarrierKickoffResult {
  kicked: boolean
  lane: "10dlc" | "tollfree"
  statusLine: string
  reason?: string
}

export async function kickCarrierRegistration(svc: any, args: { brokerageId: string; phoneNumber: string; trigger: "purchased" | "ported_in" | "manually_added"; deps?: CarrierRunDeps }): Promise<CarrierKickoffResult> {
  const lane: CarrierKickoffResult["lane"] = isTollFreeNumber(args.phoneNumber) ? "tollfree" : "10dlc"
  let result: CarrierKickoffResult
  try {
    // Wave 83D: the profile is DERIVED from the brokerage's own record first
    // (resolveA2pProfile); only what no record holds is asked of the tenant.
    const profileV = await resolveA2pProfile(svc, args.brokerageId)
    if (!profileV.ok) {
      result = { kicked: false, lane, statusLine: `Business registration waiting on the business profile — missing: ${profileV.missing.join(", ")} (Phone settings → Carrier registration). It resumes on its own once these are saved.`, reason: "profile_incomplete" }
    } else if (lane === "tollfree") {
      const r = await runTollfreeVerification(svc, args.brokerageId, { deps: args.deps })
      result = { kicked: r.ok, lane, statusLine: describeTollfreeState(r.state), reason: r.error }
    } else {
      const r = await runA2pRegistration(svc, args.brokerageId, { deps: args.deps })
      result = { kicked: r.ok, lane, statusLine: describeA2pState(r.state), reason: r.error }
    }
  } catch (err) {
    result = { kicked: false, lane, statusLine: "Business registration could not start — it will resume from Phone settings.", reason: (err as Error)?.message ?? "unknown" }
  }
  // Audit line on the SAME table the manual button writes (event_type from the
  // live CHECK — webhooks_bound is the value the a2p_registration source has
  // always used; the source names this automatic path).
  const { error } = await svc.from("phone_number_events").insert({
    brokerage_id: args.brokerageId, phone_number: args.phoneNumber,
    event_type: "webhooks_bound", source: "a2p_auto_kickoff",
    notes: `auto ${lane} registration after ${args.trigger}: ${result.kicked ? "kicked" : "not kicked"} — ${result.statusLine}${result.reason ? ` (${result.reason.slice(0, 160)})` : ""}`.slice(0, 500),
  })
  if (error) console.warn("[a2p] auto-kickoff audit line refused:", error.message)
  return result
}

// ── THE PHONE TEST FEATURE IS GATED ON REGISTRATION (wave 81D) ───────────────

export interface PhoneTestReadiness {
  ready: boolean
  /** Which lanes the tenant's active numbers need, and each lane's status. */
  lanes: Array<{ lane: "10dlc" | "tollfree"; registered: boolean; statusLine: string }>
  reason: string | null
}

/** PURE, FAIL-CLOSED: the test feature runs only when EVERY lane the tenant's
 *  active numbers need is carrier-registered. No numbers → not ready. */
export function assessPhoneTestReadiness(state: A2pState, numbers: ReadonlyArray<{ phone_number: string }>): PhoneTestReadiness {
  if (!numbers.length) return { ready: false, lanes: [], reason: "No active phone number — provision or port one first." }
  const needTollfree = numbers.some((n) => isTollFreeNumber(n.phone_number))
  const needLocal = numbers.some((n) => !isTollFreeNumber(n.phone_number))
  const lanes: PhoneTestReadiness["lanes"] = []
  if (needLocal) lanes.push({ lane: "10dlc", registered: a2pCampaignApproved(state), statusLine: describeA2pState(state) })
  if (needTollfree) lanes.push({ lane: "tollfree", registered: (state.tollfree_status ?? "").toUpperCase() === "TWILIO_APPROVED", statusLine: describeTollfreeState(state) })
  const blocked = lanes.filter((l) => !l.registered)
  return { ready: blocked.length === 0, lanes, reason: blocked.length ? `Registration not complete — ${blocked.map((l) => `${l.lane}: ${l.statusLine}`).join(" · ")}` : null }
}
