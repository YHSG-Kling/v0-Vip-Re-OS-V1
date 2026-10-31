// lib/providers/twilio/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE TWILIO SERVER ADAPTER (wave 70B, owner ruling: "if there is an sdk
// option, we should use that... keeping pricing in mind"). Twilio's official
// Node SDK is `twilio` (not previously installed — every call site below used
// a hand-built REST request through the connector gateway). The SDK does not
// change per-call price (same 2010-04-01 / TrustHub / Messaging endpoints,
// same usage-based billing) — it removes the hand-built form-encoded request
// and PascalCase→camelCase mapping every call site repeated.
//
// SCOPE. This adapter wraps the CALLS + PHONE-NUMBER + SUBACCOUNT surface used
// by lib/voice/twilio-tenancy.ts, twilio-voice.ts, twilio-outbound.ts,
// number-provisioning.ts, warm-transfer.ts and call-recording.ts — and, since
// wave 83D, number PORTING (lib/voice/number-port-in.ts: Portability, PortIn
// create/fetch on numbers.v1; the utility-bill upload is the one documented
// non-SDK call below) and the ownership proof (findIncomingPhoneNumber). Credential
// resolution (BYO → subaccount → master) stays the ONE resolver in
// lib/voice/twilio-tenancy.ts — this file only executes calls with whatever
// creds it is handed.
//
// NOT MIGRATED, ON PURPOSE: lib/voice/a2p-registration.ts. It is a ~600-line
// resumable TrustHub + Messaging ISV step machine (CustomerProfiles, EndUsers,
// EntityAssignments, Evaluations, BrandRegistrations, CNAM/SHAKEN trust
// products) filed against a compliance-critical, hours-to-days-async carrier
// review. The Node SDK does cover TrustHub/Messaging, but re-deriving every
// field mapping in a single lane pass — against a filing pipeline that is
// already contract-verified line by line against Twilio's current docs (see
// that file's own header) — is a correctness risk disproportionate to what an
// SDK swap buys here (no price change, no capability change). It keeps its
// existing `twilio()` REST helper over the connector gateway. Recorded in
// docs/provider-matrix-2026-09.md as "keep REST" with this reason.
//
// Every function returns a GatewayResponse-SHAPED result ({ok, status, data,
// error}) so callers that used to branch on a callConnector result need only
// swap the call, not their branching.

// NOT import "server-only" — every caller of this adapter is itself a server
// action / API route / cron-only lib file (never a client component), and this
// repo's proof scripts (scripts/*.ts) load modules directly via tsx outside
// Next's webpack build, where "server-only" throws unconditionally rather than
// only-when-client-bundled. A static import of this adapter from a file a proof
// script statically reaches (e.g. lib/external/apify-client.ts from
// lib/platform/provider-posture.ts's chain) would crash that proof for a
// directive with no live client-bundling risk to guard against here.
import Twilio from "twilio"

export interface AdapterResult<T> {
  ok: boolean
  status: number | null
  data: T | null
  error: string | null
}

export interface TwilioCreds {
  accountSid: string
  authToken: string
}

const clients = new Map<string, ReturnType<typeof Twilio>>()
function client(creds: TwilioCreds): ReturnType<typeof Twilio> {
  const key = `${creds.accountSid}:${creds.authToken}`
  let c = clients.get(key)
  if (!c) {
    c = Twilio(creds.accountSid, creds.authToken)
    clients.set(key, c)
  }
  return c
}

function mapError(err: unknown): AdapterResult<any> {
  // Twilio's RestException carries `.status` (HTTP status), `.code` (Twilio
  // error code) and `.message`.
  const e = err as { status?: number; code?: number; message?: string; moreInfo?: string }
  return {
    ok: false,
    status: typeof e?.status === "number" ? e.status : null,
    data: null,
    error: e?.message ?? "Twilio request failed",
  }
}

// ─── Subaccounts ──────────────────────────────────────────────────────────

export interface SubaccountData {
  sid: string
  authToken: string
}

/** `POST /2010-04-01/Accounts.json` — used by twilio-tenancy.ts::ensureTenantSubaccount. */
export async function createSubaccount(master: TwilioCreds, friendlyName: string): Promise<AdapterResult<SubaccountData>> {
  try {
    const account = await client(master).api.v2010.accounts.create({ friendlyName })
    return { ok: true, status: 201, data: { sid: account.sid, authToken: account.authToken }, error: null }
  } catch (err) {
    return mapError(err)
  }
}

