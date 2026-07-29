// lib/platform/provider-posture.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM PROVIDER POSTURE — the fleet-wide "is the platform's side of every
// external rail actually healthy?" read layer. The platform provisions and
// manages providers FOR tenants (Twilio subaccounts + numbers + A2P, SendGrid
// sending domains + suppressions), but until now the only fleet views were
// DB-shaped (what WE recorded), never provider-shaped (what Twilio/SendGrid
// actually have). This module closes three loops, read-only:
//
//   1. TWILIO FLEET POSTURE — per tenant: credential tier (byo / subaccount /
//      master-fallback), live subaccount status (active/suspended/closed —
//      a suspended subaccount is silent total SMS+voice loss for that tenant),
//      number inventory DB vs Twilio (a number Twilio owns that our DB lost —
//      or vice versa — is unbilled/undelivered), month-to-date subaccount
//      spend (Usage Records ThisMonth), and per-number webhook drift (VoiceUrl/
//      SmsUrl vs the URLs bindNumberToTwilioLane sets — drifted webhooks are
//      calls ringing into nothing).
//   2. STALLED A2P DETECTION — pure clock over the persisted A2pState + last
//      registration activity. Carrier reviews normally clear in hours-days;
//      a brand PENDING for a week is the #1 real-world "why don't my texts
//      send" blocker and previously nothing flagged it.
//   3. SENDGRID POSTURE — every sending domain's authentication validity (not
//      just "at least one valid" like the go-live probe), platform-wide
//      bounce/complaint counts from our own email_tracking ledger, and
//      suppression SYNC: SendGrid-side suppressions whose addresses are NOT on
//      platform_suppression_list (the webhook only syncs spamreports it
//      receives — anything registered while the webhook was down is invisible
//      until this sweep).
//
// Everything is creds-gated with honest not-configured states (no env key →
// DB-only posture, clearly labeled), read-only against the vendors, and
// bounded (probe caps, page sizes) so one sweep is a handful of API calls,
// not a fan-out storm. All egress via the connector gateway.

import { callConnector } from "@/lib/agentic-os/connector-gateway"
import type { A2pState } from "@/lib/voice/a2p-registration"
import { nextA2pStep } from "@/lib/voice/a2p-registration"
import { CONNECTOR_REGISTRY } from "@/lib/agentic-os/connector-registry"
import { PROVIDER_TENANCY } from "@/lib/providers/tenancy-matrix"
import { PLATFORM_VENDORS, USER_CONNECTED_VENDORS } from "@/lib/agentic-os/vendor-ownership"
import { PLATFORM_PROVIDER_KEYS, PROBE_SPECS } from "@/lib/agentic-os/connector-probe"
import { VENDOR_PRICING } from "@/lib/vendor-governance/cost-normalizer"
import { CONNECTED_CAPABILITY_REGISTRY, type ConnectedCapability } from "@/lib/agentic-os/connected-vendor-registry"
import { canonicalProvider } from "@/lib/integrations/connection-manager"
import { composeSentinelLossReport } from "@/lib/kernel/write-sentinel"
import { geoapifyConfigured } from "@/lib/external/geoapify-client"
import { OSINTClient } from "@/lib/osint-client"
import { fetchOSINTNeighborhoodData } from "@/lib/external/osint-neighborhood"
import { gatewayChat } from "@/lib/ai/gateway-chat"

// ── Webhook expectations (the URLs bindNumberToTwilioLane writes) ────────────

export interface ExpectedWebhooks {
  voice: string
  sms: string
}

/** PURE: the webhook URLs a bound tenant number is expected to carry. */
export function expectedWebhookTargets(appUrl: string): ExpectedWebhooks {
  const base = appUrl.replace(/\/$/, "")
  return { voice: `${base}/api/voice/twilio/inbound`, sms: `${base}/api/providers/inbound` }
}

export type NumberBinding = "bound" | "unbound" | "drifted"

/** PURE: classify one number's live webhook config against the expected lane.
 *  "unbound" (empty URLs) is a plain line — legitimate when the AI toggle is
 *  off; "drifted" (bound to something ELSE) is the dangerous state: the tenant
 *  thinks the AI answers, but calls/texts route elsewhere. */
export function classifyNumberBinding(
  voiceUrl: string | null | undefined,
  smsUrl: string | null | undefined,
  expected: ExpectedWebhooks,
): { voice: NumberBinding; sms: NumberBinding } {
  const one = (actual: string | null | undefined, want: string): NumberBinding => {
    const a = (actual ?? "").trim()
    if (!a) return "unbound"
    return a === want ? "bound" : "drifted"
  }
  return { voice: one(voiceUrl, expected.voice), sms: one(smsUrl, expected.sms) }
}

// ── Twilio fleet posture ─────────────────────────────────────────────────────

export interface TwilioNumberPosture {
  phoneNumber: string
  sid: string
  voice: NumberBinding
  sms: NumberBinding
  /** The actual VoiceUrl when drifted — so staff see WHERE calls actually go. */
  voiceUrl: string | null
}

export interface TwilioTenantPosture {
  brokerageId: string
  name: string
  credTier: "byo" | "subaccount" | "master_fallback" | "none"
  subaccountSid: string | null
  /** Live subaccount status from Twilio (active | suspended | closed) — null when not probed. */
  subaccountStatus: string | null
  /** Numbers our DB says this tenant has (vapi_phone_numbers active). */
  dbNumberCount: number
  /** Numbers Twilio says the tenant's account owns — null when not probed. */
  twilioNumberCount: number | null
  /** Month-to-date Twilio spend (USD) for the tenant's own account — null when not probed. */
  monthSpendUsd: number | null
  numbers: TwilioNumberPosture[]
  driftedCount: number
  unboundCount: number
  probed: boolean
  probeError: string | null
}

export interface TwilioFleetPosture {
  generatedAt: string
  /** false = no TWILIO master env creds — rows are DB-only, honestly labeled. */
  liveProbes: boolean
  detail: string
  totalTenants: number
  probedTenants: number
  tenants: TwilioTenantPosture[]
}

/** Bound: how many tenants get LIVE Twilio probes per sweep (3 calls each). */
export const TWILIO_PROBE_TENANT_CAP = 20
const TWILIO_API = "https://api.twilio.com"

type Creds = { accountSid: string; authToken: string }
const basic = (c: Creds) => ({ style: "basic" as const, username: c.accountSid, password: c.authToken })

async function fetchAccountStatus(master: Creds, accountSid: string): Promise<string | null> {
  const res = await callConnector<{ status?: string }>({
    connector: "twilio", baseUrl: TWILIO_API,
    path: `/2010-04-01/Accounts/${accountSid}.json`, method: "GET", auth: basic(master), timeoutMs: 8000,
  })
  return res.ok ? (res.data?.status ?? null) : null
}

async function fetchNumberList(creds: Creds): Promise<Array<{ sid: string; phone_number: string; voice_url: string | null; sms_url: string | null }> | null> {
  const res = await callConnector<{ incoming_phone_numbers?: Array<{ sid?: string; phone_number?: string; voice_url?: string; sms_url?: string }> }>({
    connector: "twilio", baseUrl: TWILIO_API,
    path: `/2010-04-01/Accounts/${creds.accountSid}/IncomingPhoneNumbers.json`, method: "GET",
    query: { PageSize: "200" }, auth: basic(creds), timeoutMs: 10000,
  })
  if (!res.ok) return null
  return (res.data?.incoming_phone_numbers ?? []).map((n) => ({
    sid: n.sid ?? "", phone_number: n.phone_number ?? "",
    voice_url: n.voice_url ?? null, sms_url: n.sms_url ?? null,
  }))
}

