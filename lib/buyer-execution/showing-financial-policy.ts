/**
 * lib/buyer-execution/showing-financial-policy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * IS THE BUYER FINANCIAL GATE ON FOR THIS TENANT? (m377)
 *
 * OWNER RULING: "the gate should be included as a setting choice from the tenant
 * if they want to block the financial verification before setting or scheduling
 * a showing."
 *
 * enforceFinancialGate() in ./buyer-execution-engine has always been complete —
 * pre-approval, proof of funds, lender intro, agent confirmation, plus expiry —
 * and it was enforced NOWHERE. Both of its callers were themselves unreachable,
 * and the live booking paths had no financial check at all. m377 makes it real,
 * but only for brokerages that ASK for it.
 *
 * This module answers exactly one question, and it is the question that must be
 * answered FIRST on every booking path: does this brokerage want the gate? When
 * the answer is no — the default, and the state of every existing brokerage —
 * the gate does not run at all. Not "runs and is ignored": does not run. That
 * keeps the off state byte-for-byte identical to pre-m377 behaviour, including
 * doing zero extra verification queries per booking.
 *
 * ── WHY A READ FAILURE DOES NOT BLOCK ───────────────────────────────────────
 * If the policy read itself errors we return false (gate off) and log loudly.
 * The alternative — fail closed — would take a transient database hiccup and
 * turn it into "no showing can be booked anywhere in the product", including for
 * the majority of brokerages that never enabled the setting. That blast radius
 * is far worse than the miss it prevents, and it is not a real trade anyway:
 * the gate that runs when the setting IS on already fails closed on its own
 * (checkFinancialVerification returns isVerified:false on error), so an opted-in
 * tenant still errs toward blocking. What we refuse to do is invent a policy
 * nobody set.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { checkBuyerCanPerformAction } from "@/app/actions/buyer-execution"
import { enforceFinancialGate, logBuyerExecutionEvent } from "./buyer-execution-engine"
import type { FinancialVerificationResult } from "@/lib/buyer-lifecycle/financial-verification"

/**
 * True when this brokerage requires financial verification before a showing may
 * be set or scheduled. False — the default, and the value every brokerage
 * carries until an admin changes it — means today's behaviour: no gate.
 *
 * A null/absent brokerageId is not an error and is not a policy: an unresolved
 * tenant cannot have opted in, so the gate stays off.
 *
 * Deliberately NOT exported: guardShowingFinancialGate below is the one entry
 * point. A second exported way to ask "is the gate on?" invites a caller to read
 * the policy and then forget to enforce it, which is the exact failure m377 is
 * fixing.
 */
async function isFinancialGateRequiredForShowings(
  brokerageId: string | null | undefined,
): Promise<boolean> {
  if (!brokerageId) return false

  const service = createServiceClient()
  const { data, error } = await service
    .from("brokerages")
    .select("require_financial_verification_for_showings")
    .eq("id", brokerageId)
    .maybeSingle()

  if (error) {
    // Read, never discarded — supabase-js RESOLVES a rejected read, so an
    // ignored error here would silently read as "policy off" with no trace.
    console.error(
      "[showing-financial-policy] Could not read the financial-gate setting for brokerage",
      brokerageId,
      "— proceeding WITHOUT the gate:",
      error.message,
    )
    return false
  }

  return (
    (data as { require_financial_verification_for_showings?: boolean } | null)
      ?.require_financial_verification_for_showings === true
  )
}

/** What the caller must know: is this booking blocked, and — honestly — why. */
export type ShowingFinancialGateResult =
  | { blocked: false }
  | {
      blocked: true
      /** Buyer-readable, specific, and derived from the real verification record. */
      reason: string
      /**
       * Distinguishes the two blocks that must never read alike:
       *   financial_verification_required  — we checked; the buyer is not cleared.
       *   financial_verification_unavailable — we could not check. Not the same thing.
       */
      errorCode: "financial_verification_required" | "financial_verification_unavailable"
      verification?: FinancialVerificationResult
    }

const VERIFICATION_LABEL: Record<
  NonNullable<FinancialVerificationResult["verificationType"]>,
  string
> = {
  pre_approval: "pre-approval letter",
  proof_of_funds: "proof of funds",
  lender_intro: "lender introduction",
  agent_confirmation: "agent confirmation of financials",
}

/**
 * Turn the gate's terse internal reason into something a buyer or an agent can
 * act on — WITHOUT inventing anything. Every clause below is read off the
 * verification record the gate returned; when a field is absent we say less,
 * never more.
 */
function explainBlock(reason: string | undefined, v: FinancialVerificationResult | undefined): string {
  const expired = v?.expiresAt && new Date() > v.expiresAt
  if (expired) {
    const label = v?.verificationType ? VERIFICATION_LABEL[v.verificationType] : "financial verification"
    return (
      `This brokerage requires financial verification before a showing can be scheduled, ` +
      `and the ${label} on file expired on ${v!.expiresAt!.toLocaleDateString()}. ` +
      `An updated one from the lender clears this and the showing can be booked.`
    )
  }
  if (v && !v.isVerified) {
    return (
      "This brokerage requires financial verification before a showing can be scheduled, " +
      "and nothing has been received for this buyer yet. A pre-approval letter, proof of " +
      "funds, or the lender confirming the buyer's financials will clear it."
    )
  }
  // Gate said no for a reason we do not have a richer story for — pass ITS words
  // through rather than replacing them with a guess.
  return (
    `This brokerage requires financial verification before a showing can be scheduled. ` +
    `${reason ?? "The buyer is not cleared yet."}`
  )
}

