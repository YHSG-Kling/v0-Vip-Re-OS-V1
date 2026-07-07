"use server"

/**
 * Phone Number Provisioning — brokerage-level toggle + manual add path.
 *
 * Two flows:
 *   1. AUTO: brokerage flips `auto_provision_phone_numbers = true`. When an
 *      agent is added, the system auto-purchases a Twilio number, registers
 *      it with VAPI, and assigns it to the agent.
 *   2. MANUAL: brokerage admin or agent clicks "Add Number" → choose
 *      between (a) purchase a new Twilio number for an area code, or
 *      (b) bring your own (BYO) — paste an existing Twilio/VAPI number SID.
 *
 * Audit trail: every provisioning event logs to phone_number_events.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

// ─── Brokerage-level settings ────────────────────────────────────────────────

export interface BrokeragePhoneSettings {
  autoProvisionPhoneNumbers: boolean
  defaultIsaVoiceId: string | null
  twilioSubaccountSid: string | null
}

export async function getBrokeragePhoneSettings(): Promise<BrokeragePhoneSettings | null> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return null

  const svc = createServiceClient()
  const { data } = await svc
    .from("brokerages")
    .select("auto_provision_phone_numbers, default_isa_voice_id, twilio_subaccount_sid")
    .eq("id", ctx.brokerageId)
    .maybeSingle()

  return {
    autoProvisionPhoneNumbers: data?.auto_provision_phone_numbers ?? false,
    defaultIsaVoiceId: data?.default_isa_voice_id ?? null,
    twilioSubaccountSid: data?.twilio_subaccount_sid ?? null,
  }
}

export async function updateBrokeragePhoneSettings(params: {
  autoProvisionPhoneNumbers?: boolean
  defaultIsaVoiceId?: string | null
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  if (!isBrokerRole(ctx.userType)) {
    return { success: false, error: "Only broker / admin / superadmin can change phone settings" }
  }

  const svc = createServiceClient()
  const updates: Record<string, any> = {}
  if (params.autoProvisionPhoneNumbers !== undefined) {
    updates.auto_provision_phone_numbers = params.autoProvisionPhoneNumbers
  }
  if (params.defaultIsaVoiceId !== undefined) {
    updates.default_isa_voice_id = params.defaultIsaVoiceId
  }

  const { error } = await svc
    .from("brokerages")
    .update(updates)
    .eq("id", ctx.brokerageId)

  return error ? { success: false, error: error.message } : { success: true }
}

// ─── Number provisioning ─────────────────────────────────────────────────────

interface ProvisionResult {
  success: boolean
  phoneNumber?: string
  twilioSid?: string
  error?: string
}

/**
 * Auto-purchase a new Twilio number for an agent in the requested area code.
 * Wires it through VAPI for AI voice handling. Idempotent at the action layer
 * (will not re-purchase if agent already has a number assigned).
 */
