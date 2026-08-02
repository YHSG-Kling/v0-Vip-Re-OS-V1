"use server"

/**
 * ISA Phone Number Management
 *
 * Server actions for the brokerage's phone inventory (vapi_phone_numbers — the
 * ledger the Twilio voice/SMS lane routes by). Surfaces in Settings → ISA
 * Calling, and registers a number the brokerage ALREADY owns. Buying a new one
 * is the other path entirely: searchBrokerageNumbersAction →
 * purchaseBrokerageNumberAction → lib/voice/number-provisioning.provisionNumber.
 *
 * Every export previously trusted a caller-supplied brokerageId and ran
 * with no auth check. Concrete impact: any signed-in user could
 *   - list any brokerage's phone roster
 *   - register a new phone number against another brokerage (telecom
 *     billing fraud — calls/SMS get charged to that brokerage's account)
 *   - toggle/delete any brokerage's ISA numbers (DoS the inbound funnel)
 *
 * l40-s01 then found this path was ALSO unusable, in two independent ways, both
 * because it was still speaking a retired provider's vocabulary:
 *   · it required a "VAPI Phone Number ID" that nothing in the tree reads, so
 *     the form could not be submitted without an id from a dashboard this OS
 *     has no account for;
 *   · it validated the BYOC field by looking it up in platform_credentials,
 *     but the column it writes holds a TWILIO NUMBER SID — so whenever the
 *     admin filled that field the lookup missed and the action refused.
 * Both are gone. What the lane actually needs is the Twilio number SID, which
 * is what bindNumberToTwilioLane puts in the IncomingPhoneNumbers path.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

async function requireBrokerageAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  const isAdmin = ["admin", "broker", "broker_owner", "superadmin", "super_admin"]
    .includes(u.user_type ?? "")
  if (!isAdmin) return { ok: false, error: "Forbidden: brokerage admin only" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

/** The two sources this OS actually produces — matches the live CHECK. */
export type PhoneNumberSource = "byoc_twilio" | "ported"

export interface PhoneNumberRow {
  id: string
  brokerage_id: string | null
  team_id: string | null
  agent_user_id: string | null
  scope_type: "platform" | "brokerage" | "team" | "agent"
  phone_number: string
  phone_digits: string | null
  number_source: PhoneNumberSource
  /** Twilio IncomingPhoneNumbers .sid — the handle the webhook binding needs. */
  twilio_number_sid: string | null
  department: string | null
  is_active: boolean
  created_at: string
}

function digitsOf(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10)
}

export async function listIsaPhoneNumbers(
  _brokerageId?: string  // ignored — derived from session
): Promise<PhoneNumberRow[]> {
  const auth = await requireBrokerageAdmin()
  if (!auth.ok) return []

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("vapi_phone_numbers")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })

  if (error || !data) return []
  return data as PhoneNumberRow[]
}

export async function createIsaPhoneNumber(params: {
  brokerageId?: string  // ignored — derived from session
  scopeType: "brokerage" | "team" | "agent"
  agentUserId?: string
  teamId?: string
  phoneNumber: string
  numberSource: PhoneNumberSource
  /** Twilio IncomingPhoneNumbers .sid. Optional: a number can be registered
   *  now and bound later, but until it is present the webhooks cannot be
   *  registered and the number will not receive calls or texts. */
  twilioNumberSid?: string
  department?: string
}): Promise<{ success: boolean; id?: string; error?: string }> {
  const auth = await requireBrokerageAdmin()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  // If team/agent scope, verify those belong to caller's brokerage
  if (params.teamId) {
    const { data: team } = await supabase
      .from("teams").select("brokerage_id").eq("id", params.teamId).maybeSingle()
    if (!team || team.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden: team not in your brokerage" }
    }
  }
  if (params.agentUserId) {
    const { data: agentUser } = await supabase
      .from("users").select("brokerage_id").eq("id", params.agentUserId).maybeSingle()
    if (!agentUser || agentUser.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden: agent not in your brokerage" }
    }
  }
  // The SID is an OPAQUE TWILIO identifier, not a row in our tables, so there
  // is no ownership lookup to do — the previous one pointed at
  // platform_credentials and could never match. What we can check is its shape,
  // which catches the common paste error early instead of at bind time.
  const sid = params.twilioNumberSid?.trim() || null
  if (sid && !/^PN[0-9a-fA-F]{32}$/.test(sid)) {
    return {
      success: false,
      error: "That does not look like a Twilio number SID — it starts with 'PN' and is 34 characters. Find it on the number's page in the Twilio console.",
    }
  }

  const { data, error } = await supabase
    .from("vapi_phone_numbers")
    .insert({
      brokerage_id: auth.brokerageId,
      team_id: params.teamId ?? null,
      agent_user_id: params.agentUserId ?? null,
      scope_type: params.scopeType,
      phone_number: params.phoneNumber,
      phone_digits: digitsOf(params.phoneNumber),
      number_source: params.numberSource,
      twilio_number_sid: sid,
      department: params.department ?? null,
      is_active: true,
    })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/isa-calling")
  return { success: true, id: data?.id }
}

export async function toggleIsaPhoneNumber(params: {
  id: string
  brokerageId?: string  // ignored — derived from session
  active: boolean
}): Promise<{ success: boolean; error?: string }> {
  const auth = await requireBrokerageAdmin()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from("vapi_phone_numbers")
    .update({ is_active: params.active })
    .eq("id", params.id)
    .eq("brokerage_id", auth.brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/isa-calling")
  return { success: true }
}

export async function deleteIsaPhoneNumber(params: {
  id: string
  brokerageId?: string  // ignored — derived from session
}): Promise<{ success: boolean; error?: string }> {
  const auth = await requireBrokerageAdmin()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from("vapi_phone_numbers")
    .delete()
    .eq("id", params.id)
    .eq("brokerage_id", auth.brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/isa-calling")
  return { success: true }
}
