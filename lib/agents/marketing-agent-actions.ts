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
  | "cancel_blog_cadence_tick"
  | "flag_listing_for_review"
  // Wave 36 — direct-mail resolution surface.
  | "verify_lead_address"
  | "cancel_direct_mail_send"
  | "retry_direct_mail_design"
  | "flag_design_for_review"
  // Wave 36 self-learning capstone — omnipresence fanout.
  | "omnipresence_topic_fanout"
  // Wave 39 — start the seller-facing pre-listing presentation drip on demand.
  | "start_prelisting_drip"
  // Wave 39 gate 2 — review the finished product + RELEASE it to the seller.
  | "approve_prelisting_delivery"
  // Wave 48 — cross-manager handoff (listing active / deal closed → coordinated push).
  | "promote_new_listing"
  | "just_sold_campaign"
  // GEO remediation — regenerate a persistently-uncited landing page's FAQ from fresh demand topics.
  | "regenerate_faq"
  // Lead-source learning — turn ON proven winners / turn OFF money-pit scrape sources for a market.
  | "reallocate_lead_sources"

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
    outcome = await runHandler(row.action_type, row.brokerage_id, row.action_input, approverUserId)
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
  approverUserId?: string,
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

    case "cancel_blog_cadence_tick": {
      // Skip this week's blog auto-spawn for a given (scope_type, scope_id).
      // Writes blog_cadence_policy.skipped_until = end-of-this-week so the
      // cadence-tick cron's WHERE clause excludes the row for the remaining
      // days. The next week the field is in the past and the tick fires
      // normally — no policy mutation.
      const scopeType = String(input.scope_type ?? "")
      const scopeId   = String(input.scope_id ?? "")
      if (!["agent","team","brokerage"].includes(scopeType) || !scopeId) {
        return { status: "failed", result: { error: "scope_type ∈ (agent|team|brokerage) and scope_id required" } }
      }
      // Tenant scope check: the scope_id must belong to this brokerage.
      // For agent scope, the agents row must have brokerage_id = us; for
      // team scope same on teams; for brokerage scope the id IS us.
      const svc = createServiceClient()
      let belongs = false
      if (scopeType === "brokerage") {
        belongs = scopeId === brokerageId
      } else if (scopeType === "agent") {
        const { data } = await svc.from("agents").select("id").eq("id", scopeId).eq("brokerage_id", brokerageId).maybeSingle()
        belongs = !!data
      } else {
        const { data } = await svc.from("teams").select("id").eq("id", scopeId).eq("brokerage_id", brokerageId).maybeSingle()
        belongs = !!data
      }
      if (!belongs) return { status: "failed", result: { error: "scope not in tenant" } }

      // End-of-this-week = next Monday (UTC). The cadence cron is
      // day-of-week based; setting skipped_until to next Monday's date
      // covers every remaining tick this week.
      const now = new Date()
      const dayOfWeek = (now.getUTCDay() + 6) % 7   // Monday = 0
      const daysToNextMonday = 7 - dayOfWeek
      const nextMonday = new Date(now)
      nextMonday.setUTCDate(now.getUTCDate() + daysToNextMonday)
      nextMonday.setUTCHours(0, 0, 0, 0)
      const skipUntilDate = nextMonday.toISOString().slice(0, 10)

      const { error, count } = await svc.from("blog_cadence_policy")
        .update({ skipped_until: skipUntilDate }, { count: "exact" })
        .eq("scope_type", scopeType)
        .eq("scope_id", scopeId)
      if (error) return { status: "failed", result: { error: error.message } }
      if ((count ?? 0) === 0) return { status: "skipped", result: { reason: "no policy row for that scope" } }
      return { status: "succeeded", result: { skipped_until: skipUntilDate, scope_type: scopeType, scope_id: scopeId } }
    }

    case "flag_listing_for_review": {
      // Route a degraded listing asset to the broker's
      // automation_errors review queue. The platform's existing admin
      // observability already surfaces automation_errors entries —
      // reusing the queue means no new admin UI needed for the flag
      // itself.
      const listingId = String(input.listing_id ?? "")
      const reason    = String(input.reason ?? "marketing_agent_flag")
      if (!listingId) return { status: "failed", result: { error: "listing_id required" } }
      const svc = createServiceClient()
      // Tenant + existence check
      const { data: listing } = await svc.from("listings")
        .select("id, brokerage_id, address, city")
        .eq("id", listingId)
        .maybeSingle()
      const l = listing as { id: string; brokerage_id: string | null; address: string | null; city: string | null } | null
      if (!l) return { status: "failed", result: { error: "listing not found" } }
      if (l.brokerage_id !== brokerageId) return { status: "failed", result: { error: "tenant mismatch" } }

      const { data: errRow, error } = await svc.from("automation_errors").insert({
        brokerage_id:  brokerageId,
        workflow_name: "marketing_agent_listing_flag",
        error_message: `Marketing agent flagged listing for broker review: ${reason.slice(0, 200)}`,
        severity:      "warning",
        status:        "open",
        context_json:  {
          listing_id:      listingId,
          listing_address: [l.address, l.city].filter(Boolean).join(", "),
          agent_reason:    reason,
          flagged_at:      new Date().toISOString(),
        },
      }).select("id").single()
      if (error) return { status: "failed", result: { error: error.message } }
      return { status: "succeeded", result: { automation_error_id: errRow.id, listing_id: listingId } }
    }

    case "verify_lead_address": {
      // Wave 36 — re-run Lob US verification on a lead and write the
      // canonical mailing_address_verified flag. Used when a lead has
      // a populated mailing_address but the dispatch gate keeps
      // blocking it (the flag was set false by an earlier enrichment
      // pass before Lob saw the address).
      const leadId = String(input.lead_id ?? "")
      if (!leadId) return { status: "failed", result: { error: "lead_id required" } }
      const svc = createServiceClient()
      const { data: lead } = await svc.from("leads")
        .select("id, brokerage_id, mailing_address, mailing_city, mailing_state, mailing_zip")
        .eq("id", leadId)
        .maybeSingle()
      const l = lead as {
        id: string
        brokerage_id: string | null
        mailing_address: string | null
        mailing_city: string | null
        mailing_state: string | null
        mailing_zip: string | null
      } | null
      if (!l) return { status: "failed", result: { error: "lead not found" } }
      if (l.brokerage_id !== brokerageId) return { status: "failed", result: { error: "tenant mismatch" } }
      if (!l.mailing_address || !l.mailing_zip) {
        return { status: "failed", result: { error: "lead has no mailing_address/zip to verify" } }
      }

      const { verifyAddressViaLob } = await import("@/lib/external/lob-address-verify")
      const { data: result } = await verifyAddressViaLob({
        primary_line: l.mailing_address,
        city:         l.mailing_city ?? undefined,
        state:        l.mailing_state ?? undefined,
        zip_code:     l.mailing_zip,
      })
      if (!result) {
        return { status: "failed", result: { error: "Lob verification call failed (transient or unconfigured)" } }
      }

      // Write back the canonical flag + standardized parts so the next
      // dispatch attempt uses Lob's deliverability-correct values.
      const update: Record<string, unknown> = {
        mailing_address_verified: result.verified,
        mailing_address_source:   "marketing_agent_resolution",
      }
      if (result.verified && result.standardized.primary_line) {
        update.mailing_address = result.standardized.primary_line
      }
      if (result.standardized.city)     update.mailing_city  = result.standardized.city
      if (result.standardized.state)    update.mailing_state = result.standardized.state
      if (result.standardized.zip_code) update.mailing_zip   = result.standardized.zip_code
      await svc.from("leads").update(update).eq("id", leadId)

      return {
        status: result.verified ? "succeeded" : "skipped",
        result: {
          verified:       result.verified,
          deliverability: result.deliverability,
          lead_id:        leadId,
        },
      }
    }

    case "cancel_direct_mail_send": {
      // Move a pending direct_mail_campaigns row to status='cancelled'
      // with a structured reason. Only cancels rows that haven't yet
      // been dispatched (status in 'pending'|'queued') — sent rows can't
      // be recalled.
      const campaignId = String(input.campaign_id ?? "")
      const reason     = String(input.reason ?? "agent_resolution")
      if (!campaignId) return { status: "failed", result: { error: "campaign_id required" } }
      const svc = createServiceClient()
      const { error, count } = await svc.from("direct_mail_campaigns")
        .update({ status: "cancelled" }, { count: "exact" })
        .eq("id", campaignId)
        .eq("brokerage_id", brokerageId)
        .in("status", ["pending", "queued", "draft"])
      if (error) return { status: "failed", result: { error: error.message } }
      if ((count ?? 0) === 0) {
        return { status: "skipped", result: { reason: "row not in pending/queued/draft or tenant mismatch" } }
      }
      // Log the structured reason so the admin sees WHY the agent
      // cancelled it (not just a status flip).
      await svc.from("automation_errors").insert({
        brokerage_id:  brokerageId,
        workflow_name: "marketing_agent_direct_mail_cancel",
        error_message: `Marketing agent cancelled direct-mail send: ${reason.slice(0, 200)}`,
        severity:      "info",
        status:        "resolved",
        context_json:  { campaign_id: campaignId, agent_reason: reason },
      })
      return { status: "succeeded", result: { campaign_id: campaignId, cancelled: true } }
    }

    case "retry_direct_mail_design": {
      // Re-dispatch a failed direct_mail_campaigns row. The same
      // verification gate + de-conflict gate apply inside
      // dispatchDirectMail, so a real underlying problem surfaces
      // again. Useful when a transient Lob 5xx caused the original
      // failure.
      const campaignId = String(input.campaign_id ?? "")
      if (!campaignId) return { status: "failed", result: { error: "campaign_id required" } }
      const svc = createServiceClient()
      const { data: campaign } = await svc.from("direct_mail_campaigns")
        .select("id, brokerage_id, lead_id, contact_id, piece_type, status")
        .eq("id", campaignId)
        .maybeSingle()
      const r = campaign as {
        id: string
        brokerage_id: string | null
        lead_id: string | null
        contact_id: string | null
        piece_type: string | null
        status: string | null
      } | null
      if (!r) return { status: "failed", result: { error: "campaign not found" } }
      if (r.brokerage_id !== brokerageId) return { status: "failed", result: { error: "tenant mismatch" } }
      if (r.status !== "failed") {
        return { status: "skipped", result: { reason: "campaign not in failed status" } }
      }

      // Resolve recipient address. The original send recorded the
      // recipient in direct_mail_recipients (if a fan-out batch) or
      // implied it via lead_id / contact_id. For the v1 retry we
      // require the canonical resolver to find the address — same
      // gate the original send used.
      let recipientName  = "Resident"
      let address: { street: string; city: string; state: string; zip: string } | null = null
      if (r.lead_id) {
        const { data: lead } = await svc.from("leads")
          .select("first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip")
          .eq("id", r.lead_id)
          .maybeSingle()
        const l = lead as {
          first_name: string | null
          last_name: string | null
          mailing_address: string | null
          mailing_city: string | null
          mailing_state: string | null
          mailing_zip: string | null
        } | null
        if (l?.mailing_address && l.mailing_city && l.mailing_state && l.mailing_zip) {
          recipientName = [l.first_name, l.last_name].filter(Boolean).join(" ") || recipientName
          address = { street: l.mailing_address, city: l.mailing_city, state: l.mailing_state, zip: l.mailing_zip }
        }
      } else if (r.contact_id) {
        const { resolveMailingAddressForContact } = await import("@/lib/contacts/resolve-mailing-address")
        const resolved = await resolveMailingAddressForContact({ contactId: r.contact_id, brokerageId })
        if (resolved) {
          address = { street: resolved.street, city: resolved.city, state: resolved.state, zip: resolved.zip }
          const { data: c } = await svc.from("contacts").select("first_name, last_name").eq("id", r.contact_id).maybeSingle()
          recipientName = [c?.first_name, c?.last_name].filter(Boolean).join(" ") || recipientName
        }
      }
      if (!address) {
        return { status: "failed", result: { error: "no verified address available for retry" } }
      }

      const tplId = process.env.LOB_DEFAULT_TEMPLATE_ID ?? ""
      if (!tplId) {
        return { status: "failed", result: { error: "LOB_DEFAULT_TEMPLATE_ID not configured" } }
      }

      const { dispatchDirectMail } = await import("@/lib/providers/dispatch")
      const dispatch = await dispatchDirectMail({
        brokerageId,
        userId:         brokerageId,
        contactId:      r.contact_id ?? undefined,
        leadId:         r.lead_id ?? undefined,
        recipientName,
        mailingAddress: address.street,
        city:           address.city,
        state:          address.state,
        zip:            address.zip,
        templateId:     tplId,
        pieceType:      (r.piece_type as "letter" | "postcard" | "self_mailer" | undefined) ?? "postcard",
        systemSource:   "marketing_agent_retry",
      })

      await svc.from("direct_mail_campaigns")
        .update({
          status:        dispatch.success ? "sent" : "failed",
          lob_order_id:  dispatch.messageId ?? null,
          mailing_date:  dispatch.success ? new Date().toISOString().slice(0, 10) : null,
        })
        .eq("id", campaignId)

      return {
        status: dispatch.success ? "succeeded" : "failed",
        result: { campaign_id: campaignId, lob_order_id: dispatch.messageId ?? null, error: dispatch.error ?? null },
      }
    }

    case "flag_design_for_review": {
      // Route a degraded mailer design to the broker's automation_errors
      // review queue — parallel to flag_listing_for_review. The platform
      // admin already surfaces automation_errors rows.
      const campaignId = String(input.campaign_id ?? "")
      const reason     = String(input.reason ?? "marketing_agent_design_flag")
      if (!campaignId) return { status: "failed", result: { error: "campaign_id required" } }
      const svc = createServiceClient()
      const { data: campaign } = await svc.from("direct_mail_campaigns")
        .select("id, brokerage_id, campaign_name, piece_type, status")
        .eq("id", campaignId)
        .maybeSingle()
      const c = campaign as {
        id: string
        brokerage_id: string | null
        campaign_name: string | null
        piece_type: string | null
        status: string | null
      } | null
      if (!c) return { status: "failed", result: { error: "campaign not found" } }
      if (c.brokerage_id !== brokerageId) return { status: "failed", result: { error: "tenant mismatch" } }

      const { data: errRow, error } = await svc.from("automation_errors").insert({
        brokerage_id:  brokerageId,
        workflow_name: "marketing_agent_design_flag",
        error_message: `Marketing agent flagged direct-mail design for broker review: ${reason.slice(0, 200)}`,
        severity:      "warning",
        status:        "open",
        context_json:  {
          campaign_id:   campaignId,
          campaign_name: c.campaign_name ?? null,
          piece_type:    c.piece_type ?? null,
          status:        c.status ?? null,
          agent_reason:  reason,
          flagged_at:    new Date().toISOString(),
        },
      }).select("id").single()
      if (error) return { status: "failed", result: { error: error.message } }
      return { status: "succeeded", result: { automation_error_id: errRow.id, campaign_id: campaignId } }
    }

    case "omnipresence_topic_fanout": {
      // Take one topic from content_topic_bank and queue it across the
      // named channels in one approval click. Each channel runs through
      // its own canonical staging path so compliance/cooldown/tenant
      // gates apply per-channel — the fanout doesn't bypass any of
      // them; it just collapses 4 resolutions into 1.
      const topicId = String(input.topic_id ?? "")
      const channels = Array.isArray(input.channels)
        ? (input.channels as unknown[]).map(String).filter((c) =>
            ["newsletter", "blog", "social", "direct_mail_postcard"].includes(c))
        : []
      if (!topicId || channels.length === 0) {
        return { status: "failed", result: { error: "topic_id and at least one channel required" } }
      }
      const svc = createServiceClient()
      // Tenant + existence check on the topic.
      const { data: topic } = await svc.from("content_topic_bank")
        .select("id, brokerage_id, topic_title, value_angle")
        .eq("id", topicId)
        .maybeSingle()
      const t = topic as { id: string; brokerage_id: string | null; topic_title: string; value_angle: string | null } | null
      if (!t) return { status: "failed", result: { error: "topic not found" } }
      // Topic must be either platform-wide (brokerage_id null) or owned
      // by this brokerage — same scope rule as pickTopics.
      if (t.brokerage_id !== null && t.brokerage_id !== brokerageId) {
        return { status: "failed", result: { error: "topic outside tenant" } }
      }

      const fanout: Record<string, { ok: boolean; ref?: string; error?: string }> = {}

      for (const ch of channels) {
        if (ch === "newsletter") {
          try {
            const { stageNewsletterDraft } = await import("@/lib/wizard-staging/content-staging")
            const { data: broker } = await svc.from("users")
              .select("id").eq("brokerage_id", brokerageId).order("created_at", { ascending: true }).limit(1).maybeSingle()
            const brokerUserId = (broker?.id as string | undefined) ?? null
            if (!brokerUserId) { fanout.newsletter = { ok: false, error: "no broker user" }; continue }
            const r = await stageNewsletterDraft(
              { userId: brokerUserId, brokerageId },
              { title: t.topic_title, subjectLine: t.topic_title, topic: t.topic_title, audience: "all" },
            )
            fanout.newsletter = r.success
              ? { ok: true, ref: r.draftId ?? undefined }
              : { ok: false, error: r.error ?? "stage failed" }
          } catch (e) {
            fanout.newsletter = { ok: false, error: (e as Error).message }
          }
        } else if (ch === "blog") {
          // Mark the topic so the next blog cadence tick pulls it.
          // The blog cron's pickTopics will surface this topic first
          // because we set status='fresh' + boost engagement_score.
          try {
            const { error } = await svc.from("content_topic_bank")
              .update({ engagement_score: 999 })  // sentinel — picker boosts to top
              .eq("id", topicId)
            fanout.blog = error
              ? { ok: false, error: error.message }
              : { ok: true, ref: "boosted_in_bank_for_next_cadence_tick" }
          } catch (e) {
            fanout.blog = { ok: false, error: (e as Error).message }
          }
        } else if (ch === "social") {
          // Queue a draft social_posts row tagged with the topic.
          try {
            const { data: post, error } = await svc.from("social_posts").insert({
              brokerage_id: brokerageId,
              content:      t.value_angle ?? t.topic_title,
              status:       "draft",
              post_brief:   { topic_id: topicId, source: "marketing_agent_omnipresence" },
              created_at:   new Date().toISOString(),
            }).select("id").single()
            fanout.social = error
              ? { ok: false, error: error.message }
              : { ok: true, ref: post?.id as string | undefined }
          } catch (e) {
            fanout.social = { ok: false, error: (e as Error).message }
          }
        } else if (ch === "direct_mail_postcard") {
          // The agent says "spin this topic to direct mail" — but the
          // actual farm dispatch requires an agentId + farm + lots of
          // recipient resolution that's outside this action's scope.
          // Instead we log a content_topic_uses placeholder (asset_
          // type='direct_mail_postcard', asset_id=null) so the next
          // farm-mail cron picks this topic first for the matching
          // personas, AND fire a kernel event the operator listens
          // to. This keeps the fanout deterministic without spawning
          // ad-hoc Lob spend that wasn't budgeted.
          try {
            await svc.from("content_topic_uses").insert({
              topic_id:     topicId,
              brokerage_id: brokerageId,
              asset_type:   "direct_mail_postcard",
              asset_id:     null,
              used_at:      new Date().toISOString(),
            })
            fanout.direct_mail_postcard = {
              ok: true,
              ref: "queued_for_next_farm_cycle",
            }
          } catch (e) {
            fanout.direct_mail_postcard = { ok: false, error: (e as Error).message }
          }
        }
      }

      const anyOk = Object.values(fanout).some((v) => v.ok)
      return {
        status: anyOk ? "succeeded" : "failed",
        result: { topic_id: topicId, fanout },
      }
    }

    case "start_prelisting_drip": {
      // Materialize (or refresh) the seller-facing pre-listing section drip for
      // a presentation — splits it into seller-safe sections scheduled before
      // the appointment + renders the animated CMA section. The drip cron then
      // delivers each section to the seller's portal. Idempotent.
      const presentationId = String(input.presentation_id ?? "")
      if (!presentationId) return { status: "failed", result: { error: "presentation_id required" } }
      const svc = createServiceClient()
      const { data: pres } = await svc.from("listing_presentations")
        .select("id, brokerage_id").eq("id", presentationId).maybeSingle()
      const p = pres as { id: string; brokerage_id: string | null } | null
      if (!p) return { status: "failed", result: { error: "presentation not found" } }
      if (p.brokerage_id && p.brokerage_id !== brokerageId) {
        return { status: "failed", result: { error: "presentation outside brokerage" } }
      }
      const { materializePresentationSections } = await import("@/lib/listing-presentation/section-drip")
      const res = await materializePresentationSections(presentationId, svc)
      return res.ok
        ? { status: "succeeded", result: { presentation_id: presentationId, sections_scheduled: res.inserted } }
        : { status: "failed", result: { error: res.error ?? "drip materialization failed" } }
    }

    case "approve_prelisting_delivery": {
      // GATE 2 (RELEASE). A human reviewed the finished videos + announcement
      // email in the Command Center and is releasing the presentation to the
      // seller. Stamp delivery_approved_at (un-gates the drip) + delivery_approved_by
      // (audit trail), then send the announcement email best-effort. Idempotent.
      const presentationId = String(input.presentation_id ?? "")
      if (!presentationId) return { status: "failed", result: { error: "presentation_id required" } }
      const svc = createServiceClient()
      const { data: pres } = await svc.from("listing_presentations")
        .select("id, brokerage_id, delivery_approved_at").eq("id", presentationId).maybeSingle()
      const p = pres as { id: string; brokerage_id: string | null; delivery_approved_at: string | null } | null
      if (!p) return { status: "failed", result: { error: "presentation not found" } }
      if (p.brokerage_id && p.brokerage_id !== brokerageId) {
        return { status: "failed", result: { error: "presentation outside brokerage" } }
      }
      if (p.delivery_approved_at) return { status: "skipped", result: { reason: "already released" } }

      await svc.from("listing_presentations")
        .update({ delivery_approved_at: new Date().toISOString(), delivery_approved_by: approverUserId ?? null })
        .eq("id", presentationId)

      // Send the announcement email now (the drip then reveals the portal
      // sections on schedule). Best-effort — a send failure must not un-release.
      let emailSent = false
      try {
        const { sendPrelistingAnnouncementEmail } = await import("@/lib/listing-presentation/prelisting-delivery")
        const sent = await sendPrelistingAnnouncementEmail(presentationId, svc)
        emailSent = sent.sent
      } catch { /* announcement email is best-effort */ }
      return { status: "succeeded", result: { presentation_id: presentationId, released: true, email_sent: emailSent } }
    }

    case "promote_new_listing":
    case "just_sold_campaign": {
      // Cross-manager handoff (human-approved): the Listing/Deal manager handed off
      // to Marketing — kick the coordinated promo for the listing. Idempotent via
      // the promo reactor's cooldown.
      const listingId = String(input.listing_id ?? "")
      if (!listingId) return { status: "failed", result: { error: "listing_id required" } }
      const svc = createServiceClient()
      const { data: listing } = await svc.from("listings").select("agent_id, brokerage_id").eq("id", listingId).maybeSingle()
      const l = listing as { agent_id: string | null; brokerage_id: string | null } | null
      if (!l || l.brokerage_id !== brokerageId) return { status: "failed", result: { error: "listing not found or tenant mismatch" } }
      if (!l.agent_id) return { status: "failed", result: { error: "listing has no assigned agent" } }
      const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
      const agentUserId = await resolveAgentRecordToUserId(l.agent_id)
      if (!agentUserId) return { status: "failed", result: { error: "agent user id unresolved" } }
      const eventType = action === "promote_new_listing" ? "just_listed" : "just_sold"
      const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
      const r = await dispatchListingPromoVideo({
        brokerageId, listingId, agentUserId,
        eventType: eventType as Parameters<typeof dispatchListingPromoVideo>[0]["eventType"],
        bypassPolicy: true,
      })
      return { status: r.ok ? "succeeded" : "failed", result: { listing_id: listingId, promo: eventType, dispatch_status: r.status, reason: r.reason ?? null } }
    }

    case "regenerate_faq": {
      // GEO remediation: a published landing page that AI search persistently never cites gets its FAQ
      // rebuilt from FRESH demand topics + a new schema.org FAQPage block, then persisted to
      // lead_capture_forms.landing_content (what the public /lm/[slug] page renders). Same composition
      // the builder uses, so the page picks up the improvement on next render. Idempotent.
      const svc = createServiceClient()
      const formId = String(input.form_id ?? input.formId ?? "")
      if (!formId) return { status: "failed", result: { error: "form_id required" } }
      const { data: form } = await svc.from("lead_capture_forms")
        .select("id, brokerage_id, magnet_type, slug, landing_content")
        .eq("id", formId).eq("brokerage_id", brokerageId).maybeSingle()
      if (!form) return { status: "failed", result: { error: "form not found or tenant mismatch" } }

      const magnetType = ((form as any).magnet_type ?? "generic_form") as import("@/lib/marketing/lead-magnet-copy").MagnetType
      const prev = ((form as any).landing_content ?? {}) as Record<string, unknown>
      const ctx = { area: (prev.area as string) ?? null, brand: (prev.brand as string) ?? null }

      const { fetchContentTopics } = await import("@/lib/marketing/content-topics-runner")
      const topics = await fetchContentTopics(magnetType, ctx.area).catch(() => [])
      const { realCopyGenerator } = await import("@/lib/kernel/ai-copy")
      const { landingPageCopyFromTopics } = await import("@/lib/marketing/lead-magnet-copy")
      const { buildFaqFromTopics, faqJsonLdScript } = await import("@/lib/marketing/geo-faq")

      const landing = await landingPageCopyFromTopics(magnetType, topics, ctx, { copyGenerator: realCopyGenerator })
      const faq = await buildFaqFromTopics(topics, magnetType, ctx, { copyGenerator: realCopyGenerator })
      if (faq.length === 0) return { status: "skipped", result: { reason: "no fresh demand topics available to rebuild the FAQ" } }

      const nextLandingContent = {
        ...prev,
        headline: landing.headline, subhead: landing.subhead, cta: landing.cta, bullets: landing.bullets,
        faq, faqJsonLd: faqJsonLdScript(faq, { brand: ctx.brand }),
        faq_regenerated_at: new Date().toISOString(),
      }
      const { error: upErr } = await svc.from("lead_capture_forms")
        .update({ landing_content: nextLandingContent }).eq("id", formId)
      if (upErr) return { status: "failed", result: { error: upErr.message } }
      return { status: "succeeded", result: { form_id: formId, slug: (form as any).slug ?? null, faq_count: faq.length, from_topics: landing.fromTopics, topics: topics.length } }
    }

    case "reallocate_lead_sources": {
      // Self-learning lead-gen: turn ON proven winners / turn OFF money-pit scrape sources for ONE
      // market, based on the source-conversion learner's recommendation. enabled_sources := (current ∪
      // enable) \ disable. Idempotent (re-applying the same delta is a no-op). Tenant-checked.
      const svc = createServiceClient()
      const marketId = String(input.market_id ?? input.marketId ?? "")
      const enable = Array.isArray(input.enable) ? (input.enable as unknown[]).map(String) : []
      const disable = Array.isArray(input.disable) ? (input.disable as unknown[]).map(String) : []
      if (!marketId) return { status: "failed", result: { error: "market_id required" } }
      if (enable.length === 0 && disable.length === 0) return { status: "skipped", result: { reason: "no source changes to apply" } }
      const { data: market } = await svc.from("lead_scraping_markets")
        .select("id, brokerage_id, enabled_sources").eq("id", marketId).eq("brokerage_id", brokerageId).maybeSingle()
      if (!market) return { status: "failed", result: { error: "market not found or tenant mismatch" } }
      const current = new Set<string>(((market as any).enabled_sources ?? []) as string[])
      for (const s of enable) current.add(s)
      for (const s of disable) current.delete(s)
      const next = [...current].sort()
      const { error: upErr } = await svc.from("lead_scraping_markets").update({ enabled_sources: next }).eq("id", marketId)
      if (upErr) return { status: "failed", result: { error: upErr.message } }
      return { status: "succeeded", result: { market_id: marketId, enabled: next, turned_on: enable, turned_off: disable } }
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
