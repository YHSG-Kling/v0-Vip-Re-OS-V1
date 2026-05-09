/**
 * Schedule Tour adapter — creates a multi-stop buyer tour.
 * AI route optimization is attempted via dynamic import (graceful if not built).
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const scheduleTourAdapter: ChannelAdapter = {
  channel: "schedule_tour",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, contact, brokerageId, agentId, supabase } = ctx

    const propertyIds = step.tour_property_ids ?? []
    if (propertyIds.length === 0) {
      return { status: "error", providerKey: "tours", error: "No properties configured for tour" }
    }

    const tourDate = new Date(
      Date.now() + (step.tour_date_offset_days ?? 0) * 86_400_000
    ).toISOString()

    const { data: tour, error } = await supabase.from("buyer_tours").insert({
      brokerage_id: brokerageId,
      contact_id: contact?.id ?? null,
      agent_id: agentId,
      tour_date: tourDate,
      start_address: step.tour_start_address ?? null,
      property_ids: propertyIds,
      status: "scheduled",
      stop_count: propertyIds.length,
      source: "workflow_sequence",
      created_at: new Date().toISOString(),
    }).select("id").single()

    if (error) {
      return { status: "error", providerKey: "tours", error: error.message }
    }

    // Try AI route optimization (graceful if action not yet exported)
    let routeOptimized = false
    try {
      const m = await import("@/app/actions/ai-property-matching")
      const optimizeFn = (m as any).optimizeTourRoute
      if (typeof optimizeFn === "function") {
        await optimizeFn({
          tourId: tour!.id,
          propertyIds,
          startAddress: step.tour_start_address ?? undefined,
          brokerageId,
        })
        routeOptimized = true
      }
    } catch { /* best-effort */ }

    // Notify buyer via portal notification
    if (contact?.id) {
      void Promise.resolve(
        supabase.from("notifications").insert({
          brokerage_id: brokerageId,
          contact_id: contact.id,
          type: "tour_scheduled",
          title: "Tour Scheduled",
          body: `Your property tour has been scheduled for ${new Date(tourDate).toLocaleDateString()}. ${propertyIds.length} propert${propertyIds.length === 1 ? "y" : "ies"} to visit.`,
          priority: "normal",
        })
      ).catch(() => {})
    }

    return {
      status: "sent",
      providerKey: "tours",
      messageId: tour?.id,
      output: {
        tour_id: tour?.id,
        stop_count: propertyIds.length,
        tour_date: tourDate,
        route_optimized: routeOptimized,
      },
    }
  },
}
