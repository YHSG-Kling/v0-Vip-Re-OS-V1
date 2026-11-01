/**
 * lib/social/create-social-post-draft.ts — THE social-post draft writer with an EXPLICIT actor (wave 148 integrator).
 *
 * Extracted from app/actions/social-publishing.ts createSocialPost, which is the session door around this function: the action
 * resolves the caller from the cookie session and revalidates the studio paths; everything that decides and writes lives here.
 * It exists because the orchestrator (lib/orchestrator/internal.ts) drafted posts for finished videos and images by calling the
 * SERVER ACTION — a session-bound door from an event handler that has no session, so every autonomous draft was refused as
 * "Unauthorized" while the handler logged a success — and because a lib hub importing an app action put the whole action module
 * on every page's graph (scripts/proxy-graph-budget-guard.ts). The actor is the event's own (agent_user_id / event.user_id) and
 * the tenant the event's brokerage, never a request body.
 *
 * The compliance gate is unchanged: a failing gate HOLDS the post (status draft, approval pending, brand_compliance_passed false);
 * a passing one schedules it, pending human approval when the gate asks or the caller forces it.
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { runComplianceGate } from "@/lib/kernel/marketing/real-estate-compliance-gate"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"

export interface SocialPostDraftParams {
  content: string
  mediaUrls?: string[]
  mediaTypes?: string[]
  hashtags?: string[]
  scheduledFor: string
  platforms: string[]
  contentType?: string
  linkedListingId?: string
  generatedByAi?: boolean
  aiPrompt?: string
  /** Force human review (approval_status='pending') regardless of the compliance gate — autonomous posters. */
  forceApprovalPending?: boolean
  /** social_accounts.id this post is scheduled through, when the caller already knows which connected account to use. */
  socialAccountId?: string
}

export type SocialPostDraftResult =
  | { success: false; complianceBlocked: true; violations: Array<{ rule: string } & Record<string, unknown>>; draftPostId: string | null; message: string }
  | Record<string, unknown>

export async function createSocialPostDraft(
  supabase: SupabaseClient,
  actor: { userId: string; brokerageId: string },
  params: SocialPostDraftParams,
): Promise<SocialPostDraftResult> {
  // agent_id (nullable — a non-agent staffer, e.g. broker_admin, may post).
  const agentId = await resolveAgentIdInBrokerage(supabase, actor.userId, actor.brokerageId)

  // Compliance gate — hard stop if content violates real-estate rules
  const gate = await runComplianceGate({
    content: params.content,
    brokerageId: actor.brokerageId,
    authorUserId: actor.userId,
    contentType: (params.contentType as never) ?? ("social_post" as never),
    platforms: params.platforms,
  })

  const row = {
    user_id: actor.userId,
    agent_id: agentId,
    brokerage_id: actor.brokerageId,
    content: params.content,
    media_urls: params.mediaUrls ?? [],
    hashtags: params.hashtags ?? [],
    scheduled_for: params.scheduledFor,
    platform: params.platforms?.[0] ?? "facebook",
    post_type: params.contentType ?? "custom",
    listing_id: params.linkedListingId ?? null,
    social_account_id: params.socialAccountId ?? null,
    ai_generated: params.generatedByAi ?? false,
    post_brief: params.aiPrompt ?? null,
  }

  if (!gate.passed) {
    const { data: draftPost, error: draftPostErr } = await supabase
      .from("social_posts")
      .insert({ ...row, status: "draft", brand_compliance_passed: false, approval_status: "pending" })
      .select("id")
      .maybeSingle()
    if (draftPostErr) console.error(`[social-publishing] held draft post NOT saved: ${draftPostErr.message}`)
    return {
      success: false,
      complianceBlocked: true,
      violations: gate.violations as Array<{ rule: string } & Record<string, unknown>>,
      draftPostId: (draftPost as { id?: string } | null)?.id ?? null,
      message: `Content held for compliance review: ${gate.violations.map((v) => v.rule).join(", ")}`,
    }
  }

  const { data, error } = await supabase
    .from("social_posts")
    .insert({
      ...row,
      status: "scheduled",
      brand_compliance_passed: true,
      approval_status: params.forceApprovalPending || gate.requiresHumanReview ? "pending" : "approved",
    })
    .select()
    .maybeSingle()
  if (error) throw error
  return (data ?? {}) as Record<string, unknown>
}
