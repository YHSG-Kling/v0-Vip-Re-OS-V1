"use server"

/**
 * app/actions/direct-mail-settings.ts
 *
 * Wave 36 — server actions for the Direct Mail Settings page.
 * Two concerns: brokerage-level farm-mail config + per-tenant
 * competitor watchlist CRUD.
 *
 * All actions gated through resolvePolicyScopeAccess so a brokerage
 * admin can only edit their own row + their own watchlist. No
 * cross-tenant writes possible.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { revalidatePath } from "next/cache"

export interface FarmMailConfig {
  farm_mail_enabled:        boolean
  farm_mail_max_per_week:   number | null
  lob_fallback_template_id: string | null
}

export interface CompetitorWatchlistEntry {
  id:                  string
  competitor_name:     string
  facebook_page_id:    string | null
  google_advertiser_id: string | null
  watch_zip_codes:     string[] | null
  min_engagement_score: number | null
  is_active:           boolean
}

/** Read the brokerage's current farm-mail config + competitor watchlist. */
export async function getDirectMailSettings(): Promise<{
  success:  true
  config:   FarmMailConfig
  watchlist: CompetitorWatchlistEntry[]
} | { success: false; error: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const svc = createServiceClient()
  const brokerageId = access.brokerageScopeId

  const [brokerageR, watchlistR] = await Promise.all([
    svc.from("brokerages")
      .select("farm_mail_enabled, farm_mail_max_per_week, lob_fallback_template_id")
      .eq("id", brokerageId)
      .maybeSingle(),
    svc.from("competitor_brokerages")
      .select("id, competitor_name, facebook_page_id, google_advertiser_id, watch_zip_codes, min_engagement_score, is_active")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false }),
  ])

  const config = (brokerageR.data ?? {
    farm_mail_enabled: false,
    farm_mail_max_per_week: null,
    lob_fallback_template_id: null,
  }) as FarmMailConfig
  const watchlist = (watchlistR.data ?? []) as CompetitorWatchlistEntry[]

  return { success: true, config, watchlist }
}

export async function saveFarmMailConfig(input: {
  farm_mail_enabled:        boolean
  farm_mail_max_per_week:   number | null
  lob_fallback_template_id: string | null
}): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }

  // Validate: if enabling, must have a fallback template
  if (input.farm_mail_enabled && !input.lob_fallback_template_id?.trim()) {
    return {
      success: false,
      error: "A Lob fallback template id is required to enable farm mail (it's the safety net when the AI copy gate fails).",
    }
  }
  // Cap sanity: 1-200 contacts per agent per week
  const cap = input.farm_mail_max_per_week
  if (cap !== null && (cap < 1 || cap > 200)) {
    return { success: false, error: "Max per week must be between 1 and 200 contacts." }
  }

  const svc = createServiceClient()
  const { error } = await svc.from("brokerages")
    .update({
      farm_mail_enabled:        input.farm_mail_enabled,
      farm_mail_max_per_week:   input.farm_mail_max_per_week,
      lob_fallback_template_id: input.lob_fallback_template_id?.trim() || null,
    })
    .eq("id", access.brokerageScopeId)
  if (error) return { success: false, error: error.message }

  revalidatePath("/settings/direct-mail")
  return { success: true }
}

export async function addCompetitorToWatchlist(input: {
  competitor_name:      string
  facebook_page_id?:    string | null
  google_advertiser_id?: string | null
  watch_zip_codes?:     string[] | null
  min_engagement_score?: number | null
}): Promise<{ success: boolean; entryId?: string; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const name = input.competitor_name.trim()
  if (!name) return { success: false, error: "Competitor name required" }
  if (input.min_engagement_score !== undefined && input.min_engagement_score !== null) {
    if (input.min_engagement_score < 0 || input.min_engagement_score > 100) {
      return { success: false, error: "Engagement score threshold must be 0-100." }
    }
  }

  const svc = createServiceClient()
  const { data, error } = await svc.from("competitor_brokerages")
    .insert({
      brokerage_id:         access.brokerageScopeId,
      competitor_name:      name,
      facebook_page_id:     input.facebook_page_id?.trim() || null,
      google_advertiser_id: input.google_advertiser_id?.trim() || null,
      watch_zip_codes:      input.watch_zip_codes ?? null,
      min_engagement_score: input.min_engagement_score ?? null,
      is_active:            true,
    })
    .select("id")
    .single()
  if (error) {
    // unique (brokerage_id, competitor_name) → friendly message
    if (error.code === "23505") {
      return { success: false, error: `"${name}" is already on the watchlist.` }
    }
    return { success: false, error: error.message }
  }

  revalidatePath("/settings/direct-mail")
  return { success: true, entryId: data.id as string }
}

export async function removeCompetitorFromWatchlist(entryId: string): Promise<{ success: boolean; error?: string }> {
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage || !access.brokerageScopeId) {
    return { success: false, error: "Brokerage admin scope required" }
  }
  const svc = createServiceClient()
  // Soft-delete via is_active=false so the audit trail (which ads
  // came from which watchlist row) survives. Promoter only reads
  // is_active=true rows so the entry stops sourcing new ads
  // immediately.
  const { error } = await svc.from("competitor_brokerages")
    .update({ is_active: false })
    .eq("id", entryId)
    .eq("brokerage_id", access.brokerageScopeId)
  if (error) return { success: false, error: error.message }
  revalidatePath("/settings/direct-mail")
  return { success: true }
}
