/**
 * PORTAL KERNEL CONTRACTS
 * 
 * Explicit normalized contracts for all portal data flows.
 * Every parent → child call uses these contracts.
 */

// ============================================================================
// INPUT CONTRACTS (What portal pages receive)
// ============================================================================

export interface PortalViewInput {
  /** Contact UUID (FK to contacts.id) */
  contactId: string
  /** Optional override for testing/admin */
  overrideView?: 'buyer' | 'seller' | 'lifetime'
}

export interface PortalModulesInput {
  /** Contact UUID */
  contactId: string
  /** Portal view type determined by kernel */
  view: 'buyer' | 'seller' | 'lifetime'
  /** Optional: whether contact owns property (homeowner mode) */
  isPropertyOwner?: boolean
}

export interface PortalVisibilityInput {
  /** Contact UUID */
  contactId: string
  /** Agent's brokerage_id (for authorization check) */
  brokerageId: string
  /** Contact's buyer_stage */
  buyerStage: string
  /** Contact's contact_type */
  contactType: 'buyer' | 'seller' | 'both'
  /** Whether contact has closed transaction and owns property */
  isPropertyOwner?: boolean
}

export interface NavigationBuildInput {
  /** Portal view type */
  view: 'buyer' | 'seller' | 'lifetime'
  /** Contact UUID */
  contactId: string
  /** Enabled modules from determinePortalModules */
  enabledModules: Record<string, boolean>
  /** Whether contact owns property (affects navigation labels) */
  isPropertyOwner?: boolean
}

// ============================================================================
// OUTPUT CONTRACTS (What kernel functions return)
// ============================================================================

export interface PortalViewOutput {
  /** Determined portal view */
  view: 'buyer' | 'seller' | 'lifetime'
  /** Why this view was chosen (for logging/debugging) */
  reason: string
  /** Contact's buyer_stage that determined this view */
  buyerStage: string
  /** Whether contact is in homeowner mode (closed transaction + property owner) */
  isPropertyOwner: boolean
}

export interface PortalModulesOutput {
  /** Module visibility map: module name → enabled */
  modules: Record<string, boolean>
  /** Default modules always visible */
  journey: boolean
  messages: boolean
  documents: boolean
  /** View-specific modules */
  buyer_smart_search: boolean
  seller_listing_actions: boolean
  offers: boolean
  showings: boolean
  properties: boolean
  calendar: boolean
  education: boolean
  /** Reason this module set was chosen */
  reason: string
}

export interface PortalVisibilityOutput {
  /** Whether this contact can access the portal at all */
  canAccessPortal: boolean
  /** Whether buyer smart search is visible */
  buyerSmartSearchVisible: boolean
  /** Whether seller listing actions are visible */
  sellerListingActionsVisible: boolean
  /** Whether transaction data is visible to contact */
  transactionVisible: boolean
  /** Whether lifetime/homeowner mode is enabled */
  lifetimeMode: boolean
  /** Reason for visibility decision */
  reason: string
  /** Error if access denied */
  error?: string
}

export interface NavigationItem {
  id: string
  label: string
  href: string
  icon?: string
  /** Whether this nav item should be shown */
  visible: boolean
  /** Badge count (e.g., unread messages) */
  badge?: number
}

export interface NavigationBuildOutput {
  /** Main navigation items in order */
  navItems: NavigationItem[]
  /** Secondary/profile navigation */
  profileNav: NavigationItem[]
  /** Current active section */
  activeSection?: string
  /** Whether this is homeowner mode (affects nav labels like "My Home" vs "Properties") */
  isHomeowner: boolean
}

// ============================================================================
// VALIDATION CONTRACTS (Validation rules)
// ============================================================================

export interface ValidationRules {
  /** Contact ID must be valid UUID */
  contactIdFormat: 'uuid'
  /** Brokerage ID must be valid UUID */
  brokerageIdFormat: 'uuid'
  /** Buyer stage must be one of these values */
  validBuyerStages: string[]
  /** Contact type must be one of these */
  validContactTypes: ('buyer' | 'seller' | 'both')[]
  /** Valid portal views */
  validViews: ('buyer' | 'seller' | 'lifetime')[]
}

export const PORTAL_VALIDATION_RULES: ValidationRules = {
  contactIdFormat: 'uuid',
  brokerageIdFormat: 'uuid',
  validBuyerStages: [
    'DISCOVERY',
    'SEARCHING',
    'UNDER_OFFER',
    'CLOSED',
    'BUYER_LIFETIME',
  ],
  validContactTypes: ['buyer', 'seller', 'both'],
  validViews: ['buyer', 'seller', 'lifetime'],
}

// ============================================================================
// ERROR CONTRACTS (Structured error responses)
// ============================================================================

export interface PortalError {
  code: string
  message: string
  field?: string
  status: number
}

export const PORTAL_ERRORS = {
  CONTACT_NOT_FOUND: {
    code: 'PORTAL_001',
    message: 'Contact not found or has no access',
    status: 404,
  },
  UNAUTHORIZED: {
    code: 'PORTAL_002',
    message: 'You do not have access to this portal',
    status: 403,
  },
  INVALID_INPUT: {
    code: 'PORTAL_003',
    message: 'Invalid input parameters',
    status: 400,
  },
  DATABASE_ERROR: {
    code: 'PORTAL_004',
    message: 'Failed to fetch portal data',
    status: 500,
  },
} as const

// ============================================================================
// SUCCESS CONTRACTS (Structured success responses)
// ============================================================================

export interface PortalSuccess<T = any> {
  success: true
  data: T
  timestamp: string
}

export function createPortalSuccess<T>(data: T): PortalSuccess<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  }
}

// ============================================================================
// COMBINED RESPONSE CONTRACTS (For API routes)
// ============================================================================

export type PortalResponse<T> = 
  | PortalSuccess<T>
  | { success: false; error: PortalError }

export function createPortalErrorResponse(error: PortalError): { success: false; error: PortalError } {
  return { success: false, error }
}
