/**
 * lib/kernel/deconflict/index.ts
 *
 * The De-Conflict Engine. Sits in the dispatch egress alongside the compliance
 * gate and TCPA check. Counts recent outbound touches for the recipient across
 * every channel the platform owns and decides whether one more send on `channel`
 * would over-touch the contact.
 *
 * The competitive insight: MoxiWorks (and every "marketing for real estate" tool
 * in the market) sells one product per channel, so each channel decides in
 * isolation whether to send. We have one egress. Over-messaging is the #1 reason
 * a sphere contact unsubscribes — the cure is the agent KNOWS what the other
 * lanes just did. This is that knowledge, applied before send.
 *
 * Canonical touch sources (per channel) on the live schema:
 *   email — email_sends, isa_outreach_log, marketing_campaign_touchpoints,
 *           lifetime_customer_touchpoints
 *   sms   — isa_outreach_log, marketing_campaign_touchpoints,
 *           lifetime_customer_touchpoints
 *   phone — isa_outreach_log
 *   mail  — direct_mail_recipients, marketing_campaign_touchpoints,
 *           lifetime_customer_touchpoints
 *   video — marketing_campaign_touchpoints, lifetime_customer_touchpoints
 *
 * Default policy (per channel, per contact, rolling window):
 *   email — 3 sends / 14 days
 *   sms   — 1 send  / 7  days
 *   phone — 1 call  / 7  days
 *   mail  — 1 piece / 30 days
 *   video — 1 send  / 21 days
 *
 * Auditable: every decision (allowed OR suppressed) writes one row to
 * deconflict_suppression_log (m113), which the broker cockpit reads.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { leadLogChannel, type DeconflictChannel } from "./lead-channel"
import { computeLearnedCadence, getEngagementSignals } from "./cadence-policy"

// Re-exported so existing importers of "@/lib/kernel/deconflict" keep working.
export { leadLogChannel }
export type { DeconflictChannel }

interface ChannelPolicy {
  maxTouches: number
  windowDays: number
}

const DEFAULT_POLICY: Record<DeconflictChannel, ChannelPolicy> = {
  email: { maxTouches: 3, windowDays: 14 },
  sms:   { maxTouches: 1, windowDays: 7 },
  phone: { maxTouches: 1, windowDays: 7 },
  mail:  { maxTouches: 1, windowDays: 30 },
  video: { maxTouches: 1, windowDays: 21 },
}

export interface DeconflictInput {
  brokerageId:   string
  channel:       DeconflictChannel
  contactId?:    string | null
  /** Lead ID — when the recipient is an unconverted LEAD (no contacts row yet). Lead touches are
   *  counted from isa_outreach_log (the lead-side outreach ledger) so a lead gets the SAME
   *  over-touch protection as a contact. contactId takes precedence when both are present. */
  leadId?:       string | null
  recipientEmail?: string | null
  recipientPhone?: string | null
  /** Where the outbound originated — 'ai_isa', 'sphere_agent',
   *  'campaign_orchestrator', 'manual', 'cadence', etc. Logged for the cockpit. */
  systemSource?: string
  /** Override the default channel policy for this one call. */
  policyOverride?: Partial<ChannelPolicy>
  /** Skip the write to deconflict_suppression_log (dry-run/preview). */
  skipLog?: boolean
  /** Opt in to the SELF-TUNING cadence: adjust the frequency cap from the brokerage's recent
   *  engagement (within hard safety bounds — never below the floor, never above the ceiling; the
   *  legal gates are separate and always apply). Best-effort, fails open to the base policy. */
  learn?: boolean
}

export interface DeconflictDecision {
  allowed:         boolean
  reason?:         string
  touchesInWindow: number
  policyMax:       number
  windowDays:      number
}

type Svc = ReturnType<typeof createServiceClient>

async function safeCount(p: PromiseLike<{ count: number | null }>): Promise<number> {
  try {
    const { count } = await p
    return count ?? 0
  } catch {
    return 0
  }
}

/**
 * Per-channel touch counts. Each helper queries one source table; the engine
 * sums them. Best-effort — a missing/empty source returns 0 rather than throwing.
 */
async function countEmailTouches(svc: Svc, brokerageId: string, contactId: string, since: string): Promise<number> {
  let n = 0
  n += await safeCount(svc.from("email_sends").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).gte("sent_at", since))
  n += await safeCount(svc.from("isa_outreach_log").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("channel", "email").gte("sent_at", since))
  n += await safeCount(svc.from("marketing_campaign_touchpoints").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("channel", "email").gte("sent_at", since))
  n += await safeCount(svc.from("lifetime_customer_touchpoints").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("channel", "email").gte("created_at", since))
  return n
}

