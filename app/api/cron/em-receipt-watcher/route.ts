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
 * For each match, fires flagOfferCompliance with severity='high' →
 * notifyComplianceFlag fans to agent + TC + compliance_officer + compliance_manager
 * (multi-channel for high severity: in-app + email + SMS-on-consent).
 */

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { flagOfferCompliance } from "@/app/actions/buyer-offer/flag-compliance"
import { verifyCronAuth } from "@/lib/cron-auth"

export async function GET(req: Request) {
  // Fail-closed cron auth (the previous inline check was fail-open when
  // CRON_SECRET was unset).
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const supabase = createServiceClient()

  // Find candidate offers: deadline has arrived/passed per the CONTRACT's own
  // earnest_money_due_at — not a fixed N-day window.
  const nowIso = new Date().toISOString()
  const { data: offers, error } = await supabase
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id, earnest_money, earnest_money_due_at, earnest_money_due_days, contract_date")
    .eq("status", "accepted")
    .not("earnest_money_due_at", "is", null)
    .lte("earnest_money_due_at", nowIso)
    .not("transaction_id", "is", null)
    .limit(200)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!offers || offers.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, flagged: 0 })
  }

  let flagged = 0
  for (const offer of offers) {
    // Skip offers where no earnest money was ever required (rare but possible)
    if (!offer.earnest_money || Number(offer.earnest_money) === 0) continue

    // Already have an EM receipt on file? Skip.
    const { count: receiptCount } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", offer.brokerage_id)
      .eq("classification", "earnest_money_receipt")
      .or(`contact_id.eq.${offer.contact_id},metadata->>linked_offer_id.eq.${offer.id}`)
    if ((receiptCount ?? 0) > 0) continue

    // Already flagged in the last 48 hours? Dedupe.
    const dedupeCutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    const { count: existingFlagCount } = await supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", offer.brokerage_id)
      .eq("activity_type", "buyer.offer.compliance.flagged")
      .gte("created_at", dedupeCutoff)
      .filter("notes", "ilike", `%${offer.id}%em_receipt_missing%`)
    if ((existingFlagCount ?? 0) > 0) continue

    // Resolve a user_id for the raiser (the agent attached to the offer).
    let raiserUserId = ""
    if (offer.agent_id) {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("user_id")
        .eq("id", offer.agent_id)
        .maybeSingle()
      raiserUserId = (agentRow?.user_id as string | undefined) ?? ""
    }
    if (!raiserUserId) continue

    const overdueDays = Math.floor((Date.now() - new Date(offer.earnest_money_due_at as string).getTime()) / 86_400_000)
    const dueDaysContract = offer.earnest_money_due_days ?? "?"
    await flagOfferCompliance({
      offerId:      offer.id as string,
      raiserUserId,
      flagType:     "missing_form",      // closest taxonomy bucket; body explains it's EM receipt
      severity:     "high",
      title:        `Earnest money receipt missing (${overdueDays >= 0 ? overdueDays : 0} day${overdueDays === 1 ? "" : "s"} past contract deadline)`,
      body:         `Contract required EMD within ${dueDaysContract} day(s) of contract date — deadline was ${offer.earnest_money_due_at}. No earnest_money_receipt on file. Upload the receipt or document the reason.`,
    })
    flagged++
  }

  return NextResponse.json({ ok: true, checked: offers.length, flagged })
}
