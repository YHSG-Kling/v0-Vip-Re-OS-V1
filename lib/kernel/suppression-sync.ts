// lib/kernel/suppression-sync.ts
// KERNEL SYNC LAYER: Keeps leads and contacts suppression states synchronized
// Bi-directional sync ensures no escape paths for suppression bypass

import { createServiceClient } from "@/lib/supabase/service"
import type { SupabaseClient } from "@supabase/supabase-js"

export interface SyncSuppressionInput {
  sourceType: "lead" | "contact"
  sourceId: string
  suppressionFields: {
    dnc_status?: boolean
    call_stop_flag?: boolean
    email_opt_out?: boolean
    sms_opt_out?: boolean
    tcpa_consent?: boolean
    opt_out_channels?: string[]
  }
}

export interface SyncSuppressionOutput {
  synced: boolean
  targetType: "lead" | "contact"
  targetId: string
  fieldsUpdated: string[]
  timestamp: string
}

/**
 * KERNEL SYNC: Apply suppression changes to target record
 * 
 * When a lead updates suppression → sync to contact
 * When a contact updates suppression → sync to lead (if linked)
 * 
 * Input: SyncSuppressionInput { sourceType, sourceId, suppressionFields }
 * Output: SyncSuppressionOutput { synced, targetType, fieldsUpdated }
 */
export async function syncSuppressionState(
  input: SyncSuppressionInput
): Promise<SyncSuppressionOutput> {
  const supabase = await createServiceClient()
  const fieldsUpdated: string[] = []
  let targetId = ""
  let targetType: "lead" | "contact" = input.sourceType === "lead" ? "contact" : "lead"

  try {
    // ─── FIND LINKED RECORD ────────────────────────────────────────────────
    if (input.sourceType === "lead") {
      // Find contact linked to this lead
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .select("contact_id")
        .eq("id", input.sourceId)
        .maybeSingle()

      if (leadError || !lead?.contact_id) {
        console.warn("[Sync] Lead not linked to contact:", input.sourceId)
        return {
          synced: false,
          targetType: "contact",
          targetId: "",
          fieldsUpdated: [],
          timestamp: new Date().toISOString(),
        }
      }
      targetId = lead.contact_id
    } else {
      // Find lead linked to this contact
      const { data: contact, error: contactError } = await supabase
        .from("contacts")
        .select("lead_id")
        .eq("id", input.sourceId)
        .maybeSingle()

      if (contactError || !contact?.lead_id) {
        console.warn("[Sync] Contact not linked to lead:", input.sourceId)
        return {
          synced: false,
          targetType: "lead",
          targetId: "",
          fieldsUpdated: [],
          timestamp: new Date().toISOString(),
        }
      }
      targetId = contact.lead_id
    }

    // ─── BUILD UPDATE PAYLOAD ──────────────────────────────────────────────
    const updatePayload: Record<string, any> = {}

    if (input.suppressionFields.dnc_status !== undefined) {
      updatePayload.dnc_status = input.suppressionFields.dnc_status
      fieldsUpdated.push("dnc_status")
    }
    if (input.suppressionFields.call_stop_flag !== undefined) {
      updatePayload.call_stop_flag = input.suppressionFields.call_stop_flag
      fieldsUpdated.push("call_stop_flag")
    }
    if (input.suppressionFields.email_opt_out !== undefined) {
      updatePayload.email_opt_out = input.suppressionFields.email_opt_out
      fieldsUpdated.push("email_opt_out")
    }
    if (input.suppressionFields.sms_opt_out !== undefined) {
      updatePayload.sms_opt_out = input.suppressionFields.sms_opt_out
      fieldsUpdated.push("sms_opt_out")
    }
    if (input.suppressionFields.tcpa_consent !== undefined) {
      updatePayload.tcpa_consent = input.suppressionFields.tcpa_consent
      fieldsUpdated.push("tcpa_consent")
    }
    if (input.suppressionFields.opt_out_channels !== undefined) {
      updatePayload.opt_out_channels = input.suppressionFields.opt_out_channels
      fieldsUpdated.push("opt_out_channels")
    }

    if (fieldsUpdated.length === 0) {
      return {
        synced: true,
        targetType,
        targetId,
        fieldsUpdated: [],
        timestamp: new Date().toISOString(),
      }
    }

    // ─── APPLY UPDATE ──────────────────────────────────────────────────────
    const tableName = targetType === "lead" ? "leads" : "contacts"
    const { error: updateError } = await supabase
      .from(tableName)
      .update(updatePayload)
      .eq("id", targetId)

    if (updateError) {
      console.error(`[Sync] Failed to update ${tableName}:`, updateError)
      return {
        synced: false,
        targetType,
        targetId,
        fieldsUpdated: [],
        timestamp: new Date().toISOString(),
      }
    }

    return {
      synced: true,
      targetType,
      targetId,
      fieldsUpdated,
      timestamp: new Date().toISOString(),
    }
  } catch (error) {
    console.error("[Sync] Error syncing suppression state:", error)
    return {
      synced: false,
      targetType,
      targetId,
      fieldsUpdated: [],
      timestamp: new Date().toISOString(),
    }
  }
}

/**
 * BATCH SYNC: Sync suppression to contact suppression list (audit trail)
 */
export async function recordSuppressionEvent(
  contactId: string,
  suppressionType: "dnc" | "call_stop" | "email_opt_out" | "sms_opt_out" | "manual",
  reason: string,
  source: "inbound" | "contact_request" | "admin" | "webhook"
): Promise<boolean> {
  const supabase = await createServiceClient()

  try {
    const { error } = await supabase.from("contact_suppression_list").insert({
      contact_id: contactId,
      suppression_type: suppressionType,
      reason,
      source,
      recorded_at: new Date().toISOString(),
    })

    if (error) {
      console.error("[Sync] Failed to record suppression event:", error)
      return false
    }

    return true
  } catch (error) {
    console.error("[Sync] Error recording suppression event:", error)
    return false
  }
}
