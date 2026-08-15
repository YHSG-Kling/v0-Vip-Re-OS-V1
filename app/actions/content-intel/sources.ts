/**
 * app/actions/content-intel/sources.ts
 *
 * Wave 19 — brokerage admin server actions for content_topic_sources.
 *
 * Per the canonical app rule: brokerage-scoped writes go through getAgentContext
 * (auth gate + brokerage_id derivation), never through service client. Service
 * client is reserved for cron/system paths. The list/create/toggle/delete
 * actions here all operate on the caller's brokerage_id only.
 */
"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export type SourceTypeUI = "reddit" | "exa_query" | "rss" | "apify_actor" | "manual"

export interface ContentSourceRow {
  id:            string
  source_type:   string
  label:         string | null
  source_config: Record<string, unknown>
  is_active:     boolean
  last_run_at:   string | null
  brokerage_id:  string | null
  created_at:    string
}

/** List sources visible to the caller's brokerage. Includes:
 *  - All platform-wide sources (brokerage_id IS NULL)
 *  - The brokerage's own private sources
 *  Platform-wide rows are read-only from the brokerage UI. */
export async function listContentSources(): Promise<{ ok: true; sources: ContentSourceRow[] } | { ok: false; error: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("content_topic_sources")
      .select("id, source_type, label, source_config, is_active, last_run_at, brokerage_id, created_at")
      .or(`brokerage_id.is.null,brokerage_id.eq.${ctx.brokerageId}`)
      .order("brokerage_id", { ascending: false, nullsFirst: false }) // brokerage rows first
      .order("created_at",  { ascending: false })
    if (error) return { ok: false, error: error.message }
    return { ok: true, sources: (data ?? []) as ContentSourceRow[] }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Create a brokerage-private content source. Type-specific input shapes:
 *
 *   reddit       — { subreddit: string, window?: 'day' | 'week' | 'month' }
 *   exa_query    — { query: string, withinDays?: number, type?: 'neural' | 'keyword' | 'auto', category?: string }
 *   rss          — { feed_url: string, source_trust?: number }
 *   apify_actor  — { actor: string, input: object, title_field?: string, url_field?: string,
 *                    engagement_fields?: string[], geo_relevance?: { cities?: [], states?: [], zip_codes?: [] } }
 *   manual       — (no config — used for hand-curated topic seeds)
 */
export async function createContentSource(input: {
  type:   SourceTypeUI
  label:  string
  config: Record<string, unknown>
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }

    // Map UI type → DB source_type. The DB column stores 'youtube_search' for
    // Exa (legacy overload from Wave 17) — we expose 'exa_query' in the UI for
    // clarity and translate at insert time.
    const dbType =
      input.type === "exa_query" ? "youtube_search"
      : input.type === "reddit"      ? "reddit"
      : input.type === "rss"         ? "rss"
      : input.type === "apify_actor" ? "apify_actor"
      : "manual"

    if (!input.label.trim()) return { ok: false, error: "label is required" }
    const validation = validateConfig(input.type, input.config)
    if (!validation.ok) return { ok: false, error: validation.error }

    const supabase = await createClient()
    const { data, error } = await supabase
      .from("content_topic_sources")
      .insert({
        source_type:   dbType,
        source_config: input.config,
        label:         input.label.trim(),
        brokerage_id:  ctx.brokerageId,
        is_active:     true,
      })
      .select("id")
      .single()
    if (error || !data) return { ok: false, error: error?.message ?? "insert failed" }
    revalidatePath("/dashboard/marketing/content-intel")
    return { ok: true, id: data.id as string }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function toggleContentSource(id: string, isActive: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
    const supabase = await createClient()
    const { error } = await supabase
      .from("content_topic_sources")
      .update({ is_active: isActive })
      .eq("id", id)
      .eq("brokerage_id", ctx.brokerageId) // only brokerage's own rows; platform-wide are protected
    if (error) return { ok: false, error: error.message }
    revalidatePath("/dashboard/marketing/content-intel")
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function deleteContentSource(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
    const supabase = await createClient()
    const { error } = await supabase
      .from("content_topic_sources")
      .delete()
      .eq("id", id)
      .eq("brokerage_id", ctx.brokerageId)
    if (error) return { ok: false, error: error.message }
    revalidatePath("/dashboard/marketing/content-intel")
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ─── Config validation ─────────────────────────────────────────────────────

function validateConfig(type: SourceTypeUI, config: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  if (type === "reddit") {
    if (typeof config.subreddit !== "string" || !config.subreddit.trim()) {
      return { ok: false, error: "reddit source requires a non-empty subreddit" }
    }
  } else if (type === "exa_query") {
    if (typeof config.query !== "string" || !config.query.trim()) {
      return { ok: false, error: "exa_query source requires a non-empty query" }
    }
  } else if (type === "rss") {
    if (typeof config.feed_url !== "string" || !/^https?:\/\//.test(config.feed_url)) {
      return { ok: false, error: "rss source requires feed_url starting with http(s)://" }
    }
  } else if (type === "apify_actor") {
    if (typeof config.actor !== "string" || !config.actor.includes("/")) {
      return { ok: false, error: "apify_actor source requires actor in <namespace>/<slug> form" }
    }
    if (typeof config.input !== "object" || config.input === null) {
      return { ok: false, error: "apify_actor source requires input object" }
    }
  }
  return { ok: true }
}
