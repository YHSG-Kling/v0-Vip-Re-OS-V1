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
import { resolveActingContext, resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { provisionNumber, logPhoneNumberEvent, searchAvailableNumbers } from "@/lib/voice/number-provisioning"
import { evaluateTenantNumberProvisioning } from "@/lib/billing/phone-plan-resolve"

// ─── Brokerage-level settings ────────────────────────────────────────────────

export interface BrokeragePhoneSettings {
  autoProvisionPhoneNumbers: boolean
  defaultIsaVoiceId: string | null
  twilioSubaccountSid: string | null
}

export async function getBrokeragePhoneSettings(): Promise<BrokeragePhoneSettings | null> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.brokerageId) return null

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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId) {
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
  /** Did the number's Twilio webhooks get pointed at our AI voice lane? */
  bound?: boolean
  /** Honest note when the number exists/bills but the webhook bind failed. */
  bindNote?: string
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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  if (!isBrokerRole(ctx.userType)) {
    return { success: false, error: "Only broker / admin can provision numbers" }
  }

  const svc = createServiceClient()

  // Resolve agent's auth user_id (tenant_phone_numbers uses agent_user_id, not
  // agent_id). The agents.id is CALLER-SUPPLIED, so it is resolved AND
  // tenant-checked — same gate purchaseBrokerageNumberAction applies. Without
  // it a broker of tenant A could buy a Twilio number on A's bill and bind it
  // to an agent of tenant B, taking over that agent's inbound call routing.
  const { data: agent, error: agentErr } = await svc
    .from("agents")
    .select("user_id, brokerage_id")
    .eq("id", params.agentId)
    .maybeSingle()
  if (agentErr) {
    return { success: false, error: "Could not verify agent — refusing to provision" }
  }
  if (!agent?.user_id) {
    return { success: false, error: "Agent not found" }
  }
  if (agent.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Agent belongs to a different brokerage" }
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
    // A purchased number that is never bound has no VoiceUrl/SmsUrl pointing at
    // our AI lane — it rings into nothing. This path was the ONLY tenant
    // purchase lane that left it off, so every auto-provisioned agent number
    // cost real Twilio money and then could not answer a call. The sibling
    // purchaseBrokerageNumberAction has always set it; the two are now
    // consistent.
    bindToVoiceLane: true,
    // Tenant purchase → enforce the plan's phone bundle (metered overage past
    // the included count; blocked only at the runaway hard cap).
    enforceTenantAllowance: true,
  })
  if (!result.ok) return { success: false, error: result.error }
  return {
    success: true,
    phoneNumber: result.phoneNumber,
    twilioSid: result.twilioSid ?? undefined,
    // Honest: a bind failure never undoes a real purchase, so it is reported
    // rather than swallowed — the number exists and is billing either way.
    bound: result.bound,
    bindNote: result.bindNote,
  }
}

/**
 * Manually add an existing phone number (BYO). Used when auto-provisioning
 * is OFF or for ports-in. Caller passes the phone number + optional Twilio
 * SID if the brokerage already owns it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SECURITY — why this path proves ownership (w2s3)
 *
 * This endpoint takes a phone number as a FREE STRING from the caller and,
 * before this pass, wrote it straight into `tenant_phone_numbers` with no
 * proof that the brokerage owned it and no check that anyone else already
 * had it. `tenant_phone_numbers` has **no unique constraint** on
 * `phone_number` or `phone_digits` (verified live on hrvaqgvukzxfskkcrwbt —
 * only pkey, the brokerage FK, and two CHECKs).
 *
 * Both inbound routing paths resolve the tenant from the dialled number by
 *   `.eq("phone_digits", digits).eq("is_active", true).maybeSingle()`
 * (`lib/voice/twilio-voice.ts:resolveInboundContext`,
 *  `lib/voice/sms-inbound.ts`), and both do `const { data: num }` with no
 * `error` destructure. `.maybeSingle()` ERRORS when more than one row
 * matches, so `num` comes back undefined and the resolver returns `null`.
 *
 * So any authenticated agent — this action deliberately allows a plain agent
 * to add their own number, the lowest-privilege role — could insert a row
 * claiming a phone number already active for a DIFFERENT brokerage and
 * blackhole that brokerage's inbound calls and SMS. If the victim's row was
 * later deactivated, the attacker's row became the sole match and inherited
 * the routing.
 *
 * Two guards close it: a global active-number collision check (fails closed),
 * and a real ownership proof against the brokerage's resolved Twilio account.
 * ─────────────────────────────────────────────────────────────────────────
 */