/**
 * The sessionless twin of checkBuyerCanPerformAction: same gate, same blocked-attempt
 * log, same return shape — minus the cookie-session authorization the caller has
 * already performed on this lane. Kept private so there is still exactly ONE exported
 * entry point (guardShowingFinancialGate) and no second way to run the gate.
 */
async function runGateSessionless(
  contactId: string,
  actorUserId: string | undefined,
): Promise<{ success: boolean; allowed?: boolean; reason?: string; verification?: FinancialVerificationResult }> {
  try {
    const context = { contactId, userId: actorUserId, source: "voice_assistant" as const }
    const gateCheck = await enforceFinancialGate(context, "tour")

    if (!gateCheck.allowed) {
      // The trail is the point — a voice-blocked showing must leave the same row a
      // portal-blocked one does, or the audit trail has a hole shaped like the lane.
      await logBuyerExecutionEvent({
        contactId,
        eventType: "buyer.tour.blocked",
        userId: actorUserId,
        source: "voice_assistant",
        metadata: {
          reason: gateCheck.reason,
          verification_status: gateCheck.verification?.isVerified || false,
        },
      })
    }

    return {
      success: true,
      allowed: gateCheck.allowed,
      reason: gateCheck.reason,
      verification: gateCheck.verification,
    }
  } catch (error) {
    console.error("[showing-financial-policy] sessionless gate failed:", error)
    return { success: false }
  }
}

/**
 * THE ENFORCEMENT POINT for every path that sets or schedules a showing.
 *
 * Order matters and is the contract: the tenant policy is read FIRST, and when
 * it is off this returns immediately — no verification query, no event written,
 * no behaviour change of any kind from before m377.
 *
 * When it is on, the check runs through checkBuyerCanPerformAction rather than
 * calling enforceFinancialGate directly. That wrapper was written for exactly
 * this and never used: it runs the same gate AND writes a `buyer.tour.blocked`
 * row to the buyer execution event log with the reason and verification status.
 * A gate that blocks a customer silently is half a gate; this one leaves a trail.
 *
 * ── SESSIONLESS-CALLER OVERLOAD (wave 3) ────────────────────────────────────
 * `checkBuyerCanPerformAction` is a `"use server"` action, and wave 3 gated it on
 * `requireContactAccess`, which builds a COOKIE-BASED Supabase client. Two of this
 * guard's three call sites are ordinary server actions and have cookies. The third
 * does not: `requestShowing` carries an explicit sessionless-caller overload for the
 * voice webhook (lib/voice/showing-request.ts → app/actions/showings.ts), where the
 * speaker is resolved from a voice-session row and there is no auth cookie anywhere.
 * On that lane the session gate would answer "Unauthorized", `check.success` would be
 * false, and every voice-booked showing at an opted-in brokerage would come back
 * "financial verification unavailable" — a gate failure invented by plumbing.
 *
 * So the sessionless lane gets its OWN door, exactly like `requestShowing` itself
 * does, and it is NOT given a fake identity: it passes the real `actorUserId` its
 * caller already verified, and it runs the SAME two steps — `enforceFinancialGate`
 * then the `buyer.tour.blocked` log — against the same library primitives. The
 * authorization that the cookie lane gets from `requireContactAccess` is, on this
 * lane, already done by the caller before it ever reaches here.
 */
export async function guardShowingFinancialGate(params: {
  contactId: string
  brokerageId: string | null | undefined
  /** users.id of whoever is acting — NOT a contacts.id and NOT an agents.id. */
  userId?: string | null
  /**
   * Present ONLY on the sessionless (voice webhook) lane. `actorUserId` must be a
   * users.id the caller has already resolved and verified; it is never taken from
   * anything a speaker said. Absent = the normal cookie-session lane.
   */
  caller?: { actorUserId?: string | null } | null
}): Promise<ShowingFinancialGateResult> {
  const required = await isFinancialGateRequiredForShowings(params.brokerageId)
  if (!required) return { blocked: false }

  const check = params.caller
    ? await runGateSessionless(params.contactId, params.caller.actorUserId ?? params.userId ?? undefined)
    : await checkBuyerCanPerformAction({
        contactId: params.contactId,
        action: "tour",
        userId: params.userId ?? undefined,
      })

  if (!check.success) {
    // We could NOT evaluate the gate. Saying "your lender hasn't confirmed"
    // here would be a lie, so it gets its own code and its own words.
    return {
      blocked: true,
      errorCode: "financial_verification_unavailable",
      reason:
        "This brokerage requires financial verification before a showing can be scheduled, " +
        "but that check could not be completed just now, so the showing was not booked. " +
        "Please try again — if it keeps happening this is a system problem, not a problem " +
        "with the buyer's financing.",
    }
  }

  if (check.allowed) return { blocked: false }

  return {
    blocked: true,
    errorCode: "financial_verification_required",
    reason: explainBlock(check.reason, check.verification),
    verification: check.verification,
  }
}
