// lib/listings/seller-team-activity.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE builder for the seller-portal "YOUR AI TEAM" card — the differentiator. Competitors bolt one AI
// onto a CRM; this OS runs a TEAM of accountable managers (the one-command-center egress). This surfaces
// that team to the seller with NAMED accountability and what each manager actually did — grounded ONLY
// in real activity already on the page (no fabrication, no manager shown without real work). It's the
// "we're a real estate team, not a dashboard" proof. No I/O — unit-testable.

export interface SellerTeamInput {
  /** The listing is live (MLS_ACTIVE / active). */
  listingLive: boolean
  /** Channels actively promoting the home (the honest count from marketing-channels.ts). */
  marketingChannelsLive: number
  /** Showings coordinated for the listing (total). */
  showingsTotal: number
  /** Personalized videos finished + delivered for this seller. */
  videosDelivered: number
  /** Offers received on the listing. */
  offersCount: number
}

export interface SellerTeamMember {
  /** The manager's name (matches the OS manager registry). */
  manager: string
  /** Plain-language role the seller understands. */
  role: string
  /** What this manager actually did — grounded in real activity. */
  did: string
  /** Icon hint for the card. */
  icon: "home" | "megaphone" | "video" | "users" | "handshake"
}

/**
 * PURE. Build the seller's AI team from real activity. Listing Concierge always leads (it owns the
 * live listing + coordinates the team); every other manager appears ONLY when it has done real work —
 * so the seller never sees a hollow "team member" who did nothing.
 */
export function buildSellerTeamActivity(input: SellerTeamInput): SellerTeamMember[] {
  const team: SellerTeamMember[] = []

  // Listing Concierge — always present; folds in showings it coordinated so there's no empty member.
  const showingsClause = input.showingsTotal > 0
    ? ` and coordinated ${input.showingsTotal} showing${input.showingsTotal === 1 ? "" : "s"} with buyers`
    : ""
  team.push({
    manager: "Listing Concierge",
    role: "Your listing lead",
    icon: "home",
    did: input.listingLive
      ? `Has your home live and is coordinating your whole team${showingsClause}.`
      : `Is preparing your home to go live and coordinating your team${showingsClause}.`,
  })

  if (input.marketingChannelsLive > 0) {
    team.push({
      manager: "Campaign Orchestrator",
      role: "Marketing",
      icon: "megaphone",
      did: `Promoting your home across ${input.marketingChannelsLive} channel${input.marketingChannelsLive === 1 ? "" : "s"} right now.`,
    })
  }

  if (input.videosDelivered > 0) {
    team.push({
      manager: "Asset Manager",
      role: "Video & creative",
      icon: "video",
      did: `Produced ${input.videosDelivered} personalized video${input.videosDelivered === 1 ? "" : "s"} of your home.`,
    })
  }

  if (input.offersCount > 0) {
    team.push({
      manager: "Deal Coordinator",
      role: "Offers & closing",
      icon: "handshake",
      did: `Reviewing ${input.offersCount} offer${input.offersCount === 1 ? "" : "s"} with your agent.`,
    })
  }

  return team
}

// ── CLIENT-SAFE TEAM TIMELINE ("what your AI team did this week") ─────────────
// Narrates manager_signals for the seller via a WHITELIST: only signal types
// with a pre-written client-safe line ever surface — raw manager-to-manager
// text is NEVER shown, unknown types are dropped, no prices/terms/internal
// jargon can leak because the copy is fixed here, not composed from payloads.

export const CLIENT_SAFE_SIGNAL_LINES: Record<string, { manager: string; line: string }> = {
  deal_play_prep_ready:     { manager: "Listing Concierge",    line: "staged your home's full launch plan for your agent's review" },
  deal_play_reel_ready:     { manager: "Asset Manager",        line: "produced a promo video of your home (pending your agent's approval)" },
  deal_play_campaign_ready: { manager: "Campaign Orchestrator", line: "drafted the social and email campaign for your home" },
  deal_play_ads_ready:      { manager: "Ads Manager",          line: "prepared an advertising plan for your agent to approve" },
  launch_war_room_convened: { manager: "Listing Concierge",    line: "convened your whole AI team on your home's launch" },
  listing_marketing_ready:  { manager: "Listing Concierge",    line: "handed your home to the marketing team" },
}

export interface SellerTeamTimelineLine {
  when: string
  manager: string
  line: string
}

/** PURE: whitelist-narrate a listing's manager signals for the SELLER. Unknown
 *  signal types are dropped (never leak internal chatter); newest first; capped. */
export function narrateSignalsForClient(
  signals: Array<{ signal_type: string | null; created_at: string | null }>,
  cap = 6,
): SellerTeamTimelineLine[] {
  return signals
    .filter((s) => s.signal_type && s.created_at && CLIENT_SAFE_SIGNAL_LINES[s.signal_type])
    .sort((a, b) => (b.created_at! < a.created_at! ? -1 : 1))
    .slice(0, cap)
    .map((s) => {
      const safe = CLIENT_SAFE_SIGNAL_LINES[s.signal_type!]
      return { when: s.created_at!, manager: safe.manager, line: safe.line }
    })
}
