/**
 * lib/agents/asset-manager-actions.ts
 *
 * Wave 37 — handler dispatcher for asset_manager_actions resolutions.
 * Mirrors the Wave 34b pattern of lib/agents/marketing-agent-actions:
 * each action_type has an idempotent + tenant-gated handler; the
 * executeAction entrypoint claims the row atomically (proposed →
 * executing) then dispatches to runHandler.
 *
 * Action vocabulary (m159 CHECK constraint):
 *   regenerate_asset            kind='video'|'image'|'composition' + asset_id [+ new_prompt]
 *   deprecate_asset             asset_id + reason
 *   flag_asset_for_review       asset_id + reason
 *   request_listing_hero_photo  listing_id (writes automation_errors row)
 *   request_agent_headshot      agent_id (writes automation_errors row)
 *   rerender_persona_variants   asset_id + asset_type [+ personas]
 *   sync_asset_to_listing       asset_id + listing_id (writes marketing_asset_qr_links link)
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type AssetManagerActionType =
  | "regenerate_asset"
  | "deprecate_asset"
  | "flag_asset_for_review"
  | "request_listing_hero_photo"
  | "request_agent_headshot"
  | "rerender_persona_variants"
  | "sync_asset_to_listing"
  | "start_render"
  | "restart_failed_render"
  | "publish_video_page"
  | "direct_video"

export interface ProposedAssetAction {
  action_type: AssetManagerActionType
  action_input: Record<string, unknown>
  rationale?:  string
}

export interface ActionHandlerResult {
  status: "succeeded" | "failed" | "skipped"
  result: Record<string, unknown>
}

export async function recordProposedAssetActions(args: {
  brokerageId:           string
  managedAgentSessionId: string | null
  actions:               ProposedAssetAction[]
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
  const { data, error } = await svc.from("asset_manager_actions")
    .insert(rows)
    .select("id")
  if (error) {
    console.error("[asset-manager-actions] record failed:", error.message)
    return { inserted: 0 }
  }
  return { inserted: data?.length ?? 0 }
}

/** Atomic claim → execute → patch outcome. Same pattern as the
 *  marketing-agent action executor. */
export async function executeAssetManagerAction(
  actionId: string,
  approverUserId: string,
): Promise<ActionHandlerResult> {
  const svc = createServiceClient()
  const { data: claimed, error: actionClaimErr } = await svc.from("asset_manager_actions")
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
  if (actionClaimErr) console.error(`[asset-manager] action claim refused: ${actionClaimErr.message}`)
  if (!claimed) {
    return { status: "skipped", result: { reason: "row not in proposed/approved state" } }
  }
  const row = claimed as { brokerage_id: string; action_type: AssetManagerActionType; action_input: Record<string, unknown> }

  let outcome: ActionHandlerResult
  try {
    outcome = await runHandler(row.action_type, row.brokerage_id, row.action_input)
  } catch (e) {
    outcome = { status: "failed", result: { error: (e as Error).message } }
  }
  const { error: actionOutcomeErr } = await svc.from("asset_manager_actions")
    .update({ status: outcome.status, result: outcome.result })
    .eq("id", actionId)
  if (actionOutcomeErr) console.error(`[asset-manager] action outcome NOT recorded: ${actionOutcomeErr.message}`)
  return outcome
}

