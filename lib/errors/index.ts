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
// Four exports have no callers and show up on the category-C burn-down list:
// asyncErrorBoundary, retryAsync, throwIfEmpty, throwIfNotInArray. They were
// audited before being left alone, and the finding is that NONE has a named
// duplicate and none has an adoption site waiting for it:
//
//   · retryAsync is an IN-PROCESS retry (sleep + exponential backoff on a single
//     call). lib/errors/auto-retry.ts looks like its twin and is NOT: it is a
//     durable, DB-backed retry ledger for automation errors, and its own header
//     explains why — Vercel serverless cannot sleep across a long delay, so it
//     stores next_retry_at for the retry-errors cron to pick up. Different
//     problem, different lifetime. A sweep for hand-rolled in-process backoff
//     (Math.pow(2, attempt) and friends) found only that durable ladder and the
//     webhook delivery ladder, both also DB-backed. So there is nothing for
//     retryAsync to consolidate today.
//   · asyncErrorBoundary duplicates what handleAction already does for the
//     call sites that need it; it wraps rather than being wrapped, so adopting
//     it would mean rewriting call sites that are already correct.
//   · throwIfEmpty / throwIfNotInArray are generic and unclaimed.
//
// So these are speculative utilities. Under the standing rule they are NOT
// deleted — the orphan count is never by itself a reason to remove code — but
// they are also not something to adopt on sight. If one is genuinely needed,
// take it AND keep whatever extra strictness the caller already had.

import { ERROR_MESSAGES } from "../constants"
// The canonical UUID pattern lives in lib/validations, which owns UUID checking
// (isValidUUID is on 116 call sites). This file used to declare an 11th copy of
// the same regex inline.
import { UUID_REGEX } from "../validations"

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
// VALIDATION ERROR HELPERS
// ============================================

/**
 * KEEP-ONE (this is the survivor). lib/validations/index.ts previously exported
 * requireValidUUID doing the same job with the same signature; both were unwired.
 * This one wins because it throws a typed ValidationError carrying the offending
 * value and field name, which createErrorResponse and handleError already know
 * how to render — requireValidUUID threw a bare Error, losing that. Nothing it
 * did is missing here, so it was removed rather than left as a second answer to
 * the same question.
 *
 * The regex is IMPORTED, not re-declared. This file used to inline its own copy;
 * lib/validations owns the canonical one.
 */
export function throwIfInvalidUUID(value: string | null | undefined, fieldName = "ID"): string {
  if (!value || !UUID_REGEX.test(value)) {
    throw new ValidationError(`Invalid ${fieldName} format. Expected UUID.`, { value, fieldName })
  }

  return value
}

export function throwIfEmpty(value: string | null | undefined, fieldName: string): string {
  if (!value || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} is required.`, { fieldName })
  }

  return value
}

export function throwIfNotInArray<T>(value: T, allowedValues: readonly T[], fieldName: string): T {
  if (!allowedValues.includes(value)) {
    throw new ValidationError(`Invalid ${fieldName}. Must be one of: ${allowedValues.join(", ")}`, {
      value,
      allowedValues,
      fieldName,
    })
  }

  return value
}

// ============================================
// ASYNC ERROR BOUNDARY
// ============================================

export function asyncErrorBoundary<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  context: string
): (...args: Parameters<T>) => Promise<ReturnType<T> | ErrorResponse> {
  return async (...args: Parameters<T>) => {
    try {
      return await fn(...args)
    } catch (error) {
      logError(error as Error, { context })
      return createErrorResponse(error as Error)
    }
  }
}

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
