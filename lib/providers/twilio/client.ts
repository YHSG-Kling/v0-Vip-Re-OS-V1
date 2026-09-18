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
// number-provisioning.ts, warm-transfer.ts and call-recording.ts. Credential
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
}

/** `GET /AvailablePhoneNumbers/US/Local.json` — used by
 *  number-provisioning.ts::searchAvailableNumbers. */
export async function searchAvailableLocalNumbers(
  creds: TwilioCreds,
  opts: { areaCode?: string; inLocality?: string; limit?: number },
): Promise<AdapterResult<NumberCandidateData[]>> {
  try {
    const rows = await client(creds)
      .availablePhoneNumbers("US")
      .local.list({
        ...(opts.areaCode ? { areaCode: Number(opts.areaCode) } : {}),
        ...(opts.inLocality ? { inLocality: opts.inLocality } : {}),
        limit: opts.limit ?? 10,
      })
    const candidates: NumberCandidateData[] = rows.map((n) => ({
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName ?? null,
      locality: n.locality ?? null,
      region: n.region ?? null,
      postalCode: n.postalCode ?? null,
    }))
    return { ok: true, status: 200, data: candidates, error: null }
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
