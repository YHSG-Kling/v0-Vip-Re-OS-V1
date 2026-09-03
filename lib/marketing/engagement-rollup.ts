/**
 * lib/marketing/engagement-rollup.ts
 *
 * open_rate / click_rate, DERIVED — the numbers the agent actually plans with.
 *
 * `email_campaigns.open_rate`, `email_campaigns.click_rate`,
 * `newsletter_campaigns.open_rate` and `newsletter_campaigns.click_rate` were
 * read on four surfaces and written by nobody:
 *
 *   app/actions/email-campaigns.ts:511   getEmailCampaignStats → avgOpenRate,
 *       the headline on the marketing studio. Permanently 0% across every sent
 *       campaign, because `open_rate` carries a CONSTANT default of 0 and
 *       nothing ever moved it.
 *   lib/marketing/campaign-measurer.ts:29 folds (open_rate + click_rate) × 100
 *       into the parent marketing_campaigns.engagements rollup — so the whole
 *       campaign ROI board scored newsletters at zero engagement.
 *   lib/content-intel/performance-aggregator.ts:137 ranks CONTENT TOPICS by
 *       these rates, so every topic tied at zero and the ranking was arbitrary.
 *   app/actions/ai-newsletter.ts:608 feeds them to the send-time optimiser as
 *       "historical performance", so the model was reasoning over zeroes.
 *
 * WHERE THE TRUTH ALREADY LIVES: per-recipient rows. `newsletter_sends` carries
 * opened_at/clicked_at and `email_sends` + `email_tracking` carry the same fact
 * for the queued-send lane — both now written by the SendGrid fan-out
 * (lib/outcomes/provider-event-fanout.ts). This module rolls those up. It is a
 * DERIVED rollup on purpose: the per-send row stays the record of what happened
 * and the campaign column is a cache of it, so a re-run is idempotent and a
 * disagreement is always resolved in favour of the sends.
 *
 * THE DENOMINATOR IS DELIVERED SENDS, NOT RECIPIENTS. A campaign whose
 * recipients were suppressed by the consent gate never reached them, and
 * dividing opens by an audience that was never mailed reports a rate that is
 * wrong in the direction that flatters the campaign.
 *
 * A REFUSAL IS NOT A ZERO. Every read is destructured and a refused one aborts
 * that campaign rather than writing a 0% rate over a rate that may be real.
 */

import "server-only"

type Svc = { from: (table: string) => any }

// Un-exported 2026-09-01: named only by this module's private functions; both exported functions return RollupSummary.
interface CampaignRateRollup {
  campaignId: string
  sent: number
  opened: number
  clicked: number
  openRate: number
  clickRate: number
}

export interface RollupSummary {
  campaignsRolledUp: number
  campaignsSkipped: number
  /** Campaigns whose source rows could not be read. Never folded into a zero. */
  refusals: string[]
  /** Newsletter lane only — see newsletterQueueLatency. Absent on the email lane. */
  queue?: QueueLatency
}

/**
 * QUEUE → SEND LATENCY, the reader for `newsletter_sends.queued_at`.
 *
 * The workflow-OS adapter (app/actions/ai-newsletter.ts queueNewsletterForContact)
 * stamps queued_at when it files the row and sent_at when the provider accepts
 * it. Those rows carry NO campaign_id (a step sends one contact one template),
 * so the per-campaign rollups above can never see them — which is why the
 * column was written and read by nobody. This is measured over the whole
 * window rather than per campaign for exactly that reason.
 *
 * Two facts come out of it, both invisible any other way:
 *   · medianSecondsToSend — how long a queued newsletter waits before it goes.
 *   · stuckQueued — rows still 'queued' an hour after queued_at. The adapter's
 *     status update is fire-and-forget; a row that never advanced is a send
 *     that was filed and never happened, and nothing else reports it.
 */
export interface QueueLatency {
  /** Rows with both queued_at and sent_at in the window. */
  measured: number
  medianSecondsToSend: number | null
  stuckQueued: number
}

async function newsletterQueueLatency(
  svc: Svc,
  since: string,
): Promise<{ queue: QueueLatency | null; error: string | null }> {
  const { data, error } = await svc
    .from("newsletter_sends")
    .select("queued_at, sent_at, status")
    .not("queued_at", "is", null)
    .gte("queued_at", since)
    .limit(20_000)
  if (error) return { queue: null, error: `newsletter_sends queued_at: ${error.message}` }

  const stuckBefore = Date.now() - 3_600_000
  const latencies: number[] = []
  let stuckQueued = 0
  for (const row of (data ?? []) as Array<{ queued_at: string; sent_at: string | null; status: string }>) {
    const queuedMs = Date.parse(row.queued_at)
    if (Number.isNaN(queuedMs)) continue
    if (row.sent_at) {
      const sentMs = Date.parse(row.sent_at)
      if (!Number.isNaN(sentMs) && sentMs >= queuedMs) latencies.push((sentMs - queuedMs) / 1000)
    } else if (row.status === "queued" && queuedMs < stuckBefore) {
      stuckQueued++
    }
  }
  latencies.sort((a, b) => a - b)
  const median = latencies.length === 0
    ? null
    : Math.round(latencies[Math.floor((latencies.length - 1) / 2)])
  return { queue: { measured: latencies.length, medianSecondsToSend: median, stuckQueued }, error: null }
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 1000) / 10
}

