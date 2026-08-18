
// ============================================
// SHARED VALIDATION UTILITIES
// Central validation module for consistent data validation across all actions
// ============================================
//
// WHAT IS ACTUALLY ADOPTED, AND WHAT HAPPENED TO THE REST (audited, not assumed)
//
// isValidUUID is the workhorse — 116 call sites — with validatePhone,
// validateEmail, validateContact and validateTransactionData also in use.
//
// A prior wave audited the seven that had no callers (isValidDate, isValidURL,
// validateArray, validateContentLength, validateHashtags, validateProperty,
// validateUUIDArray) and ruled them "speculative utilities with no named
// duplicate — not deleted, but not to be adopted on sight". That audit did the
// hard half of the work and then stopped one step short: for six of the seven
// it had ALREADY NAMED the survivor, and a weaker copy of a check that lives
// somewhere better is exactly the case the burn-down rule calls a duplicate.
// The seventh had no survivor because it had never been wired, which makes it a
// build, not a keep. Resolved in the orphan burn-down (lane O):
//
//   · isValidDate — DELETED. SURVIVORS: lib/transactions/earnest-terms.ts pairs
//     an ISO_DATE regex WITH Date.parse (isValidDate would accept "12/31/2025",
//     which V8 parses happily, and a contract date is not a place to widen the
//     accepted format); lib/transactions/buyer-move.ts normalises to UTC
//     midnight before parsing, so a timezone cannot shift a closing date across
//     a day. Both are STRICTER; adopting this one would have been a regression
//     dressed up as consolidation.
//   · isValidURL — DELETED. SURVIVOR: app/actions/tenant-webhooks.ts, which
//     returns the REASON a URL was rejected; this returned a bare boolean, so
//     the operator lost the message that tells them what to fix. (The try/catch
//     `new URL()` shape in lib/kernel/regulatory-watcher.ts and
//     content-intel-scan.ts is not validation at all — they extract a hostname
//     for dedup.)
//   · validateHashtags — DELETED. SURVIVOR:
//     app/actions/video-repurposing.utils.ts `validateSnippetForPlatform`
//     (live via app/actions/video-repurposing.ts:11), which enforces a
//     PER-PLATFORM hashtagLimit — 5 on Twitter, 10 on TikTok and LinkedIn, 30
//     on the Meta surfaces. This one enforced a flat 30 everywhere, i.e. it
//     passed a caption that TikTok rejects.
//   · validateContentLength — DELETED. SURVIVOR: lib/social/publisher.ts:307
//     `validateContentForPlatform`, which carries the real per-platform limits
//     (280 / 500 / 2200 / 3000 / 63206) and the requires-media rule, and is now
//     wired as the pre-flight inside `publishToSocialPlatform`. A caller of the
//     deleted function had to supply the min/max itself — i.e. had to already
//     know the answer the survivor knows.
//   · validateUUIDArray — DELETED. SURVIVOR: `isValidUUID` in this same file.
//     Its whole body was a loop over isValidUUID, and the codebase's idiom for
//     a batch is `.every(isValidUUID)` / `.filter(isValidUUID)` at the call
//     site, where the caller can say WHICH id was bad in its own vocabulary.
//   · validateArray — DELETED. No survivor is needed and none was ever found:
//     it bounds an array's length with no domain attached, and every array
//     bound in this tree is a domain rule stated where the array is used (batch
//     sizes, hashtag counts, recipient caps). It was a shape, not a check.
//   · validateProperty — KEPT and WIRED (the one build in the cluster). It is
//     the only property-fact validator in the tree, and lib/kernel/listings.ts
//     `createListingRecord` — which validated three UUIDs and three address
//     strings — had no gate on list price, zip, bedrooms or bathrooms at all.
//     That is now its caller. Do not delete it: it has one, and it is load
//     bearing.
//
// The rule that produced the prior wave's caution still stands and is why five
// of the six above are deletions rather than adoptions: when a caller's inline
// check is stricter than the shared helper, the CALLER wins. Take a shared
// helper only if you also keep the caller's extra strictness.

// UUID Validation
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidUUID(value: string | null | undefined): value is string {
  if (!value || typeof value !== "string") return false
  return UUID_REGEX.test(value)
}

// requireValidUUID lived here and was REMOVED as a duplicate of
// lib/errors/index.ts throwIfInvalidUUID (keep-one). That survivor has SINCE
// been deleted too (orphan burn-down, lane O): it never gained a caller either,
// because what this codebase does not use is the THROW, not either copy of it.
// The answer to "is this a UUID?" is isValidUUID below, used as
// `if (!isValidUUID(x)) return { success: false, error: "Invalid agent ID" }`.
// Do not reintroduce a thrower in either file.

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

// URL Validation — isValidURL REMOVED (orphan burn-down, lane O). See the
// header: app/actions/tenant-webhooks.ts is the survivor and returns the reason.

// Price Validation
export function isValidPrice(price: number | null | undefined): boolean {
  return typeof price === "number" && price >= 0 && !isNaN(price)
}

// Date Validation — isValidDate REMOVED (orphan burn-down, lane O). See the
// header: lib/transactions/earnest-terms.ts and lib/transactions/buyer-move.ts
// are the survivors and are both stricter than a bare `new Date()` parse.

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
// CONTENT VALIDATORS — REMOVED (orphan burn-down, lane O)
// ============================================
//
// `validateContentLength(content, min, max)` and `validateHashtags(hashtags)`
// both died here. See the header for the full reasoning; in one line each:
//   · length  → lib/social/publisher.ts:307 validateContentForPlatform knows the
//     per-platform limit instead of asking the caller to pass it, and is now the
//     pre-flight inside publishToSocialPlatform.
//   · hashtags → app/actions/video-repurposing.utils.ts validateSnippetForPlatform
//     enforces a per-platform hashtagLimit; the flat 30 here passed captions
//     that TikTok (10) and Twitter (5) reject.
// Do not reintroduce a platform-blind copy of either.

// ============================================
// ARRAY VALIDATORS — REMOVED (orphan burn-down, lane O)
// ============================================
//
// `validateArray(arr, min, max)` and `validateUUIDArray(uuids)` both died here.
// validateUUIDArray's survivor is `isValidUUID` above — its body was a loop over
// it, and `.every(isValidUUID)` at the call site lets the caller name which id
// was bad in its own vocabulary. validateArray bounded a length with no domain
// attached; every array bound in this tree is a domain rule stated where the
// array is used.

// Alias for backward compatibility
export const validateTransactionData = validateTransaction
