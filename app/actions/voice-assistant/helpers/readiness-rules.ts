/**
 * SYSTEM 6.1 - Readiness Rules
 * Defines required lifecycle events for each command
 */

export const READINESS_RULES = {
  // MLS activation requires full readiness
  activate_mls: {
    required_events: [
      'seller.listing_agreement.signed',
      'seller.media.approved',
      'seller.coming_soon.activated',
      'seller.mls.ready',
      'seller.open_house_marketing.approved'
    ]
  },

  // Submit to MLS requires readiness but not final approval
  submit_to_mls: {
    required_events: [
      'seller.listing_agreement.signed',
      'seller.media.approved',
      'seller.coming_soon.activated',
      'seller.open_house_marketing.approved'
    ]
  },

  // Coming soon requires media approval
  activate_coming_soon: {
    required_events: [
      'seller.media.approved'
    ]
  },

  // Open house marketing requires MLS readiness
  approve_open_house_marketing: {
    required_events: [
      'seller.mls.ready'
    ]
  },

  // CMA generation requires appointment scheduled
  generate_cma: {
    required_events: [
      'seller.appointment.scheduled'
    ]
  },

  // Buyer search requires financial verification
  configure_buyer_search: {
    required_events: [
      'buyer.financial.verified'
    ]
  },

  // Query commands - no readiness requirements
  query_listing_status: {
    required_events: []
  },

  query_buyer_stage: {
    required_events: []
  },

  query_mls_readiness: {
    required_events: []
  }
} as const

export type ReadinessRuleKey = keyof typeof READINESS_RULES
