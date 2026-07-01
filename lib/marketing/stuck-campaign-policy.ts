// ─── STUCK-CAMPAIGN POLICY (Campaign Orchestrator) ───────────────────────────
// Pure classifier for the stuck-campaign reaper. marketing_campaigns is the Campaign
// Orchestrator's PRIMARY table, but nothing watched it — a campaign could stall
// between scheduled/live/draft with no content ever distributed and no human alerted.
// This decides, per campaign, whether it's silently stuck (and why). Pure → unit-testable.

export type StuckCampaignVerdict = "keep" | "overdue_scheduled" | "live_no_traction" | "stale_draft"

export interface StuckCampaignInput {
  status: string | null
  /** when it was supposed to launch (scheduled campaigns). */
  scheduledStartAt: string | null
  /** when it actually went live. */
  launchedAt: string | null
  /** rolled-up impressions from child assets (0 = nothing distributed/tracked). */
  impressions: number | null
  createdAt: string | null
  now: Date
}

const DAY = 24 * 60 * 60 * 1000

function olderThan(ts: string | null, days: number, now: Date): boolean {
  if (!ts) return false
  const t = Date.parse(ts)
  if (Number.isNaN(t)) return false
  return now.getTime() - t >= days * DAY
}

/**
 * Classify a campaign as silently stuck:
 *   • overdue_scheduled — 'scheduled', its scheduled_start_at passed by >1 day, still not live
 *     (the launch never fired — compliance blocked it, the cron skipped it, or it was forgotten).
 *   • live_no_traction  — 'live' for >30 days with ZERO impressions (launched but nothing was ever
 *     distributed/tracked — every child asset is unsent).
 *   • stale_draft       — 'draft' for >30 days (an abandoned campaign the funnel is still counting on).
 * Everything else keeps (active campaigns, terminal states, recent drafts, in-window schedules).
 */
export function classifyStuckCampaign(input: StuckCampaignInput): StuckCampaignVerdict {
  const status = (input.status ?? "").toLowerCase()

  if (status === "scheduled" && input.scheduledStartAt && olderThan(input.scheduledStartAt, 1, input.now)) {
    return "overdue_scheduled"
  }
  if (status === "live" && olderThan(input.launchedAt, 30, input.now) && (input.impressions ?? 0) === 0) {
    return "live_no_traction"
  }
  if (status === "draft" && olderThan(input.createdAt, 30, input.now)) {
    return "stale_draft"
  }
  return "keep"
}

export type CampaignRecoveryStrategy = "relaunch" | "escalate"

/**
 * How the Campaign Orchestrator AUTONOMOUSLY recovers a stuck campaign — respecting the
 * propose→approve→send gate:
 *   • overdue_scheduled → RELAUNCH. A 'scheduled' campaign was already human-approved; its launch
 *     simply never fired (cron skip / transient), so re-running the compliance-gated publisher
 *     COMPLETES the approved action — not a new unapproved send. The agent never redoes it.
 *   • stale_draft → ESCALATE. A draft was NOT approved; auto-launching it would send unapproved
 *     content, so a human must finish/approve it.
 *   • live_no_traction → ESCALATE. Can't re-launch from 'live'; needs a human/channel-manager look.
 */
export function recoveryStrategyFor(verdict: Exclude<StuckCampaignVerdict, "keep">): CampaignRecoveryStrategy {
  return verdict === "overdue_scheduled" ? "relaunch" : "escalate"
}

/** Human-readable escalation copy per verdict (broker-facing). */
export function stuckCampaignMessage(verdict: Exclude<StuckCampaignVerdict, "keep">): { title: string; body: string } {
  switch (verdict) {
    case "overdue_scheduled":
      return {
        title: "A marketing campaign was scheduled but never launched",
        body: "A campaign's scheduled start date has passed but it never went live — it may be waiting on a compliance approval or the launch was skipped. Review it so the audience actually gets reached.",
      }
    case "live_no_traction":
      return {
        title: "A live campaign has distributed nothing",
        body: "A campaign has been 'live' for over a month with zero activity across its channels — no email, social, blog, or mail appears to have gone out. Review or relaunch it so it isn't silently dead.",
      }
    case "stale_draft":
      return {
        title: "A marketing campaign has been sitting in draft",
        body: "A campaign has been in draft for over a month and never launched. Finish and launch it, or archive it so the funnel isn't counting on a campaign that never ships.",
      }
  }
}