export async function autoProvisionAgentPhone(params: {
  agentId: string
  areaCode?: string  // optional preferred area code
}): Promise<ProvisionResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  if (!isBrokerRole(ctx.userType)) {
    return { success: false, error: "Only broker / admin can provision numbers" }
  }

  const svc = createServiceClient()

  // Resolve agent's auth user_id (vapi_phone_numbers uses agent_user_id, not agent_id)
  const { data: agent } = await svc
    .from("agents")
    .select("user_id")
    .eq("id", params.agentId)
    .maybeSingle()
  if (!agent?.user_id) {
    return { success: false, error: "Agent not found" }
  }
  const agentUserId = agent.user_id

  // Skip if agent already has a number
  const { data: existing } = await svc
    .from("vapi_phone_numbers")
    .select("phone_number")
    .eq("agent_user_id", agentUserId)
    .eq("is_active", true)
    .maybeSingle()
  if (existing?.phone_number) {
    return { success: true, phoneNumber: existing.phone_number }
  }

  // TENANT ISOLATION: numbers are purchased inside the brokerage's own Twilio
  // SUBACCOUNT (created on first provision; platform master is the parent).
  // Resolution order: BYO creds (top tier) -> tenant subaccount -> platform
  // master (legacy fallback). See lib/voice/twilio-tenancy.ts.
  const { ensureTenantSubaccount, resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  await ensureTenantSubaccount(svc, ctx.brokerageId).then(undefined, () => {}) // best-effort; master fallback below
  const creds = await resolveTenantTwilioCreds(svc, ctx.brokerageId)
  if (!creds) {
    return { success: false, error: "Twilio not configured (missing TWILIO_ACCOUNT_SID / AUTH_TOKEN)" }
  }
  const accountSid = creds.accountSid
  const authToken = creds.authToken

  // Search available numbers in area code
  let availableNumber: string | null = null
  try {
    const searchRes = await callConnector<{ available_phone_numbers?: Array<{ phone_number?: string }> }>({
      connector: "twilio", baseUrl: "https://api.twilio.com",
      path: `/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/US/Local.json`, method: "GET",
      ...(params.areaCode ? { query: { AreaCode: String(params.areaCode) } } : {}),
      auth: { style: "basic", username: accountSid, password: authToken },
    })
    if (!searchRes.ok) {
      return { success: false, error: `Twilio number search failed: ${searchRes.status}` }
    }
    availableNumber = searchRes.data?.available_phone_numbers?.[0]?.phone_number ?? null
    if (!availableNumber) {
      return { success: false, error: `No available numbers found${params.areaCode ? ` in area code ${params.areaCode}` : ""}` }
    }
  } catch (err: any) {
    return { success: false, error: `Twilio search error: ${err?.message ?? String(err)}` }
  }

  // Purchase
  let purchasedSid: string | null = null
  try {
    const purchaseRes = await callConnector<{ sid?: string }>({
      connector: "twilio", baseUrl: "https://api.twilio.com",
      path: `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`, method: "POST",
      auth: { style: "basic", username: accountSid, password: authToken },
      bodyType: "form", body: { PhoneNumber: availableNumber },
    })
    if (!purchaseRes.ok) {
      const body = purchaseRes.error ?? ""
      await logProvisionEvent(svc, {
        brokerageId: ctx.brokerageId,
        agentId: params.agentId,
        phoneNumber: availableNumber,
        eventType: "failed",
        notes: `Twilio purchase failed (${purchaseRes.status}): ${body}`,
      })
      return { success: false, error: `Twilio purchase failed (${purchaseRes.status}): ${body}` }
    }
    purchasedSid = purchaseRes.data?.sid ?? null
  } catch (err: any) {
    return { success: false, error: `Twilio purchase error: ${err?.message ?? String(err)}` }
  }

  // Save assignment (vapi_phone_numbers schema: agent_user_id + byoc_credential_id).
  // BUG FIX: this insert used to fail SILENTLY (vapi_phone_number_id was NOT NULL
  // and omitted -- the number was purchased but never saved). The column is now
  // nullable (l27-s01: the Vapi id is unknown until inbound binding registers
  // the number) and a failed save is surfaced instead of swallowed.
  const { error: saveErr } = await svc.from("vapi_phone_numbers").insert({
    agent_user_id: agentUserId,
    brokerage_id: ctx.brokerageId,
    scope_type: "agent",
    phone_number: availableNumber,
    phone_digits: availableNumber.replace(/\D/g, ""),
    byoc_credential_id: purchasedSid,
    number_source: "byoc_twilio",
    is_active: true,
  })
  if (saveErr) {
    await logProvisionEvent(svc, {
      brokerageId: ctx.brokerageId,
      agentId: params.agentId,
      phoneNumber: availableNumber,
      eventType: "failed",
      twilioSid: purchasedSid,
      notes: `Number PURCHASED on Twilio but the assignment save failed: ${saveErr.message} -- reconcile manually`,
    })
    return { success: false, error: `Number purchased but not saved (${saveErr.message}) -- support has been notified via the audit log` }
  }

  await logProvisionEvent(svc, {
    brokerageId: ctx.brokerageId,
    agentId: params.agentId,
    phoneNumber: availableNumber,
    eventType: "purchased",
    twilioSid: purchasedSid,
    costUsd: 1.15,
    notes: `Auto-provisioned via brokerage setting`,
  })

  return { success: true, phoneNumber: availableNumber, twilioSid: purchasedSid ?? undefined }
}