export async function manuallyAddAgentPhone(params: {
  agentId: string
  phoneNumber: string
  twilioSid?: string
  source?: "manually_added" | "ported_in"
}): Promise<ProvisionResult> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  // Both broker and the agent themselves may add their own number
  const isBroker = isBrokerRole(ctx.userType)
  if (!isBroker && ctx.agentId !== params.agentId) {
    return { success: false, error: "You can only add a number for your own profile" }
  }

  // Normalise once. `phone_digits` is the column both inbound resolvers key
  // on, so it — not the display string — is what must be unique.
  const digits = String(params.phoneNumber ?? "").replace(/\D/g, "")
  if (digits.length < 10 || digits.length > 15) {
    return { success: false, error: "Enter a valid phone number" }
  }
  // E.164 for the display column and for the Twilio lookup below.
  const cleaned = digits.length === 10 ? `+1${digits}` : `+${digits}`

  const svc = createServiceClient()

  // GUARD 1 — global collision. Deliberately NOT scoped to the caller's
  // brokerage: the whole point is that another tenant may already hold this
  // number, and that is precisely the case that must be refused.
  const { data: collision, error: collisionErr } = await svc
    .from("tenant_phone_numbers")
    .select("id, brokerage_id")
    .eq("phone_digits", digits)
    .eq("is_active", true)
    .limit(1)

  // Fails CLOSED. A refused read is not "nobody has it" — treating it that
  // way is how this guard would become decorative.
  if (collisionErr) {
    return { success: false, error: "Could not verify the number is free — nothing was added" }
  }
  if (collision && collision.length > 0) {
    const owner = (collision[0] as any).brokerage_id
    // Do not disclose which other tenant holds it.
    return {
      success: false,
      error:
        owner === ctx.brokerageId
          ? "That number is already active on your account"
          : "That number is already in use on this platform",
    }
  }

  // GUARD 2 — ownership proof. A BYO/ported number is only legitimately
  // yours if it actually sits in the Twilio account this brokerage resolves
  // to (BYO → tenant subaccount → platform master). Ask Twilio rather than
  // trusting the caller-supplied SID, and take the SID from the answer.
  const ownership = await verifyNumberOwnedByTenant(svc, ctx.brokerageId, cleaned)
  if (!ownership.ok) {
    return { success: false, error: ownership.error }
  }
  const verifiedSid = ownership.twilioSid

  // Resolve auth user_id for this agent. Tenant-checked for the same reason as
  // autoProvisionAgentPhone — and here the stakes are higher: the very next
  // statement DEACTIVATES whatever active number the target agent already has.
  // Un-scoped, a broker of tenant A could silently cut over another tenant's
  // agent line to a number A controls.
  const { data: agent, error: agentErr } = await svc
    .from("agents")
    .select("user_id, brokerage_id")
    .eq("id", params.agentId)
    .maybeSingle()
  if (agentErr) {
    return { success: false, error: "Could not verify agent — refusing to add number" }
  }
  if (!agent?.user_id) {
    return { success: false, error: "Agent not found" }
  }
  if (agent.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Agent belongs to a different brokerage" }
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
  // `.select("id")` because the row id is the handle bindNumberToTwilioLane
  // needs; without it the number is registered but never answers.
  const { data: inserted, error } = await svc
    .from("tenant_phone_numbers")
    .insert({
      agent_user_id: agentUserId,
      brokerage_id: ctx.brokerageId,
      scope_type: "agent",
      phone_number: cleaned,
      phone_digits: digits,
      // The SID Twilio confirmed, not the one the caller claimed.
      twilio_number_sid: verifiedSid,
      number_source: params.source === "ported_in" ? "ported" : "byoc_twilio",
      is_active: true,
    })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }

  // Point the number's VoiceUrl / SmsUrl / StatusCallback at our AI lane.
  // Without this the row exists, the UI says the agent has a number, and
  // every call to it goes wherever its old webhooks pointed. Best-effort and
  // reported honestly — a bind failure does not undo a real registration.
  let bound = false
  let bindNote: string | undefined
  const numberRowId = (inserted as { id?: string } | null)?.id
  if (numberRowId) {
    const { bindNumberToTwilioLane } = await import("@/lib/voice/twilio-voice")
    const bind = await bindNumberToTwilioLane(svc, numberRowId).catch((err: any) => ({
      ok: false as const,
      error: String(err?.message ?? err),
    }))
    bound = bind.ok
    if (!bind.ok) {
      bindNote = `Number saved, but pointing it at the AI lane failed: ${bind.error}`
    }
  } else {
    bindNote = "Number saved, but the row id was not returned — bind it from its row later"
  }

  await logPhoneNumberEvent(svc, {
    brokerageId: ctx.brokerageId,
    agentId: params.agentId,
    phoneNumber: cleaned,
    eventType: params.source === "ported_in" ? "ported_in" : "manually_added",
    source: "tenant_action",
    twilioSid: verifiedSid ?? undefined,
  })

  return { success: true, phoneNumber: cleaned, twilioSid: verifiedSid ?? undefined, bound, bindNote }
}

