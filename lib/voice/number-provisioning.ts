// lib/voice/number-provisioning.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE NUMBER-PROVISIONING CORE (keep-one, no fork). Both callers — the
// tenant-context action (app/actions/phone-provisioning.ts, broker clicks
// "Add Number") and the staff-context action (app/actions/superadmin/
// number-provisioning.ts, fleet numbers console) — run THIS pipeline:
//
//   search available numbers → purchase → persist tenant_phone_numbers row →
//   phone_number_events audit line → (optionally) bind the number's webhooks
//   to the Twilio-native AI lane (bindNumberToTwilioLane).
//
// Credential resolution stays canonical (lib/voice/twilio-tenancy.ts):
// byo → tenant subaccount → platform master. ensureTenantSubaccount runs
// best-effort first so a tenant's first purchase lands INSIDE its own
// subaccount when master creds exist. Mock-safe: no creds → honest
// notConfigured — a purchase is never faked.

import { searchAvailableLocalNumbers, purchaseIncomingPhoneNumber, releaseIncomingPhoneNumber } from "@/lib/providers/twilio/client"
import { ensureTenantSubaccount, resolveTenantTwilioCreds, type TwilioCreds } from "@/lib/voice/twilio-tenancy"
import type { CarrierKickoffResult } from "@/lib/voice/a2p-registration"

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

  // Official Twilio SDK adapter (lib/providers/twilio/client.ts) — same
  // GET /AvailablePhoneNumbers/US/Local.json endpoint, same price.
  const res = await searchAvailableLocalNumbers(creds, {
    areaCode: opts.areaCode ? String(opts.areaCode).replace(/\D/g, "").slice(0, 3) : undefined,
    inLocality: opts.locality ? String(opts.locality).slice(0, 80) : undefined,
    limit: Math.min(Math.max(opts.limit ?? 10, 1), 30),
  })
  if (!res.ok) return { ok: false, error: `Twilio number search failed (${res.status ?? "—"}): ${res.error ?? "unknown"}` }

  const candidates: NumberCandidate[] = (res.data ?? [])
    .filter((n) => typeof n?.phoneNumber === "string" && n.phoneNumber)
    .map((n) => ({
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      locality: n.locality,
      region: n.region,
      postalCode: n.postalCode,
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
  | { ok: true; phoneNumber: string; twilioSid: string | null; numberRowId: string | null; credTier: TwilioCreds["tier"]; bound: boolean; bindNote?: string; billing?: "included" | "overage"; monthlyOverageCents?: number; /** wave 81D: the automatic carrier-registration kickoff outcome (honest; may be "not kicked" with the reason). */ registration?: CarrierKickoffResult }
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

  // 2. Purchase. Official Twilio SDK adapter — same
  //    POST /IncomingPhoneNumbers.json endpoint, same price.
  const purchaseRes = await purchaseIncomingPhoneNumber(creds, targetNumber)
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
  const { data: inserted, error: saveErr } = await svc.from("tenant_phone_numbers").insert({
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

  // 6. AUTOMATIC BUSINESS REGISTRATION (wave 81D — owner: "automatic
  //    registering business after phone number purchase/port over so can use
  //    the phone/test feature"). Best-effort, never undoes the purchase; the
  //    lane (10DLC vs toll-free) follows the number; the outcome is audited on
  //    phone_number_events and reported here so the caller can show it.
  let registration: CarrierKickoffResult | undefined
  try {
    const { kickCarrierRegistration } = await import("@/lib/voice/a2p-registration")
    registration = await kickCarrierRegistration(svc, { brokerageId: params.brokerageId, phoneNumber: targetNumber, trigger: "purchased" })
  } catch (err) {
    console.warn("[number-provisioning] carrier registration kickoff failed (the number is purchased and bound):", (err as Error)?.message)
  }

  return { ok: true, phoneNumber: targetNumber, twilioSid: purchasedSid, numberRowId, credTier: creds.tier, bound, bindNote, billing, monthlyOverageCents, registration }
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
  const { data: row } = await svc.from("tenant_phone_numbers")
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
    // Official Twilio SDK adapter — same DELETE /IncomingPhoneNumbers/{sid}.json endpoint.
    const res = await releaseIncomingPhoneNumber(creds, n.twilio_number_sid)
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

  const { error: updErr } = await svc.from("tenant_phone_numbers").update({ is_active: false }).eq("id", n.id)
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
