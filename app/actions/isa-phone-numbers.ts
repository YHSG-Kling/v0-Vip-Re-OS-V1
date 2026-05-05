"use server"

/**
 * ISA Phone Number Management
 *
 * Server actions for the brokerage's vapi_phone_numbers configuration.
 * Surfaces in Settings → ISA Calling.
 */

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

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
  brokerageId: string
): Promise<VapiPhoneNumberRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("vapi_phone_numbers")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (error || !data) return []
  return data as VapiPhoneNumberRow[]
}

export async function createIsaPhoneNumber(params: {
  brokerageId: string
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
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("vapi_phone_numbers")
    .insert({
      brokerage_id: params.brokerageId,
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
  brokerageId: string
  active: boolean
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("vapi_phone_numbers")
    .update({ is_active: params.active })
    .eq("id", params.id)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/isa-calling")
  return { success: true }
}

export async function deleteIsaPhoneNumber(params: {
  id: string
  brokerageId: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("vapi_phone_numbers")
    .delete()
    .eq("id", params.id)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/isa-calling")
  return { success: true }
}

export async function updateIsaPhoneIvr(params: {
  id: string
  brokerageId: string
  ivrEnabled: boolean
  ivrMenu: Record<string, unknown> | null
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("vapi_phone_numbers")
    .update({
      ivr_enabled: params.ivrEnabled,
      ivr_menu: params.ivrMenu,
    })
    .eq("id", params.id)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/isa-calling")
  return { success: true }
}