async function runHandler(
  action: AssetManagerActionType,
  brokerageId: string,
  input: Record<string, unknown>,
): Promise<ActionHandlerResult> {
  switch (action) {
    case "regenerate_asset": {
      // v1 — soft regenerate: flip the asset's status back to a
      // 'pending' state so the appropriate render cron picks it up
      // on the next tick. Avoids us re-implementing every generator
      // here; the existing crons own the work.
      const assetId = String(input.asset_id ?? "")
      const kind = String(input.kind ?? "")
      if (!assetId) return { status: "failed", result: { error: "asset_id required" } }
      const svc = createServiceClient()
      if (kind === "video") {
        const { error, count } = await svc.from("ai_video_projects")
          .update({ status: "queued" }, { count: "exact" })
          .eq("id", assetId)
          .eq("brokerage_id", brokerageId)
        if (error) return { status: "failed", result: { error: error.message } }
        if ((count ?? 0) === 0) return { status: "skipped", result: { reason: "video project not found or tenant mismatch" } }
        return { status: "succeeded", result: { kind: "video", asset_id: assetId, queued_for: "queued" } }
      }
      if (kind === "image" || kind === "composition") {
        // m174 — queue the image for regeneration. The marketing-image-regen
        // cron drains regen_status='requested' and re-runs generateImage from
        // metadata.original_prompt. (Pre-m174 this wrote a non-existent
        // `status` column and silently errored — a dead flag.)
        const { error, count } = await svc.from("marketing_assets")
          .update({ regen_status: "requested" } as Record<string, unknown>, { count: "exact" })
          .eq("id", assetId)
          .eq("brokerage_id", brokerageId)
        if (error) return { status: "failed", result: { error: error.message } }
        if ((count ?? 0) === 0) return { status: "skipped", result: { reason: "marketing asset not found or tenant mismatch" } }
        return { status: "succeeded", result: { kind, asset_id: assetId, queued_for: "image_regen" } }
      }
      return { status: "failed", result: { error: `unknown kind: ${kind}` } }
    }

    case "deprecate_asset": {
      const assetId = String(input.asset_id ?? "")
      const reason  = String(input.reason ?? "unspecified")
      if (!assetId) return { status: "failed", result: { error: "asset_id required" } }
      const svc = createServiceClient()
      // marketing_assets is the canonical store (brand_asset_library was a
      // writer-less twin — removed from the loop). marketing_assets has NO
      // is_active column (live-verified — the old update 42703'd silently);
      // retirement there is approval_status='rejected'. ai_video_projects
      // keeps its is_active flag. At most one match per asset_id.
      {
        const { count, error: rejectAssetErr } = await svc.from("marketing_assets")
          .update({ approval_status: "rejected" }, { count: "exact" })
          .eq("id", assetId)
          .eq("brokerage_id", brokerageId)
        if (rejectAssetErr) console.error(`[asset-manager] asset rejection refused: ${rejectAssetErr.message}`)
        if ((count ?? 0) > 0) {
          return { status: "succeeded", result: { table: "marketing_assets", asset_id: assetId, reason } }
        }
      }
      {
        // ai_video_projects has no is_active either (live-verified) — unpublish
        // is the retire semantics for a video project.
        const { count, error: retireErr } = await svc.from("ai_video_projects")
          .update({ is_published: false }, { count: "exact" })
          .eq("id", assetId)
          .eq("brokerage_id", brokerageId)
        // A refused retire is a failure, not "asset not found" (lane 88F).
        if (retireErr) return { status: "failed", result: { table: "ai_video_projects", asset_id: assetId, error: retireErr.message } }
        if ((count ?? 0) > 0) {
          return { status: "succeeded", result: { table: "ai_video_projects", asset_id: assetId, reason } }
        }
      }
      return { status: "skipped", result: { reason: "asset not found in any catalog or tenant mismatch" } }
    }

    case "flag_asset_for_review": {
      const assetId = String(input.asset_id ?? "")
      const reason  = String(input.reason ?? "asset_manager_flag")
      if (!assetId) return { status: "failed", result: { error: "asset_id required" } }
      const svc = createServiceClient()
      const { data: errRow, error } = await svc.from("automation_errors").insert({
        brokerage_id:  brokerageId,
        workflow_name: "asset_manager_asset_flag",
        error_message: `Asset Manager flagged asset for broker review: ${reason.slice(0, 200)}`,
        severity:      "warning",
        status:        "open",
        context_json:  { asset_id: assetId, agent_reason: reason, flagged_at: new Date().toISOString() },
      }).select("id").single()
      if (error) return { status: "failed", result: { error: error.message } }
      return { status: "succeeded", result: { automation_error_id: errRow.id, asset_id: assetId } }
    }

    case "request_listing_hero_photo": {
      const listingId = String(input.listing_id ?? "")
      if (!listingId) return { status: "failed", result: { error: "listing_id required" } }
      const svc = createServiceClient()
      const { data: listing } = await svc.from("listings")
        .select("id, brokerage_id, address, agent_id")
        .eq("id", listingId)
        .maybeSingle()
      const l = listing as { id: string; brokerage_id: string | null; address: string | null; agent_id: string | null } | null
      if (!l) return { status: "failed", result: { error: "listing not found" } }
      if (l.brokerage_id !== brokerageId) return { status: "failed", result: { error: "tenant mismatch" } }
      const { data: errRow, error } = await svc.from("automation_errors").insert({
        brokerage_id:  brokerageId,
        workflow_name: "asset_manager_hero_photo_request",
        error_message: `Listing ${l.address ?? listingId} has no hero photo flagged — agent needs to mark one as is_hero=true.`,
        severity:      "info",
        status:        "open",
        context_json:  { listing_id: listingId, agent_id: l.agent_id, requested_at: new Date().toISOString() },
      }).select("id").single()
      if (error) return { status: "failed", result: { error: error.message } }
      return { status: "succeeded", result: { automation_error_id: errRow.id, listing_id: listingId } }
    }

    case "request_agent_headshot": {
      const agentId = String(input.agent_id ?? "")
      if (!agentId) return { status: "failed", result: { error: "agent_id required" } }
      const svc = createServiceClient()
      const { data: agent } = await svc.from("agents")
        .select("id, brokerage_id, photo_url, users(first_name, last_name, email, phone)")
        .eq("id", agentId)
        .maybeSingle()
      const a = agent as { id: string; brokerage_id: string | null; photo_url: string | null; users?: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null } | null } | null
      if (!a) return { status: "failed", result: { error: "agent not found" } }
      if (a.brokerage_id !== brokerageId) return { status: "failed", result: { error: "tenant mismatch" } }
      const name = [(a.users as any)?.first_name, (a.users as any)?.last_name].filter(Boolean).join(" ") || agentId.slice(0, 8)
      const { data: errRow, error } = await svc.from("automation_errors").insert({
        brokerage_id:  brokerageId,
        workflow_name: "asset_manager_headshot_request",
        error_message: `Agent ${name} has no photo_url — their pieces fall back to initials. Ask them to upload a headshot.`,
        severity:      "info",
        status:        "open",
        context_json:  { agent_id: agentId, requested_at: new Date().toISOString() },
      }).select("id").single()
      if (error) return { status: "failed", result: { error: error.message } }
      return { status: "succeeded", result: { automation_error_id: errRow.id, agent_id: agentId } }
    }

    case "rerender_persona_variants": {
      const assetId = String(input.asset_id ?? "")
      const assetType = String(input.asset_type ?? "")
      const personas = Array.isArray(input.personas) ? (input.personas as unknown[]).map(String) : []
      if (!assetId || !assetType) return { status: "failed", result: { error: "asset_id and asset_type required" } }
      const svc = createServiceClient()
      // Mark existing variant rows for this (asset_id, asset_type) +
      // requested personas as 'queued' so the variant-render reactor
      // picks them up on its next tick. When personas[] is empty, all
      // variants for the asset are queued.
      let q = svc.from("asset_persona_renders")
        .update({ status: "queued" } as Record<string, unknown>, { count: "exact" })
        .eq("brokerage_id", brokerageId)
        .eq("asset_id", assetId)
        .eq("asset_type", assetType)
      if (personas.length > 0) q = q.in("persona", personas)
      const { error, count } = await q
      if (error) return { status: "failed", result: { error: error.message } }
      return { status: "succeeded", result: { asset_id: assetId, asset_type: assetType, queued: count ?? 0 } }
    }

    case "sync_asset_to_listing": {
      const assetId = String(input.asset_id ?? "")
      const listingId = String(input.listing_id ?? "")
      if (!assetId || !listingId) return { status: "failed", result: { error: "asset_id and listing_id required" } }
      const svc = createServiceClient()
      // Both must be in tenant.
      const [{ data: asset }, { data: listing }] = await Promise.all([
        svc.from("marketing_assets").select("id, brokerage_id").eq("id", assetId).maybeSingle(),
        svc.from("listings").select("id, brokerage_id").eq("id", listingId).maybeSingle(),
      ])
      const aOk = (asset as { brokerage_id: string | null } | null)?.brokerage_id === brokerageId
      const lOk = (listing as { brokerage_id: string | null } | null)?.brokerage_id === brokerageId
      if (!aOk || !lOk) return { status: "failed", result: { error: "asset or listing not in tenant" } }
      // Backfill the linkage via marketing_assets — depends on
      // schema; use a generic listing_id column update if present.
      const { error } = await svc.from("marketing_assets")
        .update({ source_table: "listings", source_id: listingId } as Record<string, unknown>)
        .eq("id", assetId)
        .eq("brokerage_id", brokerageId)
      if (error) return { status: "failed", result: { error: error.message } }
      return { status: "succeeded", result: { asset_id: assetId, listing_id: listingId } }
    }

    case "start_render": {
      // Wave 39 — queue a fresh Remotion render of a registered
      // composition. The actual @remotion/renderer invocation lives
      // in the per-composition endpoint; this handler claims the
      // remotion_composition_renders row and stamps the queued state
      // so the cron / endpoint picks it up.
      const compositionId = String(input.composition_id ?? "")
      const scopeType     = String(input.scope_type ?? "brokerage") as "agent" | "team" | "brokerage"
      const scopeId       = String(input.scope_id ?? "") || brokerageId
      const agentUserId   = (input.agent_user_id as string | null) ?? null
      const entityType    = (input.entity_type as string | null) ?? null
      const entityId      = (input.entity_id as string | null) ?? null
      // Wave 39 m172 — the composition props payload. Persisted on the
      // render row so the generic render endpoint reproduces the
      // brokerage's branded piece (not the registry sample defaults).
      const inputProps    = (input.input_props && typeof input.input_props === "object")
        ? (input.input_props as Record<string, unknown>)
        : {}
      if (!compositionId) return { status: "failed", result: { error: "composition_id required" } }

      const { getComposition, recordRenderQueued } = await import("@/lib/remotion/registry")
      const composition = await getComposition(compositionId)
      if (!composition) return { status: "failed", result: { error: "composition_not_registered" } }
      if (!composition.is_active) return { status: "skipped", result: { reason: "composition_inactive" } }

      // ── FAIL CLOSED (§4) ────────────────────────────────────────────────────
      // `input_props` defaults to {} above, and Remotion MERGES input props over
      // each composition's Studio defaultProps — so a render staged with {} does
      // not come out blank, it comes out confidently wrong, and
      // render-composition's backstop CANCELS it. This handler nonetheless
      // returned status:"succeeded" with the note "the cron drains it on the
      // next tick", so an autonomous manager was told a render it can never get
      // had been claimed, with no reason it could surface or act on.
      // Same question the renderer will ask, asked here, named by prop.
      const { missingContentProps, describeMissingContent } = await import("@/lib/remotion/content-contract")
      const missingProps = missingContentProps(compositionId, inputProps)
      if (missingProps.length > 0) {
        return {
          status: "failed",
          result: {
            error: describeMissingContent(compositionId, missingProps),
            composition_id: compositionId,
            missing_content_props: missingProps,
          },
        }
      }

      // used_voiceover is a fact about THIS render (the composition plays
      // voiceoverUrl AND these props carry one), read from the one set at
      // lib/remotion/content-contract.ts — not the registry row's mirror column,
      // which asserted a narration for compositions that have no audio (m601).
      const { stagesVoiceover } = await import("@/lib/remotion/content-contract")
      const queued = await recordRenderQueued({
        brokerageId, compositionId,
        agentUserId, entityType, entityId,
        usedDidAvatar: composition.requires_did_avatar,
        usedVoiceover: stagesVoiceover(compositionId, inputProps),
        inputProps, scopeType, scopeId,
        requestedVia: "asset_manager",
      })
      if (!queued.ok) return { status: "failed", result: { error: queued.error ?? "queue failed" } }
      return {
        status: "succeeded",
        result: {
          composition_id: compositionId,
          render_id:      queued.renderId,
          scope:          { type: scopeType, id: scopeId },
          note:           "Render row claimed; the composition-render-queue cron drains it on the next tick.",
        },
      }
    }

    case "restart_failed_render": {
      // Wave 39 — re-queue a previously-failed render row. Reads the
      // original composition_id + entity refs, then claims a fresh
      // remotion_composition_renders row so the failure history is
      // preserved (the original row stays 'failed') and the new attempt
      // has its own audit lineage.
      const renderId = String(input.render_id ?? "")
      if (!renderId) return { status: "failed", result: { error: "render_id required" } }
      const svc = createServiceClient()
      const { data: original } = await svc.from("remotion_composition_renders")
        .select("composition_id, agent_user_id, entity_type, entity_id, render_status, brokerage_id, input_props, scope_type, scope_id")
        .eq("id", renderId)
        .eq("brokerage_id", brokerageId)
        .maybeSingle()
      const o = original as {
        composition_id: string; agent_user_id: string | null;
        entity_type: string | null; entity_id: string | null;
        render_status: string; brokerage_id: string;
        input_props: Record<string, unknown> | null;
        scope_type: "agent" | "team" | "brokerage" | null;
        scope_id: string | null
      } | null
      if (!o) return { status: "skipped", result: { reason: "render row not found or tenant mismatch" } }
      if (o.render_status !== "failed") {
        return { status: "skipped", result: { reason: `original render is ${o.render_status}, not failed` } }
      }
      const { getComposition, recordRenderQueued } = await import("@/lib/remotion/registry")
      const composition = await getComposition(o.composition_id)
      if (!composition) return { status: "failed", result: { error: "composition_not_registered" } }

      // A RESTART OF A DOOMED ROW IS STILL DOOMED. `o.input_props ?? {}` carries
      // the original props forward — including the case where they were never
      // sufficient, which is one of the ways the original reached 'failed' in
      // the first place. Re-queueing it would burn another render slot and hand
      // the manager a second "succeeded". Refuse by name instead, so the Asset
      // Manager learns WHICH facts have to be established before a retry can
      // work (§4 — a gate that cannot pass must refuse, not pass).
      const carriedProps = o.input_props ?? {}
      const { missingContentProps, describeMissingContent } = await import("@/lib/remotion/content-contract")
      const missingProps = missingContentProps(o.composition_id, carriedProps)
      if (missingProps.length > 0) {
        return {
          status: "failed",
          result: {
            error: describeMissingContent(o.composition_id, missingProps),
            composition_id: o.composition_id,
            original_render_id: renderId,
            missing_content_props: missingProps,
          },
        }
      }

      // Carry the original render's props + scope forward so the retry
      // reproduces the SAME branded piece, not a defaults sample.
      const { stagesVoiceover } = await import("@/lib/remotion/content-contract")
      const queued = await recordRenderQueued({
        brokerageId,
        compositionId: o.composition_id,
        agentUserId:   o.agent_user_id,
        entityType:    o.entity_type,
        entityId:      o.entity_id,
        usedDidAvatar: composition.requires_did_avatar,
        // Same rule as start_render: the render's own fact, from the one set.
        usedVoiceover: stagesVoiceover(o.composition_id, carriedProps),
        inputProps:    carriedProps,
        scopeType:     o.scope_type ?? "brokerage",
        scopeId:       o.scope_id ?? brokerageId,
        requestedVia:  "asset_manager",
      })
      if (!queued.ok) return { status: "failed", result: { error: queued.error ?? "queue failed" } }
      return {
        status: "succeeded",
        result: {
          composition_id:     o.composition_id,
          original_render_id: renderId,
          new_render_id:      queued.renderId,
        },
      }
    }

    case "publish_video_page": {
      // Wave 39 GEO — publish a successful render as a public, AI-search-
      // citable /v/[slug] page. Broker-approved (this action flows through
      // the standard proposed → approved → executing queue) because a
      // public page is broadcast advertising that must carry Fair-Housing /
      // license / EHO disclosures.
      const renderId = String(input.render_id ?? "")
      if (!renderId) return { status: "failed", result: { error: "render_id required" } }
      const { publishVideoLanding } = await import("@/lib/geo/publish-video-landing")
      const res = await publishVideoLanding({ renderId, brokerageId })
      if (!res.ok) return { status: "skipped", result: { reason: res.reason ?? "not publishable" } }
      return { status: "succeeded", result: { render_id: renderId, public_slug: res.slug, url: `/v/${res.slug}` } }
    }

    case "direct_video": {
      // The Asset Manager calls the VIDEO DIRECTOR: given a situation it picks the
      // best Remotion format + music mood for the moment×channel and assembles
      // intro (brand+photo+hook) → main → outro (brand+contact+tracked QR), staging
      // ONE compliance-gated ai_video_projects row. This is the Asset-Manager-
      // initiated front door to commissionVideo — the Director governs creation
      // BEFORE the video exists (the voice admin's commission_video verb is the
      // other entry). Idempotent per (entity, kind); nothing auto-publishes.
      const VALID_KINDS = new Set([
        "new_listing", "price_drop", "just_sold", "open_house", "coming_soon",
        "market_update", "cma", "explainer", "presentation", "anniversary",
        "testimonial", "neighborhood",
      ])
      const kind = String(input.kind ?? "")
      const targetChannel = String(input.target_channel ?? "instagram")
      const agentUserId = (input.agent_user_id as string | null) ?? null
      if (!agentUserId) return { status: "failed", result: { error: "agent_user_id required" } }

      // Wave 81C — ANY TYPE OF VIDEO, autonomously: a manager may commission a
      // DESCRIBED video through the SAME door the studio's "Describe a video"
      // card uses (commissionCustomVideo → the archetype rule → the Director
      // rail). input.brief is the CustomVideoBrief; an unplannable brief is a
      // refusal with the reason, never a silent default kind.
      if (kind === "custom") {
        const brief = input.brief as import("@/lib/video/custom-video-archetypes").CustomVideoBrief | undefined
        if (!brief || typeof brief !== "object" || typeof brief.goal !== "string") return { status: "failed", result: { error: "custom kind requires input.brief (CustomVideoBrief: audience, goal, host, assets)" } }
        const { commissionCustomVideo } = await import("@/lib/video/video-director")
        const c = await commissionCustomVideo(brief, {
          brokerageId, agentUserId,
          listingId: (input.listing_id as string | null) ?? null, contactId: (input.contact_id as string | null) ?? null,
          targetChannel: targetChannel as Parameters<typeof commissionCustomVideo>[1]["targetChannel"],
        })
        if (!c.ok) return { status: c.status === "already_staged" ? "skipped" : "failed", result: { error: c.reason, status: c.status, violations: c.violations } }
        return { status: "succeeded", result: { video_project_id: c.videoProjectId, composition_id: c.compositionId, archetype: c.plan?.archetype, purpose: c.plan?.purpose, mls_video_project_id: c.mls?.videoProjectId ?? null, note: "Planned by archetype rule (lib/video/custom-video-archetypes.ts) and staged through the Director; the composition-render cron drains it." } }
      }
      if (!VALID_KINDS.has(kind)) return { status: "failed", result: { error: "valid kind required", kind } }

      const { commissionVideo } = await import("@/lib/video/video-director")
      const r = await commissionVideo(
        { kind: kind as Parameters<typeof commissionVideo>[0]["kind"], tier: "solo_agent", targetChannel: targetChannel as Parameters<typeof commissionVideo>[0]["targetChannel"], facts: (input.facts as Record<string, unknown>) ?? {} },
        { brokerageId, agentUserId, listingId: (input.listing_id as string | null) ?? null, contactId: (input.contact_id as string | null) ?? null },
      )
      if (!r.ok) {
        return { status: r.status === "already_staged" ? "skipped" : "failed", result: { error: r.reason, status: r.status, violations: r.violations } }
      }
      return {
        status: "succeeded",
        result: {
          video_project_id: r.videoProjectId,
          composition_id: r.compositionId,
          note: "The Director picked the format + music mood and staged the video; the composition-render cron drains it.",
        },
      }
    }

    default: {
      const _exhaustive: never = action
      void _exhaustive
      return { status: "failed", result: { error: "unknown action_type" } }
    }
  }
}

