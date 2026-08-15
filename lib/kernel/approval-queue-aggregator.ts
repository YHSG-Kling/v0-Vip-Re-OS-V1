/**
 * Approval Queue Aggregator — single source for the agent's daily review queue.
 *
 * Three approval data sources existed in parallel before this:
 *   1. approval_items table (empty — nothing inserts into it)
 *   2. activities with activity_type='content.approval' (compliance dashboard)
 *   3. per-content tables (newsletter_campaigns.approval_status, etc.)
 *
 * This module unifies #1 + #3 (the #2 path stays on the compliance dashboard
 * for compliance-officer-specific workflows). The agent's /approvals page
 * sees one feed across newsletters, emails, ad creatives, video snippets,
 * and blog drafts.
 *
 * Each row carries a PREFIXED id encoding the source table so the approve/
 * reject endpoints can route the action back to the right column without
 * a schema migration.
 *
 * Prefix legend:
 *   nl:   newsletter_campaigns (approval_status pending)
 *   em:   email_campaigns      (approval_status pending)
 *   acv:  ad_creative_variations (approval_status draft — pre-launch review)
 *   vsn:  video_snippets       (approval_status pending)
 *   bp:   blog_posts           (publish_status draft)
 *   ai:   approval_items       (legacy table; no prefix when present)
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type ApprovalSource = "newsletter" | "email" | "ad_creative" | "video_snippet" | "blog" | "legacy"

export interface UnifiedApprovalItem {
  /** Prefixed id — nl:<uuid> / em:<uuid> / acv:<uuid> / vsn:<uuid> / bp:<uuid>
   *  or bare uuid for legacy approval_items. */
  id: string
  type: ApprovalSource
  agent_id: string | null
  status: string
  priority: "high" | "medium" | "standard"
  content: string
  created_at: string
  updated_at: string
}

const PER_TABLE_LIMIT = 50

