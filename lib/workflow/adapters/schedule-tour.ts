/**
 * Schedule Tour adapter — creates a multi-stop buyer tour.
 *
 * Writes the CANONICAL tour system (`tours` + `tour_stops`) — the same tables the
 * tour UI (app/crm/.../tours) and calendar read. The legacy `buyer_tours` table is
 * not used (it was write-only drift). Stops are enriched from `saved_properties`
 * (the buyer property store) keyed by the saved-property ids on the step.
 * AI route optimization runs via the real optimizeTourRoute(tourId) action.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const scheduleTourAdapter: ChannelAdapter = {
  channel: "schedule_tour",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, contact, brokerageId, agentId, supabase } = ctx

    const savedPropertyIds = step.tour_property_ids ?? []
    if (savedPropertyIds.length === 0) {
      return { status: "error", providerKey: "tours", error: "No properties configured for tour" }
    }

    const tourDate = new Date(
      Date.now() + (step.tour_date_offset_days ?? 0) * 86_400_000
    )
    const tourDateOnly = tourDate.toISOString().split("T")[0]

    // Pull the buyer's saved properties to populate the stops.
    const { data: savedProps } = await supabase
      .from("saved_properties")
      .select(
        "id, property_address, city, state, list_price, mls_number, listing_url, primary_photo_url"
      )
      .in("id", savedPropertyIds)
      .eq("brokerage_id", brokerageId)

    const propsById = new Map((savedProps ?? []).map((p: any) => [p.id, p]))
    // Preserve the order the step specified; drop ids that didn't resolve.
    const orderedProps = savedPropertyIds
      .map((id) => propsById.get(id))
      .filter((p): p is any => Boolean(p))

    if (orderedProps.length === 0) {
      return { status: "error", providerKey: "tours", error: "No matching saved properties for tour" }
    }

    const { data: tour, error } = await supabase
      .from("tours")
      .insert({
        brokerage_id: brokerageId,
        contact_id: contact?.id ?? null,
        buyer_id: contact?.id ?? null,
        agent_id: agentId,
        tour_date: tourDateOnly,
        start_address: step.tour_start_address ?? null,
        status: "planned",
        ai_plan_narrative: "workflow_sequence",
      })
      .select("id")
      .single()

    if (error || !tour) {
      return { status: "error", providerKey: "tours", error: error?.message ?? "Failed to create tour" }
    }

    const stopRows = orderedProps.map((p: any, i: number) => ({
      tour_id: tour.id,
      brokerage_id: brokerageId,
      contact_id: contact?.id ?? null,
      listing_id: null,
      order_index: i,
      property_address: p.property_address ?? null,
      city: p.city ?? null,
      state: p.state ?? null,
      mls_number: p.mls_number ?? null,
      listing_url: p.listing_url ?? null,
      primary_photo_url: p.primary_photo_url ?? null,
      list_price: p.list_price ?? null,
      scheduling_method: "manual_call",
      is_confirmed: false,
    }))

    const { error: stopsError } = await supabase.from("tour_stops").insert(stopRows)
    if (stopsError) {
      return { status: "error", providerKey: "tours", error: stopsError.message }
    }

    // Mark the saved properties as added to a tour.
    await supabase
      .from("saved_properties")
      .update({ added_to_tour: true })
      .in("id", orderedProps.map((p: any) => p.id))

    // AI route optimization (best-effort) — canonical action keyed by tourId.
    let routeOptimized = false
    try {
      const m = await import("@/app/actions/ai-showing-management")
      const optimizeFn = (m as any).optimizeTourRoute
      if (typeof optimizeFn === "function") {
        await optimizeFn(tour.id)
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
          body: `Your property tour has been scheduled for ${tourDate.toLocaleDateString()}. ${orderedProps.length} propert${orderedProps.length === 1 ? "y" : "ies"} to visit.`,
          priority: "medium",
        })
      ).catch(() => {})
    }

    return {
      status: "sent",
      providerKey: "tours",
      messageId: tour.id,
      output: {
        tour_id: tour.id,
        stop_count: orderedProps.length,
        tour_date: tourDateOnly,
        route_optimized: routeOptimized,
      },
    }
  },
}
