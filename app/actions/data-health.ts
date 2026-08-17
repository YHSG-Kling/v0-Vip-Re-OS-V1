"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"

// Get data health validation logs
export async function getDataHealthLogs(params: { status?: string }) {
  const supabase = await createClient()
  
  try {
    let query = supabase
      .from("data_health_logs")
      .select(`
        *,
        contacts (
          id,
          first_name,
          last_name,
          email,
          phone
        )
      `)
      .order("detected_at", { ascending: false })
      .limit(100)
    
    if (params.status) {
      query = query.eq("validation_status", params.status)
    }
    
    const { data, error } = await query
    
    if (error) throw error
    
    return { success: true, logs: data || [] }
  } catch (error) {
    console.error("Failed to get data health logs:", error)
    return { success: false, error: "Failed to fetch data health logs", logs: [] }
  }
}

// Get data health statistics
export async function getDataHealthStats() {
  const supabase = await createClient()
  
  try {
    // tenant anchor (scope burn-down): count only the caller's brokerage's contacts
    const ctx = await getAgentContext()
    const { count: totalLeads } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", ctx.brokerageId)
    
    // Get invalid contacts count
    const { count: invalid } = await supabase
      .from("data_health_logs")
      .select("*", { count: "exact", head: true })
      .eq("validation_status", "Invalid")
    
    // Get risky contacts count
    const { count: risky } = await supabase
      .from("data_health_logs")
      .select("*", { count: "exact", head: true })
      .eq("validation_status", "Risky")
    
    // Get last scan date (remove .single() to handle 0 results gracefully)
    const { data: lastScans } = await supabase
      .from("data_health_scans")
      .select("completed_at")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1)
    
    const lastScan = lastScans && lastScans.length > 0 ? lastScans[0] : null
    
    const totalCount = totalLeads || 0
    const healthy = Math.max(0, totalCount - (invalid || 0) - (risky || 0))
    
    return {
      success: true,
      stats: {
        totalLeads: totalCount,
        healthy,
        risky: risky || 0,
        invalid: invalid || 0,
        lastGlobalScan: lastScan?.completed_at 
          ? new Date(lastScan.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : "Never",
      },
    }
  } catch (error) {
    console.error("Failed to get data health stats:", error)
    return { 
      success: false, 
      error: "Failed to fetch stats",
      stats: {
        totalLeads: 0,
        healthy: 0,
        risky: 0,
        invalid: 0,
        lastGlobalScan: "Never",
      },
    }
  }
}

// Run data hygiene scan
/**
 * A hygiene scan is ONE TENANT'S scan, and both rows it writes are that
 * tenant's data — not the platform's.
 *
 * Both writes used to omit brokerage_id, and the SELECT policy on each table is
 * `is_platform_admin() OR (brokerage_id IS NULL) OR has_brokerage_access(brokerage_id)`
 * granted to `authenticated`. A NULL brokerage_id SATISFIES that predicate for
 * every tenant, so every unstamped scan and every unstamped finding was
 * readable by every signed-in user of every other brokerage. That matters most
 * on data_health_logs, whose `current_value` column holds the offending field
 * VERBATIM — a real contact's email address or phone number. The leak was
 * contact PII, not just scan metadata.
 *
 * Stamping also repairs a control that could never fire: the delete policy on
 * both tables is `is_platform_admin() OR (is_brokerage_admin() AND
 * has_brokerage_access(brokerage_id))`, and `has_brokerage_access(NULL)` is
 * false — so until now a brokerage admin could not delete their own scan
 * history at all.
 */