/**
 * Prove the brokerage actually owns `phoneNumber` by looking it up in the
 * Twilio account this tenant resolves to (BYO → tenant subaccount → platform
 * master, via the canonical resolver). Returns Twilio's own SID for the
 * number so nothing downstream has to trust a caller-supplied one.
 *
 * Honest about a not-configured carrier: it REFUSES rather than waving the
 * number through, because "we can't check" must not mean "it's yours".
 */
async function verifyNumberOwnedByTenant(
  svc: any,
  brokerageId: string,
  e164: string,
): Promise<{ ok: true; twilioSid: string | null } | { ok: false; error: string }> {
  const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  const creds = await resolveTenantTwilioCreds(svc, brokerageId)
  if (!creds) {
    return {
      ok: false,
      error: "Telephony isn't connected yet, so number ownership can't be verified — nothing was added.",
    }
  }

  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<{ incoming_phone_numbers?: Array<Record<string, any>> }>({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${creds.accountSid}/IncomingPhoneNumbers.json`,
    method: "GET",
    query: { PhoneNumber: e164, PageSize: "1" },
    auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
  })

  if (!res.ok) {
    return { ok: false, error: `Could not verify the number with the carrier (${res.status ?? "—"}) — nothing was added.` }
  }

  const match = (res.data?.incoming_phone_numbers ?? [])[0]
  if (!match) {
    return {
      ok: false,
      error:
        "That number isn't in your telephony account. Numbers must be owned by your brokerage before they can be added.",
    }
  }

  return { ok: true, twilioSid: (match.sid as string) ?? null }
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
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
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
  // READ — this only ASKS the carrier what is purchasable; nothing is bought and
  // no row is written (that is purchaseBrokerageNumberAction, below, which stays
  // on the writer entry point). The READER seam, so a read_only act-as grant can
  // see the same inventory a full grant sees (§5). Same tenant, same broker-role
  // predicate, same service client — nothing is widened but the grant mode.
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
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
  // SCOPE LADDER (kept inline — also drives per-agent vs brokerage provisioning
  // scope): 'superadmin' removed — dead as users.user_type (0 live rows);
  // broker_owner added — storable seat that owns the brokerage.
  return ["admin", "broker", "broker_owner", "broker_admin"].includes(t ?? "")
}
