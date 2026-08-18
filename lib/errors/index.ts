// ============================================
// SHARED ERROR HANDLING
// Central error handling module for consistent error management
// ============================================
//
// WHAT IS ADOPTED HERE, AND THE DISPOSITION OF WHAT IS NOT (audited, not assumed)
//
// handleError is the workhorse; AppError and its subclasses, logError,
// createErrorResponse / createSuccessResponse and handleAction are all in use.
//
// Five exports had no callers and sat on the category-C burn-down list:
// asyncErrorBoundary, retryAsync, throwIfInvalidUUID, throwIfEmpty,
// throwIfNotInArray. A prior wave audited them and left them alone. Resolved in
// the orphan burn-down (lane O) — one build, four deletions:
//
//   · retryAsync — KEPT and WIRED. It is an IN-PROCESS retry (sleep +
//     exponential backoff on a single call). lib/errors/auto-retry.ts looks
//     like its twin and is NOT: that one is a durable, DB-backed retry ledger
//     for automation errors, and its own header explains why — Vercel
//     serverless cannot sleep across a long delay, so it stores next_retry_at
//     for the retry-errors cron. Different problem, different lifetime, and
//     nothing in between covered a provider blip inside one request. Its
//     adoption site is lib/agentic-os/connector-gateway.ts `callConnector`, the
//     single egress choke point, which classified 429 / 5xx / timeout as error
//     types and then never retried any of them. Deliberately scoped to GET —
//     see the tombstone-adjacent note there: replaying a POST is replaying a
//     charge or a text message.
//   · throwIfInvalidUUID, throwIfEmpty, throwIfNotInArray — DELETED. These are
//     a THROW-style validation idiom, and this codebase settled on the opposite
//     convention: a refusal is RETURNED as `{ success: false, error }` from the
//     kernel command or server action that detected it. The evidence is in the
//     history of throwIfInvalidUUID itself — a prior keep-one merge deleted
//     lib/validations `requireValidUUID` in its favour, and the survivor STILL
//     never gained a caller. What was unused was never the particular copy; it
//     was the throw. Survivors, all live:
//       – UUID → `isValidUUID` (lib/validations/index.ts:42, 116 call sites),
//         used as `if (!isValidUUID(x)) return { success:false, error:… }`.
//       – required string → the inline `!value?.trim()` refusal, e.g.
//         lib/kernel/listings.ts `createListingRecord` ("Address is required").
//       – membership → the `VALID_*.includes(...)` guards, e.g.
//         lib/kernel/financial.ts:1112, lib/kernel/reputation.ts:458,
//         app/actions/blog-cadence-policy.ts:86.
//     Each survivor names the field it rejected, which is what the deleted
//     throwers did too — nothing was lost, only the control-flow style.
//   · asyncErrorBoundary — DELETED. SURVIVOR: `handleAction` below in this
//     file. Their catch blocks are the same two lines (logError, then
//     createErrorResponse); handleAction additionally wraps the success path in
//     createSuccessResponse, so it is the more complete of the two, and it
//     takes the thunk rather than re-wrapping an existing function — which is
//     the shape that fits a server action. Stated plainly: handleAction is
//     itself thinly adopted, so this is a keep-one between two forms of the
//     same idea rather than a busy survivor absorbing a dead one. Keeping both
//     would leave two answers to one question and no reason to pick either.
//
// The standing rule that produced the prior wave's caution still holds and is
// why the deletions above each name a survivor rather than citing the count:
// the orphan number is never by itself a reason to remove code.

import { ERROR_MESSAGES } from "../constants"
// The UUID_REGEX import that used to sit here went out with throwIfInvalidUUID
// (orphan burn-down, lane O). The canonical pattern still lives in
// lib/validations, which owns UUID checking (isValidUUID, 116 call sites) —
// nothing in this file needs it any more.

// ============================================
// CUSTOM ERROR CLASSES
// ============================================

