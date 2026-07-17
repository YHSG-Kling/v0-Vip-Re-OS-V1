"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

// ============================================
// MARKET CONFIGURATION
// ============================================

/**
 * SUBSCRIBER SERVICE AREAS SYNC (burn-down round 5, owner spec): subscriber_
 * service_areas is the per-zip roster of ACTIVE SUBSCRIBER TERRITORIES — it
 * feeds the platform's global lead-distribution rotation AND mirrors the
 * scraper work-list. A market's zips ARE the subscriber's claimed territory,
 * so every market create/update syncs one row per zip (no unique index —
 * check-then-insert) and a market delete deactivates them (history kept).
 */
async function syncServiceAreasForMarket(
  supabase: Awaited<ReturnType<typeof createClient>>,
  market: { brokerage_id: string; team_id?: string | null; agent_id?: string | null; zip_codes?: string[] | null; city?: string | null; state?: string | null },
) {
  const zips = Array.from(new Set((market.zip_codes ?? []).filter((z) => /^\d{5}$/.test(z))))
  if (!market.brokerage_id) return
  for (const zip of zips) {
    const { data: existing } = await supabase
      .from("subscriber_service_areas")
      .select("id, active")
      .eq("brokerage_id", market.brokerage_id)
      .eq("zip_code", zip)
      .maybeSingle()
    if (existing) {
      if (!(existing as any).active) {
        await supabase.from("subscriber_service_areas").update({ active: true }).eq("id", (existing as any).id)
      }
    } else {
      await supabase.from("subscriber_service_areas").insert({
        brokerage_id: market.brokerage_id,
        team_id: market.team_id ?? null,
        agent_user_id: null, // brokerage-level territory claim; agent claims come later
        zip_code: zip,
        city: market.city ?? null,
        state: market.state ?? null,
        is_primary: false,
        active: true,
        joined_at: new Date().toISOString(),
      })
    }
  }
}

export async function getScrapingMarkets() {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("lead_scraping_markets")
      .select(`
        *,
        lead_scraping_property_params(*),
        lead_scraping_motivated_params(*)
      `)
      .order("priority", { ascending: false })

    if (error) throw error
    return { success: true, markets: data || [] }
  } catch (error) {
    console.error("[v0] Error fetching scraping markets:", error)
    return { success: true, markets: [] }
  }
}

export async function createScrapingMarket(marketData: {
  name: string
  city: string
  state: string
  zip_codes?: string[]
  counties?: string[]
  radius_miles?: number
  priority?: number
}) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.from("lead_scraping_markets").insert(marketData).select().single()

    if (error) throw error
    // Territory enrollment: the market's zips become active subscriber
    // service areas (distribution rotation + scraper territory roster).
    await syncServiceAreasForMarket(supabase, data as any).catch(() => {})
    revalidatePath("/dashboard/admin/sla-monitor")
    return { success: true, market: data }
  } catch (error) {
    console.error("[v0] Error creating scraping market:", error)
    return { success: false, error: String(error) }
  }
}

export async function updateScrapingMarket(
  id: string,
  updates: Partial<{
    name: string
    city: string
    state: string
    zip_codes: string[]
    counties: string[]
    radius_miles: number
    priority: number
    is_active: boolean
  }>,
) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("lead_scraping_markets")
      .update(updates)
      .eq("id", id)
      .select()
      .single()

    if (error) throw error
    await syncServiceAreasForMarket(supabase, data as any).catch(() => {})
    revalidatePath("/dashboard/admin/sla-monitor")
    return { success: true, market: data }
  } catch (error) {
    console.error("[v0] Error updating scraping market:", error)
    return { success: false, error: String(error) }
  }
}

