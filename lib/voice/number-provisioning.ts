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
import type { LocalNumberCandidate, TenantLocationAnchor } from "@/lib/voice/local-number-search"

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

// ─── Local numbers nearest the tenant (wave 82D) ─────────────────────────────
// Owner: "the phone numbers most likely will not be toll free numbers, build
// non toll free provisioning and selection numbers which will most likely be
// area codes that start with their location." The LADDER is pure
// (lib/voice/local-number-search.ts); this is its one DB + carrier caller.
// The tenant is the CALLER's (session gate in both actions) — never a body.

type LocalNumberSuggestion =
  | { ok: true; candidates: LocalNumberCandidate[]; anchor: string; areaCode: string | null; tried: Array<{ rung: string; found: number; error?: string }>; credTier: TwilioCreds["tier"] }
  | { ok: false; error: string; notConfigured?: boolean }

/** Wave 83D — the office's coordinates. brokerages / locations carry NO
 *  lat/long column (scripts/schema-snapshot.ts), so there is nothing to cache
 *  ON the row; the point is resolved through THE free geocoder survivor
 *  (lib/external/nominatim-geocode.ts geocodeOne — Nominatim, keyless, 1 req/s)
 *  and memoised per address for the life of the process. A miss or an
 *  unreachable geocoder yields null and the ladder simply skips its
 *  NearLatLong rung — a missing point is never invented. */
type GeocodeFn = (parts: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }) => Promise<{ lat: number; lng: number } | null>
const officePointMemo = new Map<string, { lat: number; lng: number } | null>()
async function geocodeOffice(parts: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }, geocode?: GeocodeFn): Promise<{ latitude: number; longitude: number } | null> {
  if (!parts.address && !parts.zip && !(parts.city && parts.state)) return null
  const key = [parts.address, parts.city, parts.state, parts.zip].map((v) => String(v ?? "").trim().toLowerCase()).join("|")
  let p = geocode ? undefined : officePointMemo.get(key)
  if (p === undefined) {
    try {
      const fn: GeocodeFn = geocode ?? (await import("@/lib/external/nominatim-geocode")).geocodeOne
      p = await fn(parts)
    } catch { p = null }
    // Only a FOUND point is memoised — a miss or an outage is retried next time.
    if (!geocode && p) officePointMemo.set(key, p)
  }
  return p ? { latitude: p.lat, longitude: p.lng } : null
}

/** Read the tenant's location anchor: the named location (tenant-predicated)
 *  else the brokerage's own address + office phone, geocoded (wave 83D). */
async function tenantLocationAnchor(
  svc: any, brokerageId: string, opts: { locationId?: string | null; areaCode?: string | null; geocode?: GeocodeFn } = {},
): Promise<{ ok: true; anchor: TenantLocationAnchor } | { ok: false; error: string }> {
  const { data: b, error: bErr } = await svc.from("brokerages").select("phone, address, city, state, zip").eq("id", brokerageId).maybeSingle()
  if (bErr) return { ok: false, error: `brokerage location read refused: ${bErr.message}` }
  if (!b) return { ok: false, error: "Tenant not found" }
  let address: string | null = (b as any).address ?? null
  let city: string | null = (b as any).city ?? null
  let state: string | null = (b as any).state ?? null
  let zip: string | null = (b as any).zip ?? null
  if (opts.locationId) {
    const { data: loc, error: lErr } = await svc.from("locations").select("address, city, state").eq("id", opts.locationId).eq("brokerage_id", brokerageId).maybeSingle()
    if (lErr) return { ok: false, error: `location read refused: ${lErr.message}` }
    if (!loc) return { ok: false, error: "Location not found for this tenant" }
    const otherCity = !!(loc as any).city && (loc as any).city !== (b as any).city
    if (otherCity) zip = null // the brokerage ZIP is not this location's
    address = (loc as any).address ?? (otherCity ? null : address)
    city = (loc as any).city ?? city; state = (loc as any).state ?? state
  }
  const point = await geocodeOffice({ address, city, state, zip }, opts.geocode)
  return { ok: true, anchor: { areaCode: opts.areaCode ?? null, phone: (b as any).phone ?? null, city, state, zip, latitude: point?.latitude ?? null, longitude: point?.longitude ?? null } }
}

