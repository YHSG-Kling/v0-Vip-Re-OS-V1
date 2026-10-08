/**
 * VENDOR GOVERNANCE SYSTEM 2.4
 * Centralized Vendor Usage Logging
 * 
 * WHY THIS EXISTS:
 * Before communications scale (AI emails, voice calls, direct mail), we need:
 * - Clean, attributed usage tracking
 * - Cost normalization across different unit types
 * - Anomaly detection without blocking automation
 * - Multi-tenant isolation and audit trails
 * 
 * This system is GOVERNANCE-ONLY: no UI, no blocking, no enforcement.
 */

import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import type { CostBasis, CostCoverage, PriceState } from './cost-normalizer'

export interface VendorUsageEvent {
  vendorName: string           // e.g., 'openai', 'zenrows', 'sendgrid', 'did'
  usageType: string            // e.g., 'tokens', 'api_call', 'minutes', 'emails'
  unitCount: number            // Raw usage units
  estimatedCost: number        // Normalized to USD
  systemSource: string         // Which system triggered it: 'ai_isa', 'enrichment', 'voice', etc.
  /** The tenant the spend is attributed to. null ONLY with platformPaid (wave 139, m750). */
  brokerageId: string | null
  agentId?: string             // Optional: if agent-specific
  leadId?: string              // Optional: if lead-specific
  metadata?: Record<string, any>
  timestamp?: Date
  /**
   * WAVE 139 (lane 139C) — THE PRICE IS A STATE, THE CHARGE HAS A KEY, THE PAYER IS NAMED.
   *   priceState  — fixed / variable / unknown / free (cost-normalizer.ts). 'unknown' rows carry
   *                 estimatedCost 0 and SAY so; they are not free.
   *   costBasis   — estimated (our table × units) vs final (the provider reported the charge).
   *   coverage    — platform_covered (default) vs tenant_paid.
   *   idempotencyKey — ONE charge, ONE row: a retry carrying the same key is skipped however late it
   *                 arrives (no five-minute window), and m750's unique index makes it hold under a race.
   *   platformPaid — the platform's own spend with NO tenant (capability radar, platform research);
   *                 lands brokerage_id NULL + request_metadata.platform_paid true (m750), never on a
   *                 tenant's meter.
   */
  priceState?: PriceState
  costBasis?: CostBasis
  coverage?: CostCoverage
  idempotencyKey?: string | null
  platformPaid?: boolean
}

/** Injectable for the proof (scripts/cost-completeness-guard.ts) — production uses the service client. */
type UsageLoggerDeps = { client?: ReturnType<typeof createServiceClient> }

export interface UsageLogResult {
  success: boolean
  usageId?: string
  error?: string
  anomalyDetected?: boolean
  anomalyReason?: string
  /** true when the charge was ALREADY on the ledger (idempotency key or replay fingerprint) — nothing written. */
  duplicate?: boolean
}

/**
 * CENTRALIZED USAGE LOGGING
 * 
 * Logs vendor usage to vendor_usage_tracking table.
 * This is the SINGLE SOURCE OF TRUTH for all vendor costs.
 * 
 * Idempotent: duplicate events are detected and skipped.
 * Non-blocking: failures are logged but don't interrupt upstream systems.
 */
