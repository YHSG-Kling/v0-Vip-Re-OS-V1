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
    // WAVE 154 (lane 154G1 — directive C2 / C4): the source's own topics cascade with it (content_topic_bank.source_id ON
    // DELETE CASCADE, live). A topic of ANOTHER source that merged the same public post (THE ONE intake links observations
    // across sources) survives — so each post URL this source listed is re-evaluated: its observation leaves that topic's
    // provenance, and a topic left with none is retired (lib/content-intel/topic-intake.ts reevaluateRemovedTopicSource).
    const { data: before, error: readErr } = await supabase.from("content_topic_sources").select("source_config")
      .eq("id", id).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    if (readErr) return { ok: false, error: readErr.message }
    if (!before) return { ok: false, error: "source not found in your brokerage" }
    const { data: gone, error } = await supabase
      .from("content_topic_sources")
      .delete()
      .eq("id", id)
      .eq("brokerage_id", ctx.brokerageId)
      .select("id")
    if (error) return { ok: false, error: error.message }
    if ((gone ?? []).length !== 1) return { ok: false, error: "source was not deleted (it may be platform-wide or already gone)" }
    const urls = (before as { source_config?: { community_post_urls?: unknown } }).source_config?.community_post_urls
    if (Array.isArray(urls) && urls.length) {
      const { reevaluateRemovedTopicSource } = await import("@/lib/content-intel/topic-intake")
      for (const u of urls.filter((x): x is string => typeof x === "string").slice(0, 50)) {
        const r = await reevaluateRemovedTopicSource(supabase, { brokerageId: ctx.brokerageId, sourceUrl: u, disposition: "deleted" })
        if (!r.ok) console.error(`[content-intel/sources] topics citing ${u} not re-evaluated: ${r.error}`)
      }
    }
    revalidatePath("/dashboard/marketing/content-intel")
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * A subscriber's own observation or a permitted link they saved, filed in the ONE topic pool (wave 154, lane 154G1 — lane
 * 154C Outside-lane request 5; directive C5.1). Tenant from the SESSION (CLAUDE.md §4), never the body; the user's RLS
 * client, like every action in this file. The note passes the intake's exclusion gate and personal-data screen.
 */
export async function saveTopicObservationAction(input: { note: string; link?: string | null }): Promise<{ ok: boolean; inserted: number; merged: number; excluded: Array<{ reason: string }>; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, inserted: 0, merged: 0, excluded: [], error: "Unauthorized" }
    const note = String(input?.note ?? "").trim()
    if (!note) return { ok: false, inserted: 0, merged: 0, excluded: [], error: "A note is required" }
    const link = typeof input?.link === "string" && /^https?:\/\//.test(input.link.trim()) ? input.link.trim() : null
    const supabase = await createClient()
    const brokerageId = ctx.brokerageId
    const { saveManualTopicObservation } = await import("@/lib/content-intel/public-chatter-topics")
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    // LAW 5 — who saved what into the pool, and what the intake did with it.
    const r = await withActionLedger(
      {
        brokerageId, action: "intel.topic_observation_saved", actor: { type: "user", userId: ctx.userId },
        subject: { type: "content_topic", ref: link ?? "own_observation" }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED",
        systemSource: "content-intel/sources", reasonDetail: "a subscriber saved their own observation / a permitted link into the topic pool",
      },
      () => saveManualTopicObservation(supabase, { brokerageId, note, link }),
      {
        settle: (x) => ({ status: x.ok ? "executed" as const : "failed" as const, outcome: `inserted ${x.inserted}, merged ${x.merged}, excluded ${x.excluded.length}`, error: x.ok ? null : (x.refused ?? x.errors.slice(0, 2).join("; ")) }),
        replay: (claim) => ({ ok: false, inserted: 0, merged: 0, excluded: [], rows: [], strippedFields: 0, sameObservation: 0, errors: [claim.kind === "refused" ? `action ledger refused: ${claim.error}` : `duplicate save (${claim.kind})`], refused: claim.kind === "refused" ? "ledger_refused" : undefined }),
      },
    )
    if (r.inserted + r.merged > 0) revalidatePath("/dashboard/marketing/content-intel")
    if (!r.ok) console.error(`[content-intel/sources] topic observation not saved for ${brokerageId}: ${r.refused ?? r.errors.join("; ")}`)
    return { ok: r.ok, inserted: r.inserted, merged: r.merged, excluded: r.excluded.map((x) => ({ reason: x.reason })), ...(r.ok ? {} : { error: "The topic could not be saved. Please try again." }) }
  } catch (e) {
    return { ok: false, inserted: 0, merged: 0, excluded: [], error: (e as Error).message }
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