/** Suggest purchasable LOCAL numbers nearest the tenant — area code first,
 *  nearby fallback, toll-free only when asked (the secondary option). */
export async function suggestLocalNumbers(
  svc: any, brokerageId: string,
  opts: { locationId?: string | null; areaCode?: string | null; includeTollFree?: boolean; limit?: number; geocode?: GeocodeFn } = {},
): Promise<LocalNumberSuggestion> {
  const { planLocalNumberSearch, runLocalNumberSearch } = await import("@/lib/voice/local-number-search")
  const loc = await tenantLocationAnchor(svc, brokerageId, opts)
  if (!loc.ok) return { ok: false, error: loc.error }
  const plan = planLocalNumberSearch(loc.anchor, { includeTollFree: opts.includeTollFree === true })
  if (!plan.ok) return { ok: false, error: plan.reason }
  const creds = await resolveCreds(svc, brokerageId)
  if (!creds) return { ok: false, error: NOT_CONFIGURED, notConfigured: true }
  const { searchAvailableTollFreeNumbers } = await import("@/lib/providers/twilio/client")
  const res = await runLocalNumberSearch(plan, async (step, limit) => {
    const r = step.rung === "toll_free"
      ? await searchAvailableTollFreeNumbers(creds, { limit })
      : await searchAvailableLocalNumbers(creds, { ...step.params, limit })
    return r.ok ? { ok: true as const, rows: r.data ?? [] } : { ok: false as const, error: `(${r.status ?? "—"}) ${r.error ?? "unknown"}` }
  }, { limit: opts.limit ?? 10 })
  if (!res.ok) return { ok: false, error: res.reason }
  return { ok: true, candidates: res.candidates, anchor: res.anchor, areaCode: res.areaCode, tried: res.tried, credTier: creds.tier }
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
  if (!targetNumber && !params.areaCode) {
    // Wave 82D — no number and no area code (the auto-provision path) used to
    // buy whatever US number Twilio listed first. Now: the first LOCAL number
    // nearest the tenant (area code → nearby ladder), never toll-free here.
    const near = await suggestLocalNumbers(svc, params.brokerageId, { limit: 1 })
    if (!near.ok) return near
    targetNumber = near.candidates[0]?.phoneNumber ?? null
    if (!targetNumber) return { ok: false, error: `No available local numbers found near ${near.anchor || "the tenant's location"}` }
  }
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

// ─── Attach a number the tenant already OWNS (BYO / ported) ──────────────────
// Wave 83D: the post-gate body of app/actions/phone-provisioning.ts
// manuallyAddAgentPhone, moved here VERBATIM IN BEHAVIOUR so the port-in cron
// (lib/voice/number-port-in.ts — a completed port lands with no session) runs
// the SAME guards the human door runs, never a second copy of them:
//   GUARD 1 — global active-number collision (fails CLOSED on a refused read;
//             never discloses which other tenant holds it);
//   GUARD 2 — ownership proof: the number must sit in the Twilio account this
//             tenant's creds resolve to (SDK IncomingPhoneNumbers lookup; the
//             SID is taken from Twilio's answer, never from a caller);
//   then row → webhook bind → phone_number_events → kickCarrierRegistration.
// The caller owns identity (session gate or the cron's own tenant loop).

export type AttachOwnedNumberResult =
  | { ok: true; phoneNumber: string; twilioSid: string | null; numberRowId: string | null; bound: boolean; bindNote?: string; registration?: CarrierKickoffResult; registrationNote?: string }
  | { ok: false; error: string }

export async function attachOwnedNumber(
  svc: any,
  params: {
    brokerageId: string
    phoneNumber: string
    /** 'agent' needs agentUserId (+ agentId for the audit FK); else brokerage inventory. */
    scopeType: "agent" | "brokerage"
    agentUserId?: string | null
    agentId?: string | null
    source: "manually_added" | "ported_in"
    eventSource: string
  },
): Promise<AttachOwnedNumberResult> {
  const digits = String(params.phoneNumber ?? "").replace(/\D/g, "")
  if (digits.length < 10 || digits.length > 15) return { ok: false, error: "Enter a valid phone number" }
  const cleaned = digits.length === 10 ? `+1${digits}` : `+${digits}`

  // GUARD 1 — global collision (deliberately NOT tenant-scoped).
  const { data: collision, error: collisionErr } = await svc
    .from("tenant_phone_numbers")
    .select("id, brokerage_id")
    .eq("phone_digits", digits)
    .eq("is_active", true)
    .limit(1)
  if (collisionErr) return { ok: false, error: "Could not verify the number is free — nothing was added" }
  if (collision && collision.length > 0) {
    const owner = (collision[0] as any).brokerage_id
    return { ok: false, error: owner === params.brokerageId ? "That number is already active on your account" : "That number is already in use on this platform" }
  }

  // GUARD 2 — ownership proof against the tenant's resolved Twilio account.
  const creds = await resolveTenantTwilioCreds(svc, params.brokerageId)
  if (!creds) return { ok: false, error: "Telephony isn't connected yet, so number ownership can't be verified — nothing was added." }
  const { findIncomingPhoneNumber } = await import("@/lib/providers/twilio/client")
  const own = await findIncomingPhoneNumber(creds, cleaned)
  if (!own.ok) return { ok: false, error: `Could not verify the number with the carrier (${own.status ?? "—"}) — nothing was added.` }
  if (!own.data) return { ok: false, error: "That number isn't in your telephony account. Numbers must be owned by your brokerage before they can be added." }
  const verifiedSid = own.data.sid

  if (params.scopeType === "agent") {
    if (!params.agentUserId) return { ok: false, error: "Agent not found" }
    // Deactivate any existing active number for this agent (read the refusal).
    const { error: deErr } = await svc.from("tenant_phone_numbers").update({ is_active: false })
      .eq("agent_user_id", params.agentUserId).eq("brokerage_id", params.brokerageId).eq("is_active", true)
    if (deErr) return { ok: false, error: `Could not retire the agent's current number (${deErr.message}) — nothing was added` }
  }

  // number_source CHECK allows (byoc_twilio|ported) only.
  const { data: inserted, error } = await svc
    .from("tenant_phone_numbers")
    .insert({
      agent_user_id: params.scopeType === "agent" ? params.agentUserId : null,
      brokerage_id: params.brokerageId,
      scope_type: params.scopeType,
      phone_number: cleaned,
      phone_digits: digits,
      twilio_number_sid: verifiedSid,
      number_source: params.source === "ported_in" ? "ported" : "byoc_twilio",
      is_active: true,
    })
    .select("id")
    .single()
  if (error) return { ok: false, error: error.message }

  let bound = false
  let bindNote: string | undefined
  const numberRowId = (inserted as { id?: string } | null)?.id ?? null
  if (numberRowId) {
    const { bindNumberToTwilioLane } = await import("@/lib/voice/twilio-voice")
    const bind = await bindNumberToTwilioLane(svc, numberRowId).catch((err: any) => ({ ok: false as const, error: String(err?.message ?? err) }))
    bound = bind.ok
    if (!bind.ok) bindNote = `Number saved, but pointing it at the AI lane failed: ${bind.error}`
  } else {
    bindNote = "Number saved, but the row id was not returned — bind it from its row later"
  }

  await logPhoneNumberEvent(svc, {
    brokerageId: params.brokerageId,
    agentId: params.agentId ?? null,
    phoneNumber: cleaned,
    eventType: params.source === "ported_in" ? "ported_in" : "manually_added",
    source: params.eventSource,
    twilioSid: verifiedSid,
  })

  // AUTOMATIC BUSINESS REGISTRATION after a port-in / BYO add (wave 81D) —
  // best-effort, audited, honest about a missing business profile.
  let registration: CarrierKickoffResult | undefined
  let registrationNote: string | undefined
  try {
    const { kickCarrierRegistration } = await import("@/lib/voice/a2p-registration")
    registration = await kickCarrierRegistration(svc, { brokerageId: params.brokerageId, phoneNumber: cleaned, trigger: params.source === "ported_in" ? "ported_in" : "manually_added" })
    registrationNote = registration.statusLine
  } catch (err) {
    registrationNote = `Business registration could not start: ${(err as Error)?.message ?? "unknown"}`
  }

  return { ok: true, phoneNumber: cleaned, twilioSid: verifiedSid, numberRowId, bound, bindNote, registration, registrationNote }
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
