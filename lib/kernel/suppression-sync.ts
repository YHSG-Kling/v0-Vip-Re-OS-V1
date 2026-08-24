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
      // Find lead linked to this contact (leads point at contacts via leads.contact_id)
      const { data: linkedLead, error: linkedLeadError } = await supabase
        .from("leads")
        .select("id")
        .eq("contact_id", input.sourceId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (linkedLeadError || !linkedLead?.id) {
        console.warn("[Sync] Contact not linked to lead:", input.sourceId)
        return {
          synced: false,
          targetType: "lead",
          targetId: "",
          fieldsUpdated: [],
          timestamp: new Date().toISOString(),
        }
      }
      targetId = linkedLead.id
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

// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONE — recordSuppressionEvent(contactId, suppressionType, reason, source)
// ═══════════════════════════════════════════════════════════════════════════
//
// DELETED (owner ruling 2, 2026-08-24). It was a SECOND writer of
// `contact_suppression_list`, and it could never have written a row.
//
// ── MEASURED, NOT REASONED ABOUT ───────────────────────────────────────────
// Live on hrvaqgvukzxfskkcrwbt, 2026-08-24. `contact_suppression_list` has FOUR
// NOT NULL columns with NO DEFAULT:
//
//     brokerage_id, channel, suppression_reason, source
//
// This function supplied `suppression_reason` and `source`. It named neither
// `brokerage_id` nor `channel`, so every insert it ever attempted was refused
// 23502 (not-null violation). Probed directly against the live table inside a
// trapped block: the exact insert this body performed raises. The table holds
// ZERO rows. Its ONE caller — app/api/webhooks/inbound-suppression/route.ts —
// discarded the boolean and returned `success: true` to the feed, so an external
// opt-out was recorded in the contact FLAGS and never in the AUDIT LEDGER, and
// nothing anywhere said so.
//
// Its own comment is the trap CLAUDE.md §3 warns about, in written form:
//     "contact_suppression_list real cols: suppression_reason (no
//      suppression_type/reason/recorded_at; created_at defaults)."
// Someone checked which of the columns they were WRITING exist, and never
// checked which REQUIRED columns they were not writing.
//
// ── THE SURVIVOR, AT file:line ─────────────────────────────────────────────
//
//     lib/kernel/compliance/check-suppression.ts:275  addSuppression()
//
// which lib/kernel/crm.ts:1178 already designates as the only writer of this
// table. It supplies all four required columns, maps the channel through the
// live CHECK vocabulary, ALSO writes the contact's own opt-out flags and a
// `contact_consent_events` audit row, and returns an AddSuppressionResult whose
// `suppressed` is true only when the row is known to have landed — so a caller
// can no longer tell a person they were suppressed when they were not.
//
// Nothing had to be merged forward: this copy carried no column, no channel and
// no consent event the survivor lacks. The one caller was converted in the same
// change (see app/api/webhooks/inbound-suppression/route.ts, "RECORD SUPPRESSION
// EVENT"), and it now derives the `brokerage_id` this function could not supply
// from the contact the inbound identity actually resolved to.
//
// `syncSuppressionState` above is untouched — it is the lead↔contact FLAG mirror,
// a different job, and it has its own live caller.
