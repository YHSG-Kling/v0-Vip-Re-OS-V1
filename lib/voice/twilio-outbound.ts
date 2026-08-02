// lib/voice/twilio-outbound.ts
// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND AI CALLS ON THE TWILIO-NATIVE LANE (owner: "no longer vapi") — the
// ISA's outbound dial rides the same turn-based serverless engine as inbound
// reception: POST /Calls.json with our answer webhook, machine detection on,
// the same reception-brain turn loop after connect. The GOVERNANCE ORDER is
// identical to the Vapi lane it replaces and runs BEFORE any Twilio request:
//   1. TCPA chokepoint (DNC / consent / quiet-hours / RND — fails closed)
//   2. Vendor budget gate (over-ceiling brokerages pause outbound voice)
// The call brief (objective + optional ISA persona prompt) travels in the
// voice_calls row's ai_notes as compact JSON — the answer/turn webhooks rebuild
// the brain from it per turn (serverless: the row IS the session).

import { withAiCallDisclosures } from "@/lib/communication/call-disclosures"

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
 *  the office, states the reason briefly, never fakes a human callback. */
export function composeVoicemailMessage(brief: OutboundCallBrief, officeName: string | null): string {
  const office = officeName ?? "our office"
  const base = `${brief.contactName ? `Hi ${brief.contactName}, ` : "Hi, "}this is the AI assistant calling from ${office}. ${brief.objective.slice(0, 160)} We'll follow up — no need to call back unless it's convenient. Thank you!`
  return withAiCallDisclosures(base, { recorded: false }).slice(0, 450)
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
}

export type PlaceOutboundResult =
  | { ok: true; callSid: string; voiceCallId: string | null; fromNumber: string }
  | { ok: false; error: string; blocked?: boolean; blockReason?: string }

/**
 * Place an outbound AI call on the Twilio-native lane. Same gates, same ledger,
 * different engine: TCPA + budget first, tenant's own number + creds (BYO →
 * subaccount → master), machine detection, honest errors — a failed dial never
 * fabricates a voice_calls row claiming success.
 */
export async function placeOutboundAiCall(svc: any, params: PlaceOutboundParams): Promise<PlaceOutboundResult> {
  // 1. TCPA chokepoint — identical to the Vapi lane it replaces; fails closed.
  const { enforceTCPACompliance } = await import("@/lib/communication/tcpa-gate")
  const gate = await enforceTCPACompliance({
    channel: "call",
    phone: params.toNumber,
    contactId: params.contactId,
    brokerageId: params.brokerageId,
    initiatedBy: params.initiatedBy ?? null,
    transactional: params.transactional ?? false,
  })
  if (!gate.allowed) {
    return { ok: false, error: gate.message ?? "TCPA gate blocked the call", blocked: true, blockReason: gate.blockReason }
  }

  // 2. Vendor budget gate — over-ceiling tenants pause outbound voice.
  try {
    const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
    const { estimatePlatformVendorCost } = await import("@/lib/vendor-governance/meter-vendor")
    const budget = await checkVendorBudget({ brokerageId: params.brokerageId, addCost: estimatePlatformVendorCost("twilio_voice", 3) })
    if (!budget.allowed) {
      return { ok: false, error: "Vendor budget exceeded — outbound voice paused", blocked: true, blockReason: "vendor_budget_exceeded" }
    }
  } catch { /* budget read failure never blocks a compliant call */ }

  // 3. FROM number: the agent's own line first (contacts recognize it), else
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

  // 4. Dial.
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
    },
    auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
  })
  if (!res.ok || !res.data?.sid) {
    return { ok: false, error: `Twilio dial failed (${res.status ?? "—"}): ${res.error ?? "unknown"}` }
  }

  // 5. The ledger row IS the session — the answer/turn webhooks rebuild the
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
