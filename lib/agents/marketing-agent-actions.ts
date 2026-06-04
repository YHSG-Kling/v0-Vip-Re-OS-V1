/**
 * lib/agents/marketing-agent-actions.ts
 *
 * Wave 34 — conflict-resolution executor for the marketing agent. The
 * agent's weekly plan emits a `resolutions[]` array of structured actions
 * (Wave 33 prompt change). On human approval the platform fires each
 * action through a registered handler and records the outcome in
 * marketing_agent_actions (m143).
 *
 * Each handler is:
 *   · idempotent — re-running on the same input is safe
 *   · gated — respects the same Wave 26-29 policy / cooldown / compliance
 *     gates the manual paths use
 *   · audited — writes the result back to the ledger row so the admin UI
 *     can show "what the agent actually did this week"
 *
 * Handler registry — extending the surface in a future commit means
 * adding to ACTION_TYPES + writing the handler. The CHECK constraint
 * on m143's action_type column must be widened in the same migration.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type MarketingActionType =
  | "retry_listing_promo_render"
  | "mark_topic_used"
  | "defer_newsletter_campaign"
  | "stage_newsletter_draft"

export interface ProposedAction {
  action_type: MarketingActionType
  action_input: Record<string, unknown>
  rationale?:  string
}

export interface ActionHandlerResult {
  status: "succeeded" | "failed" | "skipped"
  result: Record<string, unknown>
}

/** Persist proposed actions for a freshly-completed agent session. The
 *  marketing-agent's plan output is parsed elsewhere; this just records
 *  the actions in the ledger so the human approval UI can read them. */
export async function recordProposedActions(args: {
  brokerageId:           string
  managedAgentSessionId: string | null
  actions:               ProposedAction[]
}): Promise<{ inserted: number }> {
  if (args.actions.length === 0) return { inserted: 0 }
  const svc = createServiceClient()
  const rows = args.actions.map((a) => ({
    brokerage_id:             args.brokerageId,
    managed_agent_session_id: args.managedAgentSessionId,
    action_type:              a.action_type,
    action_input:             a.action_input,
    rationale:                a.rationale ?? null,
  }))
  const { data, error } = await svc.from("marketing_agent_actions")
    .insert(rows)
    .select("id")
  if (error) {
    console.error("[marketing-agent-actions] record failed:", error.message)
    return { inserted: 0 }
  }
  return { inserted: data?.length ?? 0 }
}

/** Execute a proposed action — called by the approval server action
 *  after the human clicks approve. Updates the ledger row with the
 *  outcome and returns the result. */
export async function executeAction(actionId: string, approverUserId: string): Promise<ActionHandlerResult> {
  const svc = createServiceClient()

  // Claim the row — flip proposed/approved → executing atomically so
  // concurrent approve clicks don't double-fire.
  const { data: claimed } = await svc.from("marketing_agent_actions")
    .update({
      status:      "executing",
      approved_at: new Date().toISOString(),
      approved_by: approverUserId,
      executed_at: new Date().toISOString(),
    })
    .eq("id", actionId)
    .in("status", ["proposed", "approved"])
    .select("brokerage_id, action_type, action_input")
    .single()
  if (!claimed) {
    return { status: "skipped", result: { reason: "row not in proposed/approved state" } }
  }
  const row = claimed as { brokerage_id: string; action_type: MarketingActionType; action_input: Record<string, unknown> }

  let outcome: ActionHandlerResult
  try {
    outcome = await runHandler(row.action_type, row.brokerage_id, row.action_input)
  } catch (e) {
    outcome = { status: "failed", result: { error: (e as Error).message } }
  }
  await svc.from("marketing_agent_actions")
    .update({ status: outcome.status, result: outcome.result })
    .eq("id", actionId)
  return outcome
}