// ─── Incoming phone numbers ──────────────────────────────────────────────

export interface IncomingNumberWebhooks {
  voiceUrl?: string
  voiceMethod?: "GET" | "POST"
  smsUrl?: string
  smsMethod?: "GET" | "POST"
  statusCallback?: string
  statusCallbackMethod?: "GET" | "POST"
}

/** `POST /IncomingPhoneNumbers/{sid}.json` — used by
 *  twilio-voice.ts::bindNumberToTwilioLane. */
export async function updateIncomingPhoneNumber(
  creds: TwilioCreds,
  numberSid: string,
  webhooks: IncomingNumberWebhooks,
): Promise<AdapterResult<{ sid: string }>> {
  try {
    const num = await client(creds).incomingPhoneNumbers(numberSid).update(webhooks)
    return { ok: true, status: 200, data: { sid: num.sid }, error: null }
  } catch (err) {
    return mapError(err)
  }
}

export interface NumberCandidateData {
  phoneNumber: string
  friendlyName: string | null
  locality: string | null
  region: string | null
  postalCode: string | null
  /** Wave 82D — geography + capability, as Twilio returns them. */
  rateCenter?: string | null
  latitude?: number | null
  longitude?: number | null
  smsCapable?: boolean | null
  voiceCapable?: boolean | null
}

/** The geographic search Twilio's AvailablePhoneNumbers Local resource takes
 *  (US/CA only): AreaCode, InLocality, InRegion, InPostalCode, NearNumber /
 *  NearLatLong + Distance (miles, ≤500, default 25). Wave 82D — local numbers
 *  nearest the tenant's location. */
export interface LocalNumberSearchParams {
  areaCode?: string
  inLocality?: string
  inRegion?: string
  inPostalCode?: string
  nearNumber?: string
  nearLatLong?: string
  distance?: number
  smsEnabled?: boolean
  voiceEnabled?: boolean
  limit?: number
}

function toCandidates(rows: Array<{ phoneNumber: string; friendlyName?: string; locality?: string; region?: string; postalCode?: string; rateCenter?: string; latitude?: number; longitude?: number; capabilities?: { SMS?: boolean; sms?: boolean; voice?: boolean } }>): NumberCandidateData[] {
  return rows.map((n) => ({
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName ?? null,
    locality: n.locality ?? null,
    region: n.region ?? null,
    postalCode: n.postalCode ?? null,
    rateCenter: n.rateCenter ?? null,
    latitude: typeof n.latitude === "number" ? n.latitude : n.latitude != null ? Number(n.latitude) : null,
    longitude: typeof n.longitude === "number" ? n.longitude : n.longitude != null ? Number(n.longitude) : null,
    smsCapable: n.capabilities ? Boolean(n.capabilities.SMS ?? n.capabilities.sms) : null,
    voiceCapable: n.capabilities ? Boolean(n.capabilities.voice) : null,
  }))
}

/** `GET /AvailablePhoneNumbers/US/Local.json` — used by
 *  number-provisioning.ts::searchAvailableNumbers. */
export async function searchAvailableLocalNumbers(
  creds: TwilioCreds,
  opts: LocalNumberSearchParams,
): Promise<AdapterResult<NumberCandidateData[]>> {
  try {
    const rows = await client(creds)
      .availablePhoneNumbers("US")
      .local.list({
        ...(opts.areaCode ? { areaCode: Number(opts.areaCode) } : {}),
        ...(opts.inLocality ? { inLocality: opts.inLocality } : {}),
        ...(opts.inRegion ? { inRegion: opts.inRegion } : {}),
        ...(opts.inPostalCode ? { inPostalCode: opts.inPostalCode } : {}),
        ...(opts.nearNumber ? { nearNumber: opts.nearNumber } : {}),
        ...(opts.nearLatLong ? { nearLatLong: opts.nearLatLong } : {}),
        ...(opts.distance ? { distance: opts.distance } : {}),
        ...(opts.smsEnabled != null ? { smsEnabled: opts.smsEnabled } : {}),
        ...(opts.voiceEnabled != null ? { voiceEnabled: opts.voiceEnabled } : {}),
        limit: opts.limit ?? 10,
      })
    return { ok: true, status: 200, data: toCandidates(rows as any), error: null }
  } catch (err) {
    return mapError(err)
  }
}

