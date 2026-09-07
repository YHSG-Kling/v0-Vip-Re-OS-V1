"use server"

// app/actions/chatgpt-ads.ts
// Server actions for the ChatGPT Ads lane (OpenAI Ads Manager — ads.openai.com).
// Thin, session-authenticated wrappers over lib/ads/chatgpt-campaign.ts. Modeled
// exactly on app/actions/ctv-ads.ts: the tenant comes from the SESSION, never
// from the caller's input (CLAUDE.md §4), and the lib functions take the
// service client only after that gate has run.

import { createClient } from "@/lib/supabase/server"
import {
  stageChatgptCampaign,
  markChatgptCampaignLaunched,
  importChatgptPerformance,
  type ChatgptLaunchPackage,
  type ChatgptObjective,
} from "@/lib/ads/chatgpt-campaign"
import type { ListingAdKind } from "@/lib/ads/listing-ad-producer"
import type { ProviderPerformanceRow } from "@/lib/ads/connectors/types"

interface SessionActor {
  userId: string
  brokerageId: string
}

/** Resolve the signed-in user's brokerage; refuse when unauthenticated.
 *  Copied from app/actions/ctv-ads.ts requireActor() per instruction — not
 *  imported, so this file's session gate stands on its own. */
async function requireActor(): Promise<{ actor?: SessionActor; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  const { data: profile, error } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (error) return { error: error.message }
  if (!profile?.brokerage_id) return { error: "No brokerage on this account" }
  return { actor: { userId: user.id, brokerageId: profile.brokerage_id } }
}

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