async function runHandler(
  action: MarketingActionType,
  brokerageId: string,
  input: Record<string, unknown>,
): Promise<ActionHandlerResult> {
  switch (action) {
    case "retry_listing_promo_render": {
      // Re-trigger the listing-promo reactor for a stuck render. Bypasses
      // the policy auto_spawn check (the agent's proposed resolution is
      // human-approved at this point) but cooldown still applies as a
      // safety net against double-fire.
      const listingId = String(input.listing_id ?? "")
      const eventType = String(input.event_type ?? "")
      if (!listingId || !eventType) {
        return { status: "failed", result: { error: "listing_id and event_type required" } }
      }
      const svc = createServiceClient()
      const { data: listing } = await svc.from("listings")
        .select("agent_id, brokerage_id")
        .eq("id", listingId)
        .maybeSingle()
      const l = listing as { agent_id: string | null; brokerage_id: string | null } | null
      if (!l || l.brokerage_id !== brokerageId) {
        return { status: "failed", result: { error: "listing not found or tenant mismatch" } }
      }
      if (!l.agent_id) return { status: "failed", result: { error: "listing has no assigned agent" } }
      const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
      const agentUserId = await resolveAgentRecordToUserId(l.agent_id)
      if (!agentUserId) return { status: "failed", result: { error: "agent user id unresolved" } }
      const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
      const r = await dispatchListingPromoVideo({
        brokerageId,
        listingId,
        agentUserId,
        eventType:    eventType as Parameters<typeof dispatchListingPromoVideo>[0]["eventType"],
        bypassPolicy: true,
      })
      return { status: r.ok ? "succeeded" : "failed", result: { dispatch_status: r.status, reason: r.reason ?? null } }
    }

    case "mark_topic_used": {
      // Flip a content_topic_bank row to status='used' so the picker
      // skips it for the rest of the cycle. The agent uses this to
      // resolve "two channels would pick the same topic this week"
      // conflicts.
      const topicId = String(input.topic_id ?? "")
      if (!topicId) return { status: "failed", result: { error: "topic_id required" } }
      const svc = createServiceClient()
      const { error, count } = await svc.from("content_topic_bank")
        .update({ status: "used" }, { count: "exact" })
        .eq("id", topicId)
        .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
      if (error) return { status: "failed", result: { error: error.message } }
      if ((count ?? 0) === 0) return { status: "skipped", result: { reason: "topic not found or tenant mismatch" } }
      return { status: "succeeded", result: { topic_id: topicId, marked: count } }
    }

    case "defer_newsletter_campaign": {
      // Move a scheduled campaign to status='deferred' with a reason
      // the marketing-agent supplied (Wave 21 composition gate already
      // writes this same defer_reason shape — m132). Used to resolve
      // "two newsletter campaigns scheduled within the de-conflict
      // cooldown" conflicts.
      const campaignId = String(input.campaign_id ?? "")
      const reason     = String(input.reason ?? "agent_resolution")
      if (!campaignId) return { status: "failed", result: { error: "campaign_id required" } }
      const svc = createServiceClient()
      const { error, count } = await svc.from("newsletter_campaigns")
        .update({ status: "deferred", defer_reason: `agent:${reason}` }, { count: "exact" })
        .eq("id", campaignId)
        .eq("brokerage_id", brokerageId)
        .eq("status", "scheduled")
      if (error) return { status: "failed", result: { error: error.message } }
      if ((count ?? 0) === 0) return { status: "skipped", result: { reason: "campaign not scheduled or tenant mismatch" } }
      return { status: "succeeded", result: { campaign_id: campaignId, deferred: true } }
    }

    case "stage_newsletter_draft": {
      // The agent's plan proposed a specific newsletter for the week —
      // stage it as a draft via the canonical staging path. Doesn't
      // publish; lands in the approval queue at draft status so the
      // human can review the AI-generated content before send.
      const title       = String(input.title ?? "")
      const subjectLine = String(input.subject_line ?? input.title ?? "")
      const audience    = String(input.audience ?? "all")
      const topic       = String(input.topic ?? "")
      if (!title || !topic) return { status: "failed", result: { error: "title and topic required" } }
      try {
        const { stageNewsletterDraft } = await import("@/lib/wizard-staging/content-staging")
        // The agent didn't authenticate as a user — pass null and let
        // the staging action handle the system-actor case (it does).
        const svc = createServiceClient()
        const { data: broker } = await svc.from("users")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle()
        const brokerUserId = (broker?.id as string | undefined) ?? null
        if (!brokerUserId) return { status: "failed", result: { error: "no broker user to attribute draft to" } }
        const r = await stageNewsletterDraft(
          { userId: brokerUserId, brokerageId },
          { title, subjectLine, topic, audience },
        )
        return r.success
          ? { status: "succeeded", result: { draft_id: r.draftId ?? null, open_url: r.openUrl ?? null } }
          : { status: "failed", result: { error: r.error ?? "stage failed" } }
      } catch (e) {
        return { status: "failed", result: { error: (e as Error).message } }
      }
    }

    default: {
      // Exhaustiveness — TS catches at compile time; this is the runtime
      // belt for any future action_type added to the CHECK without a
      // handler.
      const _exhaustive: never = action
      void _exhaustive
      return { status: "failed", result: { error: "unknown action_type" } }
    }
  }
}
