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
// The tier vocabulary (client-safe: client components already import it) — the tenant presenter below reads WHICH
// business the tenant is from its own plan tier, never from a user_type.
import { isCanonicalTier, tierCarriesOffices } from "@/lib/kernel/tier-role-matrix"
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

// TOMBSTONE (§1.3, 2026-08-31, lane M4): SIX unadopted AppError subclasses
// deleted — AuthenticationError, AuthorizationError, ConflictError,
// IntegrationError, RateLimitError, DemoModeError. Exported since the v0
// scaffold, constructed by NOBODY, ever. The same audit that removed the
// throwIf* helpers (header above) already named why: this codebase RETURNS
// refusals rather than throwing them, and each category these classes covered
// has a live return-style home —
//   · auth/authz     the gate-first pattern (§4): session checks `return
//                    { success:false, error:"Unauthorized" }` at the action
//                    boundary (e.g. app/actions/dotloop-integration.ts) —
//                    never a thrown 401/403;
//   · conflict       already-exists refusals are returned with the field named
//                    by the kernel command that detected them;
//   · integration    provider failures are CLASSIFIED, not thrown generic:
//                    lib/did/contract.ts classifyDidError and the
//                    connector-gateway's error typing carry
//                    retryable/terminal, which a bare 502 class cannot;
//   · rate limit     the gateway + retryAsync (below) handle 429 as a
//                    retryable classification, not an exception type;
//   · demo mode      no live demo-mode write path constructs a refusal.
// SURVIVORS: AppError, ValidationError, NotFoundError, DatabaseError — the
// four with real constructors in the tree. (The D-ID strings
// "AuthorizationError"/"RateLimitError" in lib/did/contract.ts are the
// PROVIDER's error-kind vocabulary, not references to these classes.)

export class NotFoundError extends AppError {
  constructor(resource: string = "Resource") {
    super(`${resource} not found`, "NOT_FOUND", 404)
    this.name = "NotFoundError"
    Object.setPrototypeOf(this, NotFoundError.prototype)
  }
}


