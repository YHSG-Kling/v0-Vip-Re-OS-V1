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