// ─── WAVE 155 (lane 155G) — THE SERVICE-ACTOR MEDIA JOB: an APPROVED topic master becomes a real video ─────────────────────
//
// MEASURED AT BASE d2d6468c (wave 154 §14): a topic's master post (lib/repurpose/refurbish-run.ts) is filed for the TEXT
// platforms only; Instagram / TikTok / YouTube were recorded `media_partial` ("no media producer for a text master") and nothing
// ever read that list. The producers existed — the Director rail (lib/video/video-director.ts commissionVideo: service client,
// tenant-scoped, compliance-gated hook, metered, idempotent per director_key, pending_review) and the completion distributor
// (lib/repurpose/distribute.ts, fired by video.generated) — but no scheduled worker connected an approved master to them.
//
// NOW the publish-social-posts cron runs this job each tick (bounded). For each APPROVED topic master (a PERSON approved it —
// approved_by is required; the service never self-approves) that still carries media_partial and no media_job:
//   1. the topic is still fresh (expired = closed, never produced late) and the creator owner (user_id + agent_id) is on record;
//   2. each wanted platform passes THE variant contract (lib/video/media-variant-contract.ts) against the sender's connected
//      account — permission refused / not connected / no video route → that platform is refused by name; none left = held, no spend;
//   3. the situation chooser (lib/video/situation-artifact-choice.ts, kind lead_magnet_topic) confirms a reel is warranted;
//   4. commissionVideo stages ONE educational reel (the avatar-led explainer, square — vertical feeds take it; with no recorded
//      avatar the D-ID leg parks at awaiting_presenter_setup, blocked on a person, never faked) under the CREATOR OWNER's seat,
//      with the approved master as the spoken script, `autonomous: true` (the meter records a service commission), and
//      video_metadata.media_job naming who OWNS it (creator) apart from who EXECUTED it (service actor: asset_manager, this job);
//      video_metadata.repurpose hands the admitted variants to the completion distributor;
//   5. the master's post_brief.media_job is stamped (one commission per master — a replay stages nothing twice) and one ledger
//      row records the decision (recordNonAction — marketing.decision.send_touch / do_nothing).
// What it never does: impersonate a user, read a session cookie, publish, or present a script as a video — the render, the
// verified-playable check, each variant's own approval and the publish cron's egress check all still stand between this and air.

