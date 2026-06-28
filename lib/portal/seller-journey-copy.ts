// lib/portal/seller-journey-copy.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE seller-journey stage copy for the portal "Your Sale Status" card. Split out of the client
// card so it's unit-testable and so the copy can adapt to the seller's SITUATION.
//
// Why an overlay instead of one fixed script: the generic copy ("pricing, media, and marketing
// materials") is upbeat-marketing in tone, which is wrong for a seller in a SENSITIVE context
// (probate / divorce / foreclosure / a major life transition). For those sellers the persona system
// already flags `sensitive=true`; we swap in an empathy-forward, lower-pressure register.
//
// FAIR-HOUSING SAFE BY CONSTRUCTION: the overlay is keyed ONLY to the seller's self-disclosed
// sensitive flag and NEVER references a protected basis (no age/family/national-origin/etc. language).
// It changes warmth + pressure, not substance — every seller gets the same factual "what happens next".

export type SellerUrgency = "low" | "medium" | "high"

export interface SellerStageCopy {
  headline: string
  whatMeans: string
  whatNext: string
  responsible: string
  urgency: SellerUrgency
}

export const SELLER_STAGE_MEANING: Record<string, SellerStageCopy> = {
  PRE_LISTING: {
    headline: "Getting Your Home Ready",
    whatMeans: "Your agent is preparing everything needed to bring your home to market — pricing, media, and marketing materials.",
    whatNext: "Media capture, pricing review, and launch preparations are underway. Your agent will keep you posted.",
    responsible: "Your Agent",
    urgency: "low",
  },
  COMING_SOON: {
    headline: "Getting Ready to Launch",
    whatMeans: "Your listing is being prepared for market. Photos, pricing, and marketing materials are being finalized.",
    whatNext: "Once everything is ready, your agent will launch the listing and begin marketing.",
    responsible: "Your Agent",
    urgency: "low",
  },
  ACTIVE: {
    headline: "On the Market",
    whatMeans: "Your home is actively listed and being shown to potential buyers. Marketing is live and working.",
    whatNext: "Your agent will keep you updated on showings and any buyer interest.",
    responsible: "Your Agent + Market",
    urgency: "medium",
  },
  SHOWING_ACTIVE: {
    headline: "Buyers Are Viewing",
    whatMeans: "Your home is getting attention. Showings are happening and buyers are seeing the property.",
    whatNext: "After each showing, your agent will collect feedback and share insights with you.",
    responsible: "Your Agent",
    urgency: "medium",
  },
  OFFER_RECEIVED: {
    headline: "Offer Received",
    whatMeans: "A buyer has submitted an offer on your home. This is an important moment in your sale.",
    whatNext: "Review the offer with your agent. You can accept, counter, or decline.",
    responsible: "You + Your Agent",
    urgency: "high",
  },
  UNDER_CONTRACT: {
    headline: "Under Contract",
    whatMeans: "You have accepted an offer and are now in the due diligence period. The buyer is completing inspections and financing.",
    whatNext: "Key milestones: inspection, appraisal, and final walkthrough before closing.",
    responsible: "Buyer + Your Agent",
    urgency: "medium",
  },
  PENDING: {
    headline: "Sale Pending",
    whatMeans: "All contingencies have been cleared. You are on track to close.",
    whatNext: "Final preparations for closing day. Your agent will coordinate with title and escrow.",
    responsible: "Your Agent + Title",
    urgency: "low",
  },
  CLOSED: {
    headline: "Sold",
    whatMeans: "Congratulations! Your home has sold. The transaction is complete.",
    whatNext: "Your agent remains a resource for any questions about your next chapter.",
    responsible: "You",
    urgency: "low",
  },
}

// Empathy-forward overrides for SENSITIVE contexts — gentler, lower-pressure, situation-respecting.
// Only the tonal fields (whatMeans / whatNext) change; headline / responsible / urgency stay.
const SENSITIVE_STAGE_OVERRIDES: Record<string, Pick<SellerStageCopy, "whatMeans" | "whatNext">> = {
  PRE_LISTING: {
    whatMeans: "Your agent is quietly handling the details to get your home ready — pricing, photos, and paperwork — so you don't have to carry it. There's no rush; we move at the pace that's right for you.",
    whatNext: "Your agent will walk you through each step and check in before anything happens. Reach out any time — there are no wrong questions.",
  },
  COMING_SOON: {
    whatMeans: "Everything is being prepared with care behind the scenes. Your agent is making sure the home is presented the way it deserves before it goes live.",
    whatNext: "Nothing goes public until you're comfortable. Your agent will confirm with you first.",
  },
  ACTIVE: {
    whatMeans: "Your home is on the market, and your agent is looking after the day-to-day so you can focus on everything else. You'll only hear from us when there's something that matters.",
    whatNext: "Your agent will keep you gently in the loop on showings and interest — no detail too small to ask about.",
  },
  SHOWING_ACTIVE: {
    whatMeans: "Buyers are coming through to see your home. Your agent is managing the logistics and will translate the feedback into plain terms for you.",
    whatNext: "After showings, your agent will share what buyers said and talk through any decisions together, on your timeline.",
  },
  OFFER_RECEIVED: {
    whatMeans: "A buyer has made an offer. This can feel like a big moment — your agent will sit with you and explain every part in plain language before you decide anything.",
    whatNext: "Take the time you need. Your agent will walk through your options (accept, counter, or decline) and answer every question.",
  },
  UNDER_CONTRACT: {
    whatMeans: "You've accepted an offer and entered the review period. Your agent is coordinating the inspections, paperwork, and timelines so it stays manageable for you.",
    whatNext: "Your agent will guide you through inspection, appraisal, and walkthrough — flagging anything you need to know, and shielding you from the rest.",
  },
  PENDING: {
    whatMeans: "The major hurdles are cleared and you're heading toward closing. Your agent is handling the coordination with title and escrow.",
    whatNext: "Your agent will prepare you for closing day step by step, so nothing comes as a surprise.",
  },
  CLOSED: {
    whatMeans: "Your home has closed. Whatever this chapter meant for you, your agent is honored to have helped you through it.",
    whatNext: "Your agent is still here for you — for paperwork, referrals, or whatever comes next, on your timeline.",
  },
}

/** PURE. Derive the seller journey stage from listing status + live activity. */
export function deriveSellerStage(listingStatus: string | null, offerCount: number, showingCount: number): string {
  if (listingStatus === "pre_listing" || listingStatus === "draft") return "PRE_LISTING"
  if (listingStatus === "coming_soon") return "COMING_SOON"
  if (listingStatus === "pending" || listingStatus === "under_contract") return "UNDER_CONTRACT"
  if (listingStatus === "sold" || listingStatus === "closed") return "CLOSED"
  if (offerCount > 0) return "OFFER_RECEIVED"
  if (showingCount > 0) return "SHOWING_ACTIVE"
  return "ACTIVE"
}

/**
 * PURE. Resolve the stage copy, applying the empathy overlay for sensitive contexts. The factual
 * fields (headline / responsible / urgency / "what happens next" substance) are identical for every
 * seller; only warmth + pressure shift. Unknown stage falls back to ACTIVE.
 */
export function resolveSellerStageCopy(stage: string, opts?: { sensitive?: boolean }): SellerStageCopy {
  const base = SELLER_STAGE_MEANING[stage] ?? SELLER_STAGE_MEANING.ACTIVE
  if (!opts?.sensitive) return base
  const override = SENSITIVE_STAGE_OVERRIDES[stage]
  return override ? { ...base, ...override } : base
}
