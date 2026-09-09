"use server"

// app/actions/chatgpt-ads.ts
// Server actions for the ChatGPT Ads lane (OpenAI Ads Manager — ads.openai.com).
// Thin, session-authenticated wrappers over lib/ads/chatgpt-campaign.ts. Modeled
// exactly on app/actions/ctv-ads.ts: the tenant comes from the SESSION, never
// from the caller's input (CLAUDE.md §4), and the lib functions take the
// service client only after that gate has run.

import { createClient } from "@/lib/supabase/server"
import { requireAdsActor as requireActor } from "@/lib/auth/require-caller"
import {
  stageChatgptCampaign,
  markChatgptCampaignLaunched,
  importChatgptPerformance,
  launchChatgptCampaignOnOpenai,
  type ChatgptLaunchPackage,
  type ChatgptObjective,
} from "@/lib/ads/chatgpt-campaign"
import type { ListingAdKind } from "@/lib/ads/listing-ad-producer"
import type { ProviderPerformanceRow } from "@/lib/ads/connectors/types"
import type { ChatgptDispatchResult } from "@/lib/providers/openai-ads"

// TOMBSTONE: local requireActor merged onto lib/auth/require-caller.ts
// requireAdsActor (imported above as `requireActor`) — §1/§6 SAME BODY census
// round 3, 2026-09-09.

export async function stageChatgptCampaignAction(input: {
  listingId: string
  kind?: ListingAdKind
  objective?: ChatgptObjective
  dailyBudgetUsd?: number
  campaignName?: string
  extraContextHints?: string[]
}): Promise<{ success: boolean; error?: string; package?: ChatgptLaunchPackage; alreadyStaged?: boolean }> {
  const { actor, error } = await requireActor()
  if (!actor) return { success: false, error }

  return stageChatgptCampaign({
    brokerageId: actor.brokerageId,
    agentUserId: actor.userId,
    listingId: input.listingId,
    kind: input.kind,
    objective: input.objective,
    dailyBudgetUsd: input.dailyBudgetUsd,
    campaignName: input.campaignName,
    extraContextHints: input.extraContextHints,
  })
}

/**
 * Human confirmation that the campaign was actually launched at
 * ads.openai.com. draft → 'live', recording the Ads Manager campaign id.
 */
export async function markChatgptCampaignLaunchedAction(
  campaignId: string,
  externalCampaignId?: string | null,
): Promise<{ success: boolean; error?: string }> {
  const { actor, error } = await requireActor()
  if (!actor) return { success: false, error }

  return markChatgptCampaignLaunched({
    brokerageId: actor.brokerageId,
    campaignId,
    actorUserId: actor.userId,
    externalCampaignId,
  })
}

/**
 * Dispatch a staged ChatGPT campaign to OpenAI Ads end-to-end (account → geo
 * lookup → upload → campaign → ad group → ad → activate). Honest:
 * dispatched:true ONLY on an OpenAI-confirmed ACTIVE campaign — and only then
 * is the row flipped to 'live' with the OpenAI ids recorded. On any failure
 * the row is untouched and the real reason is returned (the human-finalize
 * path stays). Mirrors app/actions/ctv-ads.ts::dispatchCtvCampaignAction.
 */
export async function dispatchChatgptCampaignAction(
  campaignId: string,
): Promise<ChatgptDispatchResult | { dispatched: false; reason: string }> {
  const { actor, error } = await requireActor()
  if (!actor) return { dispatched: false, reason: error ?? "Not authenticated" }

  // Ownership check with the user-scoped client before touching the service path.
  const supabase = await createClient()
  const { data: campaign, error: fetchError } = await supabase
    .from("ad_campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  if (fetchError) return { dispatched: false, reason: fetchError.message }
  if (!campaign) return { dispatched: false, reason: "Campaign not found" }

  return launchChatgptCampaignOnOpenai({
    campaignId: campaign.id as string,
    brokerageId: actor.brokerageId,
    actorUserId: actor.userId,
    launchedVia: "openai_ads_api",
  })
}

/** Import an Ads Manager report export (CSV) for a live campaign. */
export async function importChatgptPerformanceAction(
  campaignId: string,
  csv: string,
): Promise<{ success: boolean; error?: string; row?: ProviderPerformanceRow }> {
  const { actor, error } = await requireActor()
  if (!actor) return { success: false, error }

  return importChatgptPerformance({
    brokerageId: actor.brokerageId,
    campaignId,
    csv,
  })
}
