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
    // Mark lead as inactive AND explicitly release AI-ISA ownership so the canonical
    // initiateAIISAEngagement gates (which check is_active + ai_isa_owner) both reject re-entry.
    // The agent can re-arm ISA by flipping ai_isa_owner back to true (canonical: "ISA only restarts
    // if the agent turns it back on or if the contact ghosts").
    const { error } = await supabase
      .from("leads")
      .update({
        is_active: false,
        ai_isa_owner: false,
        updated_at: new Date().toISOString()
      })
      .eq("id", leadId)

    if (error) {
      throw new Error(`Failed to deactivate lead: ${error.message}`)
    }

    // Terminate any non-final campaign_sequence_enrollments for this lead — both 'active' AND
    // 'paused' enrollments must stop on conversion (paused ones would otherwise resume firing later
    // and bypass the new contact's preferences/consent). Best-effort — never block deactivation.
    try {
      await supabase
        .from("sequence_enrollments")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("lead_id", leadId)
        .in("status", ["active", "paused"])
    } catch (e) {
      console.warn(`[deactivateLead] sequence_enrollments termination skipped:`, e)
    }

    console.log(`[v0] Lead ${leadId} deactivated (preserved for audit; ISA released; enrollments closed)`)

    return { success: true }

  } catch (error: any) {
    console.error("[deactivateLead] Error:", error)
    return {
      success: false,
      error: error.message || "Failed to deactivate lead"
    }
  }
}
