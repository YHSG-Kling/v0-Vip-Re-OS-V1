import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

/**
 * GoHighLevel workflow trigger.
 *
 * The legacy "platform sync service" (Dotloop / GHL contact sync / QuickBooks / Google Calendar /
 * ShowingTime / MLS) was removed — every one of those was a dead duplicate of a live primary:
 *   - Dotloop      → lib/providers/esign (DotloopProvider)
 *   - GHL contacts → lib/crm/sync.ts (owner-scoped CRM cascade)
 *   - QuickBooks   → lib/providers/accounting/quickbooks.ts
 *   - Calendar     → lib/providers/calendar/personal-calendar.ts
 *   - ShowingTime  → lib/showings/dispatchers.ts + app/actions/seller-showings.ts
 *   - MLS/IDX      → lib/idxbroker-client.ts
 * Only the GHL workflow-trigger had no primary equivalent, so it remains here.
 */
export async function triggerGHLWorkflow(params: {
  agentId: string
  contactId: string
  workflowId: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid IDs" }
  }

  try {
    const supabase = createServiceClient()

    const { data: credentials } = await supabase
      .from("platform_credentials")
      .select("*")
      .eq("agent_user_id", params.agentId)
      .eq("platform", "gohighlevel")
      .single()

    if (!credentials?.access_token) {
      return { success: false, error: "GoHighLevel not connected" }
    }

    const { data: contact } = await supabase
      .from("contacts")
      .select("ghl_contact_id")
      .eq("id", params.contactId)
      .single()

    if (!contact?.ghl_contact_id) {
      return { success: false, error: "Contact not synced to GHL" }
    }

    await callConnector({
      connector: "ghl", baseUrl: credentials.api_url,
      path: `/crm/contacts/${contact.ghl_contact_id}/workflow/${params.workflowId}`, method: "POST",
      auth: { style: "bearer", token: credentials.access_token },
    })

    return { success: true }
  } catch (error) {
    console.error("[v0] GHL workflow trigger error:", error)
    return handleError(error, "triggerGHLWorkflow")
  }
}