/** Count rows matching a filter chain, distinguishing a refusal from a zero. */
async function countOr(
  build: () => any,
): Promise<{ count: number; error: string | null }> {
  const { count, error } = await build()
  if (error) return { count: 0, error: error.message as string }
  return { count: count ?? 0, error: null }
}

/**
 * Rates for ONE campaign whose per-recipient rows live in `newsletter_sends`.
 * That ledger is shared: publish-newsletters files newsletter_campaigns sends
 * there, and the email-campaign sender's broadcast path files email_campaigns
 * sends there too (the column has no FK, so the id space is the caller's to
 * name). Both are counted the same way because both are the same fact.
 */
async function newsletterSendRates(
  svc: Svc,
  campaignId: string,
): Promise<{ rollup: CampaignRateRollup | null; error: string | null }> {
  const base = () => svc.from("newsletter_sends").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId)

  const sent = await countOr(() => base().not("sent_at", "is", null))
  if (sent.error) return { rollup: null, error: `newsletter_sends sent: ${sent.error}` }
  const opened = await countOr(() => base().not("opened_at", "is", null))
  if (opened.error) return { rollup: null, error: `newsletter_sends opened: ${opened.error}` }
  const clicked = await countOr(() => base().not("clicked_at", "is", null))
  if (clicked.error) return { rollup: null, error: `newsletter_sends clicked: ${clicked.error}` }

  return {
    rollup: {
      campaignId,
      sent: sent.count,
      opened: opened.count,
      clicked: clicked.count,
      openRate: pct(opened.count, sent.count),
      clickRate: pct(clicked.count, sent.count),
    },
    error: null,
  }
}

/**
 * Rates for the QUEUED-SEND lane: email_sends rows the campaign drained, with
 * engagement in email_tracking keyed by email_send_id.
 *
 * Deduped by email_send_id, because a provider fires an `open` every time the
 * pixel loads — counting raw events would report a 400% open rate for a
 * recipient who reopened the mail four times.
 */
async function emailSendRates(
  svc: Svc,
  campaignId: string,
): Promise<{ rollup: CampaignRateRollup | null; error: string | null }> {
  const sent = await countOr(() =>
    svc.from("email_sends").select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId).eq("status", "sent"),
  )
  if (sent.error) return { rollup: null, error: `email_sends sent: ${sent.error}` }
  if (sent.count === 0) return { rollup: null, error: null }

  // email_tracking → email_sends has exactly ONE foreign key, so the bare embed
  // is unambiguous (a second FK would earn PGRST201 and kill the whole query).
  const { data: events, error: eventsError } = await svc
    .from("email_tracking")
    .select("email_send_id, event_type, email_sends!inner(campaign_id)")
    .eq("email_sends.campaign_id", campaignId)
    .in("event_type", ["open", "click"])
    .limit(50_000)
  if (eventsError) return { rollup: null, error: `email_tracking: ${eventsError.message}` }

  const openedSends = new Set<string>()
  const clickedSends = new Set<string>()
  for (const row of (events ?? []) as Array<{ email_send_id: string | null; event_type: string }>) {
    if (!row.email_send_id) continue
    if (row.event_type === "open") openedSends.add(row.email_send_id)
    // A click implies an open even when the pixel was blocked, which is the
    // common case on mail clients that strip images.
    if (row.event_type === "click") { clickedSends.add(row.email_send_id); openedSends.add(row.email_send_id) }
  }

  return {
    rollup: {
      campaignId,
      sent: sent.count,
      opened: openedSends.size,
      clicked: clickedSends.size,
      openRate: pct(openedSends.size, sent.count),
      clickRate: pct(clickedSends.size, sent.count),
    },
    error: null,
  }
}

/** Merge two lanes of the same campaign into one rate over one denominator. */
function merge(a: CampaignRateRollup | null, b: CampaignRateRollup | null): CampaignRateRollup | null {
  if (!a) return b
  if (!b) return a
  const sent = a.sent + b.sent
  const opened = a.opened + b.opened
  const clicked = a.clicked + b.clicked
  return { campaignId: a.campaignId, sent, opened, clicked, openRate: pct(opened, sent), clickRate: pct(clicked, sent) }
}

/**
 * Cron work: refresh `email_campaigns.open_rate` / `.click_rate`.
 *
 * The table name is spelled out in `.from("email_campaigns")` and the columns in
 * the `.update({ open_rate, click_rate })` below rather than passed in as a
 * variable. A `.from(table)` with a parameterised name is unresolvable to every
 * static scanner in this repo, so a shared helper would have made these two
 * columns read as writer-less forever — the exact defect this file closes.
 * Twenty duplicated lines are cheaper than a permanently blind census.
 */