export async function runDataHygieneScan() {
  // Tenant from the SESSION, never from a parameter (this export takes none).
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { success: false, error: "Unauthenticated", invalidCount: 0 }
  }
  if (!ctx.brokerageId) {
    return { success: false, error: "Brokerage not configured", invalidCount: 0 }
  }

  const supabase = await createClient()

  try {
    // Create a new scan record
    const { data: scan, error: scanError } = await supabase
      .from("data_health_scans")
      .insert({
        brokerage_id: ctx.brokerageId,
        scan_type: "full",
        status: "running",
        started_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (scanError) throw scanError

    // Get all contacts to validate — scoped to the brokerage the scan is filed
    // under (same anchor getDataHealthStats uses). RLS alone is not enough here:
    // a platform-admin session reads contacts across every tenant, and a scan
    // that walked several brokerages' contacts must not be stamped as one
    // brokerage's scan.
    const { data: contacts, error: contactsError } = await supabase
      .from("contacts")
      .select("id, email, phone, first_name, last_name")
      .eq("brokerage_id", ctx.brokerageId)
      .limit(1000)

    // A refused read is NOT "no contacts". Completing the scan on a read that
    // failed would file a clean bill of health nobody measured.
    if (contactsError) {
      await supabase
        .from("data_health_scans")
        .update({ status: "failed", completed_at: new Date().toISOString() })
        .eq("id", scan.id)
      return {
        success: false,
        error: `Could not read contacts, so nothing was scanned: ${contactsError.message}`,
        invalidCount: 0,
      }
    }

    if (!contacts || contacts.length === 0) {
      await supabase
        .from("data_health_scans")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          total_records_scanned: 0,
          issues_found: 0,
        })
        .eq("id", scan.id)
      
      return { success: true, invalidCount: 0, message: "No contacts to validate" }
    }
    
    let issuesFound = 0
    let issuesRecorded = 0

    // Validate each contact
    for (const contact of contacts) {
      const validationResult = await validateContact(contact)

      if (validationResult.status !== "Valid") {
        issuesFound++

        // Log the invalid/risky contact — same tenant as the parent scan.
        // Migration 051 installs a BEFORE INSERT trigger that denormalizes
        // brokerage_id off data_health_scans, but that trigger only copies what
        // the scan carries and runs with the caller's rights; the stamp is
        // written explicitly here so this row's tenancy does not depend on it.
        const { error: logError } = await supabase.from("data_health_logs").insert({
          brokerage_id: ctx.brokerageId,
          scan_id: scan.id,
          entity_type: "contact",
          entity_id: contact.id,
          contact_id: contact.id,
          validation_status: validationResult.status,
          validation_reason: validationResult.reason,
          field_name: validationResult.field,
          current_value: validationResult.value,
          severity: validationResult.status === "Invalid" ? "high" : "medium",
          detected_at: new Date().toISOString(),
        })
        // A refused insert used to vanish: issues_found counted findings the log
        // never received, so the dashboard showed an Invalid count with no rows
        // behind it and purgeInvalidContacts had nothing to act on.
        if (logError) {
          console.error(
            `[runDataHygieneScan] could not record finding for contact ${contact.id}:`,
            logError.message,
          )
          continue
        }
        issuesRecorded++
      }
    }

    // Update scan with results — issues_found is what the log ACTUALLY holds,
    // so the scan row and the log rows agree.
    await supabase
      .from("data_health_scans")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        total_records_scanned: contacts.length,
        issues_found: issuesRecorded,
      })
      .eq("id", scan.id)

    return {
      success: true,
      invalidCount: issuesFound,
      recordedCount: issuesRecorded,
      scannedCount: contacts.length,
    }
  } catch (error) {
    console.error("Failed to run data hygiene scan:", error)
    return { success: false, error: "Failed to run scan", invalidCount: 0 }
  }
}

// Helper function to validate a contact
// Delegates to lib/contact-validation which routes phone lookups through lib/providers/messaging.
import { validateContact as libValidateContact } from "@/lib/contact-validation"

async function validateContact(contact: { email?: string; phone?: string; first_name?: string; last_name?: string }) {
  // Check for both email and phone missing
  if (!contact.email && !contact.phone) {
    return {
      status: "Invalid",
      reason: "Missing both email and phone",
      field: "email,phone",
      value: "N/A",
    }
  }

  // Run deep validation via lib/contact-validation (PeopleData + Twilio Lookups via provider)
  const result = await libValidateContact({ email: contact.email, phone: contact.phone })

  if (contact.email && !result.email_valid) {
    return {
      status: "Invalid",
      reason: "Invalid or undeliverable email",
      field: "email",
      value: contact.email,
    }
  }

  if (contact.phone && !result.phone_valid) {
    return {
      status: "Invalid",
      reason: "Invalid phone number",
      field: "phone",
      value: contact.phone,
    }
  }
  
  // Check for missing name
  if (!contact.first_name && !contact.last_name) {
    return { 
      status: "Risky", 
      reason: "Missing name",
      field: "first_name,last_name",
      value: "N/A"
    }
  }
  
  // Check if missing one contact method
  if (!contact.email && contact.phone) {
    return { 
      status: "Risky", 
      reason: "Missing email address",
      field: "email",
      value: "N/A"
    }
  }
  
  if (contact.email && !contact.phone) {
    return { 
      status: "Risky", 
      reason: "Missing phone number",
      field: "phone",
      value: "N/A"
    }
  }
  
  return { status: "Valid", reason: null, field: null, value: null }
}

// Purge invalid contacts
/** Roles allowed to run a bulk destructive purge of contact records.
 *  TENANT ADMIN GATE (kept inline — a brokerage-wide destructive purge stays at
 *  this deliberate roster, no team_lead): 'superadmin' removed — dead as
 *  users.user_type (0 live rows); broker_owner added — the storable seat that
 *  owns the brokerage whose records this purges. */
