/**
 * Cron: earnest-money receipt watcher.
 *
 * The EMD deadline is dictated by THE CONTRACT, not a hardcoded fallback.
 * Each offer carries earnest_money_due_at (computed from the contract's
 * earnest_money_due_days, set by the scanner when the signed contract
 * is uploaded). When that deadline passes and no earnest_money_receipt
 * is on file, we raise a high-severity compliance flag.
 *
 * Runs daily. Picks up:
 *   - offers where earnest_money_due_at IS NOT NULL AND earnest_money_due_at <= now()
 *   - AND no documents row with classification='earnest_money_receipt'
 *     linked to the offer/contact
 *   - AND no prior em-receipt compliance flag in the last 48h (dedupe)
 *
 * Fallback for legacy offers without earnest_money_due_at: we don't fire
 * a flag — those need the agent or the next signed-contract scan to fill
 * in the deadline. We never invent a deadline the contract didn't dictate.
 *
 * ── WHAT WAS BROKEN, IN TWO PLACES THAT HAD TO BE FIXED TOGETHER ─────────────
 *
 * 1. IT COULD NOT RAISE A FLAG AT ALL. This route holds a service credential and
 *    has no cookies, and it called `flagOfferCompliance` — a `"use server"`
 *    module whose first act is `auth.getUser()` → `Unauthorized`. Every
 *    iteration got `{ success: false, error: "Unauthorized" }` back, the return
 *    value was never read, and `flagged` was incremented anyway. So the run
 *    reported flags it had not raised, and a missing earnest-money receipt has
 *    never once reached a human. It now goes through
 *    lib/compliance/raise-offer-flag.ts — the session-free core the action ALSO
 *    calls — so the session gate on the RPC is untouched and this route stops
 *    pretending to be a browser.
 *
 * 2. THE DEDUPE COULD NOT MATCH. It filtered
 *    `notes ilike '%<offerId>%em_receipt_missing%'`, but the writer stores
 *    `JSON.stringify({ offer_id, flagType, … })` with `flagType` from the
 *    six-value packet vocabulary; the literal `em_receipt_missing` appears
 *    nowhere in the tree. Zero matches, every run. Fixing the auth half ALONE
 *    would have traded silence for a nightly re-flag and re-notify of every
 *    accepted offer. The window now keys on `metadata.flag_key` — what the
 *    writer actually writes, from wave 9's `complianceFlagKey`.
 *
 * The flag's TITLE is deliberately constant (the day count moved into the body):
 * the flag key is a function of the title, so a title that changes daily is a
 * key that changes daily, and the ledger would stack a new open row every run.
 *
 * For each match, the core fires notifyComplianceFlag → agent + TC +
 * compliance_officer (multi-channel for high severity), and every offer that is
 * NOT flagged leaves a reason in the response instead of a silent `continue`.
 */

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyCronAuth } from "@/lib/cron-auth"
import {
  raiseOfferComplianceFlag,
  resolveUnattendedRaiserUserId,
  emReceiptFlagRaisedWithin,
  emReceiptFlagSubject,
} from "@/lib/compliance/raise-offer-flag"

/** How long one raise suppresses the next for the SAME miss on the same offer. */
const DEDUPE_WINDOW_MS = 48 * 3600 * 1000

