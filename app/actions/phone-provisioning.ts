"use server"

/**
 * Phone Number Provisioning — brokerage-level toggle + manual add path.
 *
 * Two flows:
 *   1. AUTO: brokerage flips `auto_provision_phone_numbers = true`. When an
 *      agent is added, the system auto-purchases a Twilio number and assigns
 *      it to the agent.
 *   2. MANUAL: brokerage admin or agent clicks "Add Number" → choose
 *      between (a) purchase a new Twilio number for an area code, or
 *      (b) bring your own (BYO) — paste an existing Twilio number SID.
 *
 * Audit trail: every provisioning event logs to phone_number_events.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { provisionNumber, logPhoneNumberEvent, searchAvailableNumbers } from "@/lib/voice/number-provisioning"
import { evaluateTenantNumberProvisioning } from "@/lib/billing/phone-plan-resolve"

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
 * AI voice handling runs on the Twilio-native lane. Idempotent at the action layer
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

  // Resolve agent's auth user_id (tenant_phone_numbers uses agent_user_id, not agent_id)
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
    .from("tenant_phone_numbers")
    .select("phone_number")
    .eq("agent_user_id", agentUserId)
    .eq("is_active", true)
    .maybeSingle()
  if (existing?.phone_number) {
    return { success: true, phoneNumber: existing.phone_number }
  }

  // THE SHARED CORE (lib/voice/number-provisioning.ts — keep-one, no fork):
  // search → purchase → persist → phone_number_events, with the canonical
  // credential resolution (BYO → tenant subaccount → platform master) inside.
  // The staff fleet console runs the SAME pipeline.
  const result = await provisionNumber(svc, {
    brokerageId: ctx.brokerageId,
    areaCode: params.areaCode ?? null,
    scopeType: "agent",
    agentUserId,
    agentId: params.agentId,
    eventSource: "tenant_action",
    eventNotes: "Auto-provisioned via brokerage setting",
    // Tenant purchase → enforce the plan's phone bundle (metered overage past
    // the included count; blocked only at the runaway hard cap).
    enforceTenantAllowance: true,
  })
  if (!result.ok) return { success: false, error: result.error }
  return { success: true, phoneNumber: result.phoneNumber, twilioSid: result.twilioSid ?? undefined }
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
    .from("tenant_phone_numbers")
    .update({ is_active: false })
    .eq("agent_user_id", agentUserId)
    .eq("is_active", true)

  // Insert the new one — number_source CHECK allows (byoc_twilio|ported)
  // only, the two sources this OS actually produces, so manual = byoc_twilio.
  const { error } = await svc.from("tenant_phone_numbers").insert({
    agent_user_id: agentUserId,
    brokerage_id: ctx.brokerageId,
    scope_type: "agent",
    phone_number: cleaned,
    phone_digits: cleaned.replace(/\D/g, ""),
    twilio_number_sid: params.twilioSid ?? null,
    number_source: params.source === "ported_in" ? "ported" : "byoc_twilio",
    is_active: true,
  })

  if (error) return { success: false, error: error.message }

  await logPhoneNumberEvent(svc, {
    brokerageId: ctx.brokerageId,
    agentId: params.agentId,
    phoneNumber: cleaned,
    eventType: params.source === "ported_in" ? "ported_in" : "manually_added",
    source: "tenant_action",
    twilioSid: params.twilioSid,
  })

  return { success: true, phoneNumber: cleaned, twilioSid: params.twilioSid }
}

// ─── Tenant-facing "Add a Number": allowance status → search → purchase ──────
// The AI-call settings had no way to CREATE a new number (only a BYO manual-add
// and the auto-provision toggle). These wire the search+purchase flow to the ONE
// provisioning core with the plan-allowance gate ON (bundle → metered overage →
// hard cap), so a broker can buy a number and see exactly what it costs.

export interface PhoneAllowanceStatus {
  tier: string
  activeNumbers: number
  includedNumbers: number
  maxNumbers: number | null
  /** Is the NEXT number inside the bundle or billable overage? */
  nextBilling: "included" | "overage"
  /** Monthly USD-cents the next number adds when it's overage (0 when included). */
  nextMonthlyOverageCents: number
  /** Can another number be provisioned at all (false only at the hard cap)? */
  canAddNumber: boolean
  capReason?: string
}