export class AppError extends Error {
  constructor(
    message: string,
    public code: string = "APP_ERROR",
    public statusCode: number = 500,
    public details?: any
  ) {
    super(message)
    this.name = "AppError"
    Object.setPrototypeOf(this, AppError.prototype)
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      details: this.details,
    }
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(message, "VALIDATION_ERROR", 400, details)
    this.name = "ValidationError"
    Object.setPrototypeOf(this, ValidationError.prototype)
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = ERROR_MESSAGES.NOT_AUTHENTICATED) {
    super(message, "AUTHENTICATION_ERROR", 401)
    this.name = "AuthenticationError"
    Object.setPrototypeOf(this, AuthenticationError.prototype)
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = ERROR_MESSAGES.UNAUTHORIZED) {
    super(message, "AUTHORIZATION_ERROR", 403)
    this.name = "AuthorizationError"
    Object.setPrototypeOf(this, AuthorizationError.prototype)
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = "Resource") {
    super(`${resource} not found`, "NOT_FOUND", 404)
    this.name = "NotFoundError"
    Object.setPrototypeOf(this, NotFoundError.prototype)
  }
}

export class ConflictError extends AppError {
  constructor(message: string = ERROR_MESSAGES.ALREADY_EXISTS) {
    super(message, "CONFLICT_ERROR", 409)
    this.name = "ConflictError"
    Object.setPrototypeOf(this, ConflictError.prototype)
  }
}

export class DatabaseError extends AppError {
  constructor(message: string = ERROR_MESSAGES.DATABASE_ERROR, details?: any) {
    super(message, "DATABASE_ERROR", 500, details)
    this.name = "DatabaseError"
    Object.setPrototypeOf(this, DatabaseError.prototype)
  }
}

export class IntegrationError extends AppError {
  constructor(service: string, message: string = ERROR_MESSAGES.INTEGRATION_ERROR, details?: any) {
    super(`${service}: ${message}`, "INTEGRATION_ERROR", 502, details)
    this.name = "IntegrationError"
    Object.setPrototypeOf(this, IntegrationError.prototype)
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = ERROR_MESSAGES.RATE_LIMIT_EXCEEDED) {
    super(message, "RATE_LIMIT_ERROR", 429)
    this.name = "RateLimitError"
    Object.setPrototypeOf(this, RateLimitError.prototype)
  }
}

export class DemoModeError extends AppError {
  constructor(message: string = ERROR_MESSAGES.DEMO_MODE_RESTRICTION) {
    super(message, "DEMO_MODE_ERROR", 403)
    this.name = "DemoModeError"
    Object.setPrototypeOf(this, DemoModeError.prototype)
  }
}

// ============================================
// ERROR LOGGING UTILITY
// ============================================

export interface ErrorLogOptions {
  context?: string
  userId?: string
  metadata?: Record<string, any>
  silent?: boolean
}

export function logError(error: Error | AppError, options: ErrorLogOptions = {}) {
  const { context = "Unknown", userId, metadata, silent = false } = options

  const errorData = {
    timestamp: new Date().toISOString(),
    context,
    userId,
    name: error.name,
    message: error.message,
    code: error instanceof AppError ? error.code : "UNKNOWN",
    statusCode: error instanceof AppError ? error.statusCode : 500,
    stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    metadata,
  }

  // Log to console (in production, this would go to a logging service)
  if (!silent) {
    if (process.env.NODE_ENV === "development") {
      console.error(`[v0] [${context}] Error:`, errorData)
    } else {
      console.error(JSON.stringify(errorData))
    }
  }

  // In production, send to error tracking service (Sentry, etc.)
  if (process.env.NODE_ENV === "production") {
    // TODO: Send to error tracking service
  }

  return errorData
}

// ============================================
// ERROR RESPONSE HELPERS
// ============================================

export interface ErrorResponse {
  success: false
  error: string
  code?: string
  details?: any
}

