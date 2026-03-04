import { createServiceClient } from "@/lib/supabase/service"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type TerritoryMetricsRow = {
  brokerage_id: string
  zip_code: string
  metric_date: string
  lead_count: number
  qualified_lead_count: number
  consented_count: number
  assigned_count: number
  conversion_count: number
  conversion_rate: number
  avg_score: number
  sla_compliance_rate: number
  cost_per_lead: number
  total_cost: number
  roi: number
  agent_saturation: number
  leads_by_provider: Record<string, number>
}

export type AggregateResult = {
  brokerageId: string
  date: string
  zipsProcessed: number
  errors: string[]
}

// ─── AGGREGATOR ───────────────────────────────────────────────────────────────

export async function aggregateMetrics(
  brokerageId: string,
  forDate: string
): Promise<AggregateResult> {
  const supabase = createServiceClient()
  const errors: string[] = []

  // 1. Get all distinct property_zip_codes with active leads for this brokerage
  const { data: zipRows, error: zipError } = await supabase
    .from("leads")
    .select("property_zip_code")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .not("property_zip_code", "is", null)

  if (zipError) {
    throw new Error(`Failed to fetch zip codes: ${zipError.message}`)
  }

  const zipCodes = [...new Set((zipRows ?? []).map((r) => r.property_zip_code as string).filter(Boolean))]

  if (zipCodes.length === 0) {
    return { brokerageId, date: forDate, zipsProcessed: 0, errors }
  }

  const upsertRows: TerritoryMetricsRow[] = []

  for (const zip of zipCodes) {
    try {
      // Fetch all leads for this zip
      const { data: leads, error: leadsError } = await supabase
        .from("leads")
        .select("id, lifecycle_state, lead_score, agent_id, source, created_at, contact_id, is_active")
        .eq("brokerage_id", brokerageId)
        .eq("property_zip_code", zip)
        .eq("is_active", true)

      if (leadsError) throw new Error(leadsError.message)

      const allLeads = leads ?? []
      const leadIds = allLeads.map((l) => l.id as string)

      const lead_count = allLeads.length
      const qualified_lead_count = allLeads.filter(
        (l) => l.lifecycle_state === "consented" || l.lifecycle_state === "assigned" || l.lifecycle_state === "appointment" || l.lifecycle_state === "representation"
      ).length
      const consented_count = allLeads.filter((l) => l.lifecycle_state === "consented").length
      const assigned_count = allLeads.filter((l) => l.lifecycle_state === "assigned").length
      const conversion_count = allLeads.filter((l) => l.lifecycle_state === "representation").length
      const conversion_rate = lead_count > 0 ? conversion_count / lead_count : 0

      const scores = allLeads.map((l) => (l.lead_score as number) ?? 0).filter((s) => s > 0)
      const avg_score = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0

      // SLA compliance: ratio of leads NOT breached
      let sla_compliance_rate = 1
      if (leadIds.length > 0) {
        const { data: slaRows } = await supabase
          .from("lead_sla_tracking")
          .select("breached")
          .eq("brokerage_id", brokerageId)
          .in("lead_id", leadIds)

        if (slaRows && slaRows.length > 0) {
          const breachedCount = slaRows.filter((s) => s.breached === true).length
          sla_compliance_rate = 1 - breachedCount / slaRows.length
        }
      }

      // Cost metrics from vendor_usage_tracking
      let total_cost = 0
      if (leadIds.length > 0) {
        const { data: costRows } = await supabase
          .from("vendor_usage_tracking")
          .select("total_cost")
          .eq("brokerage_id", brokerageId)
          .in("lead_id", leadIds)

        total_cost = (costRows ?? []).reduce((sum, r) => sum + ((r.total_cost as number) ?? 0), 0)
      }

      const cost_per_lead = lead_count > 0 ? total_cost / lead_count : 0
      // Est. ROI: (conversions × avg deal value proxy $10k) / total_cost — labeled "Est. ROI" in UI
      const roi = total_cost > 0 ? (conversion_count * 10000 - total_cost) / total_cost : 0

      // Agent saturation: unique agents / leads (capped 0–1)
      const uniqueAgents = new Set(allLeads.map((l) => l.agent_id).filter(Boolean)).size
      const agent_saturation = lead_count > 0 ? Math.min(uniqueAgents / lead_count, 1) : 0

      // Leads by provider
      const leads_by_provider: Record<string, number> = {}
      for (const lead of allLeads) {
        const src = (lead.source as string) ?? "unknown"
        leads_by_provider[src] = (leads_by_provider[src] ?? 0) + 1
      }

      upsertRows.push({
        brokerage_id: brokerageId,
        zip_code: zip,
        metric_date: forDate,
        lead_count,
        qualified_lead_count,
        consented_count,
        assigned_count,
        conversion_count,
        conversion_rate,
        avg_score,
        sla_compliance_rate,
        cost_per_lead,
        total_cost,
        roi,
        agent_saturation,
        leads_by_provider,
      })
    } catch (err) {
      errors.push(`zip ${zip}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 3. Bulk upsert on (brokerage_id, zip_code, metric_date)
  if (upsertRows.length > 0) {
    const { error: upsertError } = await supabase
      .from("territory_metrics")
      .upsert(upsertRows, {
        onConflict: "brokerage_id,zip_code,metric_date",
        ignoreDuplicates: false,
      })

    if (upsertError) {
      throw new Error(`Upsert failed: ${upsertError.message}`)
    }
  }

  return {
    brokerageId,
    date: forDate,
    zipsProcessed: upsertRows.length,
    errors,
  }
}

// ─── SERVICE AREA SEED (idempotent) ──────────────────────────────────────────
// Seeds farm_territories from brokerage service-area settings.
// Upserts by (brokerage_id, name) — never creates duplicates.

export async function seedTerritoriesFromServiceArea(
  brokerageId: string
): Promise<{ seeded: number; skipped: number }> {
  const supabase = createServiceClient()

  // Read service area from global_settings.additional_settings
  const { data: settings } = await supabase
    .from("global_settings")
    .select("additional_settings")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  const additional = (settings?.additional_settings ?? {}) as Record<string, unknown>
  const serviceAreaZips = (additional.service_area_zip_codes as string[] | null) ?? []
  const serviceAreaCounties = (additional.service_area_counties as string[] | null) ?? []
  const serviceAreaCities = (additional.service_area_cities as string[] | null) ?? []

  if (serviceAreaZips.length === 0 && serviceAreaCounties.length === 0 && serviceAreaCities.length === 0) {
    return { seeded: 0, skipped: 0 }
  }

  // Build one territory per meaningful grouping. If zip list exists, use as single territory.
  const rows: { brokerage_id: string; name: string; zip_codes: string[]; is_active: boolean; marketing_budget_monthly: number }[] = []

  if (serviceAreaZips.length > 0) {
    rows.push({
      brokerage_id: brokerageId,
      name: "Service Area — Zip Codes",
      zip_codes: serviceAreaZips,
      is_active: true,
      marketing_budget_monthly: 0,
    })
  }

  for (const county of serviceAreaCounties) {
    rows.push({
      brokerage_id: brokerageId,
      name: `Service Area — ${county}`,
      zip_codes: [],
      is_active: true,
      marketing_budget_monthly: 0,
    })
  }

  for (const city of serviceAreaCities) {
    rows.push({
      brokerage_id: brokerageId,
      name: `Service Area — ${city}`,
      zip_codes: [],
      is_active: true,
      marketing_budget_monthly: 0,
    })
  }

  let seeded = 0
  let skipped = 0

  for (const row of rows) {
    // Check for existing by (brokerage_id, name) — upsert idempotently
    const { data: existing } = await supabase
      .from("farm_territories")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("name", row.name)
      .maybeSingle()

    if (existing) {
      skipped++
      continue
    }

    const { error } = await supabase.from("farm_territories").insert(row)
    if (!error) seeded++
  }

  return { seeded, skipped }
}

// ─── FARM TERRITORY MODE ──────────────────────────────────────────────────────

export async function setFarmTerritoryMode(
  brokerageId: string,
  mode: "use_settings" | "custom"
): Promise<void> {
  const supabase = createServiceClient()

  const { data: existing } = await supabase
    .from("global_settings")
    .select("additional_settings")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  const current = (existing?.additional_settings ?? {}) as Record<string, unknown>

  const { error } = await supabase
    .from("global_settings")
    .update({
      additional_settings: { ...current, farm_territory_mode: mode },
      updated_at: new Date().toISOString(),
    })
    .eq("brokerage_id", brokerageId)

  if (error) throw new Error(`Failed to set farm_territory_mode: ${error.message}`)
}
