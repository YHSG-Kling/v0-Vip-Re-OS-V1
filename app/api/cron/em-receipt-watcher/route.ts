/**
 * Cron: earnest-money receipt watcher.
 *
 * Many states (and most brokerage policies) require the buyer's earnest money
 * to be on file within a fixed window after contract execution — typically
 * 3 business days. When an offer is signed-and-accepted but has no
 * earnest_money_receipt classification on file after that window, we raise
 * a high-severity compliance flag so the agent + TC + compliance_officer +
 * compliance_manager all see it.
 *
 * Runs daily. Picks up:
 *   - offers where status='accepted' AND compliance_passed_at IS NOT NULL
 *   - AND age >= EM_RECEIPT_DAYS (default 3)
 *   - AND no documents row with classification='earnest_money_receipt' linked
 *     to the offer/contact
 *   - AND no prior em-receipt compliance flag in the last 48h (dedupe)
 *
 * For each match, fires flagOfferCompliance with severity='high' →
 * notifyComplianceFlag fans out through NotificationService (in_app + email +
 * SMS-on-consent).
 */

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { flagOfferCompliance } from "@/app/actions/buyer-offer/flag-compliance"

const EM_RECEIPT_DAYS = 3

export async function GET(req: Request) {
  // Standard cron-bearer auth — same pattern as the other cron routes
  const auth = req.headers.get("authorization") ?? ""
  if (process.env.CRON_SECRET && !auth.endsWith(process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Find candidate offers: accepted, with a transaction, older than EM_RECEIPT_DAYS
  const cutoff = new Date(Date.now() - EM_RECEIPT_DAYS * 24 * 3600 * 1000).toISOString()
  const { data: offers, error } = await supabase
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id, earnest_money, compliance_passed_at")
    .eq("status", "accepted")
    .not("compliance_passed_at", "is", null)
    .lte("compliance_passed_at", cutoff)
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

    const days = Math.floor((Date.now() - new Date(offer.compliance_passed_at as string).getTime()) / 86_400_000)
    await flagOfferCompliance({
      offerId:      offer.id as string,
      raiserUserId,
      flagType:     "missing_form",      // closest taxonomy bucket; flag body explains it's EM receipt
      severity:     "high",
      title:        `Earnest money receipt missing (${days} days past contract)`,
      body:         `Offer ${offer.id} has been under contract for ${days} days with no earnest_money_receipt on file. Brokerage policy + state law typically requires the receipt within ${EM_RECEIPT_DAYS} business days. Upload the EM receipt or document the reason.`,
    })
    flagged++
  }

  return NextResponse.json({ ok: true, checked: offers.length, flagged })
}
