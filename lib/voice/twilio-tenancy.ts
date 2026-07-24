// lib/voice/twilio-tenancy.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PHONE-SYSTEM COMMERCIAL MODEL, decided and enforced in ONE place:
// PLATFORM-OWNED telephony with metered resale — tenants never touch a Twilio
// or Vapi signup (that's the product promise: "AI answers your phone", not
// "go register for A2P 10DLC"). Isolation + billing correctness come from
// TWILIO SUBACCOUNTS: the platform master account creates ONE subaccount per
// brokerage, numbers are purchased INSIDE the tenant's subaccount (their
// numbers, their usage, their compliance registration — one parent). BYO
// Twilio credentials remain a TOP-TIER escape hatch for enterprises with an
// existing carrier contract.
//
// Credential resolution order (resolveTenantTwilioCreds):
//   1. BYO       — the tenant's own creds (platform_credentials 'twilio_byo',
//                  multi_location tier only)
//   2. SUBACCOUNT — the tenant's platform-created subaccount
//                  (platform_credentials 'twilio_subaccount')
//   3. MASTER     — the platform env creds (legacy fallback so nothing breaks
//                  for tenants provisioned before subaccounts existed)
// All Twilio egress stays on the connector gateway; creds-gated honestly.

import { callConnector } from "@/lib/agentic-os/connector-gateway"

export interface TwilioCreds {
  accountSid: string
  authToken: string
  tier: "byo" | "subaccount" | "master"
}

/** PURE: pick the credential tier from what exists. */
export function pickCredTier(has: { byo: boolean; subaccount: boolean; master: boolean }): TwilioCreds["tier"] | null {
  if (has.byo) return "byo"
  if (has.subaccount) return "subaccount"
  if (has.master) return "master"
  return null
}

/** Resolve the Twilio credentials this brokerage's phone operations should use. */
export async function resolveTenantTwilioCreds(svc: any, brokerageId: string): Promise<TwilioCreds | null> {
  const { data: rows } = await svc.from("platform_credentials")
    .select("platform, account_id, access_token")
    .eq("brokerage_id", brokerageId)
    .in("platform", ["twilio_byo", "twilio_subaccount"])
    .eq("is_active", true)
  const byo = ((rows ?? []) as any[]).find((r) => r.platform === "twilio_byo")
  const sub = ((rows ?? []) as any[]).find((r) => r.platform === "twilio_subaccount")
  if (byo?.account_id && byo?.access_token) return { accountSid: byo.account_id, authToken: byo.access_token, tier: "byo" }
  if (sub?.account_id && sub?.access_token) return { accountSid: sub.account_id, authToken: sub.access_token, tier: "subaccount" }
  const masterSid = process.env.TWILIO_ACCOUNT_SID
  const masterToken = process.env.TWILIO_AUTH_TOKEN
  if (masterSid && masterToken) return { accountSid: masterSid, authToken: masterToken, tier: "master" }
  return null
}

/**
 * Ensure this brokerage has its own Twilio SUBACCOUNT (idempotent). Created
 * under the platform master; sid+token stored in platform_credentials. Master
 * creds absent → honest not-configured (nothing faked).
 */
export async function ensureTenantSubaccount(
  svc: any, brokerageId: string,
): Promise<{ ok: true; accountSid: string; created: boolean } | { ok: false; error: string; notConfigured?: boolean }> {
  const { data: existing } = await svc.from("platform_credentials")
    .select("id, account_id").eq("brokerage_id", brokerageId)
    .eq("platform", "twilio_subaccount").eq("is_active", true).maybeSingle()
  if ((existing as any)?.account_id) return { ok: true, accountSid: (existing as any).account_id, created: false }

  const masterSid = process.env.TWILIO_ACCOUNT_SID
  const masterToken = process.env.TWILIO_AUTH_TOKEN
  if (!masterSid || !masterToken) {
    return { ok: false, error: "Twilio master account not configured — subaccounts need TWILIO_ACCOUNT_SID/AUTH_TOKEN. Nothing was changed.", notConfigured: true }
  }

  const { data: brk } = await svc.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
  const friendly = `${((brk as any)?.name ?? "tenant").slice(0, 40)} · ${brokerageId.slice(0, 8)}`

  const res = await callConnector<{ sid?: string; auth_token?: string }>({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: "/2010-04-01/Accounts.json",
    method: "POST",
    bodyType: "form",
    body: { FriendlyName: friendly },
    auth: { style: "basic", username: masterSid, password: masterToken },
  })
  if (!res.ok || !res.data?.sid || !res.data?.auth_token) {
    return { ok: false, error: `Twilio subaccount create failed (${res.status ?? "—"}): ${res.error ?? "unknown"}` }
  }

  const { error } = await svc.from("platform_credentials").insert({
    brokerage_id: brokerageId,
    platform: "twilio_subaccount",
    account_id: res.data.sid,
    access_token: res.data.auth_token,
    owner_type: "brokerage",
    owner_id: brokerageId,
    is_active: true,
  })
  if (error) return { ok: false, error: `Subaccount created but not saved: ${error.message} — reconcile manually (sid ${res.data.sid})` }
  return { ok: true, accountSid: res.data.sid, created: true }
}

// ── VOICE USAGE ROLLUP — the metered-resale visibility layer ─────────────────

export interface VoiceUsage {
  month: string
  callCount: number
  minutes: number
  vapiCostCents: number
  activeNumbers: number
  numberCostCents: number
  totalCostCents: number
}

/** PURE: fold call + number rows into the month's usage line. */
export function rollupVoiceUsage(
  month: string,
  calls: Array<{ minutes_billed: number | null; cost_cents: number | null }>,
  numbers: Array<{ is_active: boolean | null }>,
  numberMonthlyCents = 115, // Twilio local number ≈ $1.15/mo
): VoiceUsage {
  const callCount = calls.length
  const minutes = calls.reduce((a, c) => a + Number(c.minutes_billed ?? 0), 0)
  const vapiCostCents = calls.reduce((a, c) => a + Number(c.cost_cents ?? 0), 0)
  const activeNumbers = numbers.filter((n) => n.is_active).length
  const numberCostCents = activeNumbers * numberMonthlyCents
  return { month, callCount, minutes, vapiCostCents, activeNumbers, numberCostCents, totalCostCents: vapiCostCents + numberCostCents }
}

/** Load one tenant's voice usage for a month (YYYY-MM). */
export async function loadVoiceUsage(svc: any, brokerageId: string, month: string): Promise<VoiceUsage> {
  const start = `${month}-01`
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10)
  const [{ data: calls }, { data: numbers }] = await Promise.all([
    // Canonical billing rail: usage_logs 'voice_call' rows (both the Twilio-native
    // status route and the legacy vapi webhook write here). units_used = minutes.
    svc.from("usage_logs").select("units_used, cost_cents")
      .eq("brokerage_id", brokerageId).eq("usage_type", "voice_call")
      .gte("recorded_at", start).lt("recorded_at", end).limit(5000),
    svc.from("vapi_phone_numbers").select("is_active").eq("brokerage_id", brokerageId),
  ])
  const callRows = ((calls ?? []) as any[]).map((c) => ({ minutes_billed: c.units_used, cost_cents: c.cost_cents }))
  return rollupVoiceUsage(month, callRows, (numbers ?? []) as any[])
}
