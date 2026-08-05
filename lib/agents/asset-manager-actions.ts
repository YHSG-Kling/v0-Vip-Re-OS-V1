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
  const { data: claimed } = await svc.from("asset_manager_actions")
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
  const row = claimed as { brokerage_id: string; action_type: AssetManagerActionType; action_input: Record<string, unknown> }

  let outcome: ActionHandlerResult
  try {
    outcome = await runHandler(row.action_type, row.brokerage_id, row.action_input)
  } catch (e) {
    outcome = { status: "failed", result: { error: (e as Error).message } }
  }
  await svc.from("asset_manager_actions")
    .update({ status: outcome.status, result: outcome.result })
    .eq("id", actionId)
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
        const { count } = await svc.from("marketing_assets")
          .update({ approval_status: "rejected" }, { count: "exact" })
          .eq("id", assetId)
          .eq("brokerage_id", brokerageId)
        if ((count ?? 0) > 0) {
          return { status: "succeeded", result: { table: "marketing_assets", asset_id: assetId, reason } }
        }
      }
      {
        // ai_video_projects has no is_active either (live-verified) — unpublish
        // is the retire semantics for a video project.
        const { count } = await svc.from("ai_video_projects")
          .update({ is_published: false }, { count: "exact" })
          .eq("id", assetId)
          .eq("brokerage_id", brokerageId)
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

      const queued = await recordRenderQueued({
        brokerageId, compositionId,
        agentUserId, entityType, entityId,
        usedDidAvatar: composition.requires_did_avatar,
        usedVoiceover: composition.requires_voiceover,
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

      // Carry the original render's props + scope forward so the retry
      // reproduces the SAME branded piece, not a defaults sample.
      const queued = await recordRenderQueued({
        brokerageId,
        compositionId: o.composition_id,
        agentUserId:   o.agent_user_id,
        entityType:    o.entity_type,
        entityId:      o.entity_id,
        usedDidAvatar: composition.requires_did_avatar,
        usedVoiceover: composition.requires_voiceover,
        inputProps:    o.input_props ?? {},
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
      if (!VALID_KINDS.has(kind)) return { status: "failed", result: { error: "valid kind required", kind } }
      if (!agentUserId) return { status: "failed", result: { error: "agent_user_id required" } }

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
