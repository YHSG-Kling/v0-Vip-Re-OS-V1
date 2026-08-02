// lib/voice/number-provisioning.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE NUMBER-PROVISIONING CORE (keep-one, no fork). Both callers — the
// tenant-context action (app/actions/phone-provisioning.ts, broker clicks
// "Add Number") and the staff-context action (app/actions/superadmin/
// number-provisioning.ts, fleet numbers console) — run THIS pipeline:
//
//   search available numbers → purchase → persist vapi_phone_numbers row →
//   phone_number_events audit line → (optionally) bind the number's webhooks
//   to the Twilio-native AI lane (bindNumberToTwilioLane).
//
// Credential resolution stays canonical (lib/voice/twilio-tenancy.ts):
// byo → tenant subaccount → platform master. ensureTenantSubaccount runs
// best-effort first so a tenant's first purchase lands INSIDE its own
// subaccount when master creds exist. Mock-safe: no creds → honest
// notConfigured — a purchase is never faked.

import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { ensureTenantSubaccount, resolveTenantTwilioCreds, type TwilioCreds } from "@/lib/voice/twilio-tenancy"

const NOT_CONFIGURED = "Twilio not configured (missing TWILIO_ACCOUNT_SID / AUTH_TOKEN)"

// ─── The ONE phone_number_events writer ──────────────────────────────────────

export type PhoneNumberEventType = "purchased" | "manually_added" | "ported_in" | "released" | "failed" | "webhooks_bound"

/** Insert one phone_number_events audit line (best-effort — audit never masks
 *  the underlying outcome; callers that need audit-or-fail check the return). */
export async function logPhoneNumberEvent(
  svc: any,
  ev: {
    brokerageId: string
    phoneNumber: string
    eventType: PhoneNumberEventType
    /** Who/what drove this (free text vocabulary: 'staff_provisioned', 'staff_released', 'tenant_action', 'inbound_binding', …). */
    source?: string | null
    agentId?: string | null
    twilioSid?: string | null
    vapiNumberId?: string | null
    costUsd?: number | null
    notes?: string | null
  },
): Promise<void> {
  // Best-effort but sentinel-ledgered — the silencer ratchet forbids
  // swallowing losses; a lost events row shows up in the repair digest.
  const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
  await sentinelWrite(svc, svc.from("phone_number_events").insert({
    brokerage_id: ev.brokerageId,
    agent_id: ev.agentId ?? null,
    phone_number: ev.phoneNumber,
    event_type: ev.eventType,
    source: ev.source ?? null,
    twilio_sid: ev.twilioSid ?? null,
    vapi_number_id: ev.vapiNumberId ?? null,
    cost_usd: ev.costUsd ?? null,
    notes: ev.notes ?? null,
  }), { flow: "number_provisioning", table: "phone_number_events", brokerageId: ev.brokerageId })
}

// ─── Credential resolution (canonical, shared by search + purchase + release) ─

