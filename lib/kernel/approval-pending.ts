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
 *   - podcast:     the auto-producer stages status='completed' (generation done)
 *                  + approval_status='pending_review' (auto-producer.ts:152-154);
 *                  the DISTRIBUTOR ships only status='completed' AND
 *                  approval_status='approved' (distribute-podcast-episodes cron).
 *                  So the review gate is approval_status; status='completed' is
 *                  the ready gate. Both surfaces now use the same two-column
 *                  predicate, and both approve via the ONE canonical transition
 *                  (applyMarketingAssetApproval) that also defaults
 *                  publish_channels — a bare approval_status patch would leave
 *                  channels empty and the distributor would never ship it.
 */

/** blog_posts.publish_status value that means "awaiting a human". */
export const BLOG_PENDING_PUBLISH_STATUS = "draft" as const

/**
 * newsletter_campaigns.approval_status values that mean "awaiting a human".
 *
 * This carried a second value, 'pending', described here as "the legacy manual
 * value". It is not legacy — the column's CHECK is
 * (draft | pending_review | approved | rejected), so 'pending' is a value the
 * column has never been able to hold and no row has ever carried. Every use of
 * this constant is a read filter, so the dead literal cost nothing at runtime;
 * it was documentation asserting a state that cannot exist, which is how the
 * next reader gets it wrong. Removed.
 */
export const NEWSLETTER_PENDING_APPROVAL_STATUSES = ["pending_review"] as const

/** ad_creative_variations.approval_status values that mean "awaiting a human"
 *  (a creative under review before any paid spend). */
export const AD_CREATIVE_PENDING_APPROVAL_STATUSES = ["draft", "pending_review"] as const

/**
 * video_snippets.approval_status value that means "awaiting a human".
 *
 * The column's CHECK is (draft | pending_review | approved | rejected) — there
 * is no 'pending'. video-repurposing.ts fixed its WRITERS onto 'pending_review'
 * and documented 'pending' as schema drift, but every READER was left behind:
 * the /approvals aggregator and the manager stale-item sweep both filtered
 * 'pending', which the column can never hold. The filter returned zero rows
 * forever, so no generated snippet ever reached the approval rail and the queue
 * read as "nothing to review". Pinned here so the readers and the writers share
 * one value.
 */
export const VIDEO_SNIPPET_PENDING_APPROVAL_STATUS = "pending_review" as const

/**
 * blog_posts.publish_status after a human REJECTS the post (m296 — the column
 * did not admit this value, so rejection silently left the post at 'draft',
 * which is BLOG_PENDING_PUBLISH_STATUS: still queued and still publishable).
 */
export const BLOG_REJECTED_PUBLISH_STATUS = "rejected" as const

/** podcast_episodes: the READY gate (generation complete). */
export const PODCAST_PENDING_STATUS = "completed" as const
/** podcast_episodes: the REVIEW gate (awaiting a human release). The distributor
 *  ships only when this is 'approved', so this — not status — is the approval
 *  column both surfaces must key on. */
export const PODCAST_PENDING_APPROVAL_STATUS = "pending_review" as const