async function fetchMonthSpendUsd(creds: Creds): Promise<number | null> {
  const res = await callConnector<{ usage_records?: Array<{ price?: string | number }> }>({
    connector: "twilio", baseUrl: TWILIO_API,
    path: `/2010-04-01/Accounts/${creds.accountSid}/Usage/Records/ThisMonth.json`, method: "GET",
    query: { Category: "totalprice" }, auth: basic(creds), timeoutMs: 10000,
  })
  if (!res.ok) return null
  const price = Number(res.data?.usage_records?.[0]?.price ?? NaN)
  return Number.isFinite(price) ? Math.round(price * 100) / 100 : null
}

/**
 * The fleet sweep. DB reads always run; live Twilio probes run only when the
 * master env creds exist, capped at TWILIO_PROBE_TENANT_CAP tenants (each
 * probed tenant costs ≤3 API calls: account status, number list, month spend).
 * Master-fallback tenants (numbers bought on the master before subaccounts
 * existed) are checked against ONE shared master number list.
 */
export async function getTwilioFleetPosture(svc: any): Promise<TwilioFleetPosture> {
  const generatedAt = new Date().toISOString()
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")
  const expected = appUrl ? expectedWebhookTargets(appUrl) : null

  const [{ data: brks }, { data: credRows }, { data: numRows }] = await Promise.all([
    svc.from("brokerages").select("id, name").is("deleted_at", null).order("name").limit(300),
    svc.from("platform_credentials").select("brokerage_id, platform, account_id, access_token")
      .in("platform", ["twilio_byo", "twilio_subaccount"]).eq("is_active", true),
    svc.from("vapi_phone_numbers").select("brokerage_id, phone_number, byoc_credential_id").eq("is_active", true),
  ])

  const byoBy = new Map<string, Creds>()
  const subBy = new Map<string, Creds>()
  for (const r of (credRows ?? []) as any[]) {
    if (!r.account_id || !r.access_token) continue
    const c = { accountSid: r.account_id, authToken: r.access_token }
    if (r.platform === "twilio_byo") byoBy.set(r.brokerage_id, c)
    else subBy.set(r.brokerage_id, c)
  }
  const dbNumbersBy = new Map<string, Array<{ phone_number: string; sid: string | null }>>()
  for (const n of (numRows ?? []) as any[]) {
    const list = dbNumbersBy.get(n.brokerage_id) ?? []
    list.push({ phone_number: n.phone_number, sid: n.byoc_credential_id ?? null })
    dbNumbersBy.set(n.brokerage_id, list)
  }

  const masterSid = process.env.TWILIO_ACCOUNT_SID
  const masterToken = process.env.TWILIO_AUTH_TOKEN
  const master: Creds | null = masterSid && masterToken ? { accountSid: masterSid, authToken: masterToken } : null
  const liveProbes = !!master

  // One shared master number list serves every master-fallback tenant.
  let masterNumbers: Awaited<ReturnType<typeof fetchNumberList>> = null
  if (master) masterNumbers = await fetchNumberList(master)

  const assess = (
    live: NonNullable<Awaited<ReturnType<typeof fetchNumberList>>>,
    dbNums: Array<{ phone_number: string; sid: string | null }>,
    restrictToDb: boolean,
  ): TwilioNumberPosture[] => {
    const dbDigits = new Set(dbNums.map((d) => d.phone_number.replace(/\D/g, "")))
    return live
      .filter((n) => !restrictToDb || dbDigits.has(n.phone_number.replace(/\D/g, "")))
      .map((n) => {
        const cls = expected
          ? classifyNumberBinding(n.voice_url, n.sms_url, expected)
          : { voice: "unbound" as NumberBinding, sms: "unbound" as NumberBinding }
        return {
          phoneNumber: n.phone_number, sid: n.sid,
          voice: cls.voice, sms: cls.sms,
          voiceUrl: cls.voice === "drifted" ? n.voice_url : null,
        }
      })
  }

  let probedTenants = 0
  const tenants: TwilioTenantPosture[] = []
  for (const b of ((brks ?? []) as any[])) {
    const byo = byoBy.get(b.id)
    const sub = subBy.get(b.id)
    const dbNums = dbNumbersBy.get(b.id) ?? []
    const credTier: TwilioTenantPosture["credTier"] = byo ? "byo" : sub ? "subaccount" : dbNums.length > 0 ? "master_fallback" : "none"

    const row: TwilioTenantPosture = {
      brokerageId: b.id, name: b.name ?? "(unnamed)", credTier,
      subaccountSid: sub?.accountSid ?? null, subaccountStatus: null,
      dbNumberCount: dbNums.length, twilioNumberCount: null, monthSpendUsd: null,
      numbers: [], driftedCount: 0, unboundCount: 0, probed: false, probeError: null,
    }

    if (liveProbes && (byo || sub) && probedTenants < TWILIO_PROBE_TENANT_CAP) {
      probedTenants += 1
      row.probed = true
      const own = (byo ?? sub)!
      const [status, live, spend] = await Promise.all([
        sub && master ? fetchAccountStatus(master, sub.accountSid) : Promise.resolve(null),
        fetchNumberList(own),
        fetchMonthSpendUsd(own),
      ])
      row.subaccountStatus = status
      row.monthSpendUsd = spend
      if (live === null) {
        row.probeError = "Twilio rejected the tenant's account creds — numbers and webhooks unverifiable"
      } else {
        row.twilioNumberCount = live.length
        row.numbers = assess(live, dbNums, false)
      }
    } else if (credTier === "master_fallback" && masterNumbers) {
      // The tenant's numbers live in the MASTER account — check them there.
      row.probed = true
      row.numbers = assess(masterNumbers, dbNums, true)
      row.twilioNumberCount = row.numbers.length
    }

    row.driftedCount = row.numbers.filter((n) => n.voice === "drifted" || n.sms === "drifted").length
    row.unboundCount = row.numbers.filter((n) => n.voice === "unbound").length
    tenants.push(row)
  }

  // Attention first: drift, then suspended, then inventory mismatch.
  tenants.sort((a, z) =>
    (z.driftedCount - a.driftedCount) ||
    Number(z.subaccountStatus === "suspended" || z.subaccountStatus === "closed") - Number(a.subaccountStatus === "suspended" || a.subaccountStatus === "closed") ||
    (z.dbNumberCount + (z.twilioNumberCount ?? 0)) - (a.dbNumberCount + (a.twilioNumberCount ?? 0)))

  return {
    generatedAt, liveProbes,
    detail: liveProbes
      ? `Live Twilio probes for up to ${TWILIO_PROBE_TENANT_CAP} tenants with own creds (${probedTenants} probed) + one master number list for legacy tenants. Read-only.`
      : "TWILIO_ACCOUNT_SID/AUTH_TOKEN unset — DB-only view; subaccount status, live inventory, spend, and webhook drift unverifiable until the master creds are configured.",
    totalTenants: tenants.length, probedTenants, tenants,
  }
}

// ── Stalled A2P detection (pure) ─────────────────────────────────────────────
// Carrier reviews normally clear in hours to ~2 business days (brand) and a
// few days (campaign). Beyond these windows the registration is STUCK — the
// #1 real-world SMS blocker — and someone must act (re-run the runner to
// re-poll, fix the profile, or open a Twilio ticket).

export const A2P_BRAND_STALL_DAYS = 3
export const A2P_CAMPAIGN_STALL_DAYS = 7
export const A2P_FAILED_STALL_DAYS = 2
export const A2P_IDLE_STALL_DAYS = 14

export interface A2pStallAssessment {
  stalled: boolean
  reason: string | null
}

/** PURE: is this tenant's A2P registration stuck? `lastActivityIso` is the
 *  newest of the runner's phone_number_events / the persisted state's own
 *  updated_at. Not-started and carrier-verified tenants are never stalled. */
