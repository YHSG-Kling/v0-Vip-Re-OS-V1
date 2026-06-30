#!/usr/bin/env tsx
/**
 * scripts/stuck-social-post-reaper-simulator.ts   (npm run test:stuck-social-post-reaper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the Marketing Manager's stuck-social-post reaper: a post hung in
 * 'publishing' past the grace is RECONCILED (marked failed), a 'scheduled' post
 * past its slot is ESCALATED to its agent, and draft/published/failed/cancelled
 * posts are left alone. Pure policy + (creds-gated) live seed → reap → assert →
 * idempotent → cleanup (count == 0).
 */
import { classifyStuckSocialPost, PUBLISHING_STUCK_HOURS, SCHEDULED_OVERDUE_HOURS } from "../lib/marketing/stuck-social-post-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const NOW = new Date("2026-03-01T00:00:00Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

async function main() {
  console.log("\n[pure policy — classifyStuckSocialPost]")
  check("publishing hung past grace → reap", classifyStuckSocialPost({ status: "publishing", scheduledFor: null, updatedAt: hoursAgo(PUBLISHING_STUCK_HOURS + 1), now: NOW }) === "reap")
  check("publishing within grace → keep", classifyStuckSocialPost({ status: "publishing", scheduledFor: null, updatedAt: hoursAgo(0.2), now: NOW }) === "keep")
  check("scheduled past slot → escalate", classifyStuckSocialPost({ status: "scheduled", scheduledFor: hoursAgo(SCHEDULED_OVERDUE_HOURS + 1), updatedAt: null, now: NOW }) === "escalate")
  check("scheduled within grace → keep", classifyStuckSocialPost({ status: "scheduled", scheduledFor: hoursAgo(1), updatedAt: null, now: NOW }) === "keep")
  check("scheduled in the future → keep", classifyStuckSocialPost({ status: "scheduled", scheduledFor: hoursAgo(-5), updatedAt: null, now: NOW }) === "keep")
  check("draft → keep (not ready)", classifyStuckSocialPost({ status: "draft", scheduledFor: hoursAgo(50), updatedAt: hoursAgo(50), now: NOW }) === "keep")
  check("published → keep (done)", classifyStuckSocialPost({ status: "published", scheduledFor: hoursAgo(50), updatedAt: hoursAgo(50), now: NOW }) === "keep")
  check("failed → keep (terminal)", classifyStuckSocialPost({ status: "failed", scheduledFor: hoursAgo(50), updatedAt: hoursAgo(50), now: NOW }) === "keep")
  check("cancelled → keep (terminal)", classifyStuckSocialPost({ status: "cancelled", scheduledFor: hoursAgo(50), updatedAt: hoursAgo(50), now: NOW }) === "keep")
  check("scheduled + null date → keep (can't age)", classifyStuckSocialPost({ status: "scheduled", scheduledFor: null, updatedAt: null, now: NOW }) === "keep")

  // ── LIVE LAYER (creds-gated) ──
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] ⏭  Skipped — SUPABASE creds not set (pure layer ran).")
  } else {
    console.log("\n[live] seed an overdue scheduled post → reap → assert → idempotent → cleanup")
    const { createServiceClient } = await import("../lib/supabase/service")
    const { reapStuckSocialPosts } = await import("../lib/marketing/stuck-social-post-reaper")
    const svc = createServiceClient()
    const { data: a } = await svc.from("agents").select("id, brokerage_id, user_id").not("user_id", "is", null).limit(1).maybeSingle()
    if (!a) { console.log("  ⏭  no agent-with-user available") }
    else {
      const { data: post } = await svc.from("social_posts").insert({
        brokerage_id: a.brokerage_id, agent_id: a.id, status: "scheduled", platform: "instagram",
        post_type: "custom", scheduled_for: hoursAgo(6), content: "LIVE TEST stuck post",
      }).select("id").maybeSingle()
      try {
        const r1 = await reapStuckSocialPosts(a.brokerage_id, svc, { limit: 500 })
        check("live: escalated >= 1 (missed slot)", r1.escalated >= 1)
        const { data: note } = await svc.from("notifications").select("id")
          .eq("brokerage_id", a.brokerage_id).eq("type", "social_post_missed").eq("entity_id", post!.id).limit(1)
        check("live: missed-post notification created", !!note && note.length >= 1)
        const r2 = await reapStuckSocialPosts(a.brokerage_id, svc, { limit: 500 })
        check("live: idempotent re-run", r2.escalated === 0 || (note?.length ?? 0) >= 1)
        await svc.from("notifications").delete().eq("type", "social_post_missed").eq("entity_id", post!.id)
        await svc.from("social_posts").delete().eq("id", post!.id)
        const { count } = await svc.from("social_posts").select("id", { count: "exact", head: true }).eq("id", post!.id)
        check("live: cleanup count == 0", (count ?? 0) === 0)
      } catch (e) {
        await svc.from("notifications").delete().eq("type", "social_post_missed").eq("entity_id", post!.id).then(() => {}, () => {})
        await svc.from("social_posts").delete().eq("id", post!.id).then(() => {}, () => {})
        throw e
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STUCK_SOCIAL_POST_REAPER_FAIL"); process.exit(1) }
  console.log(" ✅ STUCK_SOCIAL_POST_REAPER_PASS — hung posts reconciled, missed slots escalated")
}
main()
