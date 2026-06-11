// lib/kernel/marketing-bench.ts
//
// THE MARKETING BENCH — one primitive that stages a coordinated draft across EVERY
// channel the OS owns, each gated and idempotent. Until now every play hand-rolled its
// own social/mail insert; this consolidates the channel-staging so a play just says
// "stage these drafts across social, email, newsletter, blog, and direct mail" and the
// bench handles each table's real CHECK constraints, ID-space (agents.id vs users.id),
// and approval state. Nothing here sends — every row lands in its channel's pending /
// draft state for the human to approve.
//
// ID-SPACE (verified against the live FKs):
//   · social_posts.agent_id, newsletter_campaigns.agent_id, direct_mail_campaigns
//     .agent_id, open_houses.agent_id  → agents.id   (agentRowId)
//   · blog_posts.agent_user_id, podcast_episodes.agent_id → users.id  (agentUserId)
//   · email_campaigns.agent_id → no FK (agents.id by convention)
//
// NOT server-only (simulator-driven).

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export type BenchChannel = "social" | "email" | "newsletter" | "blog" | "direct_mail"

export interface BenchDraft {
  channel: BenchChannel
  /** Deterministic name/title used as the idempotency key for name-keyed channels. */
  idemName: string
  subject: string
  body: string
  /** social only — must satisfy social_posts.post_type CHECK. */
  socialPostType?: "new_listing" | "coming_soon" | "open_house_announcement" | "price_reduction" | "just_sold" | "market_update" | "custom"
  /** direct_mail only — target_audience tag (no CHECK; free text). */
  mailAudience?: string
  /** the brief/rationale recorded on the row (why the bench staged it). */
  brief: string
}

export interface BenchContext {
  brokerageId: string
  /** agents.id — for social / newsletter / direct_mail / email. */
  agentRowId: string | null
  /** users.id — for blog. */
  agentUserId: string | null
  /** optional listing the drafts are about. */
  listingId?: string | null
}

export interface StageBenchResult { staged: BenchChannel[]; skipped: BenchChannel[] }

/** Stage one draft into its channel, gated + idempotent. Returns whether it was created. */
async function stageOne(supabase: Svc, ctx: BenchContext, d: BenchDraft): Promise<boolean> {
  switch (d.channel) {
    case "social": {
      if (!ctx.listingId) return false
      const { data: exists } = await supabase.from("social_posts").select("id")
        .eq("listing_id", ctx.listingId).eq("post_type", d.socialPostType ?? "custom")
        .gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString()).limit(1).maybeSingle()
      if (exists) return false
      const { error } = await supabase.from("social_posts").insert({
        brokerage_id: ctx.brokerageId, listing_id: ctx.listingId, agent_id: ctx.agentRowId,
        platform: "all", post_type: d.socialPostType ?? "custom", content: d.body,
        status: "draft", approval_status: "pending", ai_generated: true, post_brief: d.brief,
      })
      return !error
    }
    case "email": {
      const { data: exists } = await supabase.from("email_campaigns").select("id")
        .eq("brokerage_id", ctx.brokerageId).eq("campaign_name", d.idemName).limit(1).maybeSingle()
      if (exists) return false
      const { error } = await supabase.from("email_campaigns").insert({
        brokerage_id: ctx.brokerageId, agent_id: ctx.agentRowId, campaign_name: d.idemName,
        subject_line: d.subject, content: d.body, campaign_format: "one_off",
        status: "draft", approval_status: "pending",
      })
      return !error
    }
    case "newsletter": {
      const { data: exists } = await supabase.from("newsletter_campaigns").select("id")
        .eq("brokerage_id", ctx.brokerageId).eq("campaign_name", d.idemName).limit(1).maybeSingle()
      if (exists) return false
      const { error } = await supabase.from("newsletter_campaigns").insert({
        brokerage_id: ctx.brokerageId, agent_id: ctx.agentRowId, campaign_name: d.idemName,
        subject_line: d.subject, content: d.body,
        status: "draft", approval_status: "pending_review", is_ai_generated: true,
      })
      return !error
    }
    case "blog": {
      const { data: exists } = await supabase.from("blog_posts").select("id")
        .eq("brokerage_id", ctx.brokerageId).eq("title", d.idemName).limit(1).maybeSingle()
      if (exists) return false
      const { error } = await supabase.from("blog_posts").insert({
        brokerage_id: ctx.brokerageId, agent_user_id: ctx.agentUserId, title: d.idemName,
        excerpt: d.subject, content: d.body, category: "market",
        publish_status: "pending_review", publish_target: "hosted", visibility_scope: "brokerage",
        approval_status: "pending", is_ai_generated: true,
      })
      return !error
    }
    case "direct_mail": {
      const { data: exists } = await supabase.from("direct_mail_campaigns").select("id")
        .eq("brokerage_id", ctx.brokerageId).eq("campaign_name", d.idemName).limit(1).maybeSingle()
      if (exists) return false
      const { error } = await supabase.from("direct_mail_campaigns").insert({
        brokerage_id: ctx.brokerageId, agent_id: ctx.agentRowId, campaign_name: d.idemName,
        target_audience: d.mailAudience ?? "farm", piece_type: "postcard", copy_text: d.body,
        is_ai_generated: true, approval_status: "pending", status: "planning",
      })
      return !error
    }
  }
}

/**
 * Stage a batch of channel drafts (gated + idempotent). Returns which channels were
 * newly created vs skipped (already staged / not applicable).
 */
export async function stageBenchDrafts(
  ctx: BenchContext, drafts: BenchDraft[], client?: Svc,
): Promise<StageBenchResult> {
  const supabase = client ?? createServiceClient()
  const staged: BenchChannel[] = []
  const skipped: BenchChannel[] = []
  for (const d of drafts) {
    const ok = await stageOne(supabase, ctx, d).catch(() => false)
    if (ok) staged.push(d.channel)
    else skipped.push(d.channel)
  }
  return { staged, skipped }
}
