"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

// ============================================
// MARKET CONFIGURATION
// ============================================

/**
 * SUBSCRIBER SERVICE AREAS SYNC — RECONCILED WITH SETTINGS → TERRITORIES.
 * ─────────────────────────────────────────────────────────────────────────────
 * subscriber_service_areas is the per-zip roster of claimed territory. It feeds
 * the platform's global lead-distribution rotation
 * (lib/platform/distribution-engine.ts) and mirrors the scraper work-list.
 *
 * IT IS NO LONGER THIS FUNCTION'S TABLE. Settings → Territories
 * (app/actions/settings/territories.ts) now owns it, at all three grains the
 * schema declares. This function keeps working — a market's zips ARE still a
 * claim, and creating a market should still enrol the tenant — but it has been
 * demoted from OWNER to ORIGINATOR, and four defects are fixed with the demotion:
 *
 * (1) IT WROTE THE WRONG GRAIN WHEN THE MARKET CARRIED A TEAM. It passed
 *     `team_id: market.team_id`, and lead_scraping_markets really does have a
 *     team_id column (MEASURED). But distribution-engine.ts step 6 selects
 *     `.is("agent_user_id", null).is("team_id", null)` — it reads ONLY the
 *     brokerage grain. So a team-owned market produced a claim that routed
 *     nothing, and — because the pre-existing unique index is partial
 *     (`WHERE agent_user_id IS NULL AND team_id IS NULL`) — that row was also
 *     outside the only uniqueness the table had. This sync now always writes the
 *     BROKERAGE grain. Team and agent claims are made deliberately, in settings.
 *
 * (2) IT RE-DECIDED ROWS SOMEONE ELSE SET. It flipped `active` back to true on
 *     any existing row it found. Once settings can deactivate a zip ("we stopped
 *     covering 90210"), that flip silently overturns a deliberate decision the
 *     next time anyone edits an unrelated market. THE RULE NOW: this function may
 *     ORIGINATE a claim (insert one that does not exist); it may never re-decide
 *     one that does. `active` and `is_primary` on an existing row belong to
 *     settings. That is what "it must stop being the only way a row is born"
 *     costs — it also stops being the way a row is overruled.
 *
 * (3) CHECK-THEN-INSERT WITH EVERY ERROR DROPPED. Every call discarded `error`,
 *     so a refused read read as "not there" and inserted a duplicate. Errors are
 *     now checked, and m462's per-grain partial unique indexes turn a genuine
 *     race into a 23505 that is caught and treated as "already claimed" — the row
 *     exists exactly once, which is the outcome wanted.
 *
 * (4) ZIPS WERE SILENTLY DROPPED. Still filtered here (a market is not a form and
 *     has no one to tell), but the count of dropped zips is now returned so the
 *     caller can surface it instead of the claim quietly not happening.
 *
 * Returns a report rather than throwing: a market that saved must not appear to
 * have failed because its territory enrolment hit a snag.
 */
type ServiceAreaSyncReport = { claimed: string[]; alreadyClaimed: string[]; invalidZips: string[]; errors: string[] }