export function assessA2pStall(state: A2pState, lastActivityIso: string | null, now = new Date()): A2pStallAssessment {
  const step = nextA2pStep(state)
  const started = step !== "customer_profile" || !!state.last_error
  if (!started) return { stalled: false, reason: null }

  const campaignStatus = (state.campaign_status ?? "").toUpperCase()
  if (step === "done" && (campaignStatus === "VERIFIED" || campaignStatus === "APPROVED")) {
    return { stalled: false, reason: null }
  }

  const last = lastActivityIso ?? state.updated_at ?? null
  const ageDays = last ? Math.floor((now.getTime() - new Date(last).getTime()) / 86_400_000) : null
  if (ageDays === null) return { stalled: true, reason: "in progress but no activity ever recorded" }

  const brandStatus = (state.brand_status ?? "").toUpperCase()
  const failed = brandStatus === "FAILED" || campaignStatus === "FAILED" || !!state.last_error
  if (failed && ageDays >= A2P_FAILED_STALL_DAYS) {
    return { stalled: true, reason: `failed ${ageDays}d ago and not re-run${state.last_error ? ` — ${state.last_error.slice(0, 120)}` : ""}` }
  }
  if (state.brand_sid && brandStatus !== "APPROVED" && !failed && ageDays >= A2P_BRAND_STALL_DAYS) {
    return { stalled: true, reason: `brand under review ${ageDays}d (normally clears in hours–2 days)` }
  }
  if (state.campaign_sid && !["VERIFIED", "APPROVED"].includes(campaignStatus) && !failed && ageDays >= A2P_CAMPAIGN_STALL_DAYS) {
    return { stalled: true, reason: `campaign under review ${ageDays}d (normally clears within a week)` }
  }
  if (step !== "done" && !failed && ageDays >= A2P_IDLE_STALL_DAYS) {
    return { stalled: true, reason: `mid-registration and idle ${ageDays}d (next step: ${step.replace(/_/g, " ")})` }
  }
  return { stalled: false, reason: null }
}

// ── SendGrid posture ─────────────────────────────────────────────────────────

export interface SendgridDomainPosture {
  domain: string
  valid: boolean
}

export interface SendgridPosture {
  generatedAt: string
  configured: boolean
  detail: string
  /** EVERY sending domain with its auth validity (the go-live probe only asks "any valid?"). */
  domains: SendgridDomainPosture[]
  /** SendGrid-side suppressions created in the window (capped fetch). */
  suppressions: {
    windowDays: number
    bounces: number
    spamReports: number
    /** true = the fetch hit the page cap; counts are floors, not totals. */
    capped: boolean
    /** SendGrid spam-reported addresses NOT on platform_suppression_list —
     *  the webhook missed them (down/unset); they can still be re-mailed. */
    unsyncedSpamReports: number
  } | null
  /** Platform-wide outcome counts from our OWN email_tracking ledger (30d). */
  ledger: {
    windowDays: number
    delivered: number
    bounced: number
    dropped: number
    spamComplaints: number
    /** bounces+drops+complaints over all terminal outcomes, percent (null when no data). */
    problemRatePct: number | null
  }
}

const SUPPRESSION_FETCH_CAP = 500
const SENDGRID_API = "https://api.sendgrid.com"

/** PURE: fold ledger counts into the problem rate. */
export function computeProblemRatePct(delivered: number, bounced: number, dropped: number, spamComplaints: number): number | null {
  const total = delivered + bounced + dropped + spamComplaints
  if (total === 0) return null
  return Math.round(((bounced + dropped + spamComplaints) / total) * 1000) / 10
}