type MediaJobDb = { from: (t: string) => any }
type MediaCommission = { ok: boolean; status: string; videoProjectId?: string; reason?: string }

export interface TopicMediaJobDeps {
  /** @proofSeam scripts/artifact-production-guard.ts — production: commissionVideo (lib/video/video-director.ts), the ONE Director rail. */
  commission?: (svc: MediaJobDb, situation: Record<string, unknown>, opts: Record<string, unknown>) => Promise<MediaCommission>
  /** @proofSeam scripts/artifact-production-guard.ts — production: recordNonAction (lib/kernel/action-ledger.ts). */
  record?: (svc: MediaJobDb, row: Record<string, unknown>) => Promise<{ recorded: boolean; error?: string }>
  /** @proofSeam scripts/artifact-production-guard.ts — production: detectFairHousingRedFlags + escalateScriptToHumanReview
   *  (lib/video/script-compliance.ts) on the text the reel will SPEAK. A hard flag escalates to a person; nothing renders. */
  screen?: (svc: MediaJobDb, a: { text: string; userId: string; brokerageId: string; title: string }) => Promise<{ hard: string[]; escalated: boolean; error?: string }>
  now?: () => Date
}

async function prodScreenSpokenText(svc: MediaJobDb, a: { text: string; userId: string; brokerageId: string; title: string }): Promise<{ hard: string[]; escalated: boolean; error?: string }> {
  const { detectFairHousingRedFlags, escalateScriptToHumanReview } = await import("@/lib/video/script-compliance")
  const hard = detectFairHousingRedFlags(a.text, "buyer")
  if (!hard.length) return { hard, escalated: false }
  const r = await escalateScriptToHumanReview({ actor: { userId: a.userId, brokerageId: a.brokerageId }, script: a.text, videoType: "education", title: a.title, redFlags: hard, client: svc as never })
  return { hard, escalated: r.ok === true, error: r.ok ? undefined : (r as { error?: string }).error }
}

