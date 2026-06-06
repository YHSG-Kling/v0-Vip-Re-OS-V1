/**
 * lib/voice/vapi-client.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Typed helpers for the VAPI REST API.
 * All functions are server-only (use VAPI_API_KEY from env).
 * Never import this file in Client Components.
 *
 * TCPA: every initiateCall passes through enforceTCPACompliance BEFORE the
 * VAPI HTTP request. This closes the AI ISA path which previously bypassed
 * the lib/providers/messaging gate entirely. Callers MUST supply brokerageId
 * (used for compliance scope + audit log) and SHOULD supply contactId when
 * the call targets a known CRM contact.
 */

import { enforceTCPACompliance } from "@/lib/communication/tcpa-gate"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

const VAPI_BASE = "https://api.vapi.ai"

/** VAPI is a PLATFORM-owned connector — one key for everyone; per-subscriber persona/voice is
 *  passed as call overrides, not a per-tenant credential. Egress goes through the gateway. */
function vapiKey(): string {
  const key = process.env.VAPI_API_KEY
  if (!key) throw new Error("VAPI_API_KEY is not set")
  return key
}

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface VapiCallParams {
  /** E.164 phone number, e.g. "+15551234567" */
  phoneNumber: string
  /** Optional VAPI assistant ID to use */
  assistantId?: string
  /** Inline assistant config — mutually exclusive with assistantId */
  assistantConfig?: Record<string, unknown>
  /**
   * Runtime overrides applied on top of the stored assistant config.
   * Used by the AI-ISA layer to inject per-call persona, voice, and
   * system prompt derived from buildCallContext().
   */
  assistantOverrides?: {
    name?: string
    firstMessage?: string
    voice?: {
      provider: "elevenlabs" | "playht" | "deepgram" | "openai" | "azure"
      voiceId: string
      stability?: number
      similarityBoost?: number
    }
    model?: {
      provider?: string
      model?: string
      systemPrompt?: string
      temperature?: number
    }
    variableValues?: Record<string, string>
  }
  // ── TCPA compliance context (required for outbound calls to CRM contacts) ──
  /** CRM contact (contacts.id) being called. Drives DNC, consent, RND checks. */
  contactId?: string | null
  /** Brokerage initiating the call — required for tenant-scoped audit. */
  brokerageId?: string | null
  /** auth user.id of the agent / system actor initiating. */
  initiatedBy?: string | null
  /** Transactional notices skip EWC but still enforce DNC + quiet-hours + RND. */
  transactional?: boolean
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
  // ── TCPA gate (mandatory) ──────────────────────────────────────────────────
  // Runs BEFORE the VAPI HTTP request. Throws on block so the AI ISA layer
  // sees a hard failure (which routes the lead to next-channel fallback).
  const gate = await enforceTCPACompliance({
    channel:       "call",
    phone:         params.phoneNumber,
    contactId:     params.contactId   ?? null,
    brokerageId:   params.brokerageId ?? null,
    initiatedBy:   params.initiatedBy ?? null,
    transactional: params.transactional ?? false,
  })
  if (!gate.allowed) {
    const err = new Error(gate.message ?? "TCPA gate blocked VAPI call") as Error & { blocked?: true; blockReason?: string; complianceLogId?: string }
    err.blocked = true
    err.blockReason = gate.blockReason
    err.complianceLogId = gate.logEntryId
    throw err
  }

  // ── Vendor budget gate ─────────────────────────────────────────────────────
  // Auto-pause outbound voice when the brokerage is over its monthly platform-vendor
  // ceiling. Throws a blocked error (same shape as the TCPA block) so the ISA layer
  // routes to a cheaper next-channel fallback instead of incurring more spend.
  if (params.brokerageId) {
    const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
    const { estimatePlatformVendorCost } = await import("@/lib/vendor-governance/meter-vendor")
    const budget = await checkVendorBudget({ brokerageId: params.brokerageId, addCost: estimatePlatformVendorCost("vapi", 1) })
    if (!budget.allowed) {
      const err = new Error("Vendor budget exceeded — outbound voice paused") as Error & { blocked?: true; blockReason?: string }
      err.blocked = true
      err.blockReason = "vendor_budget_exceeded"
      throw err
    }
  }

  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID
  if (!phoneNumberId) throw new Error("VAPI_PHONE_NUMBER_ID is not set")

  const body: Record<string, unknown> = {
    phoneNumberId,
    customer: { number: params.phoneNumber },
  }

  if (params.assistantId) {
    body.assistantId = params.assistantId
    if (params.assistantOverrides) {
      body.assistantOverrides = params.assistantOverrides
    }
  } else if (params.assistantConfig) {
    body.assistant = params.assistantConfig
  }

  const res = await callConnector<{ id: string; status?: string; createdAt?: string }>({
    connector: "vapi",
    baseUrl: VAPI_BASE,
    path: "call",
    method: "POST",
    auth: { style: "bearer", token: vapiKey() },
    body,
  })

  if (!res.ok || !res.data) {
    throw new Error(`VAPI initiateCall failed (${res.status ?? "—"}): ${res.error ?? "unknown error"}`)
  }

  const data = res.data
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
  const res = await callConnector({
    connector: "vapi",
    baseUrl: VAPI_BASE,
    path: `call/${vapiCallId}`,
    method: "DELETE",
    auth: { style: "bearer", token: vapiKey() },
  })

  // Already-ended / unknown call (404) is not an error.
  if (!res.ok && res.status !== 404) {
    throw new Error(`VAPI endCall failed (${res.status ?? "—"}): ${res.error ?? "unknown error"}`)
  }
}

/**
 * Get the current status of a VAPI call.
 */
export async function getCallStatus(vapiCallId: string): Promise<VapiCallStatus> {
  const res = await callConnector<{ id: string; status: string; duration?: number; endedReason?: string }>({
    connector: "vapi",
    baseUrl: VAPI_BASE,
    path: `call/${vapiCallId}`,
    method: "GET",
    auth: { style: "bearer", token: vapiKey() },
  })

  if (!res.ok || !res.data) {
    throw new Error(`VAPI getCallStatus failed (${res.status ?? "—"}): ${res.error ?? "unknown error"}`)
  }

  const data = res.data
  return {
    id: data.id,
    status: data.status,
    duration: data.duration,
    endedReason: data.endedReason,
  }
}
