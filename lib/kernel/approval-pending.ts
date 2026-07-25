/**
 * lib/kernel/approval-pending.ts
 *
 * THE SINGLE SOURCE OF TRUTH for "which status means awaiting-a-human" on the
 * content types that appear in BOTH approval surfaces:
 *   - Aggregator A — lib/kernel/approval-queue-aggregator.ts  (/approvals, agent view)
 *   - Aggregator B — lib/kernel/approval-sources.ts CONTENT_SOURCES (Command Center)
 *
 * The two surfaces are kept separate on purpose (different audiences + different
 * source sets), but they overlap on a handful of content types — and their
 * pending-status filters had drifted, so the SAME item could appear in one queue
 * and not the other. These constants exist so a pending filter can never diverge
 * again: both aggregators import the same predicate values from here.
 *
 * Verified against the producers (lib/kernel/marketing.ts) + live data (2026-07):
 *   - blog:        the stager writes publish_status='draft' (marketing.ts:724);
 *                  the publish cron ships 'published'. 'draft' is pending.
 *   - newsletter:  the AI stager writes approval_status='pending_review'
 *                  (marketing.ts:218); 'pending' is the legacy manual value.
 *                  Both are awaiting a human.
 *   - ad_creative: creatives sit at 'draft' or 'pending_review' before any spend.
 *
 * NOT covered here yet (deliberately): podcast_episodes — the two surfaces use
 * DIFFERENT columns (A: approval_status='pending_review'; B: status='completed')
 * and there is no live episode data to verify the correct canonical filter
 * against. Reconciling it needs its own careful pass with real data, so it is
 * left untouched rather than guessed at.
 */

/** blog_posts.publish_status value that means "awaiting a human". */
export const BLOG_PENDING_PUBLISH_STATUS = "draft" as const

/** newsletter_campaigns.approval_status values that mean "awaiting a human"
 *  ('pending' = legacy manual, 'pending_review' = AI stager). */
export const NEWSLETTER_PENDING_APPROVAL_STATUSES = ["pending", "pending_review"] as const

/** ad_creative_variations.approval_status values that mean "awaiting a human"
 *  (a creative under review before any paid spend). */
export const AD_CREATIVE_PENDING_APPROVAL_STATUSES = ["draft", "pending_review"] as const