export async function GET(req: Request) {
  // Fail-closed cron auth (the previous inline check was fail-open when
  // CRON_SECRET was unset).
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const supabase = createServiceClient()

  // Find candidate offers: deadline has arrived/passed per the CONTRACT's own
  // earnest_money_due_at — not a fixed N-day window.
  const now = new Date()
  const nowIso = now.toISOString()
  const { data: offers, error } = await supabase
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id, earnest_money, earnest_money_due_at, earnest_money_due_days, fully_signed_contract_received_at")
    .eq("status", "accepted")
    .not("earnest_money_due_at", "is", null)
    .lte("earnest_money_due_at", nowIso)
    .not("transaction_id", "is", null)
    .limit(200)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!offers || offers.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, flagged: 0, notified: 0, skipped: [], warnings: [] })
  }

  const subject = emReceiptFlagSubject()
  const dedupeCutoff = new Date(now.getTime() - DEDUPE_WINDOW_MS)

  let flagged = 0
  let notified = 0
  /** Every offer this run did NOT flag, and why. A skip with no record is how a
   *  watchdog goes quiet without anyone noticing. */
  const skipped: Array<{ offerId: string; reason: string }> = []
  /** Degradations that did not stop the raise but must not vanish. */
  const warnings: Array<{ offerId: string; warning: string }> = []

  for (const offer of offers) {
    const offerId = offer.id as string
    const brokerageId = offer.brokerage_id as string | null

    if (!brokerageId) {
      // activities.brokerage_id is NOT NULL with no default — a flag filed
      // without a tenant writes zero rows and reports success.
      skipped.push({ offerId, reason: "offer has no brokerage" })
      continue
    }

    // Skip offers where no earnest money was ever required (rare but possible)
    if (!offer.earnest_money || Number(offer.earnest_money) === 0) {
      skipped.push({ offerId, reason: "no earnest money required on this offer" })
      continue
    }

    // Already have an EM receipt on file? Skip.
    //
    // `contact_id.eq.${null}` is not a filter, it is a malformed one — build the
    // or-clause from the keys this offer actually has.
    const receiptKeys = [`metadata->>linked_offer_id.eq.${offerId}`]
    if (offer.contact_id) receiptKeys.unshift(`contact_id.eq.${offer.contact_id}`)
    const { count: receiptCount, error: receiptError } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("classification", "earnest_money_receipt")
      .or(receiptKeys.join(","))

    if (receiptError) {
      // supabase-js RESOLVES a refused query, and `count` comes back null — which
      // `(count ?? 0) > 0` reads as "no receipt on file". Flagging on an
      // unreadable document ledger would assert something about the record we
      // could not check, so this skips AND says so rather than guessing either way.
      skipped.push({ offerId, reason: `could not read the document ledger: ${receiptError.message}` })
      continue
    }
    if ((receiptCount ?? 0) > 0) {
      skipped.push({ offerId, reason: "earnest money receipt already on file" })
      continue
    }

    // Already flagged in the last 48 hours? Dedupe on the key the WRITER writes.
    const priorRaise = await emReceiptFlagRaisedWithin(supabase, { brokerageId, offerId, since: dedupeCutoff })
    if (priorRaise.error) warnings.push({ offerId, warning: `${priorRaise.error} — raised anyway rather than losing the alert` })
    if (priorRaise.raisedWithinWindow) {
      skipped.push({ offerId, reason: `already flagged at ${priorRaise.lastRaisedAt} (inside the ${DEDUPE_WINDOW_MS / 3600000}h window)` })
      continue
    }

    // Who the flag is filed under. `activities.agent_user_id` FKs users(id), so
    // an unattended run resolves a real actor or refuses — it never invents one.
    const raiser = await resolveUnattendedRaiserUserId(supabase, {
      brokerageId,
      agentRecordId: (offer.agent_id as string | null) ?? null,
    })
    if (!raiser.userId) {
      skipped.push({ offerId, reason: `no user to file the flag under (${raiser.error ?? raiser.via})` })
      continue
    }

    const dueAt = offer.earnest_money_due_at as string
    const overdueDays = Math.floor((now.getTime() - new Date(dueAt).getTime()) / 86_400_000)
    const dueDaysContract = offer.earnest_money_due_days ?? "?"

    const outcome = await raiseOfferComplianceFlag(supabase, {
      offerId,
      raiserUserId: raiser.userId,
      // No requireBrokerageId: this sweep never reads a tenant from a caller. It
      // takes brokerage_id off the offer row it is processing.
      flagType: subject.flagType,
      severity: "high",
      // STABLE title — it is the flag's identity. The moving parts go below.
      title: subject.title,
      body:
        `${overdueDays >= 0 ? overdueDays : 0} day${overdueDays === 1 ? "" : "s"} past the contract deadline. ` +
        `Contract required EMD within ${dueDaysContract} day(s) of contract date — deadline was ${dueAt}. ` +
        `No earnest_money_receipt on file. Upload the receipt or document the reason.`,
    })

    if (!outcome.success) {
      // The previous build incremented `flagged` unconditionally, which is how a
      // route that raised nothing for its whole life reported work every night.
      skipped.push({ offerId, reason: `flag not raised: ${outcome.error ?? "unknown error"}` })
      continue
    }
    if (outcome.error) warnings.push({ offerId, warning: outcome.error })

    flagged++
    notified += outcome.notified_count
    if (outcome.notified_count === 0) {
      warnings.push({ offerId, warning: "flag recorded but it reached NO recipient — nobody in this brokerage was resolvable" })
    }
  }

  return NextResponse.json({
    ok: true,
    checked: offers.length,
    flagged,
    notified,
    skipped,
    warnings,
  })
}
