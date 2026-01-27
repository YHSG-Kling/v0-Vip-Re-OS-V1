"use server"

// ============================================
// SHARED VALIDATION UTILITIES
// Central validation module for consistent data validation across all actions
// ============================================

// UUID Validation
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidUUID(value: string | null | undefined): value is string {
  if (!value || typeof value !== "string") return false
  return UUID_REGEX.test(value)
}

export function requireValidUUID(value: string | null | undefined, fieldName = "ID"): string {
  if (!isValidUUID(value)) {
    throw new Error(`Invalid ${fieldName} format. Expected UUID.`)
  }
  return value
}

// Email Validation
export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

// Alias for consistency with imports
export const validateEmail = isValidEmail

// Phone Validation
export function isValidPhone(phone: string | null | undefined): boolean {
  if (!phone) return false
  const phoneRegex = /^\+?1?\d{10,14}$/
  return phoneRegex.test(phone.replace(/[\s\-\(\)]/g, ""))
}

// Alias for consistency with imports
export const validatePhone = isValidPhone

// URL Validation
export function isValidURL(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

// Price Validation
export function isValidPrice(price: number | null | undefined): boolean {
  return typeof price === "number" && price >= 0 && !isNaN(price)
}

// Date Validation
export function isValidDate(date: string | Date | null | undefined): boolean {
  if (!date) return false
  const parsedDate = new Date(date)
  return !isNaN(parsedDate.getTime())
}

// Zipcode Validation (US)
export function isValidZipcode(zip: string | null | undefined): boolean {
  if (!zip) return false
  const zipcodeRegex = /^\d{5}(-\d{4})?$/
  return zipcodeRegex.test(zip)
}

// ============================================
// SCHEMA VALIDATORS
// ============================================

export interface ContactValidation {
  name?: string
  email?: string
  phone?: string
  agent_id?: string
}

export function validateContact(data: ContactValidation): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (data.email && !isValidEmail(data.email)) {
    errors.push("Invalid email format")
  }

  if (data.phone && !isValidPhone(data.phone)) {
    errors.push("Invalid phone number format")
  }

  if (data.agent_id && !isValidUUID(data.agent_id)) {
    errors.push("Invalid agent ID format")
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export interface PropertyValidation {
  address?: string
  city?: string
  state?: string
  zip?: string
  price?: number
  bedrooms?: number
  bathrooms?: number
}

export function validateProperty(data: PropertyValidation): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (data.price !== undefined && !isValidPrice(data.price)) {
    errors.push("Invalid price")
  }

  if (data.zip && !isValidZipcode(data.zip)) {
    errors.push("Invalid zip code")
  }

  if (data.bedrooms !== undefined && (data.bedrooms < 0 || data.bedrooms > 50)) {
    errors.push("Invalid number of bedrooms")
  }

  if (data.bathrooms !== undefined && (data.bathrooms < 0 || data.bathrooms > 50)) {
    errors.push("Invalid number of bathrooms")
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export interface TransactionValidation {
  agent_id: string
  property_id?: string
  contact_id?: string
  transaction_type?: "listing" | "buyer" | "referral"
  status?: string
}

export function validateTransaction(data: TransactionValidation): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!isValidUUID(data.agent_id)) {
    errors.push("Invalid agent ID")
  }

  if (data.property_id && !isValidUUID(data.property_id)) {
    errors.push("Invalid property ID")
  }

  if (data.contact_id && !isValidUUID(data.contact_id)) {
    errors.push("Invalid contact ID")
  }

  const validTypes = ["listing", "buyer", "referral"]
  if (data.transaction_type && !validTypes.includes(data.transaction_type)) {
    errors.push("Invalid transaction type")
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

// ============================================
// CONTENT VALIDATORS
// ============================================

export function validateContentLength(
  content: string | null | undefined,
  minLength: number,
  maxLength: number
): { valid: boolean; error?: string } {
  if (!content) {
    return { valid: false, error: "Content is required" }
  }

  if (content.length < minLength) {
    return { valid: false, error: `Content must be at least ${minLength} characters` }
  }

  if (content.length > maxLength) {
    return { valid: false, error: `Content must not exceed ${maxLength} characters` }
  }

  return { valid: true }
}

export function validateHashtags(hashtags: string[]): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (hashtags.length > 30) {
    errors.push("Maximum 30 hashtags allowed")
  }

  for (const tag of hashtags) {
    if (!tag.startsWith("#")) {
      errors.push(`Invalid hashtag format: ${tag}`)
    }

    if (tag.length > 50) {
      errors.push(`Hashtag too long: ${tag}`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

// ============================================
// ARRAY VALIDATORS
// ============================================

export function validateArray<T>(
  arr: T[] | null | undefined,
  minLength = 0,
  maxLength = Number.POSITIVE_INFINITY
): { valid: boolean; error?: string } {
  if (!arr) {
    return { valid: false, error: "Array is required" }
  }

  if (arr.length < minLength) {
    return { valid: false, error: `Array must have at least ${minLength} items` }
  }

  if (arr.length > maxLength) {
    return { valid: false, error: `Array must not exceed ${maxLength} items` }
  }

  return { valid: true }
}

export function validateUUIDArray(uuids: string[] | null | undefined): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!uuids || !Array.isArray(uuids)) {
    return { valid: false, errors: ["Invalid UUID array"] }
  }

  for (const uuid of uuids) {
    if (!isValidUUID(uuid)) {
      errors.push(`Invalid UUID: ${uuid}`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
