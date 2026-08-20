// lib/voice/twilio-outbound.ts
// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND AI CALLS ON THE TWILIO-NATIVE LANE (owner: "no longer vapi") — the
// ISA's outbound dial rides the same turn-based serverless engine as inbound
// reception: POST /Calls.json with our answer webhook, machine detection on,
// the same reception-brain turn loop after connect. The GOVERNANCE ORDER runs
// BEFORE any Twilio request and lives in ONE place —
// lib/voice/outbound-call-gates.ts:OUTBOUND_CALL_GATES:
//   1. Autonomy boundary (a governed manager may only dial unattended within
//      its proven trust boundary; opt-in by managerKey/systemSource)
//   2. Suppression (contact flags AND contact_suppression_list — fails closed)
//   3. TCPA chokepoint (DNC / consent / quiet-hours / RND — fails closed)
//   4. De-conflict (over-touch suppression, 1 call / 7 days by default)
//   5. Vendor budget gate (over-ceiling brokerages pause outbound voice)
// Gates 1, 2 and 4 arrived in wave 8 from lib/providers/dispatch.ts:dispatchPhone
// (deleted; this function is the survivor) — until then a contact suppressed on
// the LIST rather than on the dnc_status FLAG could still be dialled here,
// because enforceTCPACompliance reads the flag and never the list.
// The call brief (objective + optional ISA persona prompt) travels in the
// voice_calls row's ai_notes as compact JSON — the answer/turn webhooks rebuild
// the brain from it per turn (serverless: the row IS the session).

import { withAiCallDisclosures } from "@/lib/communication/call-disclosures"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

export interface OutboundCallBrief {
  engine: "twilio"
  objective: string
  contactName?: string | null
  firstMessage?: string | null
  systemPrompt?: string | null
}

/** PURE: serialize the brief into ai_notes (capped — it rides a text column). */
export function encodeOutboundBrief(brief: OutboundCallBrief): string {
  return JSON.stringify({
    engine: "twilio",
    objective: brief.objective.slice(0, 500),
    contactName: brief.contactName?.slice(0, 80) ?? null,
    firstMessage: brief.firstMessage?.slice(0, 300) ?? null,
    systemPrompt: brief.systemPrompt?.slice(0, 2000) ?? null,
  })
}

/** PURE: rebuild the brief from ai_notes — a legacy/foreign note returns null
 *  (the turn route falls back to the reception brain, never crashes). */
export function decodeOutboundBrief(aiNotes: string | null | undefined): OutboundCallBrief | null {
  if (!aiNotes) return null
  try {
    const p = JSON.parse(aiNotes)
    if (p?.engine !== "twilio" || typeof p?.objective !== "string" || !p.objective) return null
    return {
      engine: "twilio",
      objective: p.objective,
      contactName: typeof p.contactName === "string" ? p.contactName : null,
      firstMessage: typeof p.firstMessage === "string" ? p.firstMessage : null,
      systemPrompt: typeof p.systemPrompt === "string" ? p.systemPrompt : null,
    }
  } catch {
    return null
  }
}

/** PURE: the honest voicemail when a machine answers — identifies the AI and
 *  the office, states the reason briefly, never fakes a human callback.
 *
 *  `recorded` IS REQUIRED, deliberately. It used to be hardcoded `false`, which
 *  was true only while `voice_calls.recording_url` had no writer at all. With
 *  the recording producer live (lib/voice/call-recording.ts), Twilio's Record
 *  parameter captures the AMD/voicemail leg too — so a hardcoded `false` would
 *  make this the one spoken output in the system that tells the callee the call
 *  is not recorded while it is being recorded. Making the flag a required
 *  parameter means no call site can reinstate that by omission; it must pass the
 *  brokerage's resolved policy. See disclosureCoversRecording. */
export function composeVoicemailMessage(
  brief: OutboundCallBrief,
  officeName: string | null,
  opts: { recorded: boolean },
): string {
  const office = officeName ?? "our office"
  const base = `${brief.contactName ? `Hi ${brief.contactName}, ` : "Hi, "}this is the AI assistant calling from ${office}. ${brief.objective.slice(0, 160)} We'll follow up — no need to call back unless it's convenient. Thank you!`
  return withAiCallDisclosures(base, { recorded: opts.recorded }).slice(0, 450)
}

