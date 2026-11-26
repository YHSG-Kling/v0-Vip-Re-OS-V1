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

// TOMBSTONE (dead-import tranche): `PortalVisibilityInput` and
// `NavigationBuildInput` are deleted. Neither ever had an implementation; the
// only file that named them was lib/kernel/portal.ts, which imported both and
// used neither, so removing that import left them referenced by nothing at all.
// Both describe functions this kernel already has under other names, and those
// are the survivors because they are the ones that are WIRED:
//   · visibility  → `determinePortalModules` (lib/kernel/portal.ts:287), whose
//     input is `PortalModulesInput` above and whose output carries exactly the
//     visibility booleans; the `canAccessPortal` half is answered for both
//     routes by `requireContactAccess` (lib/portal/require-contact-access.ts).
//   · navigation  → `buildPortalNav` (lib/kernel/portal.ts:452), called by
//     app/portal/[contactId]/layout.tsx:258 with (view, modules, contactId) —
//     the same three fields NavigationBuildInput declared.
// Nothing merged onto the survivors: every field these two carried that the
// survivors lack (`isPropertyOwner` on the nav side) has no reader either, so
// transplanting it would have created a new orphan rather than closed one.

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

// TOMBSTONE (dead-import tranche): `PortalVisibilityOutput`, `NavigationItem`
// and `NavigationBuildOutput` are deleted, for the same reason and with the same
// survivors as the two Input contracts above — `determinePortalModules` /
// `requireContactAccess` for visibility, `buildPortalNav` (returning
// `NavItem[]`, lib/kernel/portal.ts:31) for navigation. `NavigationItem` goes
// with them because `NavigationBuildOutput` was its only reference in the tree.
//
// The four fields the deleted output shapes carried that `NavItem` does not —
// `visible`, `badge`, `profileNav`, `activeSection`, `isHomeowner` — were NOT
// merged onto the survivor, deliberately: `visible` is already expressed by
// buildPortalNav filtering the item out, and the other four have no producer and
// no surface. Adding them would move the orphan rather than close it.

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
