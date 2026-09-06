/**
 * lib/direct-mail/neighbor-campaign-rollup.ts
 *
 * THE NEIGHBOR-NOTIFICATION COUNTERS, DERIVED FROM WHAT ACTUALLY MAILED.
 *
 * `neighbor_notification_campaigns.recipients_sent` and `.responses_received`
 * are read by `listNeighborCampaignsForListing`
 * (app/actions/neighbor-notifications.ts:311) and rendered on the listing's
 * neighbor-notification card. Both had NO writer — and that was not an
 * oversight. The staging action USED to write `recipients_sent: N` the instant
 * the direct_mail_recipients rows were inserted, and its own comment records
 * why that was removed: nothing had been mailed yet, the Lob drain does not
 * pick up audience campaigns, and a delivered-count inflated at staging time
 * corrupts both the seller-facing report and spend reconciliation.
 *
 * So the fix is NOT to put the optimistic write back. It is to derive the
 * counters from the rows that record a real outcome, at the two moments those
 * rows change:
 *
 *   recipients_sent    ← direct_mail_recipients whose delivery_status says a
 *                        piece actually went to the printer (written by
 *                        lib/direct-mail/campaign-drain.ts:235 on the Lob
 *                        result, never on staging).
 *   responses_received ← direct_mail_responses filed against the same campaign
 *                        (app/actions/direct-mail.ts:634).
 *
 * A campaign that is still staged therefore reads 0, which is the truth, and it
 * moves the moment something is mailed. Idempotent: re-running recomputes the
 * same two numbers from the same rows.
 */

import "server-only"

type Svc = { from: (table: string) => any }

/** Delivery states that mean a piece really went out. 'queued' and 'failed' do not. */
const MAILED_STATES = ["mailed", "delivered", "in_transit", "processed_for_delivery"]

export interface NeighborRollupResult {
  campaignsUpdated: number
  recipientsSent: number
  responsesReceived: number
  /** A refused read/write. NEVER folded into the zeroes above. */
  refusal: string | null
}

/**
 * Refresh the counters on every neighbor campaign that names this direct-mail
 * campaign. Best-effort by design — the mail already went out and must not be
 * reported as failed because its rollup did not land — but a refusal is
 * RETURNED rather than swallowed, because a zero that came from a refused query
 * is exactly the "nothing was mailed" lie this rollup exists to prevent.
 */
export async function refreshNeighborCampaignCounters(
  svc: Svc,
  directMailCampaignId: string | null | undefined,
): Promise<NeighborRollupResult> {
  const out: NeighborRollupResult = {
    campaignsUpdated: 0, recipientsSent: 0, responsesReceived: 0, refusal: null,
  }
  if (!directMailCampaignId) return out

  const { data: linked, error: linkError } = await svc
    .from("neighbor_notification_campaigns")
    .select("id")
    .eq("direct_mail_campaign_id", directMailCampaignId)
  if (linkError) { out.refusal = `neighbor_notification_campaigns: ${linkError.message}`; return out }
  const campaigns = (linked ?? []) as Array<{ id: string }>
  // No neighbor campaign points at this mailer — it is an ordinary direct-mail
  // campaign. Nothing to roll up, and nothing wrong.
  if (campaigns.length === 0) return out

  const { count: mailed, error: mailedError } = await svc
    .from("direct_mail_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", directMailCampaignId)
    .in("delivery_status", MAILED_STATES)
  if (mailedError) { out.refusal = `direct_mail_recipients: ${mailedError.message}`; return out }

  const { count: responses, error: responsesError } = await svc
    .from("direct_mail_responses")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", directMailCampaignId)
  if (responsesError) { out.refusal = `direct_mail_responses: ${responsesError.message}`; return out }

  out.recipientsSent = mailed ?? 0
  out.responsesReceived = responses ?? 0

  for (const c of campaigns) {
    const { data: updated, error: updateError } = await svc
      .from("neighbor_notification_campaigns")
      .update({
        recipients_sent: out.recipientsSent,
        responses_received: out.responsesReceived,
        updated_at: new Date().toISOString(),
      })
      .eq("id", c.id)
      .select("id")
    if (updateError) { out.refusal = `neighbor_notification_campaigns update: ${updateError.message}`; continue }
    // An UPDATE matching nothing resolves with error null and an empty array,
    // byte-identical to one that worked (CLAUDE.md §3). Count what came back.
    out.campaignsUpdated += (updated ?? []).length
  }

  return out
}