/** `GET /AvailablePhoneNumbers/US/TollFree.json` — the SECONDARY option
 *  (wave 82D: "the phone numbers most likely will not be toll free numbers").
 *  Toll-free leases at $2.15/mo vs $1.15 local (twilio.com/en-us/voice/pricing/us)
 *  and needs Toll-Free Verification instead of A2P 10DLC. */
export async function searchAvailableTollFreeNumbers(
  creds: TwilioCreds,
  opts: { contains?: string; smsEnabled?: boolean; limit?: number } = {},
): Promise<AdapterResult<NumberCandidateData[]>> {
  try {
    const rows = await client(creds)
      .availablePhoneNumbers("US")
      .tollFree.list({
        ...(opts.contains ? { contains: opts.contains } : {}),
        ...(opts.smsEnabled != null ? { smsEnabled: opts.smsEnabled } : {}),
        limit: opts.limit ?? 10,
      })
    return { ok: true, status: 200, data: toCandidates(rows as any), error: null }
  } catch (err) {
    return mapError(err)
  }
}

/** `POST /IncomingPhoneNumbers.json` — used by
 *  number-provisioning.ts::provisionNumber. */
export async function purchaseIncomingPhoneNumber(
  creds: TwilioCreds,
  phoneNumber: string,
): Promise<AdapterResult<{ sid: string }>> {
  try {
    const num = await client(creds).incomingPhoneNumbers.create({ phoneNumber })
    return { ok: true, status: 201, data: { sid: num.sid }, error: null }
  } catch (err) {
    return mapError(err)
  }
}

/** `DELETE /IncomingPhoneNumbers/{sid}.json` — used by
 *  number-provisioning.ts::releaseNumber. Twilio 404s (already released)
 *  surface with status 404 so the caller's existing branch keeps working. */
export async function releaseIncomingPhoneNumber(creds: TwilioCreds, numberSid: string): Promise<AdapterResult<true>> {
  try {
    await client(creds).incomingPhoneNumbers(numberSid).remove()
    return { ok: true, status: 204, data: true, error: null }
  } catch (err) {
    return mapError(err)
  }
}

/** `GET /IncomingPhoneNumbers.json?PhoneNumber=` — the OWNERSHIP PROOF (wave
 *  83D: moved onto the SDK from a hand-built connector request in
 *  app/actions/phone-provisioning.ts verifyNumberOwnedByTenant). A number is
 *  the tenant's only if it sits in the account the tenant's creds resolve to;
 *  data null = not in that account. */
export async function findIncomingPhoneNumber(creds: TwilioCreds, e164: string): Promise<AdapterResult<{ sid: string } | null>> {
  try {
    const rows = await client(creds).incomingPhoneNumbers.list({ phoneNumber: e164, limit: 1 })
    const hit = rows[0]
    return { ok: true, status: 200, data: hit?.sid ? { sid: hit.sid } : null, error: null }
  } catch (err) {
    return mapError(err)
  }
}

// ─── Number porting (wave 83D — "the person picks a number or ports") ────
// Twilio Porting API (numbers.twilio.com/v1/Porting, SDK numbers.v1): US
// landline + mobile only — the PortIn resource does NOT take toll-free numbers
// (twilio.com/docs/phone-numbers/port-in/port-in-request-api, 2026-09-26).
// Twilio generates the LOA from the request and e-mails it to the authorized
// representative for signature; the request then walks In Review → Waiting for
// Signature → In Progress → Completed (or Action Required / Canceled).

export interface PortabilityData {
  phoneNumber: string
  portable: boolean
  pinAndAccountNumberRequired: boolean
  notPortableReason: string | null
  numberType: string | null
}

/** `GET /v1/Porting/Portability/PhoneNumber/{n}` — can Twilio port this number
 *  into the tenant's account, and does the losing carrier need PIN + account #? */
