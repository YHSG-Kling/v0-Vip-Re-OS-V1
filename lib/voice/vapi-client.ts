/**
 * lib/voice/vapi-client.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Typed helpers for the VAPI REST API.
 * All functions are server-only (use VAPI_API_KEY from env).
 * Never import this file in Client Components.
 */

const VAPI_BASE = "https://api.vapi.ai"

function vapiHeaders(): HeadersInit {
  const key = process.env.VAPI_API_KEY
  if (!key) throw new Error("VAPI_API_KEY is not set")
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  }
}

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface VapiCallParams {
  /** E.164 phone number, e.g. "+15551234567" */
  phoneNumber: string
  /** Optional VAPI assistant ID to use */
  assistantId?: string
  /** Inline assistant config — mutually exclusive with assistantId */
  assistantConfig?: Record<string, unknown>
}

export interface VapiCallResponse {
  id: string
  status: string
  createdAt: string
}

export interface VapiCallStatus {
  id: string
  status: string
  duration?: number
  endedReason?: string
}

// ─── PUBLIC FUNCTIONS ─────────────────────────────────────────────────────────

/**
 * Initiate an outbound phone call via VAPI.
 * Returns the VAPI call object on success.
 */
export async function initiateCall(params: VapiCallParams): Promise<VapiCallResponse> {
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID
  if (!phoneNumberId) throw new Error("VAPI_PHONE_NUMBER_ID is not set")

  const body: Record<string, unknown> = {
    phoneNumberId,
    customer: { number: params.phoneNumber },
  }

  if (params.assistantId) {
    body.assistantId = params.assistantId
  } else if (params.assistantConfig) {
    body.assistant = params.assistantConfig
  }

  const res = await fetch(`${VAPI_BASE}/call`, {
    method: "POST",
    headers: vapiHeaders(),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`VAPI initiateCall failed (${res.status}): ${text}`)
  }

  const data = await res.json()
  return {
    id: data.id,
    status: data.status ?? "initiated",
    createdAt: data.createdAt ?? new Date().toISOString(),
  }
}

/**
 * End an active VAPI call by ID.
 */
export async function endCall(vapiCallId: string): Promise<void> {
  const res = await fetch(`${VAPI_BASE}/call/${vapiCallId}`, {
    method: "DELETE",
    headers: vapiHeaders(),
  })

  if (!res.ok && res.status !== 404) {
    const text = await res.text()
    throw new Error(`VAPI endCall failed (${res.status}): ${text}`)
  }
}

/**
 * Get the current status of a VAPI call.
 */
export async function getCallStatus(vapiCallId: string): Promise<VapiCallStatus> {
  const res = await fetch(`${VAPI_BASE}/call/${vapiCallId}`, {
    method: "GET",
    headers: vapiHeaders(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`VAPI getCallStatus failed (${res.status}): ${text}`)
  }

  const data = await res.json()
  return {
    id: data.id,
    status: data.status,
    duration: data.duration,
    endedReason: data.endedReason,
  }
}
