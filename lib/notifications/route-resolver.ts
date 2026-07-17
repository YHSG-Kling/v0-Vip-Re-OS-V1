/**
 * lib/notifications/route-resolver.ts
 *
 * Maps notification entity_type + entity_id pairs to in-app deep links.
 * Returns null when the entity isn't routable (e.g. system events with no
 * UI surface). Used by /notifications page to make notifications clickable.
 *
 * Pure function — safe to import from server or client components.
 */

export function resolveNotificationHref(input: {
  entityType: string | null
  entityId:   string | null
  type?:      string                  // notification.type, used as fallback router
}): string | null {
  const { entityType, entityId, type } = input

  // Entity-type-driven routes (most specific, highest priority)
  if (entityType && entityId) {
    switch (entityType) {
      case "listing_presentation":
        return `/dashboard/listings/presentations/${entityId}`
      case "transaction":
        return `/dashboard/transactions/${entityId}`
      case "listing":
        return `/dashboard/listings/${entityId}`
      case "document":
        return `/dashboard/documents/${entityId}`
      case "contact":
        return `/crm?contact=${entityId}`
      case "offer":
        // Offer detail isn't on a buyers page (CRM-centric architecture);
        // route to the listing's offers page where the offer card lives
        // (URL fragment lets the page scroll to / open the row).
        return `/dashboard/transactions?offer=${entityId}`
      case "showing":
        return `/dashboard/showings/${entityId}`
      case "buyer_tour":
        return `/dashboard/tours/${entityId}`
      case "campaign_sequence":
        return `/dashboard/campaigns/sequences/${entityId}`
      case "sequence_enrollment":
        return `/dashboard/campaigns/sequences/${entityId}`
      default:
        // Unknown entity_type — fall through to type-based routing
        break
    }
  }

  // Type-driven routes (no entity_id required — go to the section)
  if (type) {
    if (type.startsWith("contingency_") && type.endsWith("_expiring")) {
      return entityId ? `/dashboard/transactions/${entityId}` : "/dashboard/transactions"
    }
    if (type === "buyer_intake_submitted" && entityId) {
      return `/crm?contact=${entityId}`
    }
    if (type === "offer_packet_ready" && entityId) {
      return `/dashboard/documents/${entityId}`
    }
    if (type === "listing_agreement_packet_ready" && entityId) {
      return `/dashboard/listings/new?documentId=${entityId}`
    }
    if (type === "listing_presentation_ready") {
      return entityId ? `/dashboard/listings/presentations/${entityId}` : "/dashboard/listings"
    }
    if (type === "esign_provider_not_configured" || type === "esign_provider_manual_send") {
      return "/settings/integrations"
    }
    if (type === "showing_manual_contact_required" && entityId) {
      return `/dashboard/showings/${entityId}`
    }
  }

  return null
}