export function createErrorResponse(error: Error | AppError, includeDetails = false): ErrorResponse {
  const response: ErrorResponse = {
    success: false,
    error: error.message,
  }

  if (error instanceof AppError) {
    response.code = error.code

    if (includeDetails && error.details) {
      response.details = error.details
    }
  }

  return response
}

export interface SuccessResponse<T = any> {
  success: true
  data?: T
  message?: string
}

export function createSuccessResponse<T>(data?: T, message?: string): SuccessResponse<T> {
  return {
    success: true,
    ...(data !== undefined && { data }),
    ...(message && { message }),
  }
}

// ============================================
// ERROR HANDLING WRAPPER
// ============================================

export async function handleAction<T>(
  action: () => Promise<T>,
  context: string,
  options: ErrorLogOptions = {}
): Promise<{ success: true; data: T } | { success: false; error: string; code?: string }> {
  try {
    const data = await action()
    return createSuccessResponse(data) as { success: true; data: T }
  } catch (error) {
    logError(error as Error, { ...options, context })

    if (error instanceof AppError) {
      return createErrorResponse(error, process.env.NODE_ENV === "development")
    }

    return createErrorResponse(new AppError((error as Error).message || "An unexpected error occurred"))
  }
}

// ============================================
// VALIDATION ERROR HELPERS — REMOVED (orphan burn-down, lane O)
// ============================================
//
// `throwIfInvalidUUID`, `throwIfEmpty` and `throwIfNotInArray` all died here.
// See the header for the survivors; the short version is that this codebase
// RETURNS refusals (`{ success: false, error }`) rather than throwing them, so
// the throw idiom — not any one of these three — is what had no adopter.
// `ValidationError` above is untouched and still the right class to raise when
// a genuine exception is warranted. Do not reintroduce a thrower here.

// ============================================
// ASYNC ERROR BOUNDARY — REMOVED (orphan burn-down, lane O)
// ============================================
//
// `asyncErrorBoundary(fn, context)` died here. SURVIVOR: `handleAction` above —
// same catch (logError → createErrorResponse), plus the success envelope, and
// it takes the thunk instead of re-wrapping an existing function.

// ============================================
// RETRY LOGIC
// ============================================

export interface RetryOptions {
  maxRetries?: number
  delayMs?: number
  backoff?: boolean
  onRetry?: (attempt: number, error: Error) => void
}

export async function retryAsync<T>(
  action: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, delayMs = 1000, backoff = true, onRetry } = options

  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await action()
    } catch (error) {
      lastError = error as Error

      if (attempt < maxRetries - 1) {
        const delay = backoff ? delayMs * Math.pow(2, attempt) : delayMs

        if (onRetry) {
          onRetry(attempt + 1, lastError)
        }

        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError || new Error("Retry failed with unknown error")
}

// ============================================
// SIMPLIFIED ERROR HANDLER
// Used throughout action files for consistent error handling
// ============================================

export function handleError(error: any, context?: string): { success: false; error: string } {
  // Extract error message properly from various error types
  let errorMessage: string
  
  if (error instanceof Error) {
    errorMessage = error.message
  } else if (typeof error === 'object' && error !== null) {
    // Handle Supabase/PostgreSQL errors and other object errors
    errorMessage = error.message || error.error || error.details || JSON.stringify(error)
  } else if (typeof error === 'string') {
    errorMessage = error
  } else {
    errorMessage = "An unexpected error occurred"
  }
  
  const errorInstance = error instanceof Error ? error : new Error(errorMessage)
  logError(errorInstance, { context })
  
  if (error instanceof AppError) {
    return createErrorResponse(error, process.env.NODE_ENV === "development")
  }
  
  return {
    success: false,
    error: errorMessage,
  }
}

// ============================================
// EXPORT ALL
// ============================================

export {
  ERROR_MESSAGES,
}
