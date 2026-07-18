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
}

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
  if (step === "brand" || (s.brand_sid && (s.brand_status ?? "").toUpperCase() === "PENDING")) {
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

async function twilio<T = any>(creds: Creds, baseUrl: string, path: string, method: "GET" | "POST", body?: Record<string, unknown>) {
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  return callConnector<T>({
    connector: "twilio", baseUrl, path, method,
    ...(body ? { bodyType: "form" as const, body } : {}),
    auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
  })
}

/** Load the persisted A2P state row (platform_credentials 'twilio_a2p'). */
export async function loadA2pState(svc: any, brokerageId: string): Promise<{ rowId: string | null; state: A2pState }> {
  const { data } = await svc.from("platform_credentials")
    .select("id, config").eq("brokerage_id", brokerageId)
    .eq("platform", "twilio_a2p").eq("is_active", true).maybeSingle()
  return { rowId: (data as any)?.id ?? null, state: ((data as any)?.config ?? {}) as A2pState }
}

async function saveA2pState(svc: any, brokerageId: string, rowId: string | null, state: A2pState): Promise<void> {
  const config = { ...state, updated_at: new Date().toISOString() }
  if (rowId) {
    await svc.from("platform_credentials").update({ config }).eq("id", rowId)
  } else {
    await svc.from("platform_credentials").insert({
      brokerage_id: brokerageId, platform: "twilio_a2p",
      owner_type: "brokerage", owner_id: brokerageId, is_active: true, config,
    })
  }
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
export async function runA2pRegistration(svc: any, brokerageId: string, opts?: { mock?: boolean }): Promise<A2pRunResult> {
  const { rowId, state } = await loadA2pState(svc, brokerageId)
  const fail = async (error: string): Promise<A2pRunResult> => {
    const s = { ...state, last_error: error.slice(0, 400) }
    await saveA2pState(svc, brokerageId, rowId, s)
    return { ok: false, state: s, advancedTo: nextA2pStep(s), error }
  }

  // Prerequisites: business profile + master + subaccount creds.
  const { data: bs } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  const profileV = validateA2pProfile((bs as any)?.settings?.a2p_business_profile)
  if (!profileV.ok) return fail(`Business profile incomplete — missing: ${profileV.missing.join(", ")}`)
  const profile = profileV.value

  const masterSid = process.env.TWILIO_ACCOUNT_SID
  const masterToken = process.env.TWILIO_AUTH_TOKEN
  if (!masterSid || !masterToken) return fail("Twilio master account not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN)")
  const master: Creds = { accountSid: masterSid, authToken: masterToken }

  const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  const sub = await resolveTenantTwilioCreds(svc, brokerageId)
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
      await saveA2pState(svc, brokerageId, rowId, state)
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
      await saveA2pState(svc, brokerageId, rowId, state)
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
      await saveA2pState(svc, brokerageId, rowId, state)
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
      await saveA2pState(svc, brokerageId, rowId, state)
      continue
    }

    if (step === "number_attached") {
      const { data: numbers } = await svc.from("vapi_phone_numbers")
        .select("byoc_credential_id").eq("brokerage_id", brokerageId).eq("is_active", true)
        .not("byoc_credential_id", "is", null).limit(10)
      const sids = ((numbers ?? []) as any[]).map((n) => n.byoc_credential_id).filter(Boolean)
      if (sids.length === 0) return fail("No active tenant numbers to attach — provision a number first")
      for (const phoneSid of sids) {
        const attach = await twilio({ accountSid: sub.accountSid, authToken: sub.authToken }, MESSAGING, `/v1/Services/${state.messaging_service_sid}/PhoneNumbers`, "POST", { PhoneNumberSid: phoneSid })
        // 409/already-attached is fine — idempotent.
        if (!attach.ok && attach.status !== 409) return fail(`Number attach failed: ${attach.error ?? attach.status}`)
      }
      state.number_attached = true
      await saveA2pState(svc, brokerageId, rowId, state)
      continue
    }

    if (step === "campaign") {
      if ((state.brand_status ?? "").toUpperCase() !== "APPROVED") {
        // Honest pause: the campaign can't be filed until the brand clears.
        state.last_error = null
        await saveA2pState(svc, brokerageId, rowId, state)
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
      await saveA2pState(svc, brokerageId, rowId, state)
      continue
    }
  }

  // Poll async reviews on every run so the status line stays honest.
  if (state.brand_sid && (state.brand_status ?? "").toUpperCase() === "PENDING") {
    const brand = await twilio<{ status?: string }>(master, MESSAGING, `/v1/a2p/BrandRegistrations/${state.brand_sid}`, "GET")
    if (brand.ok && brand.data?.status) state.brand_status = brand.data.status
  }
  if (state.campaign_sid && !["VERIFIED", "APPROVED", "FAILED"].includes((state.campaign_status ?? "").toUpperCase())) {
    // Poll by the campaign's OWN sid (returned at creation) — never a constant.
    const c = await twilio<{ campaign_status?: string }>({ accountSid: sub.accountSid, authToken: sub.authToken }, MESSAGING,
      `/v1/Services/${state.messaging_service_sid}/Compliance/Usa2p/${state.campaign_sid}`, "GET")
    if (c.ok && c.data?.campaign_status) state.campaign_status = c.data.campaign_status
  }
  await saveA2pState(svc, brokerageId, rowId, state)
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
  const { rowId, state } = await loadA2pState(svc, brokerageId)
  const fail = async (error: string): Promise<VoiceIntegrityRunResult> => {
    const s = { ...state, voice_integrity_error: error.slice(0, 400) }
    await saveA2pState(svc, brokerageId, rowId, s)
    return { ok: false, state: s, advancedTo: nextVoiceIntegrityStep(s), error }
  }

  if (!a2pCampaignApproved(state)) return fail("A2P campaign not yet carrier-approved — voice integrity (CNAM + SHAKEN/STIR) registers AFTER campaign approval")
  if (!state.customer_profile_sid) return fail("No TrustHub customer profile on file — run A2P registration first")

  const { data: bs } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  const profileV = validateA2pProfile((bs as any)?.settings?.a2p_business_profile)
  if (!profileV.ok) return fail(`Business profile incomplete — missing: ${profileV.missing.join(", ")}`)
  const profile = profileV.value

  const masterSid = process.env.TWILIO_ACCOUNT_SID
  const masterToken = process.env.TWILIO_AUTH_TOKEN
  if (!masterSid || !masterToken) return fail("Twilio master account not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN) — nothing was filed")
  const master: Creds = { accountSid: masterSid, authToken: masterToken }

  const { data: numbers } = await svc.from("vapi_phone_numbers")
    .select("byoc_credential_id").eq("brokerage_id", brokerageId).eq("is_active", true)
    .not("byoc_credential_id", "is", null).limit(10)
  const phoneSids = ((numbers ?? []) as any[]).map((n) => n.byoc_credential_id).filter(Boolean) as string[]
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
    await saveA2pState(svc, brokerageId, rowId, state)
  }

  // ── SHAKEN/STIR ──
  if (!state.shaken_trust_product_sid) {
    const r = await registerBundle("shaken", SHAKEN_TRUST_POLICY, [])
    if ("error" in r) return fail(r.error)
    state.shaken_trust_product_sid = r.sid
    state.shaken_status = r.status
    state.voice_integrity_error = null
    await saveA2pState(svc, brokerageId, rowId, state)
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
  await saveA2pState(svc, brokerageId, rowId, state)
  return { ok: true, state, advancedTo: nextVoiceIntegrityStep(state) }
}