const PURGE_ALLOWED_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

/**
 * Bulk soft-delete every contact this brokerage's health scan marked Invalid.
 *
 * THIS IS THE MOST DESTRUCTIVE EXPORT IN THE FILE and it used to be the least
 * guarded one: a `"use server"` export taking NO arguments, with NO
 * authentication, NO role check and NO tenant scope. Anyone who could reach the
 * action soft-deleted every Invalid-flagged contact in EVERY brokerage, then
 * deleted the matching data_health_logs rows — destroying the only record of
 * which contacts had been purged and why. A no-argument endpoint is not a small
 * one; it is the one an attacker does not even have to guess parameters for.
 *
 * It also reported the wrong thing on failure: `const { data: invalidLogs }`
 * never destructured `error`, so a refused read returned
 * `{ success: true, deletedCount: 0, message: "No invalid contacts to purge" }`
 * — telling an operator the data is clean when in fact nothing could be read.
 *
 * Now: authenticated, broker/admin only, scoped to the caller's own brokerage on
 * every one of the three statements, and a read it cannot perform is a refusal.
 */
export async function purgeInvalidContacts() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { success: false, error: "Unauthenticated", deletedCount: 0 }
  }
  if (!ctx.brokerageId) {
    return { success: false, error: "Brokerage not configured", deletedCount: 0 }
  }
  if (!PURGE_ALLOWED_ROLES.has(ctx.userType)) {
    return { success: false, error: "Forbidden — only a broker or admin can purge contacts", deletedCount: 0 }
  }
  // A read-only act-as grant must not be able to bulk-delete a tenant's contacts.
  if (ctx.isImpersonating && ctx.impersonationMode !== "full") {
    return { success: false, error: "Read-only session — purge refused", deletedCount: 0 }
  }

  const supabase = await createClient()

  try {
    // Get the invalid contact IDs FOR THIS BROKERAGE.
    const { data: invalidLogs, error: readError } = await supabase
      .from("data_health_logs")
      .select("contact_id")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("validation_status", "Invalid")

    // A refused read is NOT "nothing to purge". Say so instead of reporting clean.
    if (readError) {
      return {
        success: false,
        error: `Cannot read the health log, so nothing was purged: ${readError.message}`,
        deletedCount: 0,
      }
    }

    if (!invalidLogs || invalidLogs.length === 0) {
      return { success: true, deletedCount: 0, message: "No invalid contacts to purge" }
    }

    const contactIds = invalidLogs.map(l => l.contact_id).filter(Boolean)
    if (contactIds.length === 0) {
      return { success: true, deletedCount: 0, message: "No invalid contacts to purge" }
    }

    // Soft delete contacts (mark as deleted) — brokerage-scoped.
    // .select("id") so deletedCount is what was PROVEN purged, not what we
    // intended to purge: contactIds comes from data_health_logs, and a log row
    // can outlive its contact (or point at a contact this tenant can no longer
    // touch). Reporting the intent as the result is the "control that reports
    // success without doing the thing" defect.
    const { data: purged, error } = await supabase
      .from("contacts")
      .update({ deleted_at: new Date().toISOString() })
      .eq("brokerage_id", ctx.brokerageId)
      .in("id", contactIds)
      .select("id")

    if (error) throw error

    const purgedIds = ((purged ?? []) as Array<{ id: string }>).map((r) => r.id)

    // Remove the health logs for purged contacts — same scope. Only for rows we
    // actually purged: clearing the log for a contact that survived would hide
    // it from the next scan's Invalid list.
    if (purgedIds.length > 0) {
      const { error: logError } = await supabase
        .from("data_health_logs")
        .delete()
        .eq("brokerage_id", ctx.brokerageId)
        .in("contact_id", purgedIds)
      if (logError) {
        // The purge itself landed — say so, and say the log is still dirty,
        // rather than swallowing it and letting the next scan look wrong.
        return {
          success: true,
          deletedCount: purgedIds.length,
          message: `Purged ${purgedIds.length} contact(s), but the health log could not be cleared: ${logError.message}`,
        }
      }
    }

    return {
      success: true,
      deletedCount: purgedIds.length,
      message:
        purgedIds.length === contactIds.length
          ? undefined
          : `${purgedIds.length} of ${contactIds.length} flagged contacts were purged; the rest no longer exist in this brokerage.`,
    }
  } catch (error) {
    console.error("Failed to purge invalid contacts:", error)
    return { success: false, error: "Failed to purge contacts", deletedCount: 0 }
  }
}
