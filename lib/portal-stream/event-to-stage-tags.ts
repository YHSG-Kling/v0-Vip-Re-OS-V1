/**
 * Map a lifecycle_events.event_type to the learning_modules.stage_tags
 * that should match. Used by the portal-stream projector to inject the
 * education_lesson_key into portal_event_stream.metadata so the customer
 * portal can surface the relevant lesson inline with the lifecycle event.
 *
 * Stage tag values follow MILESTONE_LABEL_MAP / MILESTONE_LESSON_MAP in
 * lib/portal/resolve-education-context.ts.
 */

export function eventTypeToStageTags(eventType: string): string[] {
  switch (eventType) {
    case "offer.submitted":               return ["offer_submitted"]
    case "offer.countered":               return ["offer_countered"]
    case "offer.accepted":                return ["offer_accepted"]
    case "offer.rejected":                return ["offer_rejected"]
    case "transaction.under_contract":    return ["under_contract"]
    case "inspection.scheduled":          return ["inspection_scheduled", "inspection_period"]
    case "inspection.completed":          return ["inspection_completed"]
    case "appraisal.ordered":             return ["appraisal_ordered", "appraisal"]
    case "appraisal.completed":           return ["appraisal_completed"]
    case "financing.cleared":             return ["loan_approved", "clear_to_close_received"]
    case "transaction.closing_scheduled": return ["closing_scheduled"]
    case "transaction.closed":            return ["closed"]
    case "listing.went_live":             return ["listing_live"]
    case "listing.showing_completed":     return ["first_showing"]
    case "listing.price_reduced":         return ["listing_price_reduced"]
    case "wealth.refinance_opportunity":  return ["forever_wealth", "refinance"]
    case "wealth.equity_milestone":       return ["forever_wealth", "equity_milestone"]
    case "lifetime.anniversary":          return ["forever_anniversary"]
    case "portal.message_sent_by_agent":  return []
    case "portal.document_signed":        return ["document_signed"]
    case "negotiation.strategy_ready":    return ["negotiation_active"]
    default:                              return []
  }
}
