/**
 * System 4.1 - Status Transition Validator
 * 
 * Validates listing status transitions and checks requirements.
 * READS ONLY - no database writes, pure validation logic.
 */

import {
  ListingStatus,
  ListingStage,
  isValidTransition,
  getTransitionRule,
  isValidStageProgression
} from './state-machine'

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  missingRequirements: string[]
  transition?: {
    from: ListingStatus
    to: ListingStatus
    description: string
  }
}

export interface ListingData {
  id: string
  status: ListingStatus
  stage?: ListingStage
  listing_agreement_signed?: boolean
  mls_number?: string
  offer_accepted?: boolean
  buyer_contract_signed?: boolean
  seller_contract_signed?: boolean
  closing_date?: string
  deed_recorded?: boolean
  listing_expiration_date?: string
  new_expiration_date?: string
  [key: string]: any
}

/**
 * Validate a status transition
 */
export function validateStatusTransition(
  currentStatus: ListingStatus,
  targetStatus: ListingStatus,
  listingData: ListingData
): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    missingRequirements: []
  }

  // Check if transition is allowed
  if (!isValidTransition(currentStatus, targetStatus)) {
    result.valid = false
    result.errors.push(
      `Invalid transition: Cannot move from "${currentStatus}" to "${targetStatus}"`
    )
    return result
  }

  // Get transition rule
  const rule = getTransitionRule(currentStatus, targetStatus)
  if (!rule) {
    result.valid = false
    result.errors.push('Transition rule not found')
    return result
  }

  result.transition = {
    from: currentStatus,
    to: targetStatus,
    description: rule.description
  }

  // Check requirements
  if (rule.requires && rule.requires.length > 0) {
    for (const requirement of rule.requires) {
      const value = listingData[requirement]
      
      if (value === undefined || value === null || value === false || value === '') {
        result.missingRequirements.push(requirement)
        result.errors.push(
          `Missing required field: ${requirement.replace(/_/g, ' ')}`
        )
      }
    }
  }

  // Set valid to false if there are missing requirements
  if (result.missingRequirements.length > 0) {
    result.valid = false
  }

  // Add warnings for specific transitions
  if (currentStatus === 'active' && targetStatus === 'withdrawn') {
    result.warnings.push('Withdrawing an active listing may affect seller reputation')
  }

  if (currentStatus === 'under_contract' && targetStatus === 'active') {
    result.warnings.push('Deal fell through - consider price adjustment or other changes')
  }

  return result
}

/**
 * Validate stage progression
 */
export function validateStageProgression(
  currentStage: ListingStage,
  targetStage: ListingStage
): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    missingRequirements: []
  }

  if (!isValidStageProgression(currentStage, targetStage)) {
    result.valid = false
    result.errors.push(
      `Invalid stage progression: Cannot move from "${currentStage}" to "${targetStage}" directly`
    )
  }

  return result
}

/**
 * Check if listing can be archived
 */
export function canArchive(status: ListingStatus): ValidationResult {
  const result: ValidationResult = {
    valid: false,
    errors: [],
    warnings: [],
    missingRequirements: []
  }

  const archivableStatuses: ListingStatus[] = ['sold', 'expired', 'withdrawn']
  
  if (archivableStatuses.includes(status)) {
    result.valid = true
  } else {
    result.errors.push(
      `Cannot archive listing with status "${status}". Only sold, expired, or withdrawn listings can be archived.`
    )
  }

  return result
}

/**
 * Check if listing can go live
 */
export function canGoLive(listingData: ListingData): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    missingRequirements: []
  }

  const requiredFields = [
    'listing_agreement_signed',
    'mls_number',
    'price',
    'address',
    'bedrooms',
    'bathrooms',
    'square_feet'
  ]

  for (const field of requiredFields) {
    const value = listingData[field]
    if (value === undefined || value === null || value === false || value === '') {
      result.missingRequirements.push(field)
      result.errors.push(`Missing required field: ${field.replace(/_/g, ' ')}`)
    }
  }

  if (result.missingRequirements.length > 0) {
    result.valid = false
  }

  // Warnings
  if (!listingData.photos || (listingData.photos as any[]).length === 0) {
    result.warnings.push('No photos uploaded - listings with photos perform better')
  }

  if (!listingData.description || (listingData.description as string).length < 50) {
    result.warnings.push('Description is too short - add more details for better engagement')
  }

  return result
}

/**
 * Check if listing can accept offer
 */
export function canAcceptOffer(status: ListingStatus): ValidationResult {
  const result: ValidationResult = {
    valid: false,
    errors: [],
    warnings: [],
    missingRequirements: []
  }

  if (status === 'active') {
    result.valid = true
  } else {
    result.errors.push(
      `Cannot accept offer. Listing must be in "active" status, currently "${status}"`
    )
  }

  return result
}

/**
 * Check if listing can be withdrawn
 */
export function canWithdraw(status: ListingStatus): ValidationResult {
  const result: ValidationResult = {
    valid: false,
    errors: [],
    warnings: [],
    missingRequirements: []
  }

  const withdrawableStatuses: ListingStatus[] = ['active', 'pending']
  
  if (withdrawableStatuses.includes(status)) {
    result.valid = true
    if (status === 'active') {
      result.warnings.push('Withdrawing may affect market perception')
    }
  } else {
    result.errors.push(
      `Cannot withdraw listing with status "${status}". Only active or pending listings can be withdrawn.`
    )
  }

  return result
}

/**
 * Check if listing can be marked as sold
 */
export function canMarkSold(status: ListingStatus, listingData: ListingData): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    missingRequirements: []
  }

  if (status !== 'under_contract') {
    result.valid = false
    result.errors.push(
      `Cannot mark as sold. Listing must be "under_contract", currently "${status}"`
    )
  }

  const requiredFields = ['closing_date', 'deed_recorded']
  for (const field of requiredFields) {
    const value = listingData[field]
    if (value === undefined || value === null || value === false) {
      result.missingRequirements.push(field)
      result.errors.push(`Missing required field: ${field.replace(/_/g, ' ')}`)
    }
  }

  if (result.missingRequirements.length > 0) {
    result.valid = false
  }

  return result
}

/**
 * Get all validation errors for a listing
 */
export function getListingValidationErrors(listingData: ListingData): string[] {
  const errors: string[] = []

  // Basic required fields
  const requiredFields = ['address', 'price']
  for (const field of requiredFields) {
    const value = listingData[field]
    if (value === undefined || value === null || value === '') {
      errors.push(`Missing required field: ${field}`)
    }
  }

  // Price validation
  if (listingData.price && listingData.price <= 0) {
    errors.push('Price must be greater than 0')
  }

  return errors
}

/**
 * Get recommendations for improving listing
 */
export function getListingRecommendations(listingData: ListingData): string[] {
  const recommendations: string[] = []

  if (!listingData.description || (listingData.description as string).length < 100) {
    recommendations.push('Add a detailed description (at least 100 characters)')
  }

  if (!listingData.photos || (listingData.photos as any[]).length < 5) {
    recommendations.push('Add more photos (minimum 5 recommended)')
  }

  if (!listingData.virtual_tour_url) {
    recommendations.push('Add a virtual tour for better engagement')
  }

  if (!listingData.open_house_scheduled) {
    recommendations.push('Schedule an open house to attract more buyers')
  }

  return recommendations
}