/**
 * Manually add an existing phone number (BYO). Used when auto-provisioning
 * is OFF or for ports-in. Caller passes the phone number + optional Twilio
 * SID if the brokerage already owns it.
 */
export async function manuallyAddAgentPhone(params: {
  agentId: string
  phoneNumber: string
  twilioSid?: string
  source?: "manually_added" | "ported_in"
}): Promise<ProvisionResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  // Both broker and the agent themselves may add their own number
  const isBroker = isBrokerRole(ctx.userType)
  if (!isBroker && ctx.agentId !== params.agentId) {
    return { success: false, error: "You can only add a number for your own profile" }
  }

  const cleaned = params.phoneNumber.replace(/[^\d+]/g, "")
  if (cleaned.length < 10) {
    return { success: false, error: "Phone number is too short" }
  }

  const svc = createServiceClient()

  // Resolve auth user_id for this agent
  const { data: agent } = await svc
    .from("agents")
    .select("user_id")
    .eq("id", params.agentId)
    .maybeSingle()
  if (!agent?.user_id) {
    return { success: false, error: "Agent not found" }
  }
  const agentUserId = agent.user_id

  // Deactivate any existing active number for this agent
  await svc
    .from("vapi_phone_numbers")
    .update({ is_active: false })
    .eq("agent_user_id", agentUserId)
    .eq("is_active", true)

  // Insert the new one — number_source CHECK only allows
  // (vapi_native|ported|byoc_twilio|byoc_vonage|forwarded), so manual = byoc_twilio
  const { error } = await svc.from("vapi_phone_numbers").insert({
    agent_user_id: agentUserId,
    brokerage_id: ctx.brokerageId,
    scope_type: "agent",
    phone_number: cleaned,
    phone_digits: cleaned.replace(/\D/g, ""),
    byoc_credential_id: params.twilioSid ?? null,
    number_source: params.source === "ported_in" ? "ported" : "byoc_twilio",
    is_active: true,
  })

  if (error) return { success: false, error: error.message }

  await logProvisionEvent(svc, {
    brokerageId: ctx.brokerageId,
    agentId: params.agentId,
    phoneNumber: cleaned,
    eventType: params.source === "ported_in" ? "ported_in" : "manually_added",
    twilioSid: params.twilioSid,
  })

  return { success: true, phoneNumber: cleaned, twilioSid: params.twilioSid }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isBrokerRole(t?: string | null) {
  return ["admin", "broker", "broker_admin", "superadmin"].includes(t ?? "")
}

async function logProvisionEvent(
  svc: ReturnType<typeof createServiceClient>,
  ev: {
    brokerageId: string
    agentId: string
    phoneNumber: string
    eventType: "purchased" | "manually_added" | "ported_in" | "released" | "failed"
    twilioSid?: string | null
    vapiNumberId?: string | null
    costUsd?: number
    notes?: string
  }
) {
  await svc.from("phone_number_events").insert({
    brokerage_id: ev.brokerageId,
    agent_id: ev.agentId,
    phone_number: ev.phoneNumber,
    event_type: ev.eventType,
    twilio_sid: ev.twilioSid ?? null,
    vapi_number_id: ev.vapiNumberId ?? null,
    cost_usd: ev.costUsd ?? null,
    notes: ev.notes ?? null,
  })
}