export async function getSendgridPosture(svc: any): Promise<SendgridPosture> {
  const generatedAt = new Date().toISOString()
  const windowDays = 30
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const sinceUnix = Math.floor((Date.now() - windowDays * 86_400_000) / 1000)

  // Our own ledger always reads (no key needed) — honest platform-wide rates.
  const countEvents = async (type: string): Promise<number> => {
    const { count } = await svc.from("email_tracking")
      .select("id", { count: "exact", head: true })
      .eq("event_type", type).gte("event_at", sinceIso)
    return count ?? 0
  }
  const [delivered, bounced, dropped, spamComplaints] = await Promise.all([
    countEvents("delivered"), countEvents("bounce"), countEvents("dropped"), countEvents("spam_complaint"),
  ])
  const ledger = {
    windowDays, delivered, bounced, dropped, spamComplaints,
    problemRatePct: computeProblemRatePct(delivered, bounced, dropped, spamComplaints),
  }

  const key = process.env.SENDGRID_API_KEY
  if (!key) {
    return {
      generatedAt, configured: false,
      detail: "SENDGRID_API_KEY unset — domain auth and suppression sync unverifiable; ledger counts below are from our own email_tracking and remain honest.",
      domains: [], suppressions: null, ledger,
    }
  }
  const auth = { style: "bearer" as const, token: key }

  const [domainsRes, bouncesRes, spamRes] = await Promise.all([
    callConnector<Array<{ domain?: string; valid?: boolean }>>({
      connector: "sendgrid", baseUrl: SENDGRID_API, path: "/v3/whitelabel/domains", method: "GET", auth, timeoutMs: 8000,
    }),
    callConnector<Array<{ email?: string }>>({
      connector: "sendgrid", baseUrl: SENDGRID_API, path: "/v3/suppression/bounces", method: "GET",
      query: { start_time: String(sinceUnix), limit: String(SUPPRESSION_FETCH_CAP) }, auth, timeoutMs: 8000,
    }),
    callConnector<Array<{ email?: string }>>({
      connector: "sendgrid", baseUrl: SENDGRID_API, path: "/v3/suppression/spam_reports", method: "GET",
      query: { start_time: String(sinceUnix), limit: String(SUPPRESSION_FETCH_CAP) }, auth, timeoutMs: 8000,
    }),
  ])

  const domains: SendgridDomainPosture[] = domainsRes.ok
    ? (domainsRes.data ?? []).map((x) => ({ domain: x.domain ?? "(unknown)", valid: x.valid === true }))
    : []

  let suppressions: SendgridPosture["suppressions"] = null
  if (bouncesRes.ok || spamRes.ok) {
    const bounceEmails = (bouncesRes.data ?? []).map((x) => (x.email ?? "").toLowerCase()).filter(Boolean)
    const spamEmails = (spamRes.data ?? []).map((x) => (x.email ?? "").toLowerCase()).filter(Boolean)

    // Sync check: which spam-reported addresses is OUR cross-tenant DNC missing?
    let unsyncedSpamReports = 0
    if (spamEmails.length > 0) {
      const { data: onList } = await svc.from("platform_suppression_list")
        .select("email").in("email", spamEmails.slice(0, SUPPRESSION_FETCH_CAP))
      const have = new Set(((onList ?? []) as any[]).map((r) => (r.email ?? "").toLowerCase()))
      unsyncedSpamReports = spamEmails.filter((e) => !have.has(e)).length
    }
    suppressions = {
      windowDays,
      bounces: bounceEmails.length,
      spamReports: spamEmails.length,
      capped: bounceEmails.length >= SUPPRESSION_FETCH_CAP || spamEmails.length >= SUPPRESSION_FETCH_CAP,
      unsyncedSpamReports,
    }
  }

  const validCount = domains.filter((d) => d.valid).length
  const detailParts = [
    domainsRes.ok
      ? `${validCount}/${domains.length} sending domain(s) authenticated`
      : `Domain list failed (${domainsRes.status ?? "—"})`,
    suppressions
      ? `${suppressions.bounces} bounce(s) + ${suppressions.spamReports} spam report(s) on SendGrid in ${windowDays}d${suppressions.capped ? " (capped fetch — floors)" : ""}`
      : "Suppression lists unreadable",
  ]
  return { generatedAt, configured: true, detail: detailParts.join(" · "), domains, suppressions, ledger }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE FULL PLATFORM PROVIDER REGISTRY (owner correction to round 24) — the
// posture board covered a hand-picked trio (Twilio fleet + SendGrid); the
// platform actually manages an entire connector economy. The registry below is
// DERIVED, never hand-typed: it is the UNION of the code's own provider
// vocabularies, so a provider added to any of those sources appears here
// automatically —
//   • CONNECTOR_REGISTRY        (lib/agentic-os/connector-registry — gateway
//                                connector specs: category, envKey)
//   • PROVIDER_TENANCY          (lib/providers/tenancy-matrix — ownership
//                                models + env vars; the "scrapers" fleet entry
//                                expands into its per-lane env vars)
//   • PLATFORM_VENDORS /
//     USER_CONNECTED_VENDORS    (lib/agentic-os/vendor-ownership — scope)
//   • PLATFORM_PROVIDER_KEYS +
//     PROBE_SPECS               (lib/agentic-os/connector-probe — the
//                                Integration Guardian's probe surface)
//   • VENDOR_PRICING            (lib/vendor-governance/cost-normalizer — every
//                                vendor the cost engine knows a rate for)
//   • CONNECTED_CAPABILITY_REGISTRY (lib/agentic-os/connected-vendor-registry —
//                                every provider a tenant capability routes to)
//   • geoapify-client           (env-gated module with no registry row — bound
//                                by importing its own configured() check)
//   • osint-client              (module-bound: the OSINT court/public-records
//                                lane — rides the ZenRows scraper key)
//   • osint-neighborhood        (module-bound: the KEYLESS OSINT-free lane —
//                                Nominatim + Overpass + US Census, no key)
//   • lib/ai gateway client     (module-bound: the VERCEL AI GATEWAY every
//                                LLM/image call routes through)
// Only NORMALIZATION is local: alias folding (d_id/did, twilio_voice/twilio,
// openai_gpt4/openai…) and mapping each source's category vocabulary onto one
// posture vocabulary. Removing a provider from every source removes it here —
// and owner-DECOMMISSIONED vendors (DECOMMISSIONED_PROVIDERS below) are
// excluded even while historical sources still speak their names.

export type ProviderCategory =
  | "voice_sms" | "email" | "mail" | "enrichment" | "scraper" | "ai_media"
  | "ai_llm" | "search" | "payments" | "accounting" | "esign" | "leadgen"
  | "social" | "showing" | "crm" | "calendar" | "listings" | "records"
  | "infra" | "other"

export type ProviderScope = "platform" | "tenant_byo" | "both"

export interface PlatformProviderEntry {
  /** Canonical provider key (alias-folded). */
  provider: string
  label: string
  category: ProviderCategory
  /** Who holds the key: the platform (env), the tenant (credential stores), or both. */
  scope: ProviderScope
  /** Platform env var(s) that can carry the key — [] means credential-stores only. */
  envVars: string[]
  /** Every name this provider may be stored under across the three credential stores. */
  storageAliases: string[]
  /** Which code sources contributed the entry — the registry's provenance. */
  sources: string[]
  /** True when the lane needs no credential BY DESIGN (free API / own infra). */
  keyless: boolean
}

/** Alias folding ON TOP of connection-manager's canonicalProvider — the extra
 *  spellings the pricing table / connector registry / ownership sets use. */
const POSTURE_CANON: Record<string, string> = {
  d_id: "did",
  twilio_voice: "twilio",
  twilio_sms: "twilio",
  twilio_byo: "twilio",
  twilio_subaccount: "twilio",
  anthropic_claude: "anthropic",
  openai_gpt4: "openai",
  openai_gpt35: "openai",
  peoplesdata: "peopledata",
  apify_social: "apify",
  facebook: "meta",
  instagram: "meta",
  // The AI-gateway clients (lib/ai/gateway-chat, lib/ai/image-generation) log
  // their connector calls under "vercel-ai-gateway" — fold onto the tenancy
  // matrix's ai_gateway key so ALL gateway traffic attributes to ONE row.
  "vercel-ai-gateway": "ai_gateway",
  vercel_ai_gateway: "ai_gateway",
  // The keyless OSINT-free lane (lib/external/osint-neighborhood + nominatim-
  // geocode + census-appreciation) calls the gateway as three connectors —
  // fold them onto its single posture row.
  nominatim: "osint_free",
  overpass: "osint_free",
  census: "osint_free",
}

/** DECOMMISSIONED (owner decision) — excluded from the derived registry even
 *  though historical sources still speak their names:
 *  • vapi — the third-party voice-AI vendor was RETIRED; the Twilio-native
 *    turn engine replaced it (VoiceUrl → our webhook → AI gateway → TwiML).
 *    Legacy code stays reachable only behind VOICE_ENGINE=vapi for the
 *    migration window and table names (vapi_phone_numbers) persist, but Vapi
 *    is not a managed provider — nothing new binds to it.
 *  • heygen — owner: "no HeyGen". The avatar/explainer engine is D-ID-locked
 *    (resolveVideoProvider forces 'did'; the direct api.heygen.com calls were
 *    removed and the l38/l39 purge scripts dropped its columns). Only manual
 *    dev shell scripts and historical VENDOR_PRICING rates (kept so old
 *    ledger rows still price — never delete rates) mention it.
 *  Exclusion also drops their aliases from posture attribution, so a stale
 *  ledger row can never resurrect a decommissioned provider's row. */
export const DECOMMISSIONED_PROVIDERS = new Set<string>(["vapi", "heygen"])

/** Env vars a source lists ALONGSIDE a provider that are not the vendor
 *  credential itself (callback/tool secrets) — excluded from envVars so the
 *  board's "configured" means the vendor KEY is present. (The tenancy matrix
 *  lists AGENT_ASSISTANT_TOOL_SECRET with ElevenLabs, but that secret guards
 *  OUR assistant-tool webhook, not the ElevenLabs account.) */
const NON_CREDENTIAL_ENV = new Set<string>(["AGENT_ASSISTANT_TOOL_SECRET"])

/** Lanes that need no credential BY DESIGN — free public APIs or our own
 *  infrastructure. Rendering them "not configured / no connections" would be a
 *  false alarm; the posture board badges them keyless instead. */
const KEYLESS_PROVIDERS = new Set<string>(["osint_free", "browser_tts", "remotion", "cma_aggregate"])

function canonPostureKey(name: string): string {
  const lc = (name ?? "").trim().toLowerCase()
  return POSTURE_CANON[lc] ?? canonicalProvider(lc)
}

/** Category overrides where a source vocabulary lacks fidelity (documented per
 *  key). The provider LIST is never hand-typed — only its shelf label is. */
const CATEGORY_OVERRIDES: Record<string, ProviderCategory> = {
  meta: "leadgen",            // the platform-side Meta rail is lead-ads ingestion (meta_lead_orphan flow)
  batchdata: "enrichment",    // owner vocabulary: enrichment, not scraper
  rentcast: "enrichment",
  geoapify: "enrichment",
  cma_aggregate: "enrichment",
  openai: "ai_llm", ai_gateway: "ai_llm", perplexity: "ai_llm",
  heygen: "ai_media", remotion: "ai_media", pexels: "ai_media", browser_tts: "ai_media",
  vapi: "voice_sms",
  stripe: "payments", plaid: "payments",
  quickbooks: "accounting",
  lob: "mail",
  socrata: "records", osint: "records", osint_free: "records",
  newsapi_ai: "search", exa: "search", tavily: "search",
  podcast_syndicator: "social",
  web_push: "infra", supabase_storage: "infra",
  zyte: "scraper",
}

/** Capability → category, checked in order (email before calendar so Outlook
 *  reads as email; its calendar role still shows via the capability registry). */
const CAPABILITY_CATEGORY: Array<[ConnectedCapability, ProviderCategory]> = [
  ["sms_send", "voice_sms"], ["phone_call_place", "voice_sms"],
  ["email_send", "email"],
  ["esign_send", "esign"], ["transaction_forms_open", "esign"],
  ["showing_schedule", "showing"],
  ["calendar_event_book", "calendar"], ["calendar_availability_get", "calendar"],
  ["crm_contact_sync", "crm"],
  ["idx_listing_search", "listings"],
  ["social_account_publish", "social"], ["podcast_syndicate", "social"],
]

const CATEGORY_ORDER: ProviderCategory[] = [
  "voice_sms", "email", "mail", "enrichment", "scraper", "ai_media", "ai_llm",
  "search", "payments", "accounting", "esign", "leadgen", "social", "showing",
  "crm", "calendar", "listings", "records", "infra", "other",
]

interface RegistryAccumulator {
  envVars: Set<string>
  aliases: Set<string>
  sources: Set<string>
  platformHint: boolean
  tenantHint: boolean
  label: string | null
  connectorCategory: string | null
  connectorTags: string[]
  capabilities: Set<ConnectedCapability>
}

function resolveCategory(canon: string, acc: RegistryAccumulator): ProviderCategory {
  const override = CATEGORY_OVERRIDES[canon]
  if (override) return override
  for (const [cap, cat] of CAPABILITY_CATEGORY) {
    if (acc.capabilities.has(cap)) return cat
  }
  switch (acc.connectorCategory) {
    case "letters": return "mail"
    case "enrichment": return "enrichment"
    case "mls": return "enrichment"
    case "scraper": return "scraper"
    case "osint": return "records"
    case "comms": return "voice_sms"
    case "ai": {
      const tags = acc.connectorTags
      if (tags.some((t) => /tts|voice|video|avatar|lip-sync/.test(t))) return "ai_media"
      if (tags.some((t) => /llm|claude|gemini/.test(t))) return "ai_llm"
      return "search"
    }
  }
  return "other"
}

function prettyLabel(key: string): string {
  return key.split("_").map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ")
}

/**
 * Derive the COMPLETE provider registry from the code's own sources (see the
 * banner above). Pure — no I/O — so it is cheap to call and unit-testable.
 */
export function getPlatformProviderRegistry(): PlatformProviderEntry[] {
  const acc = new Map<string, RegistryAccumulator>()
  const get = (name: string, source: string): RegistryAccumulator => {
    const canon = canonPostureKey(name)
    let a = acc.get(canon)
    if (!a) {
      a = {
        envVars: new Set(), aliases: new Set([canon]), sources: new Set(),
        platformHint: false, tenantHint: false, label: null,
        connectorCategory: null, connectorTags: [], capabilities: new Set(),
      }
      acc.set(canon, a)
    }
    a.aliases.add((name ?? "").trim().toLowerCase())
    a.sources.add(source)
    return a
  }

  // env var → provider, so multi-lane entries (the scraper fleet) attribute
  // each env var to its lane instead of one blurred row.
  const envToProvider = new Map<string, string>()
  for (const spec of Object.values(CONNECTOR_REGISTRY)) {
    if (spec.envKey) envToProvider.set(spec.envKey, canonPostureKey(spec.connector))
  }
  for (const [provider, envKey] of Object.entries(PLATFORM_PROVIDER_KEYS)) {
    if (!envToProvider.has(envKey)) envToProvider.set(envKey, canonPostureKey(provider))
  }

  // 1. Gateway connector registry — category, tags, env key.
  for (const spec of Object.values(CONNECTOR_REGISTRY)) {
    const a = get(spec.connector, "connector-registry")
    if (spec.envKey) { a.envVars.add(spec.envKey); a.platformHint = true }
    a.connectorCategory = a.connectorCategory ?? spec.category
    a.connectorTags = a.connectorTags.length ? a.connectorTags : (spec.tags ?? [])
  }

  // 2. Tenancy matrix — ownership models + env vars. The "scrapers" fleet
  // entry expands per env var (APIFY→apify, ZENROWS→zenrows, ZYTE→zyte…).
  for (const t of PROVIDER_TENANCY) {
    const targets: Array<{ name: string; envVars: string[] }> = t.provider === "scrapers"
      ? t.envVars.map((ev) => ({
          name: envToProvider.get(ev) ?? ev.replace(/_(API_)?(KEY|TOKEN|SECRET)$/i, "").toLowerCase(),
          envVars: [ev],
        }))
      : [{ name: t.provider, envVars: t.envVars }]
    for (const target of targets) {
      const a = get(target.name, t.provider === "scrapers" ? "tenancy-matrix (scraper fleet)" : "tenancy-matrix")
      for (const ev of target.envVars) a.envVars.add(ev)
      if (t.models.some((m) => m === "platform_metered" || m === "platform_subaccount" || m === "tenant_optional_key")) a.platformHint = true
      if (t.models.some((m) => m === "user_oauth" || m === "byo_top_tier" || m === "tenant_optional_key")) a.tenantHint = true
    }
  }

  // 3. Ownership sets — the budget-gate vs connection-gate axis.
  for (const v of PLATFORM_VENDORS) { const a = get(v, "vendor-ownership (platform)"); a.platformHint = true }
  for (const v of USER_CONNECTED_VENDORS) { const a = get(v, "vendor-ownership (user-connected)"); a.tenantHint = true }

  // 4. Integration Guardian probe surface — platform-keyed probes + specs.
  for (const [provider, envKey] of Object.entries(PLATFORM_PROVIDER_KEYS)) {
    const a = get(provider, "connector-probe (platform keys)")
    a.envVars.add(envKey); a.platformHint = true
  }
  for (const provider of Object.keys(PROBE_SPECS)) get(provider, "connector-probe (probe specs)")

  // 5. Cost normalizer — every vendor the cost engine knows a rate for.
  for (const [key, pricing] of Object.entries(VENDOR_PRICING)) {
    const a = get(key, "cost-normalizer")
    if (!a.label) a.label = pricing.vendorName.replace(/ (GPT-4|GPT-3\.5|Claude|Voice)$/, "")
  }

  // 6. Connected-capability registry — every provider a tenant capability routes to.
  for (const def of Object.values(CONNECTED_CAPABILITY_REGISTRY)) {
    for (const p of def.connections) {
      const a = get(p, "connected-capability-registry")
      a.tenantHint = true
      a.capabilities.add(def.capability)
    }
  }

  // 7. Env-gated / keyless client modules with no registry row — each bound via
  // one of its own exports so the module can't silently drift away from its row.
  void geoapifyConfigured // binding: lib/external/geoapify-client
  { const a = get("geoapify", "geoapify-client (env-gated module)"); a.envVars.add("GEOAPIFY_API_KEY"); a.platformHint = true }

  // OSINT records lane — lib/osint-client scrapes court/public records by
  // territory (divorce/probate/foreclosure… → motivated-seller signals). It
  // holds no key of its own: every fetch rides the ZenRows scraper credential,
  // so that key IS its configured-state.
  void OSINTClient // binding: lib/osint-client
  {
    const a = get("osint", "osint-client (module — rides the ZenRows key)")
    a.envVars.add("ZENROWS_API_KEY")
    a.platformHint = true
  }

  // OSINT-FREE lane (owner correction: was missing) — lib/external/
  // osint-neighborhood (+ nominatim-geocode, census-appreciation): Nominatim
  // geocoding, Overpass amenities, US Census ACS — all keyless free tiers.
  // Its gateway calls log under service keys nominatim/overpass/census, which
  // POSTURE_CANON folds here so the lane's traffic attributes to this row.
  void fetchOSINTNeighborhoodData // binding: lib/external/osint-neighborhood
  {
    const a = get("osint_free", "osint-neighborhood (keyless module)")
    a.label = "OSINT Free (OSM + Census)"
    a.aliases.add("nominatim"); a.aliases.add("overpass"); a.aliases.add("census")
    a.platformHint = true
  }

  // VERCEL AI GATEWAY (owner correction: was missing as a first-class row) —
  // where all AI moves through. Every LLM/image call routes to
  // https://ai-gateway.vercel.sh, on two client paths: the Vercel AI SDK via
  // createGateway (lib/ai/generate.ts, lib/ai/models.ts, resolve-model.ts)
  // and the raw connector "vercel-ai-gateway" (lib/ai/gateway-chat.ts,
  // lib/ai/image-generation.ts). AI_GATEWAY_API_KEY is the one model key;
  // the tenancy matrix's ANTHROPIC/OPENAI entries are direct-key fallbacks
  // (managed-agents egress is the sole deliberate direct-Anthropic path).
  void gatewayChat // binding: lib/ai/gateway-chat
  {
    const a = get("ai_gateway", "ai-gateway client (lib/ai)")
    a.label = "Vercel AI Gateway"
    a.envVars.add("AI_GATEWAY_API_KEY")
    a.aliases.add("vercel-ai-gateway")
    a.platformHint = true
  }

  const entries: PlatformProviderEntry[] = [...acc.entries()]
    // Owner decommissions beat historical vocabulary — vapi/heygen never render.
    .filter(([provider]) => !DECOMMISSIONED_PROVIDERS.has(provider))
    .map(([provider, a]) => ({
      provider,
      label: a.label ?? prettyLabel(provider),
      category: resolveCategory(provider, a),
      // Unknown-scope providers read as platform — conservative, mirroring
      // vendorOwnership()'s default (anything the platform might pay for).
      scope: (a.platformHint && a.tenantHint ? "both" : a.tenantHint ? "tenant_byo" : "platform") as ProviderScope,
      envVars: [...a.envVars].filter((v) => !NON_CREDENTIAL_ENV.has(v)).sort(),
      storageAliases: [...a.aliases].sort(),
      sources: [...a.sources].sort(),
      keyless: KEYLESS_PROVIDERS.has(provider),
    }))
  return entries.sort((x, y) =>
    CATEGORY_ORDER.indexOf(x.category) - CATEGORY_ORDER.indexOf(y.category) || x.provider.localeCompare(y.provider))
}

// ── Full-registry posture (DB + env only — no vendor calls; the deep-dive
//    Twilio/SendGrid sweeps above remain the vendor-calling drill-downs) ──────

// ─── IS THIS PROVIDER'S PLATFORM KEY PRESENT? — one implementation ───────────
//
// "Configured at the platform level" was answered by reading process.env inline
// at each call site (getBrokerageProviderReadiness below, the connector-health
// cron). Each site knew a DIFFERENT set of env vars for the same provider, so
// the answers could disagree: the capability resolver looked only at
// platform_credentials ROWS and reported Lob dark while LOB_API_KEY was set and
// dispatchDirectMail was sending happily.
//
// The canonical registry already knows every env var that can carry a
// provider's key (CONNECTOR_REGISTRY.envKey + the tenancy matrix +
// PLATFORM_PROVIDER_KEYS). So the answer is derived from it, once, here.
//
// The registry MAP is memoized (it is pure and deterministic); the ENV read
// never is — a key added at deploy time must be seen on the next call.
let ENV_VARS_BY_PROVIDER: Map<string, string[]> | null = null

function envVarsByProvider(): Map<string, string[]> {
  if (!ENV_VARS_BY_PROVIDER) {
    const m = new Map<string, string[]>()
    for (const e of getPlatformProviderRegistry()) {
      m.set(e.provider, e.envVars)
      // Storage aliases resolve too, so a caller holding 'd_id' or
      // 'twilio_voice' gets the same answer as one holding the canonical key.
      for (const al of e.storageAliases) if (!m.has(al)) m.set(al, e.envVars)
    }
    ENV_VARS_BY_PROVIDER = m
  }
  return ENV_VARS_BY_PROVIDER
}

/** The ONE env-presence expression. null = no env home, so "no platform lane
 *  exists" stays distinguishable from "the platform lane is dark". */
export function envPresence(vars: readonly string[]): boolean | null {
  if (vars.length === 0) return null
  return vars.some((v) => !!process.env[v])
}

/** Every platform env var that can carry this provider's key. [] = the provider
 *  has no env home at all (credential-stores only, or keyless). */
export function platformEnvVarsFor(provider: string): string[] {
  const key = canonPostureKey(provider)
  return envVarsByProvider().get(key) ?? envVarsByProvider().get((provider ?? "").trim().toLowerCase()) ?? []
}

/**
 * Is this provider configured AT THE PLATFORM LEVEL?
 *
 * Returns null — not false — when the provider has no env home: "no platform
 * lane exists" is a different fact from "the platform lane is dark", and
 * resolveBrokerageReadinessState below branches on exactly that distinction.
 */
export function platformEnvConfigured(provider: string): boolean | null {
  return envPresence(platformEnvVarsFor(provider))
}

export const POSTURE_WINDOW_DAYS = 14
/** A provider with ≥ this many unhealed failures (failed/escalated) in the window needs attention. */
export const UNHEALED_ATTENTION_THRESHOLD = 3
const LEDGER_FETCH_CAP = 8000
const HEAL_FETCH_CAP = 8000
const QUARANTINE_FETCH_CAP = 2000
const CRED_FETCH_CAP = 5000

export interface ProviderPostureRow {
  provider: string
  label: string
  category: ProviderCategory
  scope: ProviderScope
  envVars: string[]
  sources: string[]
  /** Platform env key present? null when the provider has no env home (credential-stores only). */
  platformEnvConfigured: boolean | null
  /** Active tenant credential rows across the three stores (all aliases). */
  tenantConnections: number
  /** Connector-ledger signal (api_response_logs — the gateway's own telemetry). */
  calls14d: number
  errors14d: number
  lastSuccessAt: string | null
  lastErrorAt: string | null
  /** Self-heal ledger activity attributed to this provider (14d). */
  selfHeal: { healed: number; failed: number; escalated: number; topFailure: string | null }
  /** Pull-drift sentinel state: pending schema_drift_quarantine dead letters. */
  drift: { pendingQuarantines: number; lastAt: string | null }
  needsAttention: boolean
  attentionReason: string | null
  /** Honest no-data label — "no traffic recorded (14d)" — never fake health. */
  activityNote: string | null
}

export interface FullProviderPosture {
  generatedAt: string
  windowDays: number
  providerCount: number
  needsAttentionCount: number
  /** True when any bounded fetch hit its cap — counts are floors, honestly labeled. */
  capped: boolean
  detail: string
  rows: ProviderPostureRow[]
}

/** PURE: fold a provider's failed/escalated heal rows into one plain-language
 *  cause line, riding composeSentinelLossReport's grouping + pg-code hints
 *  (reused, not forked — same vocabulary the sentinel loss report speaks). */
export function topFailureCause(
  rows: Array<{ brokerage_id?: string | null; detail?: unknown }>,
): string | null {
  if (rows.length === 0) return null
  // Normalize: provider-probe / drift-escalation events carry their explanation
  // in detail.reason or detail.status — surface it where the report reads message.
  const normalized = rows.map((r) => {
    const d = (r.detail ?? {}) as Record<string, unknown>
    return { brokerage_id: r.brokerage_id ?? null, detail: { ...d, message: d.message ?? d.reason ?? d.status ?? undefined } }
  })
  const report = composeSentinelLossReport(normalized)
  const g = report.groups[0]
  if (!g) return null
  const cause = g.code ? g.hint : (g.sampleMessage || g.hint)
  const where = g.flow !== "unknown" ? `${g.flow}: ` : ""
  return `${where}${cause} (${g.count}×)`.slice(0, 200)
}

/**
 * The full-registry sweep. Five bounded DB reads (three credential stores, the
 * connector ledger, the self-heal ledger) + one dead-letter read + env checks —
 * zero vendor calls, so it is safe on demand. Every signal is our own recorded
 * truth; a provider with no recorded traffic says so instead of claiming health.
 */
export async function getFullProviderPosture(svc: any): Promise<FullProviderPosture> {
  const generatedAt = new Date().toISOString()
  const sinceIso = new Date(Date.now() - POSTURE_WINDOW_DAYS * 86_400_000).toISOString()
  const registry = getPlatformProviderRegistry()

  // alias → canonical, for attributing credential rows / ledger rows / heal events.
  const aliasToCanon = new Map<string, string>()
  for (const e of registry) {
    aliasToCanon.set(e.provider, e.provider)
    for (const al of e.storageAliases) aliasToCanon.set(al, e.provider)
  }
  const canonOf = (name: string | null | undefined): string | null => {
    const lc = (name ?? "").trim().toLowerCase()
    if (!lc) return null
    return aliasToCanon.get(lc) ?? aliasToCanon.get(canonPostureKey(lc)) ?? null
  }

  const [platCreds, intCreds, agentCreds, ledgerRows, healRows, quarantineRows] = await Promise.all([
    svc.from("platform_credentials").select("platform").eq("is_active", true).limit(CRED_FETCH_CAP),
    svc.from("integration_credentials").select("provider_name").eq("is_active", true).limit(CRED_FETCH_CAP),
    svc.from("agent_api_credentials").select("service_name").eq("is_active", true).limit(CRED_FETCH_CAP),
    svc.from("api_response_logs").select("service_key, recorded_at, is_error")
      .gte("recorded_at", sinceIso).order("recorded_at", { ascending: false }).limit(LEDGER_FETCH_CAP),
    svc.from("self_heal_events").select("brokerage_id, subject, action, outcome, detail, created_at")
      .gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(HEAL_FETCH_CAP),
    svc.from("ingress_dead_letters").select("provider, status, created_at")
      .eq("event_kind", "schema_drift_quarantine").order("created_at", { ascending: false }).limit(QUARANTINE_FETCH_CAP),
  ])

  // Tenant credential presence per canonical provider.
  const connectionCounts = new Map<string, number>()
  const bump = (name: string | null | undefined) => {
    const canon = canonOf(name)
    if (canon) connectionCounts.set(canon, (connectionCounts.get(canon) ?? 0) + 1)
  }
  for (const r of ((platCreds.data ?? []) as any[])) bump(r.platform)
  for (const r of ((intCreds.data ?? []) as any[])) bump(r.provider_name)
  for (const r of ((agentCreds.data ?? []) as any[])) bump(r.service_name)

  // Connector ledger — the gateway's own per-call telemetry.
  const ledger = new Map<string, { calls: number; errors: number; lastSuccessAt: string | null; lastErrorAt: string | null }>()
  const ledgerData = (ledgerRows.data ?? []) as Array<{ service_key: string; recorded_at: string; is_error: boolean }>
  for (const r of ledgerData) {
    const canon = canonOf(r.service_key)
    if (!canon) continue
    const l = ledger.get(canon) ?? { calls: 0, errors: 0, lastSuccessAt: null, lastErrorAt: null }
    l.calls++
    if (r.is_error) { l.errors++; if (!l.lastErrorAt) l.lastErrorAt = r.recorded_at }
    else if (!l.lastSuccessAt) l.lastSuccessAt = r.recorded_at // rows arrive newest-first
    ledger.set(canon, l)
  }

  // Self-heal attribution — STRUCTURED matches only (subject prefixes the
  // connector-health cron / drift quarantine write, or detail.connector /
  // detail.provider). Unattributable flow events are never guessed at.
  type HealRow = { brokerage_id?: string | null; subject?: string; outcome?: string; detail?: any }
  const healByProvider = new Map<string, { healed: number; failed: number; escalated: number; failures: HealRow[] }>()
  const attributeHeal = (r: HealRow): string | null => {
    const subject = String(r.subject ?? "")
    const m = subject.match(/^platform_provider:([^:]+)/) ?? subject.match(/^sdq:([^:]+):/)
    if (m) return canonOf(m[1])
    const d = (r.detail ?? {}) as { connector?: string; provider?: string }
    return canonOf(d.connector) ?? canonOf(d.provider)
  }
  for (const r of ((healRows.data ?? []) as HealRow[])) {
    const canon = attributeHeal(r)
    if (!canon) continue
    const h = healByProvider.get(canon) ?? { healed: 0, failed: 0, escalated: 0, failures: [] }
    if (r.outcome === "healed") h.healed++
    else if (r.outcome === "failed") { h.failed++; h.failures.push(r) }
    else if (r.outcome === "escalated") { h.escalated++; h.failures.push(r) }
    healByProvider.set(canon, h)
  }

  // Pull-drift sentinel state (pending schema-drift quarantines per connector).
  const driftByProvider = new Map<string, { pending: number; lastAt: string | null }>()
  for (const r of ((quarantineRows.data ?? []) as Array<{ provider: string; status: string; created_at: string }>)) {
    const canon = canonOf(r.provider)
    if (!canon) continue
    const d = driftByProvider.get(canon) ?? { pending: 0, lastAt: null }
    if (r.status === "pending") d.pending++
    if (!d.lastAt) d.lastAt = r.created_at // newest-first
    driftByProvider.set(canon, d)
  }

  const capped =
    ledgerData.length >= LEDGER_FETCH_CAP ||
    ((healRows.data ?? []) as any[]).length >= HEAL_FETCH_CAP ||
    ((quarantineRows.data ?? []) as any[]).length >= QUARANTINE_FETCH_CAP

  let needsAttentionCount = 0
  const rows: ProviderPostureRow[] = registry.map((e) => {
    const envConfigured = envPresence(e.envVars)
    const l = ledger.get(e.provider) ?? { calls: 0, errors: 0, lastSuccessAt: null, lastErrorAt: null }
    const h = healByProvider.get(e.provider) ?? { healed: 0, failed: 0, escalated: 0, failures: [] }
    const d = driftByProvider.get(e.provider) ?? { pending: 0, lastAt: null }

    const unhealed = h.failed + h.escalated
    const topFailure = topFailureCause(h.failures)
    const reasons: string[] = []
    if (unhealed >= UNHEALED_ATTENTION_THRESHOLD) {
      reasons.push(`${unhealed} unhealed failure(s) in ${POSTURE_WINDOW_DAYS}d${topFailure ? ` — ${topFailure}` : ""}`)
    }
    if (d.pending > 0) {
      reasons.push(`${d.pending} pending shape-drift quarantine(s) — the provider changed shape and the contract needs teaching`)
    }
    const noTraffic = l.calls === 0 && h.healed + unhealed === 0 && d.pending === 0
    if (reasons.length > 0) needsAttentionCount++

    return {
      provider: e.provider, label: e.label, category: e.category, scope: e.scope,
      envVars: e.envVars, sources: e.sources,
      platformEnvConfigured: envConfigured,
      tenantConnections: connectionCounts.get(e.provider) ?? 0,
      calls14d: l.calls, errors14d: l.errors,
      lastSuccessAt: l.lastSuccessAt, lastErrorAt: l.lastErrorAt,
      selfHeal: { healed: h.healed, failed: h.failed, escalated: h.escalated, topFailure },
      drift: { pendingQuarantines: d.pending, lastAt: d.lastAt },
      needsAttention: reasons.length > 0,
      attentionReason: reasons.length > 0 ? reasons.join(" · ") : null,
      activityNote: noTraffic ? `no traffic recorded (${POSTURE_WINDOW_DAYS}d)` : null,
    }
  })

  // Category-grouped; attention first (then busiest) within each category.
  rows.sort((a, b) =>
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
    Number(b.needsAttention) - Number(a.needsAttention) ||
    b.calls14d - a.calls14d ||
    a.provider.localeCompare(b.provider))

  return {
    generatedAt,
    windowDays: POSTURE_WINDOW_DAYS,
    providerCount: rows.length,
    needsAttentionCount,
    capped,
    detail:
      `${rows.length} providers derived from ${new Set(registry.flatMap((e) => e.sources)).size} code sources · ` +
      `signals: env/credential presence, connector ledger (api_response_logs), self-heal ledger (self_heal_events), ` +
      `pull-drift quarantines — DB + env only, zero vendor calls${capped ? " · a fetch hit its cap; counts are floors" : ""}.`,
    rows,
  }
}

// ── Brokerage-scoped readiness (the tenant "what can I actually use?" view) ────
//
// The onboarding readiness panel previously read brokerage_integrations RAW and
// marked anything not status='connected' as "Pending". That is BLIND to two
// whole classes of live capability: keyless free lanes, and platform-PROVIDED
// providers (a platform env key the tenant never has to configure). A solo
// admin who relies entirely on the platform's keys had ZERO integration rows —
// so the panel showed 0% "nothing ready" while their whole capability set was
// live. This derives readiness from the SAME canonical registry the fleet
// posture uses, scoped to one brokerage, so the two surfaces cannot drift.

export type BrokerageReadinessState =
  | "live_connected"   // this brokerage's own active credentials
  | "live_platform"    // provided by the platform (env key present), zero tenant setup
  | "keyless"          // free lane, always on, no key at all
  | "needs_connection" // tenant-BYO provider the brokerage has not connected yet
  | "platform_dark"    // platform-scoped but the platform key is absent — staff's job, not the tenant's

export interface BrokerageReadinessInput {
  keyless: boolean
  scope: ProviderScope
  /** Platform env key present for this provider. null when it has no env home. */
  envConfigured: boolean | null
  /** This brokerage has an active credential/connection row for this provider. */
  tenantConnected: boolean
}

/**
 * PURE: the single source of truth for a provider's readiness state FOR A
 * BROKERAGE. Kept pure + exported so the simulator can exhaust every branch
 * without a DB or env. `ready` means "usable by this brokerage right now".
 */
export function resolveBrokerageReadinessState(
  input: BrokerageReadinessInput,
): { state: BrokerageReadinessState; ready: boolean } {
  // A tenant's own connection always wins — it's the strongest, most explicit signal.
  if (input.tenantConnected) return { state: "live_connected", ready: true }
  if (input.keyless) return { state: "keyless", ready: true }
  // Platform-provided: a present platform key means the tenant gets it for free.
  if (input.envConfigured === true && (input.scope === "platform" || input.scope === "both")) {
    return { state: "live_platform", ready: true }
  }
  // BYO lanes the tenant can still turn on themselves.
  if (input.scope === "tenant_byo" || input.scope === "both") {
    return { state: "needs_connection", ready: false }
  }
  // Platform-scoped but the key is absent — nothing the tenant can do; staff owns it.
  return { state: "platform_dark", ready: false }
}

export interface BrokerageProviderReadinessRow {
  provider: string
  label: string
  category: ProviderCategory
  scope: ProviderScope
  state: BrokerageReadinessState
  ready: boolean
  note: string
}

export interface BrokerageProviderReadiness {
  generatedAt: string
  total: number
  /** Capabilities usable by this brokerage right now (connected + platform + keyless). */
  ready: number
  /** BYO lanes the brokerage can enable themselves. */
  needsConnection: number
  /** Platform-scoped rails not yet lit at the platform level (staff's job). */
  platformDark: number
  readinessPct: number
  rows: BrokerageProviderReadinessRow[]
}

const READINESS_NOTE: Record<BrokerageReadinessState, string> = {
  live_connected: "Connected — your own credentials are active.",
  live_platform: "Included — provided by the platform, no setup needed.",
  keyless: "Included — free data lane, always on.",
  needs_connection: "Connect your account to switch this on.",
  platform_dark: "Not yet enabled at the platform level.",
}

/**
 * Brokerage-scoped provider readiness. Derives the full provider list from the
 * canonical registry, checks THIS brokerage's active connections across the
 * three credential stores + brokerage_integrations, and folds in platform env
 * presence — so platform-provided and keyless capabilities read LIVE instead of
 * "Pending". DB + env only, no vendor calls.
 */
export async function getBrokerageProviderReadiness(
  svc: any,
  brokerageId: string,
): Promise<BrokerageProviderReadiness> {
  const generatedAt = new Date().toISOString()
  const registry = getPlatformProviderRegistry()

  const aliasToCanon = new Map<string, string>()
  for (const e of registry) {
    aliasToCanon.set(e.provider, e.provider)
    for (const al of e.storageAliases) aliasToCanon.set(al, e.provider)
  }
  const canonOf = (name: string | null | undefined): string | null => {
    const lc = (name ?? "").trim().toLowerCase()
    if (!lc) return null
    return aliasToCanon.get(lc) ?? aliasToCanon.get(canonPostureKey(lc)) ?? null
  }

  const [intCreds, agentCreds, platCreds, brokIntegrations] = await Promise.all([
    svc.from("integration_credentials").select("provider_name").eq("is_active", true).eq("brokerage_id", brokerageId),
    svc.from("agent_api_credentials").select("service_name").eq("is_active", true).eq("brokerage_id", brokerageId),
    svc.from("platform_credentials").select("platform").eq("is_active", true).eq("brokerage_id", brokerageId),
    svc.from("brokerage_integrations").select("provider_type, provider_name, status").eq("brokerage_id", brokerageId),
  ])

  const connected = new Set<string>()
  const markConnected = (name: string | null | undefined) => {
    const canon = canonOf(name)
    if (canon) connected.add(canon)
  }
  for (const r of ((intCreds.data ?? []) as any[])) markConnected(r.provider_name)
  for (const r of ((agentCreds.data ?? []) as any[])) markConnected(r.service_name)
  for (const r of ((platCreds.data ?? []) as any[])) markConnected(r.platform)
  for (const r of ((brokIntegrations.data ?? []) as any[])) {
    if (r.status === "connected") { markConnected(r.provider_type); markConnected(r.provider_name) }
  }

  const rows: BrokerageProviderReadinessRow[] = registry.map((e) => {
    const envConfigured = envPresence(e.envVars)
    const { state, ready } = resolveBrokerageReadinessState({
      keyless: e.keyless,
      scope: e.scope,
      envConfigured,
      tenantConnected: connected.has(e.provider),
    })
    return { provider: e.provider, label: e.label, category: e.category, scope: e.scope, state, ready, note: READINESS_NOTE[state] }
  })

  // Ready first, then needs-connection (tenant-actionable) ahead of platform-dark, then by category.
  const stateRank: Record<BrokerageReadinessState, number> = {
    live_connected: 0, live_platform: 0, keyless: 0, needs_connection: 1, platform_dark: 2,
  }
  rows.sort((a, b) =>
    stateRank[a.state] - stateRank[b.state] ||
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
    a.provider.localeCompare(b.provider))

  const ready = rows.filter((r) => r.ready).length
  const needsConnection = rows.filter((r) => r.state === "needs_connection").length
  const platformDark = rows.filter((r) => r.state === "platform_dark").length
  return {
    generatedAt,
    total: rows.length,
    ready,
    needsConnection,
    platformDark,
    readinessPct: rows.length > 0 ? Math.round((ready / rows.length) * 100) : 0,
    rows,
  }
}
