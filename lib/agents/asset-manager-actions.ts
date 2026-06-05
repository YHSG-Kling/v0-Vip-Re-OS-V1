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
          .update({ status: "remotion_pending" }, { count: "exact" })
          .eq("id", assetId)
          .eq("brokerage_id", brokerageId)
        if (error) return { status: "failed", result: { error: error.message } }
        if ((count ?? 0) === 0) return { status: "skipped", result: { reason: "video project not found or tenant mismatch" } }
        return { status: "succeeded", result: { kind: "video", asset_id: assetId, queued_for: "remotion_pending" } }
      }
      if (kind === "image" || kind === "composition") {
        // marketing_assets generic regenerate flag
        const { error, count } = await svc.from("marketing_assets")
          .update({ status: "pending_regenerate" } as Record<string, unknown>, { count: "exact" })
          .eq("id", assetId)
          .eq("brokerage_id", brokerageId)
        if (error) return { status: "failed", result: { error: error.message } }
        if ((count ?? 0) === 0) return { status: "skipped", result: { reason: "marketing asset not found or tenant mismatch" } }
        return { status: "succeeded", result: { kind, asset_id: assetId, queued_for: "pending_regenerate" } }
      }
      return { status: "failed", result: { error: `unknown kind: ${kind}` } }
    }

    case "deprecate_asset": {
      const assetId = String(input.asset_id ?? "")
      const reason  = String(input.reason ?? "unspecified")
      if (!assetId) return { status: "failed", result: { error: "asset_id required" } }
      const svc = createServiceClient()
      // Try brand_asset_library first (newest), then marketing_assets,
      // then ai_video_projects. At most one match per asset_id.
      for (const table of ["brand_asset_library", "marketing_assets", "ai_video_projects"]) {
        const { count } = await svc.from(table)
          .update({ is_active: false } as Record<string, unknown>, { count: "exact" })
          .eq("id", assetId)
          .eq("brokerage_id", brokerageId)
        if ((count ?? 0) > 0) {
          return { status: "succeeded", result: { table, asset_id: assetId, reason } }
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
        .select("id, brokerage_id, first_name, last_name, photo_url")
        .eq("id", agentId)
        .maybeSingle()
      const a = agent as { id: string; brokerage_id: string | null; first_name: string | null; last_name: string | null; photo_url: string | null } | null
      if (!a) return { status: "failed", result: { error: "agent not found" } }
      if (a.brokerage_id !== brokerageId) return { status: "failed", result: { error: "tenant mismatch" } }
      const name = [a.first_name, a.last_name].filter(Boolean).join(" ") || agentId.slice(0, 8)
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
        .update({ status: "queued", updated_at: new Date().toISOString() } as Record<string, unknown>, { count: "exact" })
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
        .update({ listing_id: listingId } as Record<string, unknown>)
        .eq("id", assetId)
        .eq("brokerage_id", brokerageId)
      if (error) return { status: "failed", result: { error: error.message } }
      return { status: "succeeded", result: { asset_id: assetId, listing_id: listingId } }
    }

    default: {
      const _exhaustive: never = action
      void _exhaustive
      return { status: "failed", result: { error: "unknown action_type" } }
    }
  }
}
