"use server"

import { createClient } from "@/lib/supabase/server"

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
    // Get total contacts count
    const { count: totalLeads } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
    
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
export async function runDataHygieneScan() {
  const supabase = await createClient()
  
  try {
    // Create a new scan record
    const { data: scan, error: scanError } = await supabase
      .from("data_health_scans")
      .insert({
        scan_type: "full",
        status: "running",
        started_at: new Date().toISOString(),
      })
      .select()
      .single()
    
    if (scanError) throw scanError
    
    // Get all contacts to validate
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, email, phone, first_name, last_name")
      .limit(1000)
    
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
    
    // Validate each contact
    for (const contact of contacts) {
      const validationResult = await validateContact(contact)
      
      if (validationResult.status !== "Valid") {
        issuesFound++
        
        // Log the invalid/risky contact
        await supabase.from("data_health_logs").insert({
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
      }
    }
    
    // Update scan with results
    await supabase
      .from("data_health_scans")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        total_records_scanned: contacts.length,
        issues_found: issuesFound,
      })
      .eq("id", scan.id)
    
    return { success: true, invalidCount: issuesFound, scannedCount: contacts.length }
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

  // Run deep validation via lib/contact-validation (ZeroBounce + Twilio Lookups via provider)
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
export async function purgeInvalidContacts() {
  const supabase = await createClient()
  
  try {
    // Get all invalid contact IDs
    const { data: invalidLogs } = await supabase
      .from("data_health_logs")
      .select("contact_id")
      .eq("validation_status", "Invalid")
    
    if (!invalidLogs || invalidLogs.length === 0) {
      return { success: true, deletedCount: 0, message: "No invalid contacts to purge" }
    }
    
    const contactIds = invalidLogs.map(l => l.contact_id).filter(Boolean)
    
    // Soft delete contacts (mark as deleted)
    const { error } = await supabase
      .from("contacts")
      .update({ deleted_at: new Date().toISOString() })
      .in("id", contactIds)
    
    if (error) throw error
    
    // Remove the health logs for purged contacts
    await supabase
      .from("data_health_logs")
      .delete()
      .in("contact_id", contactIds)
    
    return { success: true, deletedCount: contactIds.length }
  } catch (error) {
    console.error("Failed to purge invalid contacts:", error)
    return { success: false, error: "Failed to purge contacts", deletedCount: 0 }
  }
}
