/**
 * Deactivates a lead after promotion to contact
 * 
 * Why this exists:
 * - Preserves lead for audit and attribution
 * - Prevents further AI engagement or orchestration
 * - Maintains historical record for reporting
 * - Ensures single source of truth (contact)
 */

export async function deactivateLead(
  supabase: any,
  leadId: string
): Promise<{ success: boolean; error?: string }> {
  
  try {
    // Mark lead as inactive - this prevents:
    // - AI ISA from sending emails
    // - Lead orchestration systems from engaging
    // - Assignment engines from processing
    const { error } = await supabase
      .from("leads")
      .update({
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq("id", leadId)

    if (error) {
      throw new Error(`Failed to deactivate lead: ${error.message}`)
    }

    console.log(`[v0] Lead ${leadId} deactivated (preserved for audit)`)

    return { success: true }

  } catch (error: any) {
    console.error("[deactivateLead] Error:", error)
    return {
      success: false,
      error: error.message || "Failed to deactivate lead"
    }
  }
}