async function countSmsTouches(svc: Svc, brokerageId: string, contactId: string, since: string): Promise<number> {
  let n = 0
  n += await safeCount(svc.from("isa_outreach_log").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("channel", "sms").gte("sent_at", since))
  n += await safeCount(svc.from("marketing_campaign_touchpoints").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("channel", "sms").gte("sent_at", since))
  n += await safeCount(svc.from("lifetime_customer_touchpoints").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("channel", "sms").gte("created_at", since))
  return n
}

async function countPhoneTouches(svc: Svc, brokerageId: string, contactId: string, since: string): Promise<number> {
  return safeCount(svc.from("isa_outreach_log").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("channel", "phone").gte("sent_at", since))
}

async function countMailTouches(svc: Svc, brokerageId: string, contactId: string, since: string): Promise<number> {
  let n = 0
  n += await safeCount(svc.from("direct_mail_recipients").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).gte("mailed_at", since))
  n += await safeCount(svc.from("marketing_campaign_touchpoints").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("channel", "mail").gte("sent_at", since))
  n += await safeCount(svc.from("lifetime_customer_touchpoints").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("channel", "mail").gte("created_at", since))
  return n
}

async function countVideoTouches(svc: Svc, brokerageId: string, contactId: string, since: string): Promise<number> {
  let n = 0
  n += await safeCount(svc.from("marketing_campaign_touchpoints").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("channel", "video").gte("sent_at", since))
  n += await safeCount(svc.from("lifetime_customer_touchpoints").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("channel", "video").gte("created_at", since))
  return n
}

// ─── Broadcast (1:many) frequency cap ───────────────────────────────────────
// Counts brokerage-wide broadcast sends per channel + optional segment in the
// trailing window. Used by the newsletter publisher cron and the future
// Brand/Listing Orchestrator agent. Same audit table — outcome flips to
// 'suppressed_cooldown' so the cockpit can distinguish per-contact over-touch
// from brokerage-wide cooldown.

export type BroadcastChannel = "newsletter" | "social_post" | "blog" | "ad"

interface BroadcastPolicy {
  /** Max sends in window across the brokerage (or the segment when supplied). */
  maxSends:    number
  windowDays:  number
}

const BROADCAST_POLICY: Record<BroadcastChannel, BroadcastPolicy> = {
  newsletter:  { maxSends: 1, windowDays: 7  },
  social_post: { maxSends: 3, windowDays: 1  },
  blog:        { maxSends: 2, windowDays: 7  },
  ad:          { maxSends: 5, windowDays: 7  },
}

export interface BroadcastDeconflictInput {
  brokerageId:  string
  channel:      BroadcastChannel
  /** When supplied, the cap is per-segment instead of brokerage-wide
   *  (e.g. one newsletter per segment per week, not per brokerage). */
  segment?:     string | null
  systemSource?: string
  policyOverride?: Partial<BroadcastPolicy>
  skipLog?:     boolean
}

export interface BroadcastDeconflictDecision {
  allowed:     boolean
  reason?:     string
  sendsInWindow: number
  policyMax:   number
  windowDays:  number
}

export async function evaluateBroadcastDeconflict(
  input: BroadcastDeconflictInput,
): Promise<BroadcastDeconflictDecision> {
  const svc    = createServiceClient()
  const policy = { ...BROADCAST_POLICY[input.channel], ...(input.policyOverride ?? {}) }
  const since  = new Date(Date.now() - policy.windowDays * 86_400_000).toISOString()

  let sends = 0
  try {
    if (input.channel === "newsletter") {
      let q = svc
        .from("newsletter_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", input.brokerageId)
        .eq("status", "sent")
        .gte("send_date", since)
      // Segment-scoped counting used to join through the legacy `newsletters`
      // table's audience_segment — but that table has NO writer, so the branch
      // could never match and only masked the brokerage-wide cap (burn-down
      // round 3: dead branch removed; the brokerage-wide count IS the cap
      // until newsletter_campaigns carries a segment dimension).
      const { count } = await q
      sends = count ?? 0
    } else if (input.channel === "social_post") {
      const { count } = await svc
        .from("social_posts")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", input.brokerageId)
        .eq("status", "published")
        .gte("published_at", since)
      sends = count ?? 0
    } else if (input.channel === "blog") {
      const { count } = await svc
        .from("blog_posts")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", input.brokerageId)
        .eq("publish_status", "published")
        .gte("published_at", since)
      sends = count ?? 0
    }
    // ad has no canonical platform-side log we own; orchestrator passes
    // policyOverride / skipLog when bidding against external campaigns.
  } catch { /* best-effort */ }

  const allowed = sends < policy.maxSends
  const decision: BroadcastDeconflictDecision = {
    allowed,
    reason: allowed
      ? undefined
      : `Broadcast cooldown: ${sends} ${input.channel} sends in last ${policy.windowDays}d ≥ policy max ${policy.maxSends}` +
        (input.segment ? ` (segment=${input.segment})` : ""),
    sendsInWindow: sends,
    policyMax:     policy.maxSends,
    windowDays:    policy.windowDays,
  }

  if (!input.skipLog) {
    try {
      await svc.from("deconflict_suppression_log").insert({
        brokerage_id:      input.brokerageId,
        contact_id:        null,
        channel:           input.channel, // m116 widened the check constraint
        system_source:     input.systemSource ?? null,
        outcome:           allowed ? "allowed" : "suppressed_cooldown",
        reason:            decision.reason ?? null,
        touches_in_window: sends,
        window_days:       policy.windowDays,
        policy_max:        policy.maxSends,
        metadata:          { broadcast_channel: input.channel, segment: input.segment ?? null },
      })
    } catch { /* never fail a send because audit hiccuped */ }
  }

  return decision
}