export async function checkPortability(creds: TwilioCreds, e164: string): Promise<AdapterResult<PortabilityData>> {
  try {
    const p = await client(creds).numbers.v1.portingPortabilities(e164).fetch({ targetAccountSid: creds.accountSid })
    return {
      ok: true, status: 200, error: null,
      data: { phoneNumber: p.phoneNumber, portable: p.portable === true, pinAndAccountNumberRequired: p.pinAndAccountNumberRequired === true, notPortableReason: p.notPortableReason ?? null, numberType: (p.numberType as string | undefined) ?? null },
    }
  } catch (err) {
    return mapError(err)
  }
}

export interface PortInCreateInput {
  /** The account the numbers land in (the tenant's subaccount). */
  accountSid: string
  documentSids: string[]
  phoneNumbers: Array<{ phoneNumber: string; pin?: string }>
  losingCarrier: {
    customerName: string
    customerType: "Business" | "Individual"
    accountNumber?: string
    accountTelephoneNumber?: string
    authorizedRepresentative: string
    authorizedRepresentativeEmail: string
    address: { street: string; street2?: string; city: string; state: string; zip: string }
  }
  notificationEmails?: string[]
  /** ISO local date, ≥ 7 days out for US ports (Twilio). */
  targetPortInDate?: string
}

export interface PortInRequestData {
  sid: string
  status: string
  signatureRequestUrl: string | null
  targetPortInDate: string | null
  numbers: Array<{ phoneNumber: string; status: string | null; portable: boolean | null; rejectionReason: string | null; portDate: string | null }>
}

function toPortInData(r: { portInRequestSid: string; portInRequestStatus?: string; signatureRequestUrl?: string; targetPortInDate?: Date | string | null; phoneNumbers?: Array<any> }): PortInRequestData {
  const d = r.targetPortInDate
  return {
    sid: r.portInRequestSid,
    status: r.portInRequestStatus ?? "",
    signatureRequestUrl: r.signatureRequestUrl ?? null,
    targetPortInDate: d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d)) : null,
    numbers: (r.phoneNumbers ?? []).map((n: any) => ({
      phoneNumber: n.phoneNumber ?? n.phone_number ?? "",
      status: n.portInPhoneNumberStatus ?? n.port_in_phone_number_status ?? null,
      portable: typeof n.portable === "boolean" ? n.portable : null,
      rejectionReason: n.rejectionReason ?? n.rejection_reason ?? n.notPortabilityReason ?? n.not_portability_reason ?? null,
      portDate: n.portDate ? String(n.portDate instanceof Date ? n.portDate.toISOString() : n.portDate) : (n.port_date ?? null),
    })),
  }
}

/** `POST /v1/Porting/PortIn` — submit the port-in request (Twilio e-mails the LOA). */
export async function createPortInRequest(creds: TwilioCreds, input: PortInCreateInput): Promise<AdapterResult<PortInRequestData>> {
  try {
    const lc = input.losingCarrier
    const r = await client(creds).numbers.v1.portingPortIns.create({
      accountSid: input.accountSid,
      documents: input.documentSids,
      phoneNumbers: input.phoneNumbers.map((n) => ({ phoneNumber: n.phoneNumber, ...(n.pin ? { pin: n.pin } : {}) })),
      losingCarrierInformation: {
        customerName: lc.customerName,
        customerType: lc.customerType,
        ...(lc.accountNumber ? { accountNumber: lc.accountNumber } : {}),
        ...(lc.accountTelephoneNumber ? { accountTelephoneNumber: lc.accountTelephoneNumber } : {}),
        authorizedRepresentative: lc.authorizedRepresentative,
        authorizedRepresentativeEmail: lc.authorizedRepresentativeEmail,
        address: { street: lc.address.street, ...(lc.address.street2 ? { street2: lc.address.street2 } : {}), city: lc.address.city, state: lc.address.state, zip: lc.address.zip, country: "US" },
      },
      ...(input.notificationEmails?.length ? { notificationEmails: input.notificationEmails } : {}),
      ...(input.targetPortInDate ? { targetPortInDate: input.targetPortInDate } : {}),
    } as any)
    return { ok: true, status: 201, data: toPortInData(r as any), error: null }
  } catch (err) {
    return mapError(err)
  }
}