export async function deleteScrapingMarket(id: string) {
  try {
    const supabase = await createClient()
    // Deactivate the territory claims BEFORE the market goes (history kept —
    // the distribution engine only rotates active=true rows).
    const { data: market } = await supabase
      .from("lead_scraping_markets").select("brokerage_id, zip_codes").eq("id", id).maybeSingle()
    if (market?.brokerage_id && Array.isArray((market as any).zip_codes)) {
      await supabase.from("subscriber_service_areas")
        .update({ active: false })
        .eq("brokerage_id", (market as any).brokerage_id)
        .in("zip_code", (market as any).zip_codes)
    }
    const { error } = await supabase.from("lead_scraping_markets").delete().eq("id", id)

    if (error) throw error
    revalidatePath("/dashboard/admin/sla-monitor")
    return { success: true }
  } catch (error) {
    console.error("[v0] Error deleting scraping market:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// KEYWORD CONFIGURATION
// ============================================

export async function getScrapingKeywords() {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("lead_scraping_keywords")
      .select("*")
      .order("keyword_type", { ascending: true })
      .order("weight", { ascending: false })

    if (error) throw error
    return { success: true, keywords: data || [] }
  } catch (error) {
    console.error("[v0] Error fetching scraping keywords:", error)
    return { success: true, keywords: [] }
  }
}

export async function createScrapingKeyword(keywordData: {
  keyword: string
  category: string
  weight?: number
  sources?: string[]
}) {
  try {
    const supabase = await createClient()
    // live column is keyword_type, not category
    const { category, ...rest } = keywordData
    const { data, error } = await supabase
      .from("lead_scraping_keywords")
      .insert({ ...rest, keyword_type: category })
      .select()
      .single()

    if (error) throw error
    revalidatePath("/dashboard/admin/sla-monitor")
    return { success: true, keyword: data }
  } catch (error) {
    console.error("[v0] Error creating keyword:", error)
    return { success: false, error: String(error) }
  }
}

export async function updateScrapingKeyword(
  id: string,
  updates: Partial<{
    keyword: string
    category: string
    weight: number
    sources: string[]
    is_active: boolean
  }>,
) {
  try {
    const supabase = await createClient()
    // live column is keyword_type, not category
    const { category, ...rest } = updates
    const dbUpdates = category !== undefined ? { ...rest, keyword_type: category } : rest
    const { data, error } = await supabase.from("lead_scraping_keywords").update(dbUpdates).eq("id", id).select().single()

    if (error) throw error
    revalidatePath("/dashboard/admin/sla-monitor")
    return { success: true, keyword: data }
  } catch (error) {
    console.error("[v0] Error updating keyword:", error)
    return { success: false, error: String(error) }
  }
}

export async function deleteScrapingKeyword(id: string) {
  try {
    const supabase = await createClient()
    const { error } = await supabase.from("lead_scraping_keywords").delete().eq("id", id)

    if (error) throw error
    revalidatePath("/dashboard/admin/sla-monitor")
    return { success: true }
  } catch (error) {
    console.error("[v0] Error deleting keyword:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// PROPERTY SEARCH PARAMETERS (for ZenRows buyer detection)
// ============================================

export async function createPropertyParams(
  marketId: string,
  params: {
    min_price?: number
    max_price?: number
    min_beds?: number
    max_beds?: number
    min_baths?: number
    max_baths?: number
    property_types?: string[]
    target_sites?: string[]
  },
) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("lead_scraping_property_params")
      .insert({ market_id: marketId, ...params })
      .select()
      .single()

    if (error) throw error
    revalidatePath("/dashboard/admin/sla-monitor")
    return { success: true, params: data }
  } catch (error) {
    console.error("[v0] Error creating property params:", error)
    return { success: false, error: String(error) }
  }
}

export async function updatePropertyParams(
  id: string,
  updates: Partial<{
    min_price: number
    max_price: number
    min_beds: number
    max_beds: number
    min_baths: number
    max_baths: number
    property_types: string[]
    target_sites: string[]
    is_active: boolean
  }>,
) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("lead_scraping_property_params")
      .update(updates)
      .eq("id", id)
      .select()
      .single()

    if (error) throw error
    revalidatePath("/dashboard/admin/sla-monitor")
    return { success: true, params: data }
  } catch (error) {
    console.error("[v0] Error updating property params:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// MOTIVATED SELLER PARAMETERS (for BatchData)
// ============================================

export async function createMotivatedParams(
  marketId: string,
  params: {
    motivation_types?: string[]
    min_equity_percent?: number
    max_days_on_market?: number
    include_expired_listings?: boolean
    include_fsbo?: boolean
  },
) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("lead_scraping_motivated_params")
      .insert({ market_id: marketId, ...params })
      .select()
      .single()

    if (error) throw error
    revalidatePath("/dashboard/admin/sla-monitor")
    return { success: true, params: data }
  } catch (error) {
    console.error("[v0] Error creating motivated params:", error)
    return { success: false, error: String(error) }
  }
}

export async function updateMotivatedParams(
  id: string,
  updates: Partial<{
    motivation_types: string[]
    min_equity_percent: number
    max_days_on_market: number
    include_expired_listings: boolean
    include_fsbo: boolean
    is_active: boolean
  }>,
) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("lead_scraping_motivated_params")
      .update(updates)
      .eq("id", id)
      .select()
      .single()

    if (error) throw error
    revalidatePath("/dashboard/admin/sla-monitor")
    return { success: true, params: data }
  } catch (error) {
    console.error("[v0] Error updating motivated params:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// SCRAPING JOB MANAGEMENT
// ============================================

export async function getScrapingJobs(limit = 50) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("lead_scraping_jobs")
      .select(`
        *,
        lead_scraping_markets(name, city, state)
      `)
      .order("created_at", { ascending: false })
      .limit(limit)

    if (error) throw error
    return { success: true, jobs: data || [] }
  } catch (error) {
    console.error("[v0] Error fetching scraping jobs:", error)
    return { success: true, jobs: [] }
  }
}

export async function createScrapingJob(jobData: {
  job_type: string
  market_id?: string
  source: string
}) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("lead_scraping_jobs")
      .insert({
        ...jobData,
        status: "pending",
      })
      .select()
      .single()

    if (error) throw error
    return { success: true, job: data }
  } catch (error) {
    console.error("[v0] Error creating scraping job:", error)
    return { success: false, error: String(error) }
  }
}

export async function updateScrapingJob(
  id: string,
  updates: Partial<{
    status: string
    leads_found: number
    leads_created: number
    error_message: string
    started_at: string
    completed_at: string
  }>,
) {
  try {
    const supabase = await createClient()
    const { error } = await supabase.from("lead_scraping_jobs").update(updates).eq("id", id)

    if (error) throw error
    return { success: true }
  } catch (error) {
    console.error("[v0] Error updating scraping job:", error)
    return { success: false, error: String(error) }
  }
}