async function countTouchesByChannel(
  svc:  Svc,
  args: { brokerageId: string; contactId: string; channel: DeconflictChannel; since: string },
): Promise<number> {
  switch (args.channel) {
    case "email": return countEmailTouches(svc, args.brokerageId, args.contactId, args.since)
    case "sms":   return countSmsTouches  (svc, args.brokerageId, args.contactId, args.since)
    case "phone": return countPhoneTouches(svc, args.brokerageId, args.contactId, args.since)
    case "mail":  return countMailTouches (svc, args.brokerageId, args.contactId, args.since)
    case "video": return countVideoTouches(svc, args.brokerageId, args.contactId, args.since)
  }
}

/** Count a LEAD's recent touches on one channel from isa_outreach_log (the lead-side ledger).
 *  Leads have no contacts row, so the per-contact sources don't see them — this gives an
 *  unconverted lead the SAME over-touch protection a contact gets. */
async function countLeadTouchesByChannel(
  svc:  Svc,
  args: { brokerageId: string; leadId: string; channel: DeconflictChannel; since: string },
): Promise<number> {
  return safeCount(svc.from("isa_outreach_log").select("id", { count: "exact", head: true })
    .eq("brokerage_id", args.brokerageId).eq("lead_id", args.leadId)
    .eq("channel", leadLogChannel(args.channel)).gte("sent_at", args.since))
}

/**
 * Evaluate whether sending one more outbound on `channel` would over-touch
 * the recipient. Writes one row to deconflict_suppression_log unless skipLog.
 *
 * If contactId is null we can't count per-contact touches, so we return allowed
 * (with a metadata note). The dispatch gates short-circuit on missing contactId
 * before calling here, so this path is uncommon.
 */
export async function evaluateDeconflict(input: DeconflictInput): Promise<DeconflictDecision> {
  const svc    = createServiceClient()
  let   policy = { ...DEFAULT_POLICY[input.channel], ...(input.policyOverride ?? {}) }

  // Self-tuning cadence (opt-in, best-effort, bounded). Adjusts ONLY the over-touch count from
  // recent engagement; the consent/opt-out/DNC/quiet-hours gates are separate and always apply.
  if (input.learn) {
    try {
      const signals = await getEngagementSignals(svc, input.brokerageId, input.channel, 30)
      policy = computeLearnedCadence(policy, signals).policy
    } catch { /* fail open to the base policy */ }
  }

  const since  = new Date(Date.now() - policy.windowDays * 86_400_000).toISOString()

  // Count touches by contact when promoted, else by lead — an unconverted lead gets the SAME
  // over-touch protection (counted from its isa_outreach_log ledger).
  const touches = input.contactId
    ? await countTouchesByChannel(svc, { brokerageId: input.brokerageId, contactId: input.contactId, channel: input.channel, since })
    : input.leadId
    ? await countLeadTouchesByChannel(svc, { brokerageId: input.brokerageId, leadId: input.leadId, channel: input.channel, since })
    : 0

  const allowed = touches < policy.maxTouches
  const decision: DeconflictDecision = {
    allowed,
    reason: allowed
      ? undefined
      : `Over-touch: ${touches} ${input.channel} touches in last ${policy.windowDays}d ≥ policy max ${policy.maxTouches}`,
    touchesInWindow: touches,
    policyMax:       policy.maxTouches,
    windowDays:      policy.windowDays,
  }

  if (!input.skipLog) {
    try {
      await svc.from("deconflict_suppression_log").insert({
        brokerage_id:      input.brokerageId,
        contact_id:        input.contactId ?? null,
        recipient_email:   input.recipientEmail ?? null,
        recipient_phone:   input.recipientPhone ?? null,
        channel:           input.channel,
        system_source:     input.systemSource ?? null,
        outcome:           allowed ? "allowed" : "suppressed_over_touch",
        reason:            decision.reason ?? null,
        touches_in_window: touches,
        window_days:       policy.windowDays,
        policy_max:        policy.maxTouches,
      })
    } catch { /* never fail a send because the audit write hiccuped */ }
  }

  return decision
}