async function resolveCreds(svc: any, brokerageId: string): Promise<TwilioCreds | null> {
  // Best-effort: give the tenant its own subaccount before the first purchase
  // (idempotent; without master creds it honestly no-ops and we fall through).
  try { await ensureTenantSubaccount(svc, brokerageId) } catch { /* falls through to existing creds */ }
  return resolveTenantTwilioCreds(svc, brokerageId)
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface NumberCandidate {
  phoneNumber: string
  friendlyName: string | null
  locality: string | null
  region: string | null
  postalCode: string | null
}

export type SearchNumbersResult =
  | { ok: true; candidates: NumberCandidate[]; credTier: TwilioCreds["tier"] }
  | { ok: false; error: string; notConfigured?: boolean }

/** Search purchasable US local numbers for this tenant (area code / locality). */
export async function searchAvailableNumbers(
  svc: any,
  brokerageId: string,
  opts: { areaCode?: string | null; locality?: string | null; limit?: number } = {},
): Promise<SearchNumbersResult> {
  const creds = await resolveCreds(svc, brokerageId)
  if (!creds) return { ok: false, error: NOT_CONFIGURED, notConfigured: true }

  const query: Record<string, string> = { PageSize: String(Math.min(Math.max(opts.limit ?? 10, 1), 30)) }
  if (opts.areaCode) query.AreaCode = String(opts.areaCode).replace(/\D/g, "").slice(0, 3)
  if (opts.locality) query.InLocality = String(opts.locality).slice(0, 80)

  const res = await callConnector<{ available_phone_numbers?: Array<Record<string, any>> }>({
    connector: "twilio", baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${creds.accountSid}/AvailablePhoneNumbers/US/Local.json`,
    method: "GET", query,
    auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
  })
  if (!res.ok) return { ok: false, error: `Twilio number search failed (${res.status ?? "—"}): ${res.error ?? "unknown"}` }

  const candidates: NumberCandidate[] = (res.data?.available_phone_numbers ?? [])
    .filter((n) => typeof n?.phone_number === "string" && n.phone_number)
    .map((n) => ({
      phoneNumber: n.phone_number as string,
      friendlyName: (n.friendly_name as string) ?? null,
      locality: (n.locality as string) ?? null,
      region: (n.region as string) ?? null,
      postalCode: (n.postal_code as string) ?? null,
    }))
  return { ok: true, candidates, credTier: creds.tier }
}

// ─── Provision (search-or-exact → purchase → persist → event → bind) ─────────

export interface ProvisionNumberParams {
  brokerageId: string
  /** Exact candidate (E.164) picked from a search; omit to buy the first match for areaCode. */
  phoneNumber?: string | null
  areaCode?: string | null
  /** 'agent' rows carry agentUserId; staff-provisioned inventory is 'brokerage'-scoped. */
  scopeType: "agent" | "brokerage"
  agentUserId?: string | null
  /** agents.id — for the phone_number_events FK line (null for brokerage scope). */
  agentId?: string | null
  /** phone_number_events.source — e.g. 'staff_provisioned'. */
  eventSource?: string | null
  eventNotes?: string | null
  /** Point the number's VoiceUrl/SmsUrl/StatusCallback at our AI lane after purchase. */
  bindToVoiceLane?: boolean
  /** TENANT purchases enforce the plan's phone allowance (bundle → metered
   *  overage → hard cap); the staff fleet console leaves this off (staff
   *  provision on a tenant's behalf and see the numbers console directly). */
  enforceTenantAllowance?: boolean
}

export type ProvisionNumberResult =
  | { ok: true; phoneNumber: string; twilioSid: string | null; numberRowId: string | null; credTier: TwilioCreds["tier"]; bound: boolean; bindNote?: string; billing?: "included" | "overage"; monthlyOverageCents?: number }
  | { ok: false; error: string; notConfigured?: boolean; capReached?: boolean }

/** The full purchase pipeline — the ONE implementation both the tenant action
 *  and the staff console run. Failures are honest: a purchase that lands but
 *  fails to save is logged 'failed' with a reconcile note, never swallowed. */
export async function provisionNumber(svc: any, params: ProvisionNumberParams): Promise<ProvisionNumberResult> {
  // 0. Plan-allowance gate (tenant purchases only). The bundle is metered resale:
  //    inside the included count is free, beyond it is billable overage, and the
  //    hard cap is a runaway backstop — the ONLY case that blocks a purchase.
  let billing: "included" | "overage" | undefined
  let monthlyOverageCents = 0
  if (params.enforceTenantAllowance) {
    const { evaluateTenantNumberProvisioning } = await import("@/lib/billing/phone-plan-resolve")
    const verdict = await evaluateTenantNumberProvisioning(svc, params.brokerageId)
    if (!verdict.allowed) {
      return { ok: false, error: verdict.reason ?? "Your plan's active-number limit has been reached", capReached: true }
    }
    billing = verdict.billing
    monthlyOverageCents = verdict.monthlyOverageCents
  }

  const creds = await resolveCreds(svc, params.brokerageId)
  if (!creds) return { ok: false, error: NOT_CONFIGURED, notConfigured: true }

  // 1. Target number: exact candidate, else first search match.
  let targetNumber = params.phoneNumber?.trim() || null
  if (!targetNumber) {
    const search = await searchAvailableNumbers(svc, params.brokerageId, { areaCode: params.areaCode, limit: 1 })
    if (!search.ok) return search
    targetNumber = search.candidates[0]?.phoneNumber ?? null
    if (!targetNumber) {
      return { ok: false, error: `No available numbers found${params.areaCode ? ` in area code ${params.areaCode}` : ""}` }
    }
  }

  // 2. Purchase.
  const purchaseRes = await callConnector<{ sid?: string }>({
    connector: "twilio", baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${creds.accountSid}/IncomingPhoneNumbers.json`, method: "POST",
    auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
    bodyType: "form", body: { PhoneNumber: targetNumber },
  })
  if (!purchaseRes.ok) {
    const body = purchaseRes.error ?? ""
    await logPhoneNumberEvent(svc, {
      brokerageId: params.brokerageId, agentId: params.agentId, phoneNumber: targetNumber,
      eventType: "failed", source: params.eventSource,
      notes: `Twilio purchase failed (${purchaseRes.status ?? "—"}): ${body}`,
    })
    return { ok: false, error: `Twilio purchase failed (${purchaseRes.status ?? "—"}): ${body}` }
  }
  const purchasedSid = purchaseRes.data?.sid ?? null

  // 3. Persist the number row. twilio_number_sid is the Twilio
  //    IncomingPhoneNumbers .sid — the handle bindNumberToTwilioLane needs to
  //    register this number's webhooks, so it is written at purchase time.
  const { data: inserted, error: saveErr } = await svc.from("vapi_phone_numbers").insert({
    agent_user_id: params.scopeType === "agent" ? params.agentUserId ?? null : null,
    brokerage_id: params.brokerageId,
    scope_type: params.scopeType,
    phone_number: targetNumber,
    phone_digits: targetNumber.replace(/\D/g, ""),
    twilio_number_sid: purchasedSid,
    number_source: "byoc_twilio",
    is_active: true,
  }).select("id").maybeSingle()
  if (saveErr) {
    await logPhoneNumberEvent(svc, {
      brokerageId: params.brokerageId, agentId: params.agentId, phoneNumber: targetNumber,
      eventType: "failed", source: params.eventSource, twilioSid: purchasedSid,
      notes: `Number PURCHASED on Twilio but the assignment save failed: ${saveErr.message} -- reconcile manually`,
    })
    return { ok: false, error: `Number purchased but not saved (${saveErr.message}) -- support has been notified via the audit log` }
  }
  const numberRowId = (inserted as any)?.id ?? null

  // 4. The audit line — the billing disposition (bundle vs metered overage) is
  //    stamped so finance can trace which numbers ride the plan and which bill.
  const billingNote = billing
    ? `plan:${billing}${billing === "overage" ? ` (+${(monthlyOverageCents / 100).toFixed(2)}/mo)` : ""}`
    : null
  await logPhoneNumberEvent(svc, {
    brokerageId: params.brokerageId, agentId: params.agentId, phoneNumber: targetNumber,
    eventType: "purchased", source: params.eventSource, twilioSid: purchasedSid,
    costUsd: 1.15, notes: [params.eventNotes, billingNote].filter(Boolean).join(" · ") || null,
  })

  // 5. Optional webhook binding onto the Twilio-native AI lane (best-effort:
  //    a bind failure never undoes a real purchase — it is reported honestly).
  let bound = false
  let bindNote: string | undefined
  if (params.bindToVoiceLane && numberRowId) {
    const { bindNumberToTwilioLane } = await import("@/lib/voice/twilio-voice")
    const bind = await bindNumberToTwilioLane(svc, numberRowId).catch((err: any) => ({ ok: false as const, error: String(err?.message ?? err) }))
    bound = bind.ok
    if (!bind.ok) bindNote = `Purchased + saved, but webhook binding failed: ${bind.error}`
  } else if (params.bindToVoiceLane && !numberRowId) {
    bindNote = "Purchased + saved, but the row id was not returned — bind the number from its row later"
  }

  return { ok: true, phoneNumber: targetNumber, twilioSid: purchasedSid, numberRowId, credTier: creds.tier, bound, bindNote, billing, monthlyOverageCents }
}

// ─── Release (Twilio release → deactivate row → event) ───────────────────────

export type ReleaseNumberResult =
  | { ok: true; phoneNumber: string; twilioReleased: boolean; note?: string }
  | { ok: false; error: string; notConfigured?: boolean }

/** Release a number: delete it from Twilio (when a SID is on file), deactivate
 *  the inventory row, write the 'released' audit line. Honest failure modes:
 *  a live Twilio delete that fails leaves the row ACTIVE (nothing pretended);
 *  a number with no SID on file (manual/BYO add) is a DB-only release, stated. */
export async function releaseNumber(
  svc: any,
  params: { brokerageId: string; numberRowId: string; eventSource?: string | null; notes?: string | null },
): Promise<ReleaseNumberResult> {
  const { data: row } = await svc.from("vapi_phone_numbers")
    .select("id, brokerage_id, phone_number, twilio_number_sid, is_active")
    .eq("id", params.numberRowId).maybeSingle()
  const n = row as any
  if (!n) return { ok: false, error: "Number row not found" }
  if (n.brokerage_id !== params.brokerageId) return { ok: false, error: "Number does not belong to this tenant" }
  if (!n.is_active) return { ok: false, error: "Number is already inactive" }

  let twilioReleased = false
  let note: string | undefined
  if (n.twilio_number_sid) {
    const creds = await resolveCreds(svc, params.brokerageId)
    if (!creds) {
      // A Twilio-owned number cannot be honestly released without creds.
      return { ok: false, error: `${NOT_CONFIGURED} — this number has a Twilio SID on file and cannot be released without credentials. Nothing was changed.`, notConfigured: true }
    }
    const res = await callConnector({
      connector: "twilio", baseUrl: "https://api.twilio.com",
      path: `/2010-04-01/Accounts/${creds.accountSid}/IncomingPhoneNumbers/${n.twilio_number_sid}.json`,
      method: "DELETE",
      auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
    })
    if (res.ok) {
      twilioReleased = true
    } else if (res.status === 404) {
      note = "Number was not found on Twilio (already released there) — inventory row deactivated"
    } else {
      return { ok: false, error: `Twilio release failed (${res.status ?? "—"}): ${res.error ?? "unknown"} — the number stays ACTIVE (nothing was changed)` }
    }
  } else {
    note = "No Twilio SID on file (manually added / ported number) — DB-only release"
  }

  const { error: updErr } = await svc.from("vapi_phone_numbers").update({ is_active: false }).eq("id", n.id)
  if (updErr) {
    await logPhoneNumberEvent(svc, {
      brokerageId: params.brokerageId, phoneNumber: n.phone_number,
      eventType: "failed", source: params.eventSource, twilioSid: n.twilio_number_sid,
      notes: `Number ${twilioReleased ? "RELEASED on Twilio" : "release attempted"} but the row deactivation failed: ${updErr.message} -- reconcile manually`,
    })
    return { ok: false, error: `Number ${twilioReleased ? "released on Twilio" : "release attempted"} but the row deactivation failed (${updErr.message}) -- reconcile manually` }
  }

  await logPhoneNumberEvent(svc, {
    brokerageId: params.brokerageId, phoneNumber: n.phone_number,
    eventType: "released", source: params.eventSource, twilioSid: n.twilio_number_sid,
    notes: [params.notes, note].filter(Boolean).join(" · ") || null,
  })
  return { ok: true, phoneNumber: n.phone_number, twilioReleased, note }
}
