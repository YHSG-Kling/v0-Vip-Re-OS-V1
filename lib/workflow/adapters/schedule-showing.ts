/**
 * Schedule Showing adapter — creates a showing appointment.
 *
 * Routing logic:
 *   1. step.showing_property_id is set         → IN-HOUSE listing (one of our listings)
 *      • Read listings row, use listing_agent contact info
 *      • Try ShowingTime API if integration is active for the brokerage
 *      • Fall back to creating a showings row + emailing the listing agent
 *
 *   2. step.showing_external_source is set     → EXTERNAL listing (not ours)
 *      • Look up via RentCast / IDX (lib/property/rentcast.ts) when MLS id given,
 *        otherwise just use the supplied address
 *      • ShowingTime doesn't help for external listings unless we have the MLS id
 *      • Create a showings row with external_source / external_address /
 *        external_mls_id columns and notify the agent to confirm with the
 *        listing agent manually if no contact is resolved
 *
 *   Without either, this fails — we need a target property.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

export const scheduleShowingAdapter: ChannelAdapter = {
  channel: "schedule_showing",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, contact, brokerageId, agentId, supabase } = ctx

    const inHousePropertyId = step.showing_property_id
    const externalSource    = (step as any).showing_external_source as
      | "rentcast" | "mls" | "manual" | undefined
    const externalAddress   = (step as any).showing_external_address as string | undefined
    const externalMlsId     = (step as any).showing_external_mls_id   as string | undefined

    if (!inHousePropertyId && !externalSource) {
      return { status: "error", providerKey: "showings", error: "No property configured (need showing_property_id for in-house OR showing_external_source for external)" }
    }

    const requestedDate = new Date(
      Date.now() + (step.tour_date_offset_days ?? 0) * 86_400_000
    ).toISOString()

    // ── PATH A: in-house listing ────────────────────────────────────────────
    if (inHousePropertyId) {
      const { data: property } = await supabase
        .from("listings")
        .select("id, address, city, state, zip, listing_agent_name, listing_agent_email")
        .eq("id", inHousePropertyId)
        .maybeSingle()

      if (!property) {
        return { status: "error", providerKey: "showings", error: "In-house listing not found" }
      }

      const { data: integration } = await supabase
        .from("brokerage_integrations")
        .select("metadata, status")
        .eq("brokerage_id", brokerageId)
        .eq("provider_type", "showingtime")
        .eq("status", "active")
        .maybeSingle()

      const integrationApiKey = (integration?.metadata as { api_key?: string } | null)?.api_key

      if (integrationApiKey) {
        const stRes = await callConnector<{ id?: string }>({
          connector: "showingtime",
          baseUrl: "https://api.showingtime.com",
          path: "/v1/showings",
          method: "POST",
          auth: { style: "bearer", token: integrationApiKey },
          body: {
            listingId: inHousePropertyId,
            requestedDateTime: requestedDate,
            duration: step.showing_duration_minutes,
            agentNotes: step.showing_notes,
          },
        })
        if (stRes.ok) {
          const data = stRes.data ?? {}
          return {
            status: "sent",
            providerKey: "showingtime",
            messageId: data?.id,
            output: { showing_id: data?.id, property_address: property.address, scheduled_at: requestedDate },
          }
        }
      }

      const { data: showing, error } = await supabase.from("showings").insert({
        brokerage_id: brokerageId,
        contact_id:   contact?.id ?? null,
        agent_id:     agentId,
        listing_id:   inHousePropertyId,
        status:       "requested",
        scheduled_at: requestedDate,
        duration_minutes: step.showing_duration_minutes,
        notes:        step.showing_notes ?? null,
        sync_source:  "workflow_sequence",
        created_at:   new Date().toISOString(),
      }).select("id").single()

      if (error) return { status: "error", providerKey: "showings", error: error.message }

      // Email the listing agent
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
          source: "in_house_listing",
        },
      }
    }

    // ── PATH B: external listing (RentCast / MLS / manual) ─────────────────
    let externalDetails: {
      address: string
      city?: string | null
      state?: string | null
      zip?: string | null
      listingAgentEmail?: string | null
      listingAgentName?:  string | null
      raw?: unknown
    } = {
      address: externalAddress ?? "External property",
      city:    (step as any).showing_external_city  ?? null,
      state:   (step as any).showing_external_state ?? null,
      zip:     (step as any).showing_external_zip   ?? null,
    }

    if (externalSource === "rentcast" && externalAddress) {
      try {
        const { searchRentcastSaleListings } = await import("@/lib/property/rentcast")
        const results = await searchRentcastSaleListings({
          address: externalAddress,
          city:  externalDetails.city  ?? undefined,
          state: externalDetails.state ?? undefined,
          zipCode: externalDetails.zip ?? undefined,
          limit: 1,
        } as any)
        const top = (results as any)?.listings?.[0] ?? (results as any)?.[0]
        if (top) {
          externalDetails = {
            address: top.formattedAddress ?? top.address ?? externalDetails.address,
            city:    top.city  ?? externalDetails.city,
            state:   top.state ?? externalDetails.state,
            zip:     top.zipCode ?? externalDetails.zip,
            listingAgentEmail: top.listingAgent?.email ?? null,
            listingAgentName:  top.listingAgent?.name  ?? null,
            raw: top,
          }
        }
      } catch { /* continue with what we have */ }
    } else if (externalSource === "mls" && externalMlsId) {
      try {
        const { searchExternalListings } = await import("@/lib/property/external-listings-search")
        const results = await searchExternalListings({ mlsId: externalMlsId } as any)
        const top = (results as any)?.listings?.[0]
        if (top) {
          externalDetails = {
            address: top.address ?? externalDetails.address,
            city:    top.city  ?? externalDetails.city,
            state:   top.state ?? externalDetails.state,
            zip:     top.zipCode ?? externalDetails.zip,
            listingAgentEmail: top.listingAgent?.email ?? null,
            listingAgentName:  top.listingAgent?.name  ?? null,
            raw: top,
          }
        }
      } catch { /* continue */ }
    }

    const { data: showing, error } = await supabase.from("showings").insert({
      brokerage_id: brokerageId,
      contact_id:   contact?.id ?? null,
      agent_id:     agentId,
      listing_id:   null,                                 // external — no in-house FK
      status:       "requested",
      scheduled_at: requestedDate,
      duration_minutes: step.showing_duration_minutes,
      notes:        step.showing_notes ?? null,
      external_source:  externalSource,
      external_address: externalDetails.address,
      external_mls_id:  externalMlsId ?? null,
      external_metadata: externalDetails.raw ?? null,
      sync_source:  "workflow_sequence",
      created_at:   new Date().toISOString(),
    }).select("id").single()

    if (error) return { status: "error", providerKey: "showings", error: error.message }

    if (externalDetails.listingAgentEmail) {
      const { dispatchEmail } = await import("@/lib/providers/dispatch")
      const buyerName = `${contact?.first_name ?? ""} ${contact?.last_name ?? ""}`.trim() || "my buyer"
      void Promise.resolve(dispatchEmail({
        brokerageId,
        systemSource: "sequence",
        contactId: contact?.id,
        from: "noreply@platform.com",
        to: externalDetails.listingAgentEmail,
        subject: `Showing Request — ${externalDetails.address}`,
        html: `<p>I'd like to schedule a showing of ${externalDetails.address} for ${buyerName}.<br>Requested: ${new Date(requestedDate).toLocaleString()}<br>Duration: ${step.showing_duration_minutes} min${step.showing_notes ? `<br>Notes: ${step.showing_notes}` : ""}</p>`,
      })).catch(() => {})
    } else if (ctx.agentUserId) {
      // No listing-agent contact resolved — notify the agent to handle manually
      void Promise.resolve(supabase.from("notifications").insert({
        brokerage_id: brokerageId,
        type: "showing_manual_contact_required",
        title: "Showing booked — listing agent contact not found",
        body: `The listing agent for ${externalDetails.address} couldn't be auto-resolved. Confirm manually before the requested time.`,
        priority: "high",
      })).catch(() => {})
    }

    return {
      status: "sent",
      providerKey: "showings",
      messageId: showing?.id,
      output: {
        showing_id: showing?.id,
        property_address: externalDetails.address,
        scheduled_at: requestedDate,
        source: externalSource,
        listing_agent_email: externalDetails.listingAgentEmail ?? null,
      },
    }
  },
}