export interface PlaceOutboundParams {
  toNumber: string
  contactId: string | null
  brokerageId: string
  /** Whose line/identity dials — the contact's assigned agent when known. */
  agentUserId?: string | null
  initiatedBy?: string | null
  objective: string
  contactName?: string | null
  firstMessage?: string | null
  systemPrompt?: string | null
  transactional?: boolean
  /** Unconverted LEAD origin, when the dial came from a lead rather than a
   *  promoted contact — gives the lead the same over-touch protection
   *  (de-conflict counts lead touches from isa_outreach_log). */
  leadId?: string | null
  /** Attribution for the de-conflict audit row; also the signal the autonomy
   *  gate infers a governed manager from (SYSTEM_SOURCE_TO_MANAGER). */
  systemSource?: string
  /** The governed AI manager placing this call. Set ONLY for AUTONOMOUS
   *  (unattended) manager dials — it arms the autonomy gate. Deliberately
   *  unset by default: an agent clicking "call" in the UI is a human decision
   *  and must never be held by an autonomy posture. */
  managerKey?: ManagerKey | null
  /** A human approved this call (approval queue) — bypasses the autonomy gate. */
  humanApproved?: boolean
}

export type PlaceOutboundResult =
  | { ok: true; callSid: string; voiceCallId: string | null; fromNumber: string }
  | { ok: false; error: string; blocked?: boolean; blockReason?: string }

/**
 * Place an outbound AI call on the Twilio-native lane. Same ledger, one gate
 * stack: every pre-dial gate runs first (autonomy → suppression → TCPA →
 * de-conflict → vendor budget, all in lib/voice/outbound-call-gates.ts), then
 * the tenant's own number + creds (BYO → subaccount → master), machine
 * detection, honest errors — a failed dial never fabricates a voice_calls row
 * claiming success.
 */