export interface TopicMediaJobResult {
  scanned: number
  commissioned: number
  alreadyStaged: number
  held: Array<{ postId: string; reason: string }>
  errors: string[]
}

/** `scope` is REQUIRED (lib/kernel/tenant-scope.ts): one tenant, or every tenant with the reason written at the call site — a
 *  missing tenant never decays into "every tenant". Each master's own brokerage_id pins every read and write after the sweep. */
export async function runApprovedTopicMediaJobs(svc: MediaJobDb, opts: { scope: import("@/lib/kernel/tenant-scope").TenantScope; max?: number }, deps: TopicMediaJobDeps = {}): Promise<TopicMediaJobResult> {
  const now = (deps.now ?? (() => new Date()))()
  const out: TopicMediaJobResult = { scanned: 0, commissioned: 0, alreadyStaged: 0, held: [], errors: [] }
  const record = deps.record ?? (async (s: MediaJobDb, r: Record<string, unknown>) => (await import("@/lib/kernel/action-ledger")).recordNonAction(r as never, { client: s as never }))
  const commission = deps.commission ?? (async (s: MediaJobDb, situation: Record<string, unknown>, o: Record<string, unknown>): Promise<MediaCommission> => (await import("@/lib/video/video-director")).commissionVideo(situation as never, o as never, s as never))
  const { applyTenantScope } = await import("@/lib/kernel/tenant-scope")
  const q = applyTenantScope(svc.from("social_posts")
    .select("id, brokerage_id, agent_id, user_id, content, post_brief, approved_by, approved_at")
    .eq("approval_status", "approved").eq("ai_generated", true).not("approved_by", "is", null)
    .eq("post_brief->>source", "topic_refurbish").eq("post_brief->>role", "master").is("post_brief->media_job", null)
    .gte("created_at", new Date(now.getTime() - 30 * 86_400_000).toISOString()), opts.scope)
  const { data, error } = await q.order("approved_at", { ascending: false }).limit(25)
  if (error) { out.errors.push(`approved masters unreadable: ${error.message}`); return out }
  type Master = { id: string; brokerage_id: string; agent_id: string | null; user_id: string | null; content: string | null; post_brief: Record<string, any> | null; approved_by: string | null; approved_at: string | null }
  const masters = ((data ?? []) as Master[]).filter((m) => !!m.approved_by && Array.isArray(m.post_brief?.media_partial) && m.post_brief!.media_partial.length > 0 && !m.post_brief!.media_job)
  const { decidePlatformVariant } = await import("@/lib/video/media-variant-contract")
  const { chooseSituationArtifact } = await import("@/lib/video/situation-artifact-choice")
  const max = Math.max(0, opts.max ?? 3)
  for (const m of masters) {
    if (out.commissioned + out.alreadyStaged >= max) break
    out.scanned++
    const pb = m.post_brief ?? {}
    const topicId = String(pb.topic_id ?? "")
    const day = now.toISOString().slice(0, 10)
    const ledger = async (started: boolean, reason: string, detail: Record<string, unknown>) => {
      const r = await record(svc, { brokerageId: m.brokerage_id, domain: "marketing", decision: started ? "send_touch" : "do_nothing", actor: { type: "manager", managerKey: "asset_manager" }, subject: { type: "social_posts", id: m.id, ref: topicId ? `content_topic:${topicId}` : null }, reasonCode: "NURTURE_TOUCH", reasonDetail: reason.slice(0, 500), cycle: started ? `topic_media:post:${m.id}` : `topic_media:post:${m.id}:held:${day}`, systemSource: "topic_media_job", policyKey: "refurbish_trigger", detail: { media_job: detail } }).catch((e: unknown) => ({ recorded: false, error: e instanceof Error ? e.message : String(e) }))
      if (!r.recorded) out.errors.push(`${m.id}: decision NOT ledgered (${r.error ?? "refused"})`)
    }
    const hold = async (reason: string, detail: Record<string, unknown> = {}) => { out.held.push({ postId: m.id, reason }); await ledger(false, reason, { outcome: "held", ...detail }) }
    if (!pb.topic_expires_at || !(Date.parse(String(pb.topic_expires_at)) > now.getTime())) { await hold("the topic's freshness window ended — closed, never produced late"); continue }
    if (!m.user_id || !m.agent_id) { await hold("the master names no creator owner (user + agent) — nothing is produced under nobody's seat"); continue }
    const wanted = [...new Set((pb.media_partial as unknown[]).map((p) => String(p).toLowerCase()))]
    const { data: accts, error: aErr } = await svc.from("social_media_accounts").select("platform, is_active, scope").eq("brokerage_id", m.brokerage_id).eq("agent_id", m.agent_id).in("platform", wanted)
    if (aErr) { await hold(`the sender's connected accounts could not be read (${aErr.message}) — nothing produced`); continue }
    const byPlatform = new Map<string, { isActive: boolean; scope: string | null }>()
    for (const a of (accts ?? []) as Array<{ platform: string; is_active: boolean | null; scope: string | null }>) {
      const prev = byPlatform.get(a.platform)
      if (!prev || (!prev.isActive && a.is_active)) byPlatform.set(a.platform, { isActive: a.is_active === true, scope: a.scope ?? null })
    }
    // PLANNED media: the explainer's square cut (AgentExplainerReel, 1:1 — vertical feeds take it). distribute.ts re-runs the
    // contract on the REAL render (its recorded format and duration, verified playable) before any draft exists.
    const verdicts = wanted.map((platform) => decidePlatformVariant({ platform, account: byPlatform.get(platform) ?? null, media: { kind: "video", playable: true, aspect: "1:1", durationSeconds: null } }))
    const admitted = verdicts.flatMap((v) => (v.ok ? [v] : []))
    const refused = verdicts.flatMap((v) => (v.ok ? [] : [{ platform: v.platform, reason: v.reason }]))
    if (!admitted.length) { await hold(`no platform may carry a video for this sender: ${refused.map((r) => `${r.platform} — ${r.reason}`).join("; ")}`, { refused_variants: refused }); continue }
    const approvedText = String(m.content ?? "").trim()
    const choice = chooseSituationArtifact({ kind: "lead_magnet_topic", sourceFacts: approvedText ? [{ fact: approvedText.slice(0, 280), source: `social_posts:${m.id} (approved master)`, asOf: m.approved_at }] : [], recipient: { type: "audience", videoOptOut: false, playableVia: ["social"], writtenVia: ["social"] }, producer: { avatarReady: null, renderReady: true }, agentAssigned: true })
    if (choice.chosen !== "educational_video") { await hold(`no reel is warranted: ${choice.why}`, { choice: choice.chosen, refused_variants: refused }); continue }
    // FAIR HOUSING ON WHAT THE REEL WILL SAY (CLAUDE.md §5; eval BIAS-003): a hard flag escalates to a person and nothing renders;
    // advisory findings pass through to the Director's own compliance-first hook gate. A screen that cannot run holds (fail closed).
    const title = `Topic reel — ${approvedText.slice(0, 60) || topicId}`
    const fh = await (deps.screen ?? prodScreenSpokenText)(svc, { text: approvedText, userId: m.user_id, brokerageId: m.brokerage_id, title }).catch((e: unknown) => ({ hard: [] as string[], escalated: false, error: `screen threw: ${e instanceof Error ? e.message : String(e)}` }))
    if (fh.error && !fh.hard.length) { await hold(`the fair-housing screen could not run (${fh.error}) — nothing rendered unscreened`, { outcome: "screen_unavailable" }); continue }
    if (fh.hard.length) { await hold(`hard fair-housing flag — ${fh.escalated ? "escalated to a person for review" : `escalation NOT filed (${fh.error ?? "refused"})`}; nothing rendered: ${fh.hard.slice(0, 3).join("; ")}`, { outcome: "escalated_fair_housing", red_flags: fh.hard, escalated: fh.escalated }); continue }
    const mediaJob = {
      master_post_id: m.id, topic_id: topicId || null,
      creator_owner: { user_id: m.user_id, agent_id: m.agent_id }, approved_by: m.approved_by, approved_at: m.approved_at,
      executed_by: { type: "service", manager: "asset_manager", job: "topic_media", worker: "cron:publish-social-posts" },
      planned_variants: admitted.map((v) => ({ platform: v.platform, route: v.route, format: v.format, permission: v.permission })), refused_variants: refused,
      source_facts: [{ source: `social_posts:${m.id} (approved master)`, as_of: m.approved_at }],
      usage_rights: String(pb.rights ?? "unstated"), privacy: "public_marketing", decision: choice.why, artifacts: choice.artifacts,
    }
    const c: MediaCommission = await commission(svc,
      { kind: "explainer", tier: "solo_agent", targetChannel: "tiktok", facts: { topic_id: topicId || null, approved_text: approvedText.slice(0, 600) } },
      { brokerageId: m.brokerage_id, agentUserId: m.user_id, idempotencyDiscriminator: `topic_media:${m.id}`, autonomous: true, spokenScript: approvedText || null, title, meterFeature: "topic_media_job",
        extraMetadata: { media_job: mediaJob, repurpose: { channels: admitted.map((v) => v.format), distribute_as_draft: true, rights_basis: pb.rights ?? null } } },
    ).catch((e: unknown): MediaCommission => ({ ok: false, status: "failed", reason: e instanceof Error ? e.message : String(e) }))
    if (!c.ok || !c.videoProjectId) { await hold(`the reel was not staged (${c.status}: ${c.reason ?? "no project"}) — nothing claimed as produced`, { commission_status: c.status, refused_variants: refused }); continue }
    const stamp = { video_project_id: c.videoProjectId, status: c.status, at: now.toISOString(), executed_by: mediaJob.executed_by }
    const { data: upd, error: sErr } = await svc.from("social_posts").update({ post_brief: { ...pb, media_job: stamp }, updated_at: now.toISOString() }).eq("id", m.id).eq("brokerage_id", m.brokerage_id).select("id")
    if (sErr || !Array.isArray(upd) || upd.length === 0) out.errors.push(`${m.id}: reel ${c.videoProjectId} staged but the master was NOT stamped (${sErr?.message ?? "matched no row"}) — the director_key keeps a replay from staging twice`)
    if (c.status === "already_staged") out.alreadyStaged++; else out.commissioned++
    await ledger(true, `an educational reel of the approved master is ${c.status === "already_staged" ? "already staged" : "staged"} (${c.videoProjectId}) for ${admitted.map((v) => `${v.platform}:${v.route}`).join(", ")}${refused.length ? `; refused ${refused.map((r) => r.platform).join(", ")}` : ""}`, { outcome: c.status, video_project_id: c.videoProjectId, ...mediaJob })
  }
  return out
}