export async function rollupEmailCampaignRates(
  svc: Svc,
  opts?: { sinceDays?: number; limit?: number },
): Promise<RollupSummary> {
  const out: RollupSummary = { campaignsRolledUp: 0, campaignsSkipped: 0, refusals: [] }
  const since = new Date(Date.now() - (opts?.sinceDays ?? 45) * 86_400_000).toISOString()

  // WINDOW ON EVERY TIMESTAMP THE TABLE ACTUALLY HAS. Verified live:
  // email_campaigns carries send_date AND sent_at. A campaign sent immediately
  // from the studio rather than scheduled has a NULL send_date, so anchoring on
  // that column alone would silently exclude the whole send-now lane — the
  // shape of blind spot that reports a clean zero.
  const { data: campaigns, error } = await svc
    .from("email_campaigns")
    .select("id")
    .eq("status", "sent")
    .or(`sent_at.gte.${since},send_date.gte.${since},created_at.gte.${since}`)
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 200)
  if (error) {
    out.refusals.push(`email_campaigns: ${error.message}`)
    return out
  }

  for (const row of (campaigns ?? []) as Array<{ id: string }>) {
    // BOTH LANES, ONE RATE. The sender drains queued per-contact rows into
    // email_sends (listing campaigns) and files broadcast recipients into
    // newsletter_sends. A campaign uses one path or the other, so the union is
    // the audience and either half alone would under-report.
    const viaNewsletterSends = await newsletterSendRates(svc, row.id)
    if (viaNewsletterSends.error) {
      out.refusals.push(`email_campaigns ${row.id}: ${viaNewsletterSends.error}`)
      out.campaignsSkipped++
      continue
    }
    const viaEmailSends = await emailSendRates(svc, row.id)
    if (viaEmailSends.error) {
      out.refusals.push(`email_campaigns ${row.id}: ${viaEmailSends.error}`)
      out.campaignsSkipped++
      continue
    }
    const rollup = merge(viaNewsletterSends.rollup, viaEmailSends.rollup)

    // Nothing was delivered for this campaign. Writing 0% here would be
    // indistinguishable from "mailed and ignored", so leave the row alone.
    if (!rollup || rollup.sent === 0) { out.campaignsSkipped++; continue }

    const { error: updateError } = await svc
      .from("email_campaigns")
      .update({ open_rate: rollup.openRate, click_rate: rollup.clickRate })
      .eq("id", row.id)
    if (updateError) {
      out.refusals.push(`email_campaigns ${row.id} update: ${updateError.message}`)
      out.campaignsSkipped++
      continue
    }
    out.campaignsRolledUp++
  }

  return out
}

/**
 * Cron work: refresh `newsletter_campaigns.open_rate` / `.click_rate`.
 *
 * Spelled out for the same reason as the email lane above. Verified live:
 * newsletter_campaigns carries send_date and created_at and NO sent_at, so the
 * window anchors differ from that lane and cannot be shared either.
 */
export async function rollupNewsletterCampaignRates(
  svc: Svc,
  opts?: { sinceDays?: number; limit?: number },
): Promise<RollupSummary> {
  const out: RollupSummary = { campaignsRolledUp: 0, campaignsSkipped: 0, refusals: [] }
  const since = new Date(Date.now() - (opts?.sinceDays ?? 45) * 86_400_000).toISOString()

  const { data: campaigns, error } = await svc
    .from("newsletter_campaigns")
    .select("id")
    .eq("status", "sent")
    .or(`send_date.gte.${since},created_at.gte.${since}`)
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 200)
  if (error) {
    out.refusals.push(`newsletter_campaigns: ${error.message}`)
    return out
  }

  for (const row of (campaigns ?? []) as Array<{ id: string }>) {
    // A newsletter's recipients only ever land in newsletter_sends — the
    // email_sends queue belongs to the listing-campaign lane.
    const rates = await newsletterSendRates(svc, row.id)
    if (rates.error) {
      out.refusals.push(`newsletter_campaigns ${row.id}: ${rates.error}`)
      out.campaignsSkipped++
      continue
    }
    if (!rates.rollup || rates.rollup.sent === 0) { out.campaignsSkipped++; continue }

    const { error: updateError } = await svc
      .from("newsletter_campaigns")
      .update({ open_rate: rates.rollup.openRate, click_rate: rates.rollup.clickRate })
      .eq("id", row.id)
    if (updateError) {
      out.refusals.push(`newsletter_campaigns ${row.id} update: ${updateError.message}`)
      out.campaignsSkipped++
      continue
    }
    out.campaignsRolledUp++
  }

  // Queue latency rides the same window. A refusal here is reported, not
  // folded into "no queued sends" — the same rule as every count above.
  const queue = await newsletterQueueLatency(svc, since)
  if (queue.error) out.refusals.push(queue.error)
  else if (queue.queue) out.queue = queue.queue

  return out
}
