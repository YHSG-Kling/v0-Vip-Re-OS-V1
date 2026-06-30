// ─── STUCK-SOCIAL-POST REAPER (Marketing Manager) ────────────────────────────
// Nothing-falls-through guard for the Marketing Manager: a social post that hung
// mid-publish gets reconciled (marked failed) and a scheduled post that missed its
// window gets escalated to its agent — so a planned post never silently dies in
// the scheduler. Mirrors the video/workflow reapers (scan → classify → reconcile/
// escalate). Pure policy in stuck-social-post-policy.ts.

import { createServiceClient } from "@/lib/supabase/service"
import { classifyStuckSocialPost } from "./stuck-social-post-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface StuckSocialPostReapResult {
  scanned: number
  escalated: number
  reaped: number
}

// social_posts.agent_id may be an agents.id; resolve to its users.id for the
// notification recipient, falling back to the raw value if it's already a user id.
async function resolvePostUserId(svc: Svc, agentId: string | null): Promise<string | null> {
  if (!agentId) return null
  const { data } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  return (data as { user_id?: string | null } | null)?.user_id ?? agentId
}

export async function reapStuckSocialPosts(
  brokerageId: string,
  client?: Svc,
  opts?: { now?: Date; limit?: number },
): Promise<StuckSocialPostReapResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: StuckSocialPostReapResult = { scanned: 0, escalated: 0, reaped: 0 }

  const { data: rows } = await svc
    .from("social_posts")
    .select("id, status, scheduled_for, published_at, updated_at, agent_id, platform")
    .eq("brokerage_id", brokerageId)
    .in("status", ["scheduled", "publishing"])
    .is("published_at", null)
    .limit(opts?.limit ?? 200)

  for (const row of (rows ?? []) as Array<{
    id: string; status: string | null; scheduled_for: string | null
    published_at: string | null; updated_at: string | null; agent_id: string | null; platform: string | null
  }>) {
    result.scanned++
    const action = classifyStuckSocialPost({ status: row.status, scheduledFor: row.scheduled_for, updatedAt: row.updated_at, now })
    if (action === "keep") continue

    const platform = (row.platform ?? "social").toString()

    if (action === "reap") {
      // Hung mid-publish — reconcile to failed so it stops sitting + the agent can retry.
      const { error } = await svc.from("social_posts")
        .update({ status: "failed", error_message: "stalled in 'publishing' — reaped by the Marketing Manager", updated_at: now.toISOString() })
        .eq("id", row.id).eq("status", "publishing")
      if (error) continue
      result.reaped++
      const userId = await resolvePostUserId(svc, row.agent_id)
      if (userId) {
        await svc.from("notifications").insert({
          user_id: userId, brokerage_id: brokerageId, type: "social_post_stalled",
          title: "A scheduled post got stuck publishing",
          body: `Your ${platform} post hung while publishing and your AI team flagged it so it doesn't sit unfinished. You can re-queue it from your content calendar.`,
          entity_type: "social_post", entity_id: row.id, priority: "medium", is_read: false,
        }).then(() => {}, () => {})
      }
      continue
    }

    // escalate — a scheduled post missed its window. Idempotent per post.
    const { data: prior } = await svc.from("notifications")
      .select("id").eq("brokerage_id", brokerageId).eq("type", "social_post_missed")
      .eq("entity_id", row.id).eq("is_read", false).limit(1)
    if (prior && prior.length > 0) continue
    const userId = await resolvePostUserId(svc, row.agent_id)
    if (!userId) continue
    await svc.from("notifications").insert({
      user_id: userId, brokerage_id: brokerageId, type: "social_post_missed",
      title: "A scheduled post missed its time slot",
      body: `Your ${platform} post was scheduled to go out but never published — it may be waiting on approval or the scheduler skipped it. Re-queue or approve it so the content keeps flowing.`,
      entity_type: "social_post", entity_id: row.id, priority: "medium", is_read: false,
    })
    result.escalated++
  }

  return result
}
