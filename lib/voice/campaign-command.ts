// ─── VOICE CAMPAIGN COMMAND ("launch the campaign for 123 Oak St") ─────────────
// The most natural unwired broker voice command: launch a listing's marketing campaign.
// The executor (launchMarketingCampaignAction → publishMarketingCampaignSafe) already
// exists and self-enforces admin gating + tenant + compliance. This pure helper picks
// WHICH of a listing's campaigns to launch when the broker doesn't name a specific one —
// the most launch-ready by status, then the most recent. Deterministic, unit-testable.

export interface LaunchableCampaign {
  id: string
  status: string
  campaign_name?: string | null
  campaign_type?: string | null
  created_at?: string | null
}

// publishMarketingCampaignSafe accepts these statuses; ordered most-ready → least.
export const LAUNCHABLE_STATUS_PRIORITY = ["approved", "scheduled", "pending_review", "draft"] as const

/**
 * Pick the campaign to launch from a listing's campaigns: the most launch-ready status
 * (approved > scheduled > pending_review > draft), tie-broken by most recently created.
 * Campaigns already live/ended/etc. are ignored. Returns null when none are launchable. Pure.
 */
export function pickLaunchableCampaign(campaigns: LaunchableCampaign[]): LaunchableCampaign | null {
  const launchable = campaigns.filter((c) => (LAUNCHABLE_STATUS_PRIORITY as readonly string[]).includes(c.status))
  if (launchable.length === 0) return null

  const rank = (s: string) => {
    const i = (LAUNCHABLE_STATUS_PRIORITY as readonly string[]).indexOf(s)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return [...launchable].sort((a, b) => {
    const r = rank(a.status) - rank(b.status)
    if (r !== 0) return r
    // Same status → most recently created first.
    return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
  })[0]
}
