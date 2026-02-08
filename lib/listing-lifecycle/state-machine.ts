/**
 * System 4.1 - Listing Lifecycle State Machine
 * 
 * Defines valid listing statuses and allowed transitions between them.
 * This is the single source of truth for listing lifecycle rules.
 */

export type ListingStatus =
  | 'draft'
  | 'active'
  | 'pending'
  | 'under_contract'
  | 'sold'
  | 'expired'
  | 'withdrawn'
  | 'archived'

export type ListingStage =
  | 'prospecting'
  | 'pre_listing'
  | 'listing_agreement'
  | 'pre_market'
  | 'active_market'
  | 'under_contract'
  | 'closing'
  | 'closed'
  | 'post_close'

export interface TransitionRule {
  from: ListingStatus
  to: ListingStatus
  requires?: string[] // Required fields or conditions
  triggers?: string[] // Automated workflows to trigger
  description: string
}

/**
 * Valid status transitions for listing lifecycle
 * Each transition includes requirements and automated triggers
 */
export const LISTING_TRANSITIONS: TransitionRule[] = [
  // Draft to Active
  {
    from: 'draft',
    to: 'active',
    requires: ['listing_agreement_signed', 'mls_number'],
    triggers: ['listing_went_live_workflow'],
    description: 'Listing goes live in MLS after agreement signed'
  },
  
  // Active to Pending
  {
    from: 'active',
    to: 'pending',
    requires: ['offer_accepted'],
    triggers: ['offer_accepted_workflow'],
    description: 'Offer accepted, awaiting contract signatures'
  },
  
  // Pending to Under Contract
  {
    from: 'pending',
    to: 'under_contract',
    requires: ['buyer_contract_signed', 'seller_contract_signed'],
    triggers: ['under_contract_workflow'],
    description: 'All contracts signed, in escrow'
  },
  
  // Under Contract to Sold
  {
    from: 'under_contract',
    to: 'sold',
    requires: ['closing_date', 'deed_recorded'],
    triggers: ['sale_closed_workflow'],
    description: 'Transaction closed, deed recorded'
  },
  
  // Active to Expired
  {
    from: 'active',
    to: 'expired',
    requires: ['listing_expiration_date'],
    triggers: ['listing_expired_workflow'],
    description: 'Listing agreement expired without sale'
  },
  
  // Active/Pending to Withdrawn
  {
    from: 'active',
    to: 'withdrawn',
    triggers: ['listing_withdrawn_workflow'],
    description: 'Seller withdrew listing from market'
  },
  {
    from: 'pending',
    to: 'withdrawn',
    triggers: ['listing_withdrawn_workflow'],
    description: 'Deal fell through, listing withdrawn'
  },
  
  // Withdrawn back to Active (re-list)
  {
    from: 'withdrawn',
    to: 'active',
    requires: ['listing_agreement_signed'],
    triggers: ['listing_relisted_workflow'],
    description: 'Listing reactivated after being withdrawn'
  },
  
  // Expired to Active (renewal)
  {
    from: 'expired',
    to: 'active',
    requires: ['listing_agreement_signed', 'new_expiration_date'],
    triggers: ['listing_renewed_workflow'],
    description: 'Listing renewed with new agreement'
  },
  
  // Any final status to Archived
  {
    from: 'sold',
    to: 'archived',
    description: 'Closed listing archived for historical records'
  },
  {
    from: 'expired',
    to: 'archived',
    description: 'Expired listing archived'
  },
  {
    from: 'withdrawn',
    to: 'archived',
    description: 'Withdrawn listing archived'
  },
  
  // Under Contract back to Active (deal fell through)
  {
    from: 'under_contract',
    to: 'active',
    triggers: ['back_on_market_workflow'],
    description: 'Deal fell through, listing back on market'
  },
  
  // Pending back to Active (offer rejected/cancelled)
  {
    from: 'pending',
    to: 'active',
    triggers: ['back_on_market_workflow'],
    description: 'Offer cancelled, listing back on market'
  }
]

/**
 * Stage progression map - defines how stages advance
 */
export const STAGE_PROGRESSION: Record<ListingStage, ListingStage | null> = {
  prospecting: 'pre_listing',
  pre_listing: 'listing_agreement',
  listing_agreement: 'pre_market',
  pre_market: 'active_market',
  active_market: 'under_contract',
  under_contract: 'closing',
  closing: 'closed',
  closed: 'post_close',
  post_close: null // Final stage
}

/**
 * Check if a status transition is valid
 */
export function isValidTransition(from: ListingStatus, to: ListingStatus): boolean {
  return LISTING_TRANSITIONS.some(rule => rule.from === from && rule.to === to)
}

/**
 * Get transition rule for a specific transition
 */
export function getTransitionRule(from: ListingStatus, to: ListingStatus): TransitionRule | undefined {
  return LISTING_TRANSITIONS.find(rule => rule.from === from && rule.to === to)
}

/**
 * Get all possible transitions from a given status
 */
export function getAvailableTransitions(from: ListingStatus): TransitionRule[] {
  return LISTING_TRANSITIONS.filter(rule => rule.from === from)
}

/**
 * Get recommended status based on stage
 */
export function getRecommendedStatus(stage: ListingStage): ListingStatus {
  const stageToStatusMap: Record<ListingStage, ListingStatus> = {
    prospecting: 'draft',
    pre_listing: 'draft',
    listing_agreement: 'draft',
    pre_market: 'draft',
    active_market: 'active',
    under_contract: 'under_contract',
    closing: 'under_contract',
    closed: 'sold',
    post_close: 'sold'
  }
  
  return stageToStatusMap[stage] || 'draft'
}

/**
 * Get next stage in progression
 */
export function getNextStage(currentStage: ListingStage): ListingStage | null {
  return STAGE_PROGRESSION[currentStage]
}

/**
 * Validate if stage transition is allowed
 */
export function isValidStageProgression(from: ListingStage, to: ListingStage): boolean {
  const nextStage = STAGE_PROGRESSION[from]
  return nextStage === to || to === from // Can stay in same stage
}

/**
 * Get status label for display
 */
export function getStatusLabel(status: ListingStatus): string {
  const labels: Record<ListingStatus, string> = {
    draft: 'Draft',
    active: 'Active',
    pending: 'Pending',
    under_contract: 'Under Contract',
    sold: 'Sold',
    expired: 'Expired',
    withdrawn: 'Withdrawn',
    archived: 'Archived'
  }
  return labels[status]
}

/**
 * Get stage label for display
 */
export function getStageLabel(stage: ListingStage): string {
  const labels: Record<ListingStage, string> = {
    prospecting: 'Prospecting',
    pre_listing: 'Pre-Listing',
    listing_agreement: 'Listing Agreement',
    pre_market: 'Pre-Market Prep',
    active_market: 'Active on Market',
    under_contract: 'Under Contract',
    closing: 'Closing Process',
    closed: 'Closed',
    post_close: 'Post-Close'
  }
  return labels[stage]
}

/**
 * Get status color for UI
 */
export function getStatusColor(status: ListingStatus): string {
  const colors: Record<ListingStatus, string> = {
    draft: 'gray',
    active: 'green',
    pending: 'yellow',
    under_contract: 'blue',
    sold: 'purple',
    expired: 'red',
    withdrawn: 'orange',
    archived: 'gray'
  }
  return colors[status]
}
