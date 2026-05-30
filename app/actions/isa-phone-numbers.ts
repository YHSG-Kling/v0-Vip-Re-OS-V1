"use server"

/**
 * ISA Phone Number Management
 *
 * Server actions for the brokerage's vapi_phone_numbers configuration.
 * Surfaces in Settings → ISA Calling.
 *
 * Every export previously trusted a caller-supplied brokerageId and ran
 * with no auth check. Concrete impact: any signed-in user could
 *   - list any brokerage's Vapi/Twilio phone roster (including BYOC
 *     credential refs and IVR routing)
 *   - register a new phone number against another brokerage (telecom
 *     billing fraud — calls/SMS get charged to that brokerage's vapi
 *     account)
 *   - toggle/delete any brokerage's ISA numbers (DoS the inbound funnel)
 *   - rewrite IVR menus on any brokerage's numbers
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

export interface VapiPhoneNumberRow {
  id: string
  brokerage_id: string | null
  team_id: string | null
  agent_user_id: string | null
  scope_type: "platform" | "brokerage" | "team" | "agent"
  vapi_phone_number_id: string
  phone_number: string
  phone_digits: string | null
  number_source:
    | "vapi_native"
    | "ported"
    | "byoc_twilio"
    | "byoc_vonage"
    | "forwarded"
  byoc_credential_id: string | null
  forwarding_target: string | null
  department: string | null
  ivr_enabled: boolean
  ivr_menu: Record<string, unknown> | null
  is_active: boolean
  created_at: string
}

function digitsOf(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10)
}

export async function listIsaPhoneNumbers(
  _brokerageId?: string  // ignored — derived from session
): Promise<VapiPhoneNumberRow[]> {
  const auth = await requireBrokerageAdmin()
  if (!auth.ok) return []

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("vapi_phone_numbers")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })

  if (error || !data) return []
  return data as VapiPhoneNumberRow[]
}

export async function createIsaPhoneNumber(params: {
  brokerageId?: string  // ignored — derived from session
  scopeType: "brokerage" | "team" | "agent"
  agentUserId?: string
  teamId?: string
  vapiPhoneNumberId: string
  phoneNumber: string
  numberSource: "vapi_native" | "ported" | "byoc_twilio" | "byoc_vonage" | "forwarded"
  byocCredentialId?: string
  forwardingTarget?: string
  department?: string
  ivrEnabled?: boolean
  ivrMenu?: Record<string, unknown>
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
  if (params.byocCredentialId) {
    const { data: cred } = await supabase
      .from("platform_credentials").select("brokerage_id").eq("id", params.byocCredentialId).maybeSingle()
    if (!cred || cred.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden: BYOC credential not in your brokerage" }
    }
  }

  const { data, error } = await supabase
    .from("vapi_phone_numbers")
    .insert({
      brokerage_id: auth.brokerageId,
      team_id: params.teamId ?? null,
      agent_user_id: params.agentUserId ?? null,
      scope_type: params.scopeType,
      vapi_phone_number_id: params.vapiPhoneNumberId,
      phone_number: params.phoneNumber,
      phone_digits: digitsOf(params.phoneNumber),
      number_source: params.numberSource,
      byoc_credential_id: params.byocCredentialId ?? null,
      forwarding_target: params.forwardingTarget ?? null,
      department: params.department ?? null,
      ivr_enabled: params.ivrEnabled ?? false,
      ivr_menu: params.ivrMenu ?? null,
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

export async function updateIsaPhoneIvr(params: {
  id: string
  brokerageId?: string  // ignored — derived from session
  ivrEnabled: boolean
  ivrMenu: Record<string, unknown> | null
}): Promise<{ success: boolean; error?: string }> {
  const auth = await requireBrokerageAdmin()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from("vapi_phone_numbers")
    .update({
      ivr_enabled: params.ivrEnabled,
      ivr_menu: params.ivrMenu,
    })
    .eq("id", params.id)
    .eq("brokerage_id", auth.brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/isa-calling")
  return { success: true }
}