export class DatabaseError extends AppError {
  constructor(message: string = ERROR_MESSAGES.DATABASE_ERROR, details?: any) {
    super(message, "DATABASE_ERROR", 500, details)
    this.name = "DatabaseError"
    Object.setPrototypeOf(this, DatabaseError.prototype)
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

interface ErrorResponse {
  success: false
  error: string
  code?: string
  details?: any
}

// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
function createErrorResponse(error: Error | AppError, includeDetails = false): ErrorResponse {
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

interface SuccessResponse<T = any> {
  success: true
  data?: T
  message?: string
}

// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
function createSuccessResponse<T>(data?: T, message?: string): SuccessResponse<T> {
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
    // Wave 152 (lane 152A): the raw text is logged for staff WITH a reference; the person reads it only when it is a
    // plain sentence (relayed-copy check below), otherwise the contract-shaped sentence carrying that reference.
    const reference = newTenantReference()
    logError(error as Error, { ...options, context, metadata: { ...(options.metadata ?? {}), reference } })

    if (error instanceof AppError) {
      const r = createErrorResponse(error, process.env.NODE_ENV === "development")
      return { ...r, error: relayedErrorText(r.error, reference) }
    }

    return createErrorResponse(new AppError(relayedErrorText((error as Error).message || "An unexpected error occurred", reference)))
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
  // Wave 152 (lane 152A): THE action boundary (41 "use server" files return through here). A Supabase / Postgres /
  // provider refusal used to reach the person verbatim — `new row violates row-level security policy for table "x"`,
  // a PGRST code, a JSON body. The raw text now stays in the log beside a reference; the person reads it only when it
  // is a plain sentence (a validation refusal such as "Address is required" passes unchanged).
  const reference = newTenantReference()
  logError(errorInstance, { context, metadata: { reference } })

  if (error instanceof AppError) {
    const r = createErrorResponse(error, process.env.NODE_ENV === "development")
    return { ...r, error: relayedErrorText(r.error, reference) }
  }

  return {
    success: false,
    error: relayedErrorText(errorMessage, reference),
  }
}

// ============================================
// THE TENANT-FACING MESSAGE CONTRACT — THE ONE PRESENTER (wave 152, lane 152A)
// ============================================
//
// Owner (verbatim, 2026-11-11): "the honest connection states need to be more tenant friendly along with any other
// tenant faing errors, etc. the connections for tenant shouldn't say brokerage pays unless the tenant is a brokerage".
//
// WHY THIS FILE IS THE SURVIVOR (LAW 1). Tenant copy was policed in two places, each half of the job:
//   · lib/support/ticket-triage.ts tenantFacingGate — a forbidden-phrase list (credential words, prices,
//     "platform-covered", PGRST codes) with no payer rule, no HTTP status, no SQL / RLS wording, no source path;
//   · lib/kernel/immediate-operations.ts tenantFacing — the operation reporter's one tenant sentence, gated by the above;
// and the raw refusal of every other door left through handleError above, unpoliced. This file is that error boundary,
// and — like the other two — it already sits in the app/crm/page.tsx module graph at its 1300 budget, so the presenter
// lives HERE (no new module) and the two survivors read their rules from it: tenantFacingGate delegates to
// tenantCopyVerdict (ONE forbidden list), the operation reporter's bell is composed by presentTenantMessage.
//
// THE CONTRACT. A message a tenant / Contact / vendor reads says, in plain English: what happened · what it affects ·
// whether the work was saved / kept / retried / tracked — ONLY with the evidence that makes it true (a retry needs its
// retry reference, "tracked" needs a ticket id; without it the clause is DROPPED, never guessed) · who can act next ·
// ONE real action · optionally a safe reference. Technical detail stays internal (the log line keyed by the reference,
// the evidence row, the staff notification).
//
// CONNECTIONS carry THREE SEPARATE TRUTHS (directive 152A): availability · who controls the credentials (the platform
// or THIS account) · cost and authority. Payer wording follows the VERIFIED arrangement: "your brokerage" only when the
// tenant IS a brokerage by its own plan tier (resolveTenantPayer); otherwise actor-neutral ("your account", or "your
// team" for a team subscription). Never inferred from a user_type.
//
// Pure and client-safe; the only I/O is resolveTenantPayer, which takes the caller's (session-pinned) client.

/** Who can take the next step. */
type TenantNextActor = "you" | "account_admin" | "platform_support" | "provider"
/** Who is reading: a member of the subscribing account, a Contact (client), or a vendor the account works with. */
type TenantAudience = "account" | "contact" | "vendor"

/** WHICH business the tenant is — from its own plan tier (the existing tier vocabulary), "unknown" when unread. */
export interface TenantPayer { kind: "brokerage" | "team" | "solo" | "unknown" }

/** The actor-neutral payer: what every caller gets when the tier was not (or could not be) read. */
const UNKNOWN_PAYER: TenantPayer = { kind: "unknown" }

/** PURE — the business kind for a plan tier. The tiers that carry offices (tierCarriesOffices — brokerage and above in
 *  TIER_ORDER, the same set lib/kernel/tenant-creation.ts planTenantOffices reads) are brokerages; a team is a team; solo is solo. */
function tenantPayerForTier(tier: string | null | undefined): TenantPayer {
  if (!isCanonicalTier(tier)) return UNKNOWN_PAYER
  // THE one office-tier spelling (lib/kernel/tier-role-matrix.ts tierCarriesOffices — wave 152, 152K).
  if (tierCarriesOffices(tier)) return { kind: "brokerage" }
  return tier === "team" ? { kind: "team" } : { kind: "solo" }
}

/**
 * The SESSION tenant's verified business kind, read from its own brokerages.plan_tier. The caller passes the tenant it
 * resolved from the session (never a body value). A refused or empty read is "unknown" → actor-neutral wording (fail
 * closed: the brokerage wording is never the default).
 */
export async function resolveTenantPayer(svc: { from: (table: string) => any }, brokerageId: string | null | undefined): Promise<TenantPayer> {
  if (!brokerageId) return UNKNOWN_PAYER
  try {
    const { data, error } = await svc.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
    if (error || !data) return UNKNOWN_PAYER
    return tenantPayerForTier((data as { plan_tier?: string | null }).plan_tier ?? null)
  } catch {
    return UNKNOWN_PAYER
  }
}

/** "your brokerage" / "your team" / "your account" — possessive form for cost wording ("your team's"). */
function accountOwner(payer: TenantPayer | undefined): { noun: string; possessive: string; firstPerson: string } {
  switch (payer?.kind) {
    case "brokerage": return { noun: "your brokerage", possessive: "your brokerage's", firstPerson: "my brokerage" }
    case "team": return { noun: "your team", possessive: "your team's", firstPerson: "my team" }
    default: return { noun: "your account", possessive: "your", firstPerson: "my account" }
  }
}

/** The business a VENDOR works with, named by what the tenant is. */
function vendorCounterpart(payer: TenantPayer | undefined): string {
  switch (payer?.kind) {
    case "brokerage": return "the brokerage you work with"
    case "team": return "the team you work with"
    case "solo": return "the agent you work with"
    default: return "the business you work with"
  }
}

// ── the ONE forbidden list ────────────────────────────────────────────────────────────────────

/** leak = never in anything a tenant reads (authored OR relayed); authored = never in copy WE write for a tenant;
 *  payer = a brokerage-payer claim, admitted only when the verified payer IS a brokerage. */
type TenantCopyRuleScope = "leak" | "authored" | "payer"
const TENANT_COPY_RULES: ReadonlyArray<{ scope: TenantCopyRuleScope; re: RegExp; why: string }> = [
  { scope: "leak", re: /\b(?:sk_live|sk_test|whsec|pk_live|rk_live)[a-z0-9_]*/i, why: "a key-shaped string" },
  { scope: "leak", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\benc:v1:/i, why: "a credential value" },
  { scope: "leak", re: /\b(?:stack ?trace|exception|null pointer|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|PGRST\d{3}|42P01|42501|42703|23502|23503|23505|23514|22P02)\b/i, why: "a provider / database internal" },
  { scope: "leak", re: /\b(?:violates (?:row-level security|foreign key|unique|check|not-null)|row-level security|duplicate key value|permission denied for (?:table|relation|schema|function)|null value in column|invalid input syntax|schema cache)\b|\b(?:relation|column|table|function) "[^"]+"(?: of relation "[^"]+")? does not exist/i, why: "a database refusal" },
  { scope: "leak", re: /\bat (?:async )?[\w.$<>[\]]+ \(|\.(?:tsx?|jsx?|mjs):\d+\b/, why: "a stack frame" },
  { scope: "leak", re: /\b(?:app|lib|scripts|supabase|components)\/[\w\-/[\].]+\.(?:tsx?|jsx?|sql)\b/, why: "a source path" },
  { scope: "leak", re: /\bHTTP\s?[1-5]\d{2}\b|\bstatus(?: code)?:? [45]\d{2}\b/i, why: "a provider HTTP status" },
  { scope: "leak", re: /[{[]\s*"[\w-]+"\s*:/, why: "a raw response body" },
  { scope: "leak", re: /(?<![@.\w-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b(?![\w.+-]*@)/, why: "an internal identifier (table, column, policy or field name)" },
  { scope: "leak", re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/, why: "an environment / configuration name" },
  { scope: "authored", re: /\b(?:api[_ -]?key|secret|password|token|bearer)\b/i, why: "credential vocabulary" },
  { scope: "authored", re: /\$\s?\d[\d,]*(?:\.\d+)?/, why: "a price" },
  { scope: "authored", re: /platform[- ]?covered|\bplatform[- ]paid\b|\b(?:the )?platform (?:pays|is paying|will pay)\b|\bpaid by the platform\b/i, why: "the platform-pays phrase" },
  { scope: "payer", re: /\b(?:brokerage (?:pays|will pay|is paying)|(?:billed|charged|invoiced) to (?:your |the |my )?brokerage|(?:your|the|my) brokerage(?:'s)? (?:is |will be )?(?:billed|charged|invoiced)\b|bills? (?:your|the|my) brokerage|payer:?\s*(?:your |the |my )?brokerage|paid by (?:your|the|my) brokerage)/i, why: "a brokerage-payer claim" },
]

/**
 * PURE — may a tenant / Contact / vendor read this text? `authored` (default): copy we write — every rule; `relayed`:
 * a raw error being handed back — the leak rules only (a plain human refusal passes unchanged). The payer rule admits
 * a brokerage-payer claim ONLY when `payer.kind === "brokerage"`.
 */
export function tenantCopyVerdict(
  text: string | null | undefined,
  opts: { mode?: "authored" | "relayed"; payer?: TenantPayer } = {},
): { ok: true } | { ok: false; reason: string } {
  const t = (text ?? "").trim()
  if (!t) return { ok: false, reason: "empty" }
  const mode = opts.mode ?? "authored"
  for (const rule of TENANT_COPY_RULES) {
    if (rule.scope !== "leak" && mode !== "authored") continue
    if (rule.scope === "payer" && opts.payer?.kind === "brokerage") continue
    if (rule.re.test(t)) return { ok: false, reason: `contains ${rule.why}` }
  }
  return { ok: true }
}

// ── the message ───────────────────────────────────────────────────────────────────────────────

/** What happened to the work — each claim carries the evidence that makes it TRUE; without it the clause is dropped. */
type TenantWorkTruth =
  | { state: "saved" }
  | { state: "not_saved" }
  | { state: "unchanged" }
  | { state: "kept"; count: number }
  | { state: "retrying"; retryRef: string | null }
  | { state: "ticket_open"; ticketId: string | null; answeredBy: "platform_support" | "account_admin" }

interface TenantAction { label: string; href?: string | null }

/** The composed message. `text` carries no action; `sentence` is the same with the action in words (for a plain-string
 *  surface such as an action's `error`). `replaced` = the composition failed the gate and the safe fallback was used.
 *  Module-private: callers read it through presentTenantMessage's return / TenantConnectionView.message. */
interface TenantMessage {
  text: string
  sentence: string
  action: TenantAction | null
  next: TenantNextActor
  referenceId: string | null
  replaced: boolean
}

function sentenceCase(s: string): string {
  const t0 = s.trim()
  if (!t0) return t0
  const t = `${t0.charAt(0).toUpperCase()}${t0.slice(1)}`
  return /[.!?…]$/.test(t) ? t : `${t}.`
}

function workClause(w: TenantWorkTruth | null | undefined, audience: TenantAudience): string | null {
  if (!w) return null
  switch (w.state) {
    case "saved": return "Your changes were saved."
    case "not_saved": return "Nothing was saved."
    case "unchanged": return "Nothing was changed."
    case "kept": return w.count > 0 ? "Anything received in the meantime is kept." : null
    case "retrying": return w.retryRef ? "We'll retry automatically." : null
    case "ticket_open":
      if (!w.ticketId) return null
      if (audience !== "account") return null
      return w.answeredBy === "platform_support" ? "Our support team is tracking it." : "It is tracked as a support request your account's admins can see."
  }
}

function nextClause(next: TenantNextActor, audience: TenantAudience, payer: TenantPayer | undefined, provider: string | null, tracked: boolean): string | null {
  if (next === "you") return null
  if (audience === "contact") return "Your agent can help with this."
  if (audience === "vendor") return `${vendorCounterpart(payer).replace(/^the/, "The")} can help with this.`
  switch (next) {
    case "account_admin": return "An admin on your account can take care of this."
    case "platform_support": return tracked ? null : "If it keeps happening, contact support."
    case "provider": return `This has to be resolved with ${provider ?? "the provider"}.`
  }
}

function inlineAction(a: TenantAction | null): string | null {
  if (!a?.label) return null
  return `Next step: ${a.label.charAt(0).toLowerCase()}${a.label.slice(1)}.`
}

/** A short, safe reference a person can quote to support (never a row id, never a secret). */
function tenantReference(id: string | null | undefined): string | null {
  const r = (id ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase()
  return r.length >= 4 ? r : null
}

function newTenantReference(): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.()
  return tenantReference(uuid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`) ?? "REF00000"
}

/**
 * THE PRESENTER — compose one tenant-facing message to the contract. The text is gated (tenantCopyVerdict, authored,
 * with the payer); a composition that fails is REPLACED by a safe generic message carrying the same next actor, action
 * and reference (`replaced: true`), so a leaking input can never reach the reader.
 */
export function presentTenantMessage(input: {
  what: string
  affects?: string | null
  work?: TenantWorkTruth | null
  next: TenantNextActor
  action?: TenantAction | null
  provider?: string | null
  referenceId?: string | null
  audience?: TenantAudience
  payer?: TenantPayer
}): TenantMessage {
  const audience = input.audience ?? "account"
  const ref = tenantReference(input.referenceId)
  const work = workClause(input.work, audience)
  const tracked = input.work?.state === "ticket_open" && !!input.work.ticketId
  const action = input.action?.label ? { label: input.action.label, href: input.action.href ?? null } : null
  // "Contact support" as the ONE action already says who acts next — never said twice.
  const next = action && /contact support/i.test(action.label) ? null : nextClause(input.next, audience, input.payer, input.provider ?? null, tracked)
  const refLine = ref ? `Reference: ${ref}.` : null
  const join = (parts: Array<string | null | undefined>) => parts.filter((s): s is string => !!s && !!s.trim()).map(sentenceCase).join(" ")
  let what = input.what
  let affects = input.affects ?? null
  let replaced = false
  if (!tenantCopyVerdict(join([what, affects, work, next]), { mode: "authored", payer: input.payer }).ok) {
    replaced = true
    what = "This didn't go through as expected"
    affects = null
  }
  return {
    text: join([what, affects, work, next, refLine]),
    // The plain-string form: the ONE action sits right after what happened to the work, before who else can help.
    sentence: join([what, affects, work, inlineAction(action), next, refLine]),
    action, next: input.next, referenceId: ref, replaced,
  }
}

/**
 * A raw refusal (a Supabase error, a provider error) made safe for the person who triggered it. The raw text is LOGGED
 * for staff with a reference; the person reads `what` + the contract clauses. Use this wherever an action used to
 * return `error.message`.
 */
export function presentTenantError(input: {
  what: string
  raw?: unknown
  work?: TenantWorkTruth | null
  next?: TenantNextActor
  action?: TenantAction | null
  context?: string
  audience?: TenantAudience
}): TenantMessage {
  const raw = input.raw instanceof Error ? input.raw.message : typeof input.raw === "string" ? input.raw : input.raw && typeof input.raw === "object" ? String((input.raw as { message?: unknown }).message ?? "") : ""
  const reference = raw ? newTenantReference() : null
  if (raw) logError(new Error(raw), { context: input.context ?? "tenant-error", metadata: { reference }, silent: false })
  return presentTenantMessage({
    what: input.what, work: input.work ?? null, next: input.next ?? "platform_support",
    action: input.action === undefined ? { label: "Try again" } : input.action, referenceId: reference, audience: input.audience,
  })
}

/** handleError / handleAction: the raw text when it is a plain sentence, else the contract's fallback with the reference. */
function relayedErrorText(raw: string, reference: string): string {
  if (tenantCopyVerdict(raw, { mode: "relayed" }).ok) return raw
  return presentTenantMessage({
    what: "This didn't finish because of a problem on our side", next: "platform_support", action: { label: "Try again" }, referenceId: reference,
  }).sentence
}

// ── connections: the three truths ─────────────────────────────────────────────────────────────

/** 1. AVAILABILITY (directive 152A). */
type TenantConnectionAvailability =
  | "platform_configured" | "tenant_configurable" | "needs_credentials" | "awaiting_activation" | "connected"
  | "degraded" | "disconnected" | "unsupported" | "license_not_verified" | "sandbox"
/** 3. COST AND AUTHORITY — never an invented payer. */
type TenantCostAuthority = "subscription_allowance" | "your_provider_account" | "platform_internal" | "unknown" | "approval_required" | "blocked_by_budget"
/** Why a connection needs attention (degraded / provider-refused), in the provider-health reader's terms. */
type TenantConnectionCause = "not_verified" | "provider_refused" | "provider_limit" | "unreachable" | "unreadable" | "check_failed"

/** One connection as a tenant sees it. */
export interface TenantConnectionView {
  label: string
  tone: "ok" | "attention" | "neutral"
  message: TenantMessage
  /** 2. WHO CONTROLS THE CREDENTIALS — the platform or THIS account (never a statement of who is charged). */
  credentialLine: string | null
  /** 3. Cost and authority — null for a Contact or a vendor (they see no financials). */
  costLine: string | null
}

/**
 * THE CONNECTION PRESENTER — availability · credential control · cost/authority, each its own line, composed to the
 * message contract. Claims of retry / kept / tracked need their evidence (retryRef, kept count, ticketId).
 */
export function presentTenantConnection(input: {
  provider: string
  availability: TenantConnectionAvailability
  credentials: "platform" | "this_account"
  cost?: TenantCostAuthority | null
  cause?: TenantConnectionCause | null
  since?: string | null
  kept?: number
  retryRef?: string | null
  referenceId?: string | null
  payer?: TenantPayer
  audience?: TenantAudience
  /** "connected" says CONFIRMED only when the caller's health reader confirmed it (a stored, untested credential is not). */
  confirmed?: boolean
}): TenantConnectionView {
  const audience = input.audience ?? "account"
  // A Contact or a vendor never reads the account's provider names, credentials or costs.
  const name = audience === "account" ? input.provider : "a connected service"
  const owner = accountOwner(input.payer)
  // "Being handled" on THIS surface is only ever a kept delivery or a real retry; a support ticket is announced by the
  // operation consumer's bell (lib/kernel/immediate-operations.ts), which holds the ticket id.
  const ticket: TenantWorkTruth | null = null
  const keptWork: TenantWorkTruth | null = (input.kept ?? 0) > 0 ? { state: "kept", count: input.kept ?? 0 } : null
  const retryWork: TenantWorkTruth | null = input.retryRef ? { state: "retrying", retryRef: input.retryRef } : null
  // The account's next step is never handed to a Contact or a vendor: for them the account is who acts, with no button.
  const msg = (m: { what: string; affects?: string | null; work?: TenantWorkTruth | null; next: TenantNextActor; action?: TenantAction | null }) =>
    presentTenantMessage({
      ...m, provider: name, referenceId: input.referenceId ?? null, audience, payer: input.payer,
      ...(audience === "account" ? {} : { next: "account_admin" as const, action: null }),
    })
  const date = input.since ? input.since.slice(0, 10) : null

  let label: string
  let tone: TenantConnectionView["tone"]
  let message: TenantMessage
  switch (input.availability) {
    case "connected":
      label = "Connected"; tone = "ok"
      message = msg({ what: input.credentials === "this_account" ? (input.confirmed ? `Connected and confirmed with your ${name} account` : `Connected through your own ${name} account`) : "Connected and working", next: "you" })
      break
    case "platform_configured":
      label = "Included"; tone = "ok"
      message = msg({ what: "Provided through the platform — there's nothing for you to set up", next: "you" })
      break
    case "tenant_configurable":
      label = "Available to connect"; tone = "neutral"
      message = msg({ what: "This isn't provided through the platform right now", affects: `You can connect your own ${name} account to use it`, next: "you", action: { label: "Connect provider" } })
      break
    case "needs_credentials":
      label = "Not connected"; tone = "neutral"
      message = msg({ what: `Connect your ${name} account to start using it here`, next: "you", action: { label: "Connect provider" } })
      break
    case "awaiting_activation":
      label = "Not available yet"; tone = "neutral"
      message = msg({ what: `${name} isn't available yet`, affects: "Everything else you've connected keeps working; there's nothing for you to set up", next: "you", action: { label: "View available sources" } })
      break
    case "unsupported":
      label = "Can't be connected here"; tone = "neutral"
      message = msg({ what: `${name} can't be connected here today`, affects: "Your other connected sources keep working", next: "you", action: { label: "View available sources" } })
      break
    case "license_not_verified":
      label = "Licensing review"; tone = "neutral"
      message = msg({ what: "This source needs an access or licensing review before it can be used", affects: "Your other connected sources keep working", next: "platform_support", action: { label: "Review connection requirements" } })
      break
    case "sandbox":
      label = "Test account"; tone = "attention"
      message = msg({ what: `This is connected to a ${name} test account`, affects: "Records from it are test data and are never used as live leads", next: "you", action: { label: "Connect your live account" } })
      break
    case "disconnected":
      label = "Disconnected"; tone = "neutral"
      message = msg({ what: `This connection was turned off${date ? ` on ${date}` : ""}`, affects: `Nothing new comes in from ${name}; records already received are kept`, next: "you", action: { label: "Reconnect" } })
      break
    case "degraded":
    default:
      label = "Needs attention"; tone = "attention"
      switch (input.cause) {
        case "not_verified":
          label = "Waiting for confirmation"
          message = msg({ what: `This connection is saved but hasn't been confirmed with ${name} yet`, affects: `It is confirmed the next time data arrives from ${name}`, work: ticket, next: "you", action: { label: "Update connection" } })
          break
        case "provider_refused":
          message = msg({ what: "This connection needs to be updated", affects: `New data from ${name} is paused; saved records are unaffected`, work: ticket ?? keptWork, next: "you", action: { label: "Update connection" } })
          break
        case "provider_limit":
          message = msg({ what: `${name} reported a usage or balance limit on your ${name} account`, affects: `New data from ${name} is paused until the limit is raised; saved records are unaffected`, work: ticket ?? keptWork, next: "provider", action: { label: "Review your provider account" } })
          break
        case "unreachable":
          message = msg({ what: `${name} didn't respond at the last check`, affects: "Saved records are unaffected", work: ticket ?? retryWork ?? keptWork, next: "you", action: { label: "Re-check the connection" } })
          break
        case "unreadable":
          message = msg({ what: `We couldn't read the latest data from ${name}`, affects: "Saved records are unaffected", work: ticket ?? keptWork, next: "platform_support", action: { label: "Contact support" } })
          break
        default:
          message = msg({ what: "The last check of this connection failed", affects: `New data from ${name} is paused until the connection is updated`, work: ticket, next: "you", action: { label: "Update connection" } })
      }
  }

  const credentialLine = audience !== "account" ? null
    : input.credentials === "this_account" ? `Uses your own ${name} account — you control it and can disconnect it any time.`
      : "Managed by the platform — no account of yours is needed."
  let costLine: string | null = null
  if (audience === "account" && input.cost) {
    switch (input.cost) {
      case "your_provider_account": costLine = `${name} bills ${owner.possessive} ${name} account directly under your plan with them — separate from your subscription.`; break
      case "subscription_allowance": costLine = "Counts toward your subscription's allowance."; break
      case "platform_internal": costLine = "Included in your subscription."; break
      case "unknown": costLine = "Pricing for this source hasn't been confirmed."; break
      case "approval_required": costLine = "New paid data requests need an approved acquisition budget before they run."; break
      case "blocked_by_budget": costLine = "New paid data requests are paused until the acquisition budget is approved."; break
    }
    if (costLine && !tenantCopyVerdict(costLine, { mode: "authored", payer: input.payer }).ok) costLine = null
  }
  return { label, tone, message, credentialLine, costLine }
}

/** The first-person attestation a tenant gives when it connects its OWN provider account — payer-true wording. */
export function tenantProviderAttestation(provider: string, payer: TenantPayer | undefined): string {
  const owner = accountOwner(payer)
  return `I hold this ${provider} account under ${provider}'s own terms and license, and authorize the platform to use it for ${owner.firstPerson}. ${provider} bills that account directly; records from it are never shared outside ${owner.firstPerson === "my account" ? "this account" : owner.firstPerson}.`
}

// ============================================
// EXPORT ALL
// ============================================

export {
  ERROR_MESSAGES,
}