async function syncServiceAreasForMarket(
  supabase: Awaited<ReturnType<typeof createClient>>,
  market: { brokerage_id: string; team_id?: string | null; agent_id?: string | null; zip_codes?: string[] | null; city?: string | null; state?: string | null },
): Promise<ServiceAreaSyncReport> {
  const report: ServiceAreaSyncReport = { claimed: [], alreadyClaimed: [], invalidZips: [], errors: [] }
  if (!market.brokerage_id) {
    report.errors.push("market has no brokerage_id — nothing was claimed")
    return report
  }
  const raw = market.zip_codes ?? []
  report.invalidZips = Array.from(new Set(raw.filter((z) => !/^\d{5}$/.test(String(z))).map(String)))
  const zips = Array.from(new Set(raw.filter((z) => /^\d{5}$/.test(String(z))).map(String)))

  for (const zip of zips) {
    // BROKERAGE GRAIN ONLY — `.is(…, null)` on both grain columns, so this can
    // never see, and never clobber, a team or agent claim made in settings.
    const { data: existing, error: existingError } = await supabase
      .from("subscriber_service_areas")
      .select("id, active")
      .eq("brokerage_id", market.brokerage_id)
      .eq("zip_code", zip)
      .is("team_id", null)
      .is("agent_user_id", null)
      .maybeSingle()
    if (existingError) {
      // A refused read is not an absent row. Say so; do not insert on top of it.
      report.errors.push(`${zip}: ${existingError.message}`)
      continue
    }
    if (existing) {
      // ORIGINATOR, NOT OWNER: the row exists, so its lifecycle is settings'
      // business. Deliberately no `active: true` write here — see defect (2).
      report.alreadyClaimed.push(zip)
      continue
    }

    const { data: inserted, error: insertError } = await supabase
      .from("subscriber_service_areas")
      .insert({
        brokerage_id: market.brokerage_id,
        // Always NULL: the brokerage grain is the one the rotation reads. See (1).
        team_id: null,
        agent_user_id: null,
        zip_code: zip,
        city: market.city ?? null,
        state: market.state ?? null,
        // Never set by a side effect — "primary" is a decision, made in settings.
        is_primary: false,
        active: true,
        joined_at: new Date().toISOString(),
      })
      .select("id")
    if (insertError) {
      // 23505 → uq_service_area_brokerage_zip fired: a concurrent writer got there
      // first. The row exists once. That is a win, not a failure.
      if (String((insertError as { code?: string }).code) === "23505") { report.alreadyClaimed.push(zip); continue }
      report.errors.push(`${zip}: ${insertError.message}`)
      continue
    }
    // A zero-row INSERT under RLS returns error:null with no rows — count them.
    if (!inserted || inserted.length === 0) {
      report.errors.push(`${zip}: the claim wrote no row (permission?)`)
      continue
    }
    report.claimed.push(zip)
  }
  return report
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
    // TENANCY STAMP (round 42): the row must carry the caller's brokerage_id —
    // the scrape resolver (lib/lead-pipeline/scrape-territories.ts) only ever
    // scrapes markets owned by an ACTIVE SUBSCRIBER brokerage, so an unstamped
    // market is invisible to the pipeline (and the service-area sync no-ops).
    let brokerageId: string | null = null
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: profile } = await supabase
        .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
      brokerageId = (profile as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
    }
    const { data, error } = await supabase
      .from("lead_scraping_markets")
      .insert(brokerageId ? { ...marketData, brokerage_id: brokerageId } : marketData)
      .select()
      .single()

    if (error) throw error
    // Territory enrollment: the market's zips ORIGINATE brokerage-grain claims
    // (distribution rotation + scraper territory roster). The report is returned
    // rather than swallowed — a market that saved with zero territory claimed is
    // a fact the caller is entitled to see. Settings → Territories
    // (/dashboard/settings/territories) is where claims are actually managed.
    const territory = await syncServiceAreasForMarket(supabase, data as any)
    revalidatePath("/dashboard/admin/sla-monitor")
    revalidatePath("/dashboard/settings/territories")
    return { success: true, market: data, territory }
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
    const territory = await syncServiceAreasForMarket(supabase, data as any)
    revalidatePath("/dashboard/admin/sla-monitor")
    revalidatePath("/dashboard/settings/territories")
    return { success: true, market: data, territory }
  } catch (error) {
    console.error("[v0] Error updating scraping market:", error)
    return { success: false, error: String(error) }
  }
}

export async function deleteScrapingMarket(id: string) {
  try {
    const supabase = await createClient()
    // Retire the territory claims BEFORE the market goes (history kept — the
    // distribution engine only rotates active=true rows).
    //
    // THREE THINGS THIS USED TO GET WRONG, all of them clobber:
    //  • It matched brokerage_id + zip ONLY, across every grain — so deleting one
    //    market switched off the Westside team's claim and Dana's claim on the
    //    same zip, neither of which this market had anything to do with. It now
    //    touches the BROKERAGE grain only (`.is(team_id, null).is(agent_user_id, null)`).
    //  • It retired a zip even when ANOTHER live market of the same brokerage
    //    still covered it. The surviving markets' zips are now subtracted first.
    //  • It dropped every error, so a refused read retired nothing and said
    //    nothing. Both reads and the update now check `error` and throw, which the
    //    outer catch turns into success:false. The update deliberately does NOT
    //    assert a row count: retiring zero rows is a correct, common outcome here
    //    (settings may already have retired the zip), so a count assertion would
    //    fail a delete that did exactly the right thing. Where a zero-row result
    //    IS a fault — every write in app/actions/settings/territories.ts — the
    //    count is asserted, because there a zero-row RLS refusal is silent.
    const { data: market, error: marketError } = await supabase
      .from("lead_scraping_markets").select("brokerage_id, zip_codes").eq("id", id).maybeSingle()
    if (marketError) throw marketError

    const brokerageId = (market as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
    const doomedZips = Array.isArray((market as any)?.zip_codes)
      ? Array.from(new Set(((market as any).zip_codes as unknown[]).map(String).filter((z) => /^\d{5}$/.test(z))))
      : []

    if (brokerageId && doomedZips.length > 0) {
      const { data: survivors, error: survivorsError } = await supabase
        .from("lead_scraping_markets")
        .select("zip_codes")
        .eq("brokerage_id", brokerageId)
        .neq("id", id)
      if (survivorsError) throw survivorsError
      const stillCovered = new Set<string>()
      for (const s of (survivors ?? []) as Array<{ zip_codes?: unknown[] | null }>) {
        for (const z of s.zip_codes ?? []) stillCovered.add(String(z))
      }
      const toRetire = doomedZips.filter((z) => !stillCovered.has(z))
      if (toRetire.length > 0) {
        const { error: retireError } = await supabase.from("subscriber_service_areas")
          .update({ active: false, is_primary: false })
          .eq("brokerage_id", brokerageId)
          .in("zip_code", toRetire)
          .is("team_id", null)
          .is("agent_user_id", null)
          .select("id")
        // Retiring zero rows is a legitimate outcome (settings may already have
        // retired them), so only `error` is a fault here.
        if (retireError) throw retireError
      }
    }
    const { error } = await supabase.from("lead_scraping_markets").delete().eq("id", id)

    if (error) throw error
    revalidatePath("/dashboard/admin/sla-monitor")
    revalidatePath("/dashboard/settings/territories")
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
