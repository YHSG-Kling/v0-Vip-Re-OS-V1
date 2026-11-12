"use server"

/**
 * Raise a compliance flag against an offer.
 *
 * Called when an agent, TC, or automated scan finds:
 *   - a signature missing on a contract page
 *   - an initial missing
 *   - a required form/disclosure not in the packet
 *   - any other compliance concern that requires human review
 *
 * The flag is recorded as an activities row AND fanned out to the agent's
 * + TC's + compliance_officer's notification bells via the shared
 * notifyComplianceFlag helper. Critical flags also surface to broker /
 * broker_admin so show-stoppers never sit unread.
 *
 * No transaction state changes here — the flag is informational. The flag is
 * CLEARED by lib/compliance/offer-flag-resolution.ts:resolveOfferComplianceFlags
 * (on a passing submit, or when the specific miss it names is supplied); the
 * notifications stay until the recipients mark them read.
 *
 * ── ONE ROW PER MISS, NOT ONE PER ATTEMPT ────────────────────────────────────
 * This action used to INSERT unconditionally, so every resubmission that still
 * hit the same miss minted another `status:'open'` row. Nothing ever closed one,
 * so the queue only ever grew and stopped meaning anything.
 *
 * It now UPSERTS on the flag's stable identity. The row write itself lives in
 * lib/compliance/offer-flag-resolution.ts:recordOfferComplianceFlag, alongside
 * the resolver that closes it — one module owns the flag row's whole lifecycle,
 * and it takes an injectable client so the behaviour is provable without
 * credentials (scripts/offer-flag-loop-simulator.ts). That module documents why
 * the identity is `flagType + title` and explicitly NOT `documentId`.
 *
 * THIS action keeps what ONLY it can do: the auth gate and the caller's tenant.
 *
 * ── WHY THE REST MOVED OUT ───────────────────────────────────────────────────
 * Everything below the gate — loading the offer, asserting the tenant, resolving
 * the buyer-side agent, writing the row, fanning out — is now
 * lib/compliance/raise-offer-flag.ts:raiseOfferComplianceFlag, a session-free
 * core that takes a client.
 *
 * It had to move because `app/api/cron/em-receipt-watcher/route.ts` calls this
 * lane with a SERVICE credential and no cookies: `auth.getUser()` returned null
 * on every iteration, so the earnest-money watchdog got "Unauthorized" back for
 * every offer it examined and has never once raised a flag. The gate is not the
 * bug and does not move — a cron is not a user, and a bypass parameter on an RPC
 * endpoint would let any authenticated caller claim it. The cron gets its own
 * door into the same logic instead, the way lib/buyer-offer/expire-offers.ts
 * already does for offer expiry.
 *
 * DELETED FROM HERE: the inline `agents → user_id` lookup that resolved the
 * assigned agent's bell target. SURVIVOR:
 * lib/kernel/agent-identity-resolver.ts:resolveAgentRecordToUserId, which the
 * core calls — the canonical resolver for that exact hop, already used at ~30
 * call sites. Nothing was lost: the copy did the same single-column lookup and
 * yielded null the same way.
 *
 * The NOTIFICATION fan-out is deliberately NOT deduped. A failed resubmission is
 * a new event for the humans even when the miss is old — the owner's rule is that
 * the missing piece goes to the TC and the agent every time it blocks.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID }          from "@/lib/validations"
import {
  raiseOfferComplianceFlag,
  type OfferComplianceFlagType,
} from "@/lib/compliance/raise-offer-flag"

export interface FlagOfferComplianceParams {
  offerId:    string
  /** Ignored — derived from session. Kept for backward compat with existing callers. */
  raiserUserId?: string
  /** Stable type — drives filtering / analytics. */
  flagType:   OfferComplianceFlagType
  severity:   "low" | "medium" | "high" | "critical"
  title:      string
  /** Optional body / detail (e.g. "Page 3 buyer initial missing"). */
  body?:      string
  /** Optional document id when the flag is page-specific. */
  documentId?: string
}

export interface FlagOfferComplianceResult {
  success: boolean
  notified_count?: number
  /** The stable identity of the miss this flag names — see offer-flag-resolution.ts. */
  flag_key?: string
  /** True when an already-open flag for the SAME miss was refreshed instead of
   *  a second one being minted. */
  deduped?: boolean
  error?:  string
}

export async function flagOfferCompliance(
  params: FlagOfferComplianceParams,
): Promise<FlagOfferComplianceResult> {
  const { offerId, flagType, severity, title, body, documentId } = params

  if (!isValidUUID(offerId)) {
    return { success: false, error: "Invalid offer ID" }
  }

  // Auth gate — previously trusted params.raiserUserId, letting any caller
  // impersonate another user when raising compliance flags.
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { success: false, error: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id")
    .eq("id", authUser.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }
  const raiserUserId = authUser.id

  const supabase = createServiceClient()

  // Everything past the gate is the shared core. The caller's brokerage travels
  // as an ASSERTION (`requireBrokerageId`) rather than as the tenant: the core
  // still reads `offers.brokerage_id` off the row and refuses on a mismatch, so
  // a session can never widen its own scope by naming another tenant.
  const outcome = await raiseOfferComplianceFlag(supabase, {
    offerId,
    raiserUserId,
    requireBrokerageId: callerRow.brokerage_id as string,
    flagType,
    severity,
    title,
    body,
    documentId,
  })

  if (!outcome.success || outcome.error) {
    console.error(`[flag-compliance] offer ${offerId}: compliance-flag audit row problem:`, outcome.error)
  }

  // The audit row is the ledger; the fan-out is the human alert. Refusals that
  // happened BEFORE either (not found, forbidden, unreadable offer) come back as
  // a failure with the reason — they must not read as a raised flag.
  if (!outcome.success && outcome.notified_count === 0) {
    return { success: false, error: outcome.error ?? "Could not raise the compliance flag" }
  }

  return {
    success: true,
    notified_count: outcome.notified_count,
    flag_key: outcome.flag_key,
    deduped: outcome.deduped,
    error: outcome.error,
  }
}