/** Surface the plan's number allowance so the "Add a Number" card can show
 *  "3 of 5 included · the next is +$2.50/mo" before the broker buys. */
export async function getPhoneAllowanceStatusAction(): Promise<
  { success: true; status: PhoneAllowanceStatus } | { success: false; error: string }
> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const v = await evaluateTenantNumberProvisioning(svc, ctx.brokerageId)
  return {
    success: true,
    status: {
      tier: v.tier,
      activeNumbers: v.activeNumbers,
      includedNumbers: v.includedNumbers,
      maxNumbers: v.maxNumbers,
      nextBilling: v.billing,
      nextMonthlyOverageCents: v.monthlyOverageCents,
      canAddNumber: v.allowed,
      capReason: v.allowed ? undefined : v.reason,
    },
  }
}

export interface NumberCandidateView {
  phoneNumber: string
  locality: string | null
  region: string | null
}

/** Search purchasable numbers for the tenant (broker/admin only). Honest about
 *  a not-configured carrier — never fakes candidates. */
export async function searchBrokerageNumbersAction(params: {
  areaCode?: string
  locality?: string
}): Promise<{ success: true; candidates: NumberCandidateView[] } | { success: false; error: string; notConfigured?: boolean }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!isBrokerRole(ctx.userType)) return { success: false, error: "Only broker / admin can search numbers" }

  const svc = createServiceClient()
  const res = await searchAvailableNumbers(svc, ctx.brokerageId, {
    areaCode: params.areaCode ?? null,
    locality: params.locality ?? null,
    limit: 10,
  })
  if (!res.ok) return { success: false, error: res.error, notConfigured: res.notConfigured }
  return {
    success: true,
    candidates: res.candidates.map((c) => ({ phoneNumber: c.phoneNumber, locality: c.locality, region: c.region })),
  }
}

/** Purchase a specific number for the brokerage (or a named agent). Runs the ONE
 *  provisioning core with the plan-allowance gate ON, so the buy is bundled or
 *  metered-overage, and blocked only at the hard cap. */
export async function purchaseBrokerageNumberAction(params: {
  phoneNumber: string
  /** Optional: assign to a specific agent (agents.id); else brokerage-scoped inventory. */
  agentId?: string
}): Promise<
  | { success: true; phoneNumber: string; billing: "included" | "overage"; monthlyOverageCents: number }
  | { success: false; error: string; capReached?: boolean }
> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!isBrokerRole(ctx.userType)) return { success: false, error: "Only broker / admin can purchase numbers" }

  const svc = createServiceClient()

  // If an agent was named, resolve their auth user_id for the agent-scoped row.
  let agentUserId: string | null = null
  if (params.agentId) {
    const { data: agent } = await svc.from("agents").select("user_id, brokerage_id").eq("id", params.agentId).maybeSingle()
    if (!agent?.user_id) return { success: false, error: "Agent not found" }
    if ((agent as any).brokerage_id !== ctx.brokerageId) return { success: false, error: "Agent belongs to a different brokerage" }
    agentUserId = agent.user_id
  }

  const result = await provisionNumber(svc, {
    brokerageId: ctx.brokerageId,
    phoneNumber: params.phoneNumber,
    scopeType: params.agentId ? "agent" : "brokerage",
    agentUserId,
    agentId: params.agentId ?? null,
    eventSource: "tenant_action",
    eventNotes: "Purchased via Add-a-Number in AI call settings",
    bindToVoiceLane: true,
    enforceTenantAllowance: true,
  })
  if (!result.ok) return { success: false, error: result.error, capReached: result.capReached }
  return {
    success: true,
    phoneNumber: result.phoneNumber,
    billing: result.billing ?? "included",
    monthlyOverageCents: result.monthlyOverageCents ?? 0,
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isBrokerRole(t?: string | null) {
  return ["admin", "broker", "broker_admin", "superadmin"].includes(t ?? "")
}