export async function logVendorUsage(event: VendorUsageEvent, deps: UsageLoggerDeps = {}): Promise<UsageLogResult> {
  // Wave 139 (139C): a row with neither a tenant nor the platform flag has no owner — refused here
  // (the column is NOT NULL until m750, and m750's CHECK keeps it that way for non-platform rows).
  const platformPaid = !event.brokerageId && event.platformPaid === true
  if (!event.brokerageId && !platformPaid) {
    return { success: false, error: 'Vendor usage with no tenant and no platform flag — not booked' }
  }
  try {
    const supabase = deps.client ?? createServiceClient()

    // Generate unique event fingerprint for idempotency
    const eventFingerprint = generateEventFingerprint(event)
    const idempotencyKey = (event.idempotencyKey ?? '').trim() || null

    // WAVE 139 (139C) — AN EXPLICIT IDEMPOTENCY KEY IS ONE CHARGE, FOREVER. The fingerprint below is a
    // five-minute heuristic (a replay that arrives later is charged twice); a caller that KNOWS the
    // charge's identity (a provider job id, a photo-edit job, a workflow step) passes it, and a second
    // booking under the same key — a retried step, a re-run cron — is skipped however late it comes.
    // The read is tenant-pinned (or platform-pinned), the error is READ, and m750's unique index makes
    // the rule hold under a race (23505 below).
    if (idempotencyKey) {
      let q = supabase
        .from('vendor_usage_tracking')
        .select('id, created_at')
        .eq('request_metadata->>idempotency_key', idempotencyKey)
      q = platformPaid ? q.is('brokerage_id', null).eq('request_metadata->>platform_paid', 'true') : q.eq('brokerage_id', event.brokerageId as string)
      const { data: keyed, error: keyedError } = await q.limit(1).maybeSingle()
      if (keyedError) {
        console.error('[VENDOR GOVERNANCE] Idempotency-key lookup refused, logging anyway (the unique index still holds):', keyedError.message)
      } else if (keyed) {
        return { success: true, usageId: (keyed as { id: string }).id, duplicate: true, error: 'Duplicate event (idempotency key)' }
      }
    }

    // ── THE IDEMPOTENCY CHECK COULD NEVER FIRE ──────────────────────────────
    //
    // Two halves of one mechanism, each missing the other:
    //
    //   · `event_fingerprint` is COMPUTED above and written into
    //     request_metadata on every insert below — and NOTHING has ever read
    //     it back. A write with no reader.
    //   · `isLikelyDuplicate` compares `existingLog.created_at` against a
    //     five-minute window, and this SELECT asked for `id` ALONE. So
    //     `created_at` was `undefined`, `new Date(undefined)` is Invalid Date,
    //     and `InvalidDate > fiveMinutesAgo` is FALSE — for every event, always.
    //     A read with no writer. The skip branch below was unreachable code.
    //
    // The predicate was also too loose to be a fingerprint even if it had run:
    // vendor + usage_type + brokerage only, so a 1-unit charge and a
    // 10,000-unit charge for the same vendor were "the same event". This is a
    // COST LEDGER (§5) — that is a wrong invoice in both directions.
    //
    // Now the query asks the fingerprint the writer already stamps, and selects
    // the column the comparison needs. `.maybeSingle()` because `.single()`
    // ERRORS on zero rows, which is the ordinary case for a first-ever event.
    let fq = supabase
      .from('vendor_usage_tracking')
      .select('id, created_at')
      .eq('request_metadata->>event_fingerprint', eventFingerprint)
    fq = platformPaid ? fq.is('brokerage_id', null).eq('request_metadata->>platform_paid', 'true') : fq.eq('brokerage_id', event.brokerageId as string)
    const { data: existingLog, error: dupeReadError } = idempotencyKey
      ? { data: null, error: null } // the key above is the identity — the heuristic is not consulted
      : await fq
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

    // Destructured and acted on: supabase-js RESOLVES a refused read, and a
    // refusal arrives as `data: null` — identical to "no prior event". Reported
    // rather than swallowed, and the charge is still LOGGED, because dropping a
    // real cost because a dedupe lookup failed is the worse of the two errors.
    if (dupeReadError) {
      console.error('[v0] [VENDOR GOVERNANCE] Duplicate lookup refused, logging anyway:', dupeReadError.message)
    }

    if (existingLog && isLikelyDuplicate(existingLog, event)) {
      console.log('[v0] [VENDOR GOVERNANCE] Duplicate usage event detected, skipping')
      return {
        success: true,
        usageId: existingLog.id,
        duplicate: true,
        error: 'Duplicate event (idempotent skip)',
      }
    }

    // Detect anomalies (but don't block)
    const anomaly = detectUsageAnomaly(event)

    // Insert usage record
    const { data, error } = await supabase
      .from('vendor_usage_tracking')
      .insert({
        vendor_name: event.vendorName,
        usage_type: event.usageType,
        units_used: event.unitCount,
        cost_per_unit: event.estimatedCost / event.unitCount,
        total_cost: event.estimatedCost,
        // NULL only on a declared platform row (m750 drops NOT NULL and CHECKs that a tenant-less row
        // carries request_metadata.platform_paid = true; before m750 such a row is refused and REPORTED).
        brokerage_id: event.brokerageId,
        agent_id: event.agentId || null,
        lead_id: event.leadId || null,
        request_metadata: {
          ...event.metadata,
          system_source: event.systemSource,
          timestamp: event.timestamp?.toISOString() || new Date().toISOString(),
          event_fingerprint: eventFingerprint,
          // Wave 139 (139C): the row says what its number IS — the Finance Manager reads these.
          price_state: event.priceState ?? (event.estimatedCost > 0 ? 'fixed' : 'free'),
          cost_basis: event.costBasis ?? 'estimated',
          coverage: event.coverage ?? 'platform_covered',
          ...(platformPaid ? { platform_paid: true } : {}),
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        },
      })
      .select('id')
      .single()

    // 23505 = m750's idempotency index refused a SECOND row for the same key (two retries racing past
    // the lookup above). That is the rule holding, not a failure: the charge is already on the ledger.
    if (error && idempotencyKey && String((error as { code?: string }).code ?? '') === '23505') {
      return { success: true, duplicate: true, error: 'Duplicate event (idempotency key, unique index)' }
    }

    if (error) {
      console.error('[v0] [VENDOR GOVERNANCE] Failed to log usage:', error)
      
      // Log failure to automation_errors (but don't fail upstream).
      //
      // TENANT — `event.brokerageId`, a REQUIRED field of this function's own
      // parameter, so nothing is resolved and nothing can fail while resolving.
      // It was already present in this call, spelled `brokerageId` and nested
      // inside `context_json` — the same letters at the wrong depth, stamping
      // nothing, because every reader filters `.eq("brokerage_id", …)` at depth 1
      // and `workflows.ts:531` uses that predicate as an OWNERSHIP check. A
      // brokerage losing vendor-cost attribution could neither see nor
      // acknowledge that it had.
      const { error: usageLogError } = await supabase.from('automation_errors').insert({
        brokerage_id: event.brokerageId,
        workflow_name: 'vendor_usage_logging',
        error_message: `Failed to log ${event.vendorName} usage: ${error.message}`,
        severity: 'medium',
        status: 'open',
        context_json: JSON.stringify({ ...event }),
      })
      if (usageLogError) {
        // The original usage-tracking failure is returned below and is never
        // replaced by a failure to file it.
        console.error('[VENDOR GOVERNANCE] automation_errors insert refused:', usageLogError.message)
      }

      return {
        success: false,
        error: error.message,
      }
    }

    // If anomaly detected, log it
    if (anomaly.detected) {
      // TENANT — `event.brokerageId`, the same anchor as above: the brokerage
      // whose vendor spend the anomaly is about, and the only party who can judge
      // whether it is real. Same nested-`brokerageId`-in-`context_json` trap, same
      // depth-1 fix.
      const { error: anomalyLogError } = await supabase.from('automation_errors').insert({
        brokerage_id: event.brokerageId,
        workflow_name: 'vendor_usage_anomaly',
        error_message: `Anomaly detected: ${anomaly.reason}`,
        severity: 'low',
        status: 'open',
        context_json: JSON.stringify({ usageId: data.id, ...event }),
      })
      if (anomalyLogError) {
        console.error('[VENDOR GOVERNANCE] automation_errors anomaly insert refused:', anomalyLogError.message)
      }
    }

    return {
      success: true,
      usageId: data.id,
      anomalyDetected: anomaly.detected,
      anomalyReason: anomaly.reason,
    }
  } catch (error: any) {
    console.error('[v0] [VENDOR GOVERNANCE] Unexpected error logging usage:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}

/**
 * Generate a unique fingerprint for idempotency checking
 */
function generateEventFingerprint(event: VendorUsageEvent): string {
  const parts = [
    event.vendorName,
    event.usageType,
    event.systemSource,
    event.brokerageId,
    event.agentId || 'none',
    event.leadId || 'none',
    event.unitCount,
    // Lane 87F — WHAT ELSE THE EVENT SAYS ABOUT ITSELF. The seven parts above name no contact, no raw
    // record, no market and no queue entry, so two DIFFERENT people's identical PeopleData matches (or
    // two markets' identical scrape bookings) inside the five-minute window fingerprinted as one event
    // and the second real charge was skipped as a "replay" — an undercount on the platform ledger and a
    // missing line on the person's cost. A true replay re-sends the SAME metadata, so it still matches.
    metadataDigest(event.metadata),
  ]
  return parts.join('|')
}

/** Order-independent digest of the event's own metadata (key order never makes two events differ). */
function metadataDigest(metadata: Record<string, any> | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) return 'none'
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable)
      : v && typeof v === 'object' && !(v instanceof Date)
        ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
        : v
  return createHash('sha256').update(JSON.stringify(stable(metadata))).digest('hex').slice(0, 16)
}

/** How close two identically-fingerprinted events must be to count as one. */
const DEDUPE_WINDOW_MS = 5 * 60 * 1000

/**
 * Is this the SAME event we already logged, replayed?
 *
 * `event` was accepted and never read — the comparison was pure clock
 * arithmetic against a `created_at` the caller never selected. It now reads
 * both sides:
 *
 *   · the caller narrows on `request_metadata->>event_fingerprint`, so the row
 *     handed here is already known to describe the same vendor, usage type,
 *     source, tenant, agent, lead AND unit count as `event`;
 *   · the window is anchored on the EVENT's own timestamp rather than on
 *     `Date.now()`. A queued or retried event carries when it happened, and
 *     judging it against wall-clock time meant a replay that arrived six
 *     minutes late got charged twice while an unrelated event could not.
 *
 * FAILS OPEN, deliberately: every branch that cannot decide returns false, so
 * the charge is LOGGED. This is a cost ledger — a duplicated line is visible
 * and correctable, a silently dropped one is neither.
 */
function isLikelyDuplicate(
  existingLog: { created_at?: string | null } | null,
  event: VendorUsageEvent,
): boolean {
  const loggedAt = existingLog?.created_at ? new Date(existingLog.created_at).getTime() : NaN
  if (!Number.isFinite(loggedAt)) return false

  const eventAt = event.timestamp ? event.timestamp.getTime() : Date.now()
  if (!Number.isFinite(eventAt)) return false

  return Math.abs(eventAt - loggedAt) <= DEDUPE_WINDOW_MS
}

/**
 * ANOMALY DETECTION
 * 
 * Detect unusual usage patterns without blocking.
 * Future systems can use these signals for enforcement.
 */
function detectUsageAnomaly(event: VendorUsageEvent): { detected: boolean; reason?: string } {
  // Anomaly: Unusually high cost for single event
  if (event.estimatedCost > 50) {
    return {
      detected: true,
      reason: `High cost event: $${event.estimatedCost} for ${event.vendorName}`,
    }
  }

  // Anomaly: Extremely high unit count
  if (event.unitCount > 100000) {
    return {
      detected: true,
      reason: `Unusually high unit count: ${event.unitCount} ${event.usageType}`,
    }
  }

  // Anomaly: Missing attribution (a declared platform row is attributed — to the platform)
  if (!event.brokerageId && event.platformPaid !== true) {
    return {
      detected: true,
      reason: 'Missing brokerage attribution',
    }
  }

  return { detected: false }
}
