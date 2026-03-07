import { createServiceClient } from '@/lib/supabase/service'

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type DateRange = '30' | '60' | '90'

export interface ProviderMetrics {
  providerName:         string
  totalLeads:           number
  leadsQualified:       number
  conversionRate:       number   // 0–1
  totalSpend:           number   // USD
  costPerLead:          number   // USD
  costPerQualifiedLead: number   // USD
  estRoi:               number   // decimal e.g. 1.4 = 140% — always "Est."
  avgLeadScore:         number
  avgDaysToQualify:     number | null
}

export interface ProviderTrendPoint {
  date:        string   // ISO date string YYYY-MM-DD
  avgScore:    number
  leadCount:   number
  providerName: string
}

export interface VendorRoiResult {
  providers:  ProviderMetrics[]
  trendData:  ProviderTrendPoint[]
  generatedAt: string
}

// ─── MAIN FUNCTION ────────────────────────────────────────────────────────────

export async function getProviderRoiMetrics(params: {
  brokerageId: string
  dateRangeDays: DateRange
}): Promise<VendorRoiResult> {
  const supabase = createServiceClient()
  const { brokerageId, dateRangeDays } = params
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - parseInt(dateRangeDays, 10))
  const cutoffIso = cutoff.toISOString()

  // ── 1. Load all leads in window ──────────────────────────────────────────────
  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('id, source, lifecycle_state, lead_score, created_at')
    .eq('brokerage_id', brokerageId)
    .gte('created_at', cutoffIso)

  if (leadsError) throw new Error(`Failed to load leads: ${leadsError.message}`)
  if (!leads || leads.length === 0) {
    return { providers: [], trendData: [], generatedAt: new Date().toISOString() }
  }

  const leadIds = leads.map(l => l.id)

  // ── 2. Load all vendor usage rows for these leads ────────────────────────────
  const { data: usageRows, error: usageError } = await supabase
    .from('vendor_usage_tracking')
    .select('vendor_name, total_cost, lead_id, created_at')
    .eq('brokerage_id', brokerageId)
    .in('lead_id', leadIds)

  if (usageError) throw new Error(`Failed to load vendor usage: ${usageError.message}`)

  // cost lookup: leadId → total cost across all vendor rows
  const costByLead = new Map<string, number>()
  for (const row of usageRows ?? []) {
    if (!row.lead_id) continue
    costByLead.set(row.lead_id, (costByLead.get(row.lead_id) ?? 0) + (row.total_cost ?? 0))
  }

  // ── 3. Load lifecycle_events to compute time-to-qualify ─────────────────────
  const { data: qualEvents } = await supabase
    .from('lifecycle_events')
    .select('entity_id, created_at')
    .eq('brokerage_id', brokerageId)
    .eq('entity_type', 'lead')
    .eq('event_type', 'isa_qualified_lead')
    .in('entity_id', leadIds)

  const qualDateByLead = new Map<string, string>()
  for (const ev of qualEvents ?? []) {
    qualDateByLead.set(ev.entity_id, ev.created_at)
  }

  // ── 4. Group leads by source (provider) ─────────────────────────────────────
  const providerMap = new Map<string, {
    leads: typeof leads
  }>()

  for (const lead of leads) {
    const source = (lead.source as string | null) ?? 'unknown'
    if (!providerMap.has(source)) providerMap.set(source, { leads: [] })
    providerMap.get(source)!.leads.push(lead)
  }

  // ── 5. Compute per-provider metrics ─────────────────────────────────────────
  const providers: ProviderMetrics[] = []

  for (const [providerName, { leads: pLeads }] of providerMap) {
    const totalLeads = pLeads.length

    const qualified = pLeads.filter(l =>
      l.lifecycle_state === 'consented' ||
      l.lifecycle_state === 'assigned' ||
      l.lifecycle_state === 'appointment' ||
      l.lifecycle_state === 'representation'
    )
    const leadsQualified = qualified.length
    const conversionRate = totalLeads > 0 ? leadsQualified / totalLeads : 0

    const totalSpend = pLeads.reduce((sum, l) => sum + (costByLead.get(l.id) ?? 0), 0)
    const costPerLead = totalLeads > 0 ? totalSpend / totalLeads : 0
    const costPerQualifiedLead = leadsQualified > 0 ? totalSpend / leadsQualified : 0

    // Est. ROI = (qualified × $10k proxy − spend) / spend — labeled "Est." in UI
    const estRoi = totalSpend > 0
      ? (leadsQualified * 10_000 - totalSpend) / totalSpend
      : 0

    // Avg lead score (only for leads with a score)
    const scoredLeads = pLeads.filter(l => typeof l.lead_score === 'number')
    const avgLeadScore = scoredLeads.length > 0
      ? scoredLeads.reduce((sum, l) => sum + (l.lead_score as number), 0) / scoredLeads.length
      : 0

    // Avg days from created_at to isa_qualified_lead lifecycle event
    const daysToQualifyList: number[] = []
    for (const lead of pLeads) {
      const qualDate = qualDateByLead.get(lead.id)
      if (qualDate) {
        const days = (new Date(qualDate).getTime() - new Date(lead.created_at).getTime())
          / (1000 * 60 * 60 * 24)
        daysToQualifyList.push(days)
      }
    }
    const avgDaysToQualify = daysToQualifyList.length > 0
      ? daysToQualifyList.reduce((s, d) => s + d, 0) / daysToQualifyList.length
      : null

    providers.push({
      providerName,
      totalLeads,
      leadsQualified,
      conversionRate,
      totalSpend,
      costPerLead,
      costPerQualifiedLead,
      estRoi,
      avgLeadScore,
      avgDaysToQualify,
    })
  }

  // Sort by totalLeads desc by default
  providers.sort((a, b) => b.totalLeads - a.totalLeads)

  // ── 6. Build trend data: daily avg score + lead count per provider ───────────
  const trendData: ProviderTrendPoint[] = []
  const trendMap = new Map<string, Map<string, { scores: number[]; count: number }>>()
  // key: providerName → date → { scores, count }

  for (const lead of leads) {
    const source = (lead.source as string | null) ?? 'unknown'
    const date = lead.created_at.substring(0, 10)
    if (!trendMap.has(source)) trendMap.set(source, new Map())
    const provTrend = trendMap.get(source)!
    if (!provTrend.has(date)) provTrend.set(date, { scores: [], count: 0 })
    const entry = provTrend.get(date)!
    entry.count++
    if (typeof lead.lead_score === 'number') entry.scores.push(lead.lead_score)
  }

  for (const [providerName, dateMap] of trendMap) {
    for (const [date, { scores, count }] of dateMap) {
      trendData.push({
        providerName,
        date,
        leadCount: count,
        avgScore: scores.length > 0
          ? scores.reduce((s, v) => s + v, 0) / scores.length
          : 0,
      })
    }
  }

  trendData.sort((a, b) => a.date.localeCompare(b.date))

  return {
    providers,
    trendData,
    generatedAt: new Date().toISOString(),
  }
}

// ─── CSV EXPORT HELPER ────────────────────────────────────────────────────────

export function providerMetricsToCsv(providers: ProviderMetrics[]): string {
  const headers = [
    'Provider',
    'Total Leads',
    'Leads Qualified',
    'Conversion Rate %',
    'Total Spend ($)',
    'Cost / Lead ($)',
    'Cost / Qualified Lead ($)',
    'Est. ROI %',
    'Avg Lead Score',
    'Avg Days to Qualify',
  ]

  const rows = providers.map(p => [
    p.providerName,
    p.totalLeads,
    p.leadsQualified,
    (p.conversionRate * 100).toFixed(1),
    p.totalSpend.toFixed(2),
    p.costPerLead.toFixed(2),
    p.costPerQualifiedLead.toFixed(2),
    (p.estRoi * 100).toFixed(1),
    p.avgLeadScore.toFixed(1),
    p.avgDaysToQualify !== null ? p.avgDaysToQualify.toFixed(1) : 'N/A',
  ])

  return [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n')
}
