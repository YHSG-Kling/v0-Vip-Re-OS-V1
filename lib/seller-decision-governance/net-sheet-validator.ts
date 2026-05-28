/**
 * System 5.3: CMA & Listing Presentation Governance Engine
 * Net Sheet Validator
 * 
 * Validates net sheet validity based on:
 * - Expiration window (default 30 days)
 * - Generation timestamp
 * - Override authority
 * 
 * This is GOVERNANCE ONLY - no net sheet calculations, no data generation
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"

export interface NetSheetValidityInput {
  listingId: string
  
  // Net sheet metadata (derived from activities or passed in)
  generatedAt?: Date
  validityDays?: number
  
  // Override context
  overrideByRole?: "agent" | "team_lead" | "broker" | "admin"
  overrideReason?: string
}

export interface NetSheetValidityResult {
  isValid: boolean
  isExpired: boolean
  daysRemaining: number
  
  generatedAt?: Date
  expiresAt?: Date
  
  warnings: string[]
  
  // Override tracking
  wasOverridden: boolean
  overrideBy?: string
  overrideReason?: string
}

/**
 * Default validity window (30 days)
 */
const DEFAULT_VALIDITY_DAYS = 30

/**
 * Validate net sheet validity
 */
export function validateNetSheetValidity(input: NetSheetValidityInput): NetSheetValidityResult {
  // Validation
  if (!isValidUUID(input.listingId)) {
    return {
      isValid: false,
      isExpired: true,
      daysRemaining: 0,
      warnings: ["Invalid listing ID"],
      wasOverridden: false,
    }
  }
  
  // Check for explicit override
  if (input.overrideByRole && ["broker", "admin"].includes(input.overrideByRole)) {
    return {
      isValid: true,
      isExpired: false,
      daysRemaining: 999,
      warnings: ["Net sheet validity overridden by " + input.overrideByRole],
      wasOverridden: true,
      overrideBy: input.overrideByRole,
      overrideReason: input.overrideReason || "No reason provided",
    }
  }
  
  // Check if net sheet exists
  if (!input.generatedAt) {
    return {
      isValid: false,
      isExpired: false,
      daysRemaining: 0,
      warnings: ["Net sheet not yet generated"],
      wasOverridden: false,
    }
  }
  
  const validityDays = input.validityDays || DEFAULT_VALIDITY_DAYS
  const generatedAt = input.generatedAt
  const expiresAt = new Date(generatedAt.getTime() + validityDays * 24 * 60 * 60 * 1000)
  const now = new Date()
  
  const isExpired = now > expiresAt
  const daysRemaining = Math.floor((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
  
  const warnings: string[] = []
  
  if (isExpired) {
    warnings.push(`Net sheet expired ${Math.abs(daysRemaining)} days ago`)
  } else if (daysRemaining <= 7) {
    warnings.push(`Net sheet expires in ${daysRemaining} days - regeneration recommended`)
  }
  
  return {
    isValid: !isExpired,
    isExpired,
    daysRemaining,
    generatedAt,
    expiresAt,
    warnings,
    wasOverridden: false,
  }
}

/**
 * Derive net sheet validity from activities events
 */
export async function deriveNetSheetValidityFromEvents(
  listingId: string
): Promise<NetSheetValidityInput | null> {
  if (!isValidUUID(listingId)) {
    return null
  }
  
  const supabase = await createClient()
  
  // Query activities for net sheet generation events
  const { data: events, error } = await supabase
    .from("activities")
    .select("event_type, metadata, created_at")
    .eq("listing_id", listingId)
    .or("event_type.eq.seller.net_sheet.generated,event_type.eq.seller.net_sheet.regenerated")
    .order("created_at", { ascending: false })
    .limit(1)
  
  if (error || !events || events.length === 0) {
    return null
  }
  
  const latestEvent = events[0]
  const meta = latestEvent.metadata as any
  
  return {
    listingId,
    generatedAt: new Date(latestEvent.created_at),
    validityDays: meta?.validity_days || meta?.validityDays || DEFAULT_VALIDITY_DAYS,
  }
}

/**
 * Check if net sheet is valid (quick check)
 */
export async function isNetSheetValid(listingId: string): Promise<boolean> {
  const input = await deriveNetSheetValidityFromEvents(listingId)
  if (!input) return false
  
  const result = validateNetSheetValidity(input)
  return result.isValid
}

// Agent task (correct location, no changes) — event_type: seller.net_sheet.expiration_warning
/**
 * Emit net sheet expiration event (for monitoring only)
 */
export async function emitNetSheetExpirationWarning(listingId: string, daysRemaining: number): Promise<void> {
  if (!isValidUUID(listingId)) return
  
  const supabase = await createClient()

  const { data: listing } = await supabase
    .from("listings")
    .select("brokerage_id")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing?.brokerage_id) return

  await supabase.from("activities").insert({
    brokerage_id: listing.brokerage_id,
    listing_id: listingId,
    entity_type: "listing",
    entity_id: listingId,
    activity_type: "seller.net_sheet.expiration_warning",
    metadata: {
      days_remaining: daysRemaining,
      warning_level: daysRemaining <= 3 ? "high" : daysRemaining <= 7 ? "medium" : "low",
      emitted_at: new Date().toISOString(),
    },
  })
}
