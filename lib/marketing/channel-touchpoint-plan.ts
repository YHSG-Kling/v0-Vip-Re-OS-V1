// lib/marketing/channel-touchpoint-plan.ts
//
// WAVE 153 (lane 153R — owner B11, census row sms, ROI hop): an SMS preset send carried no campaign attribution outside a
// bundle, so its outcome never reached the ROI ledger (lib/intelligence/roi-ledger.ts counts marketing_campaign_touchpoints per
// campaign — activity, reach, and every reached Contact's appointments / deals). This is the PURE decision the SMS door asks
// after a dispatch: record ONE campaign touchpoint, or say why not. It never invents attribution: no named campaign, a campaign
// not verified in this tenant, no contact, or a send the provider did not accept → NOT recorded, with the reason — the ledger
// then shows no SMS figure for it (N/A with its reason), never $0.

// (A podcast episode reaches no individual Contact, so it never records a touchpoint — its ROI hop is the ledger's channel
// measure in lib/intelligence/roi-ledger.ts measureChannelOutcomes: episodes published under a campaign, listens N/A.)
export type TouchpointPlan =
  | { record: true; channel: "sms"; campaignId: string; contactId: string }
  | { record: false; reason: string }

export function planCampaignTouchpoint(input: {
  channel: "sms"
  accepted: boolean
  contactId: string | null | undefined
  marketingCampaignId: string | null | undefined
  /** the campaign row was read in THIS tenant (true), refused / foreign / missing (false), or not asked (null — no campaign named) */
  campaignVerified: boolean | null
}): TouchpointPlan {
  if (!input.marketingCampaignId) return { record: false, reason: "no marketing campaign was named on this send — it is not attributed (the ROI ledger shows no figure for it, never $0)" }
  if (!input.accepted) return { record: false, reason: "the provider did not accept the send — nothing reached the person to attribute" }
  if (!input.contactId) return { record: false, reason: "the send has no Contact (a lead or a bare number) — campaign touchpoints attribute Contacts only" }
  if (input.campaignVerified !== true) return { record: false, reason: "the named campaign is not verified in this tenant — attribution is refused, never guessed" }
  return { record: true, channel: input.channel, campaignId: input.marketingCampaignId, contactId: input.contactId }
}
