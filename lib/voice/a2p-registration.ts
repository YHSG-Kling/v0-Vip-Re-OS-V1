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
// Twilio's published policy SIDs (constant across all accounts):
const SECONDARY_PROFILE_POLICY = "RN806dd6cd175f314e1f96a9727ee271f4"
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
 * what the carrier registry rejected.
 */
export async function runA2pRegistration(svc: any, brokerageId: string): Promise<A2pRunResult> {
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
      const campaign = await twilio<{ sid?: string; campaign_status?: string }>(
        { accountSid: sub.accountSid, authToken: sub.authToken }, MESSAGING,
        `/v1/Services/${state.messaging_service_sid}/Compliance/Usa2p`, "POST", {
          BrandRegistrationSid: state.brand_sid!,
          Description: profile.useCaseDescription,
          MessageFlow: "Contacts opt in by texting or calling the office first, submitting a web form with consent language, or signing in at an open house with express consent. Every message includes opt-out honoring; STOP is processed immediately.",
          "MessageSamples": "Hi {first name}, confirming your showing at {address} tomorrow at {time}. Reply C to confirm or R to reschedule.",
          UsAppToPersonUsecase: "LOW_VOLUME",
          HasEmbeddedLinks: true,
          HasEmbeddedPhone: true,
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
    const c = await twilio<{ campaign_status?: string }>({ accountSid: sub.accountSid, authToken: sub.authToken }, MESSAGING,
      `/v1/Services/${state.messaging_service_sid}/Compliance/Usa2p/QE2c6890da8086d771620e9b13fadeba0b`, "GET")
    if (c.ok && c.data?.campaign_status) state.campaign_status = c.data.campaign_status
  }
  await saveA2pState(svc, brokerageId, rowId, state)
  return { ok: true, state, advancedTo: nextA2pStep(state) }
}