export async function aggregatePendingApprovals(
  brokerageId: string,
  agentScopeId: string | null,
): Promise<UnifiedApprovalItem[]> {
  const svc = createServiceClient()

  // newsletter_campaigns.agent_id is agents.id (FK); blog_posts uses
  // agent_user_id (users.id). Filter applied conditionally — when the caller
  // is a broker/admin agentScopeId is null so they see brokerage-wide.
  const [newsletters, emails, adCreatives, videoSnippets, blogs, legacy] =
    await Promise.all([
      svc
        .from("newsletter_campaigns")
        .select("id, agent_id, campaign_name, subject_line, status, approval_status, created_at, updated_at")
        .eq("brokerage_id", brokerageId)
        .eq("approval_status", "pending")
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        .from("email_campaigns")
        .select("id, agent_id, campaign_name, subject_line, status, approval_status, created_at, updated_at")
        .eq("brokerage_id", brokerageId)
        .eq("approval_status", "pending")
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        .from("ad_creative_variations")
        .select("id, ad_campaign_id, variation_name, headline, primary_text, approval_status, created_at, updated_at")
        .eq("brokerage_id", brokerageId)
        .eq("approval_status", "draft")
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        .from("video_snippets")
        .select("id, created_by, snippet_title, caption_text, approval_status, created_at")
        .eq("brokerage_id", brokerageId)
        .eq("approval_status", "pending")
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        .from("blog_posts")
        .select("id, agent_user_id, title, excerpt, publish_status, created_at, updated_at")
        .eq("brokerage_id", brokerageId)
        .eq("publish_status", "draft")
        .order("created_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
      svc
        .from("approval_items")
        .select("id, agent_id, item_type, item_id, status, submitted_at, reviewed_at")
        .eq("brokerage_id", brokerageId)
        .eq("status", "pending")
        .order("submitted_at", { ascending: false })
        .limit(PER_TABLE_LIMIT),
    ])

  const items: UnifiedApprovalItem[] = []

  for (const row of (newsletters.data ?? []) as Array<Record<string, unknown>>) {
    if (agentScopeId && row.agent_id && row.agent_id !== agentScopeId) continue
    items.push({
      id: `nl:${String(row.id)}`,
      type: "newsletter",
      agent_id: (row.agent_id as string | null) ?? null,
      status: String(row.approval_status ?? "pending"),
      priority: "standard",
      content: `${String(row.campaign_name ?? "(untitled)")} — ${String(row.subject_line ?? "")}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (emails.data ?? []) as Array<Record<string, unknown>>) {
    if (agentScopeId && row.agent_id && row.agent_id !== agentScopeId) continue
    items.push({
      id: `em:${String(row.id)}`,
      type: "email",
      agent_id: (row.agent_id as string | null) ?? null,
      status: String(row.approval_status ?? "pending"),
      priority: "standard",
      content: `${String(row.campaign_name ?? "(untitled)")} — ${String(row.subject_line ?? "")}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (adCreatives.data ?? []) as Array<Record<string, unknown>>) {
    items.push({
      id: `acv:${String(row.id)}`,
      type: "ad_creative",
      agent_id: null, // ad creatives are scoped via ad_campaigns; future: join + check
      status: String(row.approval_status ?? "draft"),
      priority: "medium",
      content: `${String(row.variation_name ?? "(unnamed)")} — ${String(row.headline ?? "")}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (videoSnippets.data ?? []) as Array<Record<string, unknown>>) {
    // video_snippets uses created_by (users.id) — separate scope key.
    // No agent_id, snippet_title (not title), caption_text (not caption),
    // no updated_at column.
    if (agentScopeId && row.created_by && row.created_by !== agentScopeId) continue
    items.push({
      id: `vsn:${String(row.id)}`,
      type: "video_snippet",
      agent_id: (row.created_by as string | null) ?? null,
      status: String(row.approval_status ?? "pending"),
      priority: "standard",
      content: `${String(row.snippet_title ?? "(snippet)")} — ${String(row.caption_text ?? "")}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (blogs.data ?? []) as Array<Record<string, unknown>>) {
    // blog uses agent_user_id (users.id) — separate scope key
    items.push({
      id: `bp:${String(row.id)}`,
      type: "blog",
      agent_id: (row.agent_user_id as string | null) ?? null,
      status: String(row.publish_status ?? "draft"),
      priority: "standard",
      content: `${String(row.title ?? "(untitled)")} — ${String(row.excerpt ?? "")}`.trim(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
    })
  }

  for (const row of (legacy.data ?? []) as Array<Record<string, unknown>>) {
    if (agentScopeId && row.agent_id && row.agent_id !== agentScopeId) continue
    items.push({
      id: String(row.id), // bare uuid — no prefix
      type: "legacy",
      agent_id: (row.agent_id as string | null) ?? null,
      status: String(row.status ?? "pending"),
      priority: "standard",
      content: `${String(row.item_type ?? "approval")} — ${String(row.item_id ?? "")}`.trim(),
      created_at: String(row.submitted_at ?? new Date().toISOString()),
      updated_at: String(row.reviewed_at ?? row.submitted_at ?? new Date().toISOString()),
    })
  }

  // Sort newest first across all sources
  return items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
}

// ─── Dispatch approve / reject by prefix ─────────────────────────────────────

export type CascadeOutcome =
  | { success: true; type: ApprovalSource; targetId: string }
  | { success: false; error: string }

interface CascadeContext {
  brokerageId: string
  agentScopeId: string | null
  reviewerUserId: string
  notes?: string
}

/** Route an approve action to the right source table based on the prefixed id. */
export async function cascadeApprove(
  prefixedId: string,
  ctx: CascadeContext,
): Promise<CascadeOutcome> {
  return cascade(prefixedId, "approved", ctx)
}

/** Route a reject action to the right source table based on the prefixed id. */
export async function cascadeReject(
  prefixedId: string,
  ctx: CascadeContext,
): Promise<CascadeOutcome> {
  return cascade(prefixedId, "rejected", ctx)
}

async function cascade(
  prefixedId: string,
  outcome: "approved" | "rejected",
  ctx: CascadeContext,
): Promise<CascadeOutcome> {
  const svc = createServiceClient()
  const colonIdx = prefixedId.indexOf(":")
  const prefix = colonIdx > 0 ? prefixedId.slice(0, colonIdx) : ""
  const targetId = colonIdx > 0 ? prefixedId.slice(colonIdx + 1) : prefixedId

  if (!targetId) return { success: false, error: "Invalid id" }

  // Helper for per-content-table updates with brokerage scoping
  async function updateApprovalStatus(table: string, type: ApprovalSource) {
    let query = svc
      .from(table)
      .update({
        approval_status: outcome,
        updated_at: new Date().toISOString(),
      })
      .eq("id", targetId)
      .eq("brokerage_id", ctx.brokerageId)
    if (ctx.agentScopeId) query = query.eq("agent_id", ctx.agentScopeId)
    const { error } = await query
    if (error) return { success: false as const, error: error.message }
    return { success: true as const, type, targetId }
  }

  switch (prefix) {
    case "nl":
      return updateApprovalStatus("newsletter_campaigns", "newsletter")
    case "em":
      return updateApprovalStatus("email_campaigns", "email")
    case "acv": {
      // ad_creative_variations doesn't have agent_id; brokerage scope only
      const { error } = await svc
        .from("ad_creative_variations")
        .update({
          approval_status: outcome,
          updated_at: new Date().toISOString(),
        })
        .eq("id", targetId)
        .eq("brokerage_id", ctx.brokerageId)
      if (error) return { success: false, error: error.message }
      return { success: true, type: "ad_creative", targetId }
    }
    case "vsn": {
      // video_snippets uses created_by for scope (no agent_id), no updated_at.
      let q = svc
        .from("video_snippets")
        .update({ approval_status: outcome })
        .eq("id", targetId)
        .eq("brokerage_id", ctx.brokerageId)
      if (ctx.agentScopeId) q = q.eq("created_by", ctx.agentScopeId)
      const { error } = await q
      if (error) return { success: false, error: error.message }
      return { success: true, type: "video_snippet", targetId }
    }
    case "bp": {
      // blog_posts uses publish_status semantics: approved → publishable,
      // rejected → archive. No compliance_approved column in live schema.
      const newStatus = outcome === "approved" ? "approved" : "rejected"
      let q = svc
        .from("blog_posts")
        .update({
          publish_status: newStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", targetId)
        .eq("brokerage_id", ctx.brokerageId)
      if (ctx.agentScopeId) q = q.eq("agent_user_id", ctx.agentScopeId)
      const { error } = await q
      if (error) return { success: false, error: error.message }
      return { success: true, type: "blog", targetId }
    }
    case "": {
      // Bare uuid — legacy approval_items row
      let q = svc
        .from("approval_items")
        .update({
          status: outcome,
          reviewed_by: ctx.reviewerUserId,
          reviewed_at: new Date().toISOString(),
          review_notes: ctx.notes ?? null,
        })
        .eq("id", targetId)
        .eq("brokerage_id", ctx.brokerageId)
      if (ctx.agentScopeId) q = q.eq("agent_id", ctx.agentScopeId)
      const { error } = await q
      if (error) return { success: false, error: error.message }
      return { success: true, type: "legacy", targetId }
    }
    default:
      return { success: false, error: `Unknown approval id prefix: ${prefix}` }
  }
}
