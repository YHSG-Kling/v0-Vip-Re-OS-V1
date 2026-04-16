"use server"

/**
 * lib/marketing/campaign-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 9.1 — Marketing Campaign Registry
 *
 * Provides unified read access across all content sources that can be
 * registered to a marketing campaign. Content sources include:
 * - newsletter_campaigns
 * - direct_mail_campaigns
 * - social_posts
 * - video_snippets
 * - ai_video_projects
 * - video_scripts_library
 * - repurposed_content_log
 *
 * This module does NOT own any tables — it only reads from existing tables
 * and writes to marketing_assets when registering a source to a campaign.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type ContentSourceTable =
  | "newsletter_campaigns"
  | "direct_mail_campaigns"
  | "social_posts"
  | "video_snippets"
  | "ai_video_projects"
  | "video_scripts_library"
  | "repurposed_content_log"

export interface ContentSourceItem {
  id: string
  sourceTable: ContentSourceTable
  title: string
  status: string
  createdAt: string
  thumbnailUrl?: string
  previewText?: string
  channel?: string
  metadata?: Record<string, unknown>
}

export interface CampaignRegistryFilters {
  sourceTable?: ContentSourceTable
  status?: string
  search?: string
  limit?: number
  offset?: number
}

// ─── SOURCE TABLE CONFIGS ─────────────────────────────────────────────────────

interface SourceConfig {
  titleColumn: string
  statusColumn: string
  thumbnailColumn?: string
  previewColumn?: string
  channelColumn?: string
  additionalSelect?: string
}

const SOURCE_CONFIGS: Record<ContentSourceTable, SourceConfig> = {
  newsletter_campaigns: {
    titleColumn: "campaign_name",
    statusColumn: "status",
    previewColumn: "subject_line",
    channelColumn: "'email'",
  },
  direct_mail_campaigns: {
    titleColumn: "campaign_name",
    statusColumn: "status",
    thumbnailColumn: "design_url",
    channelColumn: "'direct_mail'",
  },
  social_posts: {
    titleColumn: "content",
    statusColumn: "status",
    previewColumn: "content",
    channelColumn: "platform",
    additionalSelect: "media_urls, hashtags",
  },
  video_snippets: {
    titleColumn: "snippet_title",
    statusColumn: "approval_status",
    thumbnailColumn: "thumbnail_url",
    previewColumn: "caption_text",
    channelColumn: "platform_target",
  },
  ai_video_projects: {
    titleColumn: "title",
    statusColumn: "status",
    thumbnailColumn: "video_url",
    previewColumn: "script_content",
    channelColumn: "video_type",
  },
  video_scripts_library: {
    titleColumn: "title",
    statusColumn: "approval_status",
    previewColumn: "script_content",
    channelColumn: "script_type",
  },
  repurposed_content_log: {
    titleColumn: "output_type",
    statusColumn: "status",
    channelColumn: "platform_target",
    additionalSelect: "source_type, source_id",
  },
}

// ─── MAIN REGISTRY FUNCTION ───────────────────────────────────────────────────

/**
 * getCampaignRegistry
 *
 * Fetches available content sources across all supported tables.
 * Returns a unified list of ContentSourceItem objects that can be
 * registered (linked) to a marketing campaign.
 */
export async function getCampaignRegistry(
  filters?: CampaignRegistryFilters
): Promise<{ success: boolean; items: ContentSourceItem[]; error?: string }> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const items: ContentSourceItem[] = []
  const limit = filters?.limit ?? 50
  const offset = filters?.offset ?? 0

  // Determine which tables to query
  const tablesToQuery: ContentSourceTable[] = filters?.sourceTable
    ? [filters.sourceTable]
    : (Object.keys(SOURCE_CONFIGS) as ContentSourceTable[])

  for (const table of tablesToQuery) {
    const config = SOURCE_CONFIGS[table]

    try {
      // Build select columns
      const selectCols = [
        "id",
        `${config.titleColumn} as title`,
        `${config.statusColumn} as status`,
        "created_at",
        config.thumbnailColumn ? `${config.thumbnailColumn} as thumbnail_url` : null,
        config.previewColumn ? `${config.previewColumn} as preview_text` : null,
        config.channelColumn ? `${config.channelColumn} as channel` : null,
        config.additionalSelect ?? null,
      ]
        .filter(Boolean)
        .join(", ")

      let query = supabase
        .from(table)
        .select(selectCols)
        .eq("brokerage_id", brokerageId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1)

      if (filters?.status) {
        query = query.eq(config.statusColumn, filters.status)
      }

      if (filters?.search) {
        query = query.ilike(config.titleColumn, `%${filters.search}%`)
      }

      const { data, error } = await query

      if (error) {
        console.error(`[v0] Error querying ${table}:`, error)
        continue
      }

      for (const row of data ?? []) {
        const r = row as any
        items.push({
          id: r.id,
          sourceTable: table,
          title: truncateText(r.title ?? `${table} item`, 100) ?? "",
          status: r.status ?? "unknown",
          createdAt: r.created_at,
          thumbnailUrl: r.thumbnail_url ?? undefined,
          previewText: truncateText(r.preview_text, 200),
          channel: r.channel ?? undefined,
          metadata: r as Record<string, unknown>,
        })
      }
    } catch (err) {
      console.error(`[v0] Exception querying ${table}:`, err)
    }
  }

  // Sort combined results by created_at descending
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return { success: true, items: items.slice(0, limit) }
}

