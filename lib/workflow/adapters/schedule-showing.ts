/**
 * Schedule Showing adapter — creates a showing appointment.
 * Tries ShowingTime if configured; falls back to manual showing record + email.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const scheduleShowingAdapter: ChannelAdapter = {
  channel: "schedule_showing",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, contact, brokerageId, agentId, supabase } = ctx

    const propertyId = step.showing_property_id
    if (!propertyId) {
      return { status: "error", providerKey: "showings", error: "No property configured for showing" }
    }

    // Fetch property
    const { data: property } = await supabase
      .from("listings")
      .select("id, address, city, state, zip, listing_agent_name, listing_agent_email")
      .eq("id", propertyId)
      .maybeSingle()

    if (!property) {
      return { status: "error", providerKey: "showings", error: "Property not found" }
    }

    const requestedDate = new Date(
      Date.now() + (step.tour_date_offset_days ?? 0) * 86_400_000
    ).toISOString()

    // Check for ShowingTime integration
    // brokerage_integrations columns: provider_type, status, metadata (jsonb)
    const { data: integration } = await supabase
      .from("brokerage_integrations")
      .select("metadata, status")
      .eq("brokerage_id", brokerageId)
      .eq("provider_type", "showingtime")
      .eq("status", "active")
      .maybeSingle()

    const integrationApiKey = (integration?.metadata as { api_key?: string } | null)?.api_key

    if (integrationApiKey) {
      try {
        // ShowingTime API via fetch (no separate client module needed)
        const stRes = await fetch("https://api.showingtime.com/v1/showings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${integrationApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            listingId: propertyId,
            requestedDateTime: requestedDate,
            duration: step.showing_duration_minutes,
            agentNotes: step.showing_notes,
          }),
        })
        if (stRes.ok) {
          const data = await stRes.json()
          return {
            status: "sent",
            providerKey: "showingtime",
            messageId: data?.id,
            output: {
              showing_id: data?.id,
              property_address: property.address,
              scheduled_at: requestedDate,
            },
          }
        }
      } catch { /* fall through to manual */ }
    }

    // Manual showing record — column names match showings table
    const { data: showing, error } = await supabase.from("showings").insert({
      brokerage_id: brokerageId,
      contact_id: contact?.id ?? null,
      agent_id: agentId,
      listing_id: propertyId,                               // showings.listing_id (not "property_id")
      status: "requested",
      scheduled_at: requestedDate,                          // showings.scheduled_at (not "requested_at")
      duration_minutes: step.showing_duration_minutes,
      notes: step.showing_notes ?? null,
      sync_source: "workflow_sequence",                     // existing column for provenance
      created_at: new Date().toISOString(),
    }).select("id").single()

    if (error) {
      return { status: "error", providerKey: "showings", error: error.message }
    }

    // Draft request message to listing agent
    if (property.listing_agent_email) {
      const { dispatchEmail } = await import("@/lib/providers/dispatch")
      const buyerName = `${contact?.first_name ?? ""} ${contact?.last_name ?? ""}`.trim() || "my buyer"
      void Promise.resolve(dispatchEmail({
        brokerageId,
        systemSource: "sequence",
        contactId: contact?.id,
        from: "noreply@platform.com",
        to: property.listing_agent_email,
        subject: `Showing Request — ${property.address}`,
        html: `<p>I'd like to schedule a showing of ${property.address} for ${buyerName}.<br>Requested: ${new Date(requestedDate).toLocaleString()}<br>Duration: ${step.showing_duration_minutes} min${step.showing_notes ? `<br>Notes: ${step.showing_notes}` : ""}</p>`,
      })).catch(() => {})
    }

    return {
      status: "sent",
      providerKey: "showings",
      messageId: showing?.id,
      output: {
        showing_id: showing?.id,
        property_address: `${property.address}, ${property.city}, ${property.state}`,
        scheduled_at: requestedDate,
      },
    }
  },
}