/** `GET /v1/Porting/PortIn/{sid}` — the cron poll, by the request's OWN sid. */
export async function fetchPortInRequest(creds: TwilioCreds, portInRequestSid: string): Promise<AdapterResult<PortInRequestData>> {
  try {
    const r = await client(creds).numbers.v1.portingPortIns(portInRequestSid).fetch()
    return { ok: true, status: 200, data: toPortInData(r as any), error: null }
  } catch (err) {
    return mapError(err)
  }
}

/**
 * `POST https://numbers-upload.twilio.com/v1/Documents` (document_type
 * utility_bill) — the ONE non-SDK call in this adapter, on purpose: twilio-node
 * 6.1.1 ships no Documents-upload resource (node_modules/twilio/lib/rest/
 * numbers/v1 has portingPortIn / portingPortability but no documents), and the
 * port-in request REQUIRES a utility-bill document SID (dated within 30 days).
 * Multipart via the platform fetch; same basic auth the SDK uses.
 */
export async function uploadPortingUtilityBill(
  creds: TwilioCreds,
  file: { name: string; type: string; bytes: ArrayBuffer },
  fetchImpl: typeof fetch = fetch,
): Promise<AdapterResult<{ sid: string; status: string | null }>> {
  try {
    const form = new FormData()
    form.append("document_type", "utility_bill")
    form.append("friendly_name", file.name.slice(0, 120))
    form.append("File", new Blob([file.bytes], { type: file.type || "application/pdf" }), file.name)
    const res = await fetchImpl("https://numbers-upload.twilio.com/v1/Documents", {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}` },
      body: form,
    })
    const body: any = await res.json().catch(() => null)
    if (!res.ok || !body?.sid) return { ok: false, status: res.status, data: null, error: body?.message ?? `utility bill upload refused (${res.status})` }
    return { ok: true, status: res.status, data: { sid: body.sid, status: body.status ?? null }, error: null }
  } catch (err) {
    return mapError(err)
  }
}

// ─── Calls ──────────────────────────────────────────────────────────────

export interface PlaceCallParams {
  to: string
  from: string
  url: string
  method?: "GET" | "POST"
  machineDetection?: "Enable" | "DetectMessageEnd"
  timeout?: number
  statusCallback?: string
  statusCallbackMethod?: "GET" | "POST"
  record?: boolean
  recordingChannels?: "mono" | "dual"
  recordingTrack?: "inbound" | "outbound" | "both"
  recordingStatusCallback?: string
  recordingStatusCallbackMethod?: "GET" | "POST"
  recordingStatusCallbackEvent?: string[]
}

/** `POST /Calls.json` — used by twilio-outbound.ts::placeOutboundAiCall and
 *  warm-transfer.ts (agent-bridge dial). */
export async function placeCall(creds: TwilioCreds, params: PlaceCallParams): Promise<AdapterResult<{ sid: string }>> {
  try {
    const call = await client(creds).calls.create(params)
    return { ok: true, status: 201, data: { sid: call.sid }, error: null }
  } catch (err) {
    return mapError(err)
  }
}

/** `POST /Calls/{sid}.json Status=completed` — used by
 *  twilio-outbound.ts::endOutboundAiCall. */
export async function hangupCall(creds: TwilioCreds, callSid: string): Promise<AdapterResult<{ sid: string }>> {
  try {
    const call = await client(creds).calls(callSid).update({ status: "completed" })
    return { ok: true, status: 200, data: { sid: call.sid }, error: null }
  } catch (err) {
    return mapError(err)
  }
}

// ─── Call recordings ────────────────────────────────────────────────────

export interface StartRecordingParams {
  recordingChannels?: "mono" | "dual"
  recordingTrack?: "inbound" | "outbound" | "both"
  recordingStatusCallback: string
  recordingStatusCallbackMethod?: "GET" | "POST"
  recordingStatusCallbackEvent?: string[]
}

/** `POST /Calls/{sid}/Recordings.json` — used by
 *  call-recording.ts::startCallRecording (arms recording on a LIVE call). */
export async function startCallRecording(
  creds: TwilioCreds,
  callSid: string,
  params: StartRecordingParams,
): Promise<AdapterResult<{ sid: string }>> {
  try {
    const recording = await client(creds).calls(callSid).recordings.create(params)
    return { ok: true, status: 201, data: { sid: recording.sid }, error: null }
  } catch (err) {
    return mapError(err)
  }
}