export async function placeOutboundAiCall(svc: any, params: PlaceOutboundParams): Promise<PlaceOutboundResult> {
  // 1. THE GATE STACK — every deterministic refusal, cheapest first, money last,
  //    all of it BEFORE anything that dials. A refusal short-circuits, so a
  //    suppressed or non-consenting recipient never reaches the budget read and
  //    never reaches Twilio. Refusals already carry a real reason string.
  const { runOutboundCallGates } = await import("@/lib/voice/outbound-call-gates")
  const refusal = await runOutboundCallGates({
    brokerageId: params.brokerageId,
    toNumber: params.toNumber,
    contactId: params.contactId,
    leadId: params.leadId ?? null,
    initiatedBy: params.initiatedBy ?? null,
    transactional: params.transactional ?? false,
    systemSource: params.systemSource,
    managerKey: params.managerKey ?? null,
    humanApproved: params.humanApproved,
  })
  if (refusal) return refusal

  // 2. FROM number: the agent's own line first (contacts recognize it), else
  //    any active brokerage line — dialing needs a real tenant number; no
  //    shared-platform fallback on this lane (caller ID honesty).
  let numQ = svc.from("tenant_phone_numbers")
    .select("id, phone_number, agent_user_id")
    .eq("brokerage_id", params.brokerageId).eq("is_active", true)
  const { data: numbers } = await numQ
  const list = (numbers ?? []) as Array<{ phone_number: string; agent_user_id: string | null }>
  const fromRow = (params.agentUserId ? list.find((n) => n.agent_user_id === params.agentUserId) : null)
    ?? list.find((n) => !n.agent_user_id) ?? list[0]
  if (!fromRow?.phone_number) {
    return { ok: false, error: "No active tenant phone number to dial from — provision a number first. No call was placed." }
  }

  const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  const creds = await resolveTenantTwilioCreds(svc, params.brokerageId)
  if (!creds) return { ok: false, error: "Twilio not configured for this tenant — no call was placed." }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { ok: false, error: "NEXT_PUBLIC_APP_URL not set — the answer webhook can't be registered. No call was placed." }
  const base = appUrl.replace(/\/$/, "")

  // 2b. RECORDING POSTURE — opt-in per brokerage, DEFAULT OFF (all-party-consent
  //     states + a TCPA surface: the broker, not the platform, answers for a
  //     recorded conversation). recordingDialParams returns {} when the tenant
  //     has not opted in, so a non-opted dial body is byte-identical to what it
  //     was before recording existed. The spoken side needs no change: the
  //     opener from buildOutboundPrompt already carries the recording
  //     announcement on every call (ANNOUNCED ⊇ RECORDED — see
  //     lib/voice/call-recording.ts).
  const { resolveCallRecordingPolicy, recordingDialParams } = await import("@/lib/voice/call-recording")
  const recordingPolicy = await resolveCallRecordingPolicy(svc, params.brokerageId)

  // 3. Dial.
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<{ sid?: string }>({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${creds.accountSid}/Calls.json`,
    method: "POST",
    bodyType: "form",
    body: {
      To: params.toNumber,
      From: fromRow.phone_number,
      Url: `${base}/api/voice/twilio/outbound`,
      Method: "POST",
      MachineDetection: "Enable",
      StatusCallback: `${base}/api/voice/twilio/status`,
      StatusCallbackMethod: "POST",
      ...recordingDialParams(recordingPolicy, base),
    },
    auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
  })
  if (!res.ok || !res.data?.sid) {
    return { ok: false, error: `Twilio dial failed (${res.status ?? "—"}): ${res.error ?? "unknown"}` }
  }

  // 4. The ledger row IS the session — the answer/turn webhooks rebuild the
  //    brain from ai_notes. Insert failure is surfaced (the call is live but
  //    the turn webhook can't run without its session row).
  const { data: row, error: insErr } = await svc.from("voice_calls").insert({
    brokerage_id: params.brokerageId,
    contact_id: params.contactId,
    direction: "outbound",
    call_type: "ai_isa_call",
    status: "initiated",
    phone_from: fromRow.phone_number,
    phone_to: params.toNumber,
    started_at: new Date().toISOString(),
    // THE ONLY HONEST WRITER OF THIS COLUMN, and it is reached only past the
    // whole gate stack at step 1 (autonomy → suppression/DNC → TCPA consent and
    // quiet hours → de-conflict → budget). A refusal returns above, so `true`
    // here records a check that RAN on this call.
    //
    // Three surfaces render this as a compliance verdict — the agent's call
    // history (app/components/dashboard/voice/VoiceCallHistoryTable.tsx:156, a
    // green shield), the voice-intelligence board and the superadmin tenant call
    // log — and NOTHING in the tree wrote it, while the column carried DEFAULT
    // true. Every call on every lane therefore displayed "compliance passed"
    // having been checked by nobody, and the red `=== false` branch on those
    // surfaces was unreachable. m510 drops that default so a lane with no gate
    // says NOTHING (null → "—") instead of claiming a pass.
    compliance_passed: true,
    // The companion column the voice-intelligence board reads beside the verdict
    // (app/dashboard/voice-intelligence/page.tsx:50) — text[], no default, and
    // written by nobody either. An EMPTY array is the honest partner of a pass:
    // "the stack ran and raised nothing". It is not the same statement as NULL,
    // which every other lane still writes and which means "no stack ran here" —
    // a blocking flag never reaches this line at all, because the gate returns.
    compliance_flags: [],
    vendor_call_id: res.data.sid, // vendor call id (Twilio CallSid on this lane)
    ai_notes: encodeOutboundBrief({
      engine: "twilio",
      objective: params.objective,
      contactName: params.contactName ?? null,
      firstMessage: params.firstMessage ?? null,
      systemPrompt: params.systemPrompt ?? null,
    }),
  }).select("id").single()
  if (insErr) {
    console.error("[twilio-outbound] voice_calls insert failed — call is live without a session row:", insErr.message)
  }

  return { ok: true, callSid: res.data.sid, voiceCallId: (row as any)?.id ?? null, fromNumber: fromRow.phone_number }
}

/**
 * Terminate a live Twilio call from the agent UI ("End Call"). Resolves the
 * tenant's creds and POSTs Status=completed to the call resource. Best-effort:
 * a call Twilio already ended returns non-2xx, which is not a hard failure (the
 * caller still closes the ledger row). No stub — a missing-creds/tenant case is
 * surfaced honestly.
 */
export async function endOutboundAiCall(
  svc: any, brokerageId: string, callSid: string,
): Promise<{ ok: boolean; error?: string }> {
  const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  const creds = await resolveTenantTwilioCreds(svc, brokerageId)
  if (!creds) return { ok: false, error: "Twilio not configured for this tenant" }
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<{ sid?: string }>({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${creds.accountSid}/Calls/${callSid}.json`,
    method: "POST",
    bodyType: "form",
    body: { Status: "completed" },
    auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
  })
  if (!res.ok) return { ok: false, error: `Twilio hangup failed (${res.status ?? "—"}): ${res.error ?? "unknown"}` }
  return { ok: true }
}
