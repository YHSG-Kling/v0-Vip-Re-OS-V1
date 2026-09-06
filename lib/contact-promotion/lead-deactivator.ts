/**
 * THE ONE lead-deactivation implementation. All three converters call it:
 *   · lib/kernel/crm.ts:convertLeadToContact          (manual lead-desk lane)
 *   · lib/contact-promotion/promote-lead-to-contact.ts (promotion service)
 *   · lib/kernel/lead-acquisition-handlers.ts:handleLeadAssigned (automatic lane)
 *
 * Why this exists:
 * - Preserves lead for audit and attribution
 * - Prevents further AI engagement or orchestration
 * - Maintains historical record for reporting
 * - Ensures single source of truth (contact)
 *
 * It writes lead-CLOSURE columns only. It does NOT write `lifecycle_state` —
 * lib/kernel/lead-acquisition-handlers.ts declares itself that column's only
 * writer — and it does NOT write `contact_id`; the link is stamped by the caller
 * (crm.ts) or by lib/contact-promotion/history-carry.ts:116, which pairs it with
 * `converted_at` in one statement.
 *
 * `contact_id` — not anything set here — is what the conversion guard reads. See
 * lib/contact-promotion/conversion-finality.ts for why: it is the only marker
 * every converter writes, and `is_active` was NOT one of them until this pass.
 */

export async function deactivateLead(
  supabase: any,
  leadId: string
): Promise<{ success: boolean; error?: string }> {

  try {
    // Mark lead as inactive AND explicitly release AI-ISA ownership.
    // The agent can re-arm ISA by flipping ai_isa_owner back to true (canonical: "ISA only restarts
    // if the agent turns it back on or if the contact ghosts").
    //
    // CORRECTED CLAIM (this comment used to assert something false). It read:
    // "so the canonical initiateAIISAEngagement gates (which check is_active +
    // ai_isa_owner) both reject re-entry." app/actions/ai-isa/initiate-engagement.ts
    // checks `is_active === false` — it has NEVER checked `ai_isa_owner`. And
    // lib/kernel/ai-isa.ts:assignAiIsaToLeadAfterGate, the other ISA door,
    // checked NEITHER: its select was `id, call_stop_flag, opted_out_at,
    // lifecycle_state`. So this file was documenting protection that did not
    // exist, on behalf of gates that did not run. Both doors now consult the
    // conversion guard directly (lib/contact-promotion/conversion-finality.ts),
    // which keys on `contact_id` and does not depend on either flag landing.
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