// ─── REGISTER SOURCE TO CAMPAIGN ──────────────────────────────────────────────

/**
 * registerCampaignSource
 *
 * Links an existing content item from any source table to a marketing campaign
 * by creating a corresponding marketing_assets record.
 */
export async function registerCampaignSource(params: {
  campaignId: string
  sourceTable: ContentSourceTable
  sourceId: string
  assetName?: string
}): Promise<{ success: boolean; assetId?: string; error?: string }> {
  const { userId, agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Fetch source item to get metadata
  const config = SOURCE_CONFIGS[params.sourceTable]
  const { data: sourceItem, error: fetchError } = await supabase
    .from(params.sourceTable)
    .select(`id, ${config.titleColumn}, ${config.thumbnailColumn ?? "null as thumbnail"}, ${config.previewColumn ?? "null as preview"}`)
    .eq("id", params.sourceId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (fetchError || !sourceItem) {
    return { success: false, error: "Source item not found" }
  }

  // Map source table to asset type
  const assetTypeMap: Record<ContentSourceTable, string> = {
    newsletter_campaigns: "email",
    direct_mail_campaigns: "direct_mail",
    social_posts: "social_post",
    video_snippets: "video",
    ai_video_projects: "video",
    video_scripts_library: "document",
    repurposed_content_log: "document",
  }

  const { data: asset, error: insertError } = await supabase
    .from("marketing_assets")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: agentId,
      created_by: userId,
      campaign_id: params.campaignId,
      asset_type: assetTypeMap[params.sourceTable],
      asset_name: params.assetName ?? (sourceItem as any)[config.titleColumn] ?? "Untitled",
      source_table: params.sourceTable,
      source_id: params.sourceId,
      thumbnail_url: (sourceItem as any).thumbnail ?? null,
      preview_text: truncateText((sourceItem as any).preview, 500),
      approval_status: "pending",
      visibility_scope: "agent",
    })
    .select("id")
    .single()

  if (insertError) {
    console.error("[v0] Error registering source:", insertError)
    return { success: false, error: insertError.message }
  }

  return { success: true, assetId: asset.id }
}

// ─── UNREGISTER SOURCE ────────────────────────────────────────────────────────

/**
 * unregisterCampaignSource
 *
 * Removes a source item from a campaign by deleting the marketing_assets record.
 * Does NOT delete the source item itself.
 */
export async function unregisterCampaignSource(assetId: string): Promise<{ success: boolean; error?: string }> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { error } = await supabase
    .from("marketing_assets")
    .delete()
    .eq("id", assetId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    console.error("[v0] Error unregistering source:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── GET CAMPAIGN SOURCES ─────────────────────────────────────────────────────

/**
 * getCampaignSources
 *
 * Returns all content sources registered to a specific campaign.
 */
export async function getCampaignSources(campaignId: string): Promise<{
  success: boolean
  sources: ContentSourceItem[]
  error?: string
}> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data: assets, error } = await supabase
    .from("marketing_assets")
    .select("id, source_table, source_id, asset_name, thumbnail_url, preview_text, approval_status, created_at")
    .eq("campaign_id", campaignId)
    .eq("brokerage_id", brokerageId)
    .not("source_table", "is", null)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[v0] Error fetching campaign sources:", error)
    return { success: false, sources: [], error: error.message }
  }

  const sources: ContentSourceItem[] = (assets ?? []).map((a) => ({
    id: a.source_id!,
    sourceTable: a.source_table as ContentSourceTable,
    title: a.asset_name ?? "Untitled",
    status: a.approval_status ?? "pending",
    createdAt: a.created_at,
    thumbnailUrl: a.thumbnail_url ?? undefined,
    previewText: a.preview_text ?? undefined,
  }))

  return { success: true, sources }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function truncateText(text: string | null | undefined, maxLength: number): string | undefined {
  if (!text) return undefined
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + "..."
}
