"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted } from "@/lib/ai/models"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SourceFamily = "raw" | "lead" | "contact_direct"

export interface SourceMetrics {
  source: string
  source_family: SourceFamily
  source_channel: string | null
  source_subtype: string | null

  // Stage counts — populated per source family
  raw_record_count: number    // raw only
  lead_count: number          // raw + lead
  contact_count: number       // all families
  appointment_count: number
  transaction_count: number
  closed_count: number

  // Conversion rates
  lead_to_contact_rate: number   // raw/lead families only
  contact_to_appt_rate: number
  appt_to_transaction_rate: number
  close_rate: number

  // Financial
  total_spend: number
  revenue_attributed: number
  roi_multiple: number
  cost_per_record: number
  cost_per_contact: number

  // Agent performance
  agent_count: number
  top_agent_id: string | null
  top_agent_name: string | null

  // Campaign attribution
  campaign_id: string | null
  campaign_name: string | null

  created_at_oldest: string | null
  created_at_newest: string | null
}

export interface SourcePerformanceResult {
  success: boolean
  sources: SourceMetrics[]
  summary: {
    total_sources: number
    total_contacts: number
    total_leads: number
    total_raw_records: number
    total_transactions: number
    total_revenue: number
    top_roi_source: string | null
    top_volume_source: string | null
    top_direct_source: string | null
  }
  error?: string
}

export interface SourceDrilldownResult {
  success: boolean
  source: SourceMetrics | null
  recent_contacts: Array<{
    id: string
    first_name: string
    last_name: string
    email: string | null
    created_at: string
    status: string | null
    agent_name: string | null
  }>
  recent_leads: Array<{
    id: string
    first_name: string
    last_name: string
    lead_stage: string | null
    created_at: string
  }>
  recent_transactions: Array<{
    id: string
    deal_name: string | null
    purchase_price: number | null
    status: string
    close_date: string | null
    agent_name: string | null
  }>
  timeline: Array<{
    month: string
    contacts: number
    leads: number
    transactions: number
    revenue: number
  }>
  agents: Array<{
    agent_id: string
    agent_name: string
    contact_count: number
    transaction_count: number
    revenue: number
  }>
  ai_summary: string | null
  error?: string
}

export interface SourceComparisonResult {
  success: boolean
  sources: SourceMetrics[]
  error?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceAnalyticsFilter {
  brokerageId: string
  agentId?: string
  teamId?: string
  sourceFamilies?: SourceFamily[]
  dateFrom?: string
  dateTo?: string
  sortBy?: "roi" | "volume" | "revenue" | "appt_rate" | "close_rate" | "cost_efficiency"
  sortDir?: "asc" | "desc"
}

// ─────────────────────────────────────────────────────────────────────────────
// getSourcePerformance — main listing view
// ─────────────────────────────────────────────────────────────────────────────

export async function getSourcePerformance(
  filter: SourceAnalyticsFilter
): Promise<SourcePerformanceResult> {
  try {
    const supabase = await createClient()
    const { brokerageId, agentId, dateFrom, dateTo, sourceFamilies, sortBy = "volume", sortDir = "desc" } = filter

    // Build date constraints
    const fromDate = dateFrom ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
    const toDate = dateTo ?? new Date().toISOString()

    // ── 1. Contacts grouped by source + source_family ──────────────────────────
    let contactsQuery = supabase
      .from("contacts")
      .select("id, source, source_family, source_channel, source_subtype, agent_id, cost_per_record, campaign_attribution_id, created_at")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", fromDate)
      .lte("created_at", toDate)
      .is("deleted_at", null)

    if (agentId) contactsQuery = contactsQuery.eq("agent_id", agentId)
    if (sourceFamilies?.length) contactsQuery = contactsQuery.in("source_family", sourceFamilies)

    const { data: contacts, error: cErr } = await contactsQuery
    if (cErr) throw cErr

    // ── 2. Leads grouped by source ─────────────────────────────────────────────
    let leadsQuery = supabase
      .from("leads")
      .select("id, source, source_family, source_channel, agent_id, cost_per_record, campaign_attribution_id, lifecycle_state, created_at, contact_id")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", fromDate)
      .lte("created_at", toDate)

    if (agentId) leadsQuery = leadsQuery.eq("agent_id", agentId)
    if (sourceFamilies?.length && !sourceFamilies.includes("contact_direct")) {
      leadsQuery = leadsQuery.in("source_family", sourceFamilies)
    }

    const { data: leads, error: lErr } = await leadsQuery
    if (lErr) throw lErr

    // ── 3. Raw scraped leads ────────────────────────────────────────────────────
    let rawQuery = supabase
      .from("raw_scraped_leads")
      .select("id, source, source_family, processing_status, created_at, lead_id")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", fromDate)
      .lte("created_at", toDate)

    if (sourceFamilies?.length && !sourceFamilies.includes("contact_direct") && !sourceFamilies.includes("lead")) {
      // raw only filter
    } else if (sourceFamilies?.length && !sourceFamilies.includes("raw")) {
      // skip raw entirely
      rawQuery = rawQuery.eq("id", "00000000-0000-0000-0000-000000000000") // no results
    }

    const { data: rawRecords } = await rawQuery

    // ── 4. Transactions with source attribution ────────────────────────────────
    let txQuery = supabase
      .from("transactions")
      .select(`
        id, source, source_family, purchase_price, commission_amount,
        status, close_date, agent_id, contact_id
      `)
      .eq("brokerage_id", brokerageId)
      .gte("created_at", fromDate)
      .lte("created_at", toDate)

    if (agentId) txQuery = txQuery.eq("agent_id", agentId)

    const { data: transactions } = await txQuery

    // ── 5. Activities / appointments ───────────────────────────────────────────
    const { data: activities } = await supabase
      .from("activities")
      .select("id, contact_id, agent_id, activity_type")
      .eq("brokerage_id", brokerageId)
      .in("activity_type", ["appointment", "showing", "meeting", "call"])
      .gte("created_at", fromDate)
      .lte("created_at", toDate)

    // ── 6. Agent name lookup ───────────────────────────────────────────────────
    const allAgentIds = [
      ...new Set([
        ...(contacts?.map(c => c.agent_id) ?? []),
        ...(leads?.map(l => l.agent_id) ?? []),
        ...(transactions?.map(t => t.agent_id) ?? []),
      ].filter(Boolean))
    ]

    let agentNames: Record<string, string> = {}
    if (allAgentIds.length > 0) {
      const { data: agentRows } = await supabase
        .from("users")
        .select("id, first_name, last_name")
        .in("id", allAgentIds.slice(0, 100))
      agentRows?.forEach(a => { agentNames[a.id] = `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() })
    }

    // ── 7. Campaign name lookup ────────────────────────────────────────────────
    const campaignIds = [
      ...new Set([
        ...(contacts?.map(c => c.campaign_attribution_id).filter(Boolean) ?? []),
        ...(leads?.map(l => l.campaign_attribution_id).filter(Boolean) ?? []),
      ])
    ]
    let campaignNames: Record<string, string> = {}
    if (campaignIds.length > 0) {
      const { data: campaigns } = await supabase
        .from("marketing_campaigns")
        .select("id, campaign_name")
        .in("id", campaignIds as string[])
      campaigns?.forEach(c => { campaignNames[c.id] = c.campaign_name })
    }

    // ── 8. Build source map ────────────────────────────────────────────────────
    const sourceMap = new Map<string, SourceMetrics>()

    const getOrCreate = (source: string, family: SourceFamily, channel?: string | null, subtype?: string | null): SourceMetrics => {
      const key = `${source}::${family}`
      if (!sourceMap.has(key)) {
        sourceMap.set(key, {
          source: source || "unknown",
          source_family: family,
          source_channel: channel ?? null,
          source_subtype: subtype ?? null,
          raw_record_count: 0,
          lead_count: 0,
          contact_count: 0,
          appointment_count: 0,
          transaction_count: 0,
          closed_count: 0,
          lead_to_contact_rate: 0,
          contact_to_appt_rate: 0,
          appt_to_transaction_rate: 0,
          close_rate: 0,
          total_spend: 0,
          revenue_attributed: 0,
          roi_multiple: 0,
          cost_per_record: 0,
          cost_per_contact: 0,
          agent_count: 0,
          top_agent_id: null,
          top_agent_name: null,
          campaign_id: null,
          campaign_name: null,
          created_at_oldest: null,
          created_at_newest: null,
        })
      }
      return sourceMap.get(key)!
    }

    // Process raw records
    rawRecords?.forEach(r => {
      const m = getOrCreate(r.source ?? "scraped", "raw")
      m.raw_record_count++
      if (r.lead_id) m.lead_count++
    })

    // Process leads
    const leadAgentCounts: Record<string, Record<string, number>> = {}
    leads?.forEach(l => {
      const family = (l.source_family as SourceFamily) ?? "lead"
      const m = getOrCreate(l.source ?? "manual_entry", family, l.source_channel)
      m.lead_count++
      m.total_spend += l.cost_per_record ?? 0
      if (l.contact_id) m.contact_count++
      if (l.campaign_attribution_id && !m.campaign_id) {
        m.campaign_id = l.campaign_attribution_id
        m.campaign_name = campaignNames[l.campaign_attribution_id] ?? null
      }
      if (l.created_at) {
        if (!m.created_at_oldest || l.created_at < m.created_at_oldest) m.created_at_oldest = l.created_at
        if (!m.created_at_newest || l.created_at > m.created_at_newest) m.created_at_newest = l.created_at
      }
      if (l.agent_id) {
        const key = `${l.source}::${family}`
        if (!leadAgentCounts[key]) leadAgentCounts[key] = {}
        leadAgentCounts[key][l.agent_id] = (leadAgentCounts[key][l.agent_id] ?? 0) + 1
      }
    })

    // Process contacts
    const contactAgentCounts: Record<string, Record<string, number>> = {}
    contacts?.forEach(c => {
      const family = (c.source_family as SourceFamily) ?? "contact_direct"
      const m = getOrCreate(c.source ?? "website", family, c.source_channel, c.source_subtype)
      m.contact_count++
      m.total_spend += c.cost_per_record ?? 0
      if (c.campaign_attribution_id && !m.campaign_id) {
        m.campaign_id = c.campaign_attribution_id
        m.campaign_name = campaignNames[c.campaign_attribution_id] ?? null
      }
      if (c.created_at) {
        if (!m.created_at_oldest || c.created_at < m.created_at_oldest) m.created_at_oldest = c.created_at
        if (!m.created_at_newest || c.created_at > m.created_at_newest) m.created_at_newest = c.created_at
      }
      if (c.agent_id) {
        const key = `${c.source}::${family}`
        if (!contactAgentCounts[key]) contactAgentCounts[key] = {}
        contactAgentCounts[key][c.agent_id] = (contactAgentCounts[key][c.agent_id] ?? 0) + 1
      }
    })

    // Process activities (appointments)
    activities?.forEach(a => {
      // Match appointment to source via contact
      const contact = contacts?.find(c => c.id === a.contact_id)
      if (contact) {
        const family = (contact.source_family as SourceFamily) ?? "contact_direct"
        const m = getOrCreate(contact.source ?? "website", family)
        m.appointment_count++
      }
    })

    // Process transactions
    transactions?.forEach(t => {
      const family = (t.source_family as SourceFamily) ?? "lead"
      const sourceKey = t.source ?? "unknown"
      const m = getOrCreate(sourceKey, family)
      m.transaction_count++
      if (t.status === "closed" || t.status === "completed") {
        m.closed_count++
        const revenue = t.commission_amount ?? (t.purchase_price ? t.purchase_price * 0.03 : 0)
        m.revenue_attributed += revenue
      }
    })

    // Compute derived metrics for each source
    for (const m of sourceMap.values()) {
      const key = `${m.source}::${m.source_family}`
      const agentMap = contactAgentCounts[key] ?? leadAgentCounts[key] ?? {}
      const agentCountsArr = (Object.entries(agentMap) as Array<[string, number]>).sort((a, b) => b[1] - a[1])
      m.agent_count = agentCountsArr.length
      if (agentCountsArr.length > 0) {
        m.top_agent_id = agentCountsArr[0][0]
        m.top_agent_name = agentNames[agentCountsArr[0][0]] ?? null
      }

      // Conversion rates
      const upstream = m.source_family === "raw"
        ? m.raw_record_count
        : m.source_family === "lead"
          ? m.lead_count
          : m.contact_count

      if (m.source_family !== "contact_direct" && m.lead_count > 0) {
        m.lead_to_contact_rate = m.contact_count > 0
          ? Math.round((m.contact_count / m.lead_count) * 100)
          : 0
      }

      if (m.contact_count > 0) {
        m.contact_to_appt_rate = Math.round((m.appointment_count / m.contact_count) * 100)
      }
      if (m.appointment_count > 0) {
        m.appt_to_transaction_rate = Math.round((m.transaction_count / m.appointment_count) * 100)
      }
      if (upstream > 0) {
        m.close_rate = Math.round((m.closed_count / upstream) * 100)
      }

      // ROI
      if (m.total_spend > 0) {
        m.roi_multiple = parseFloat((m.revenue_attributed / m.total_spend).toFixed(2))
        m.cost_per_record = parseFloat((m.total_spend / Math.max(upstream, 1)).toFixed(2))
        m.cost_per_contact = parseFloat((m.total_spend / Math.max(m.contact_count, 1)).toFixed(2))
      }
    }

    let sources = Array.from(sourceMap.values())

    // Sort
    const sortFn: Record<string, (a: SourceMetrics, b: SourceMetrics) => number> = {
      roi: (a, b) => b.roi_multiple - a.roi_multiple,
      volume: (a, b) => b.contact_count - a.contact_count,
      revenue: (a, b) => b.revenue_attributed - a.revenue_attributed,
      appt_rate: (a, b) => b.contact_to_appt_rate - a.contact_to_appt_rate,
      close_rate: (a, b) => b.close_rate - a.close_rate,
      cost_efficiency: (a, b) => a.cost_per_contact - b.cost_per_contact,
    }
    const fn = sortFn[sortBy] ?? sortFn.volume
    sources.sort(fn)
    if (sortDir === "asc") sources.reverse()

    // Summary
    const allSources = sources
    const summary = {
      total_sources: allSources.length,
      total_contacts: allSources.reduce((s, x) => s + x.contact_count, 0),
      total_leads: allSources.reduce((s, x) => s + x.lead_count, 0),
      total_raw_records: allSources.reduce((s, x) => s + x.raw_record_count, 0),
      total_transactions: allSources.reduce((s, x) => s + x.transaction_count, 0),
      total_revenue: allSources.reduce((s, x) => s + x.revenue_attributed, 0),
      top_roi_source: allSources.sort((a, b) => b.roi_multiple - a.roi_multiple)[0]?.source ?? null,
      top_volume_source: allSources.sort((a, b) => b.contact_count - a.contact_count)[0]?.source ?? null,
      top_direct_source: allSources
        .filter(s => s.source_family === "contact_direct")
        .sort((a, b) => b.close_rate - a.close_rate)[0]?.source ?? null,
    }

    return { success: true, sources, summary }
  } catch (err) {
    console.error("[source-analytics] getSourcePerformance error:", err)
    return {
      success: false,
      sources: [],
      summary: {
        total_sources: 0, total_contacts: 0, total_leads: 0,
        total_raw_records: 0, total_transactions: 0, total_revenue: 0,
        top_roi_source: null, top_volume_source: null, top_direct_source: null,
      },
      error: err instanceof Error ? err.message : "Failed to load source performance",
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getSourceDrilldown — individual source detail
// ─────────────────────────────────────────────────────────────────────────────

export async function getSourceDrilldown(
  brokerageId: string,
  sourceKey: string, // format: "source_name::source_family"
  agentId?: string,
  dateFrom?: string,
  dateTo?: string
): Promise<SourceDrilldownResult> {
  try {
    const supabase = await createClient()
    const [sourceName, sourceFamily] = sourceKey.split("::")
    const fromDate = dateFrom ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
    const toDate = dateTo ?? new Date().toISOString()

    // Build base metrics via getSourcePerformance filtered to this source
    const perfResult = await getSourcePerformance({
      brokerageId,
      agentId,
      dateFrom: fromDate,
      dateTo: toDate,
    })
    const source = perfResult.sources.find(
      s => s.source === sourceName && s.source_family === sourceFamily
    ) ?? null

    // Recent contacts
    let contactsQuery = supabase
      .from("contacts")
      .select("id, first_name, last_name, email, created_at, status, agent_id")
      .eq("brokerage_id", brokerageId)
      .eq("source", sourceName)
      .eq("source_family", sourceFamily as SourceFamily)
      .gte("created_at", fromDate)
      .order("created_at", { ascending: false })
      .limit(20)
    if (agentId) contactsQuery = contactsQuery.eq("agent_id", agentId)
    const { data: recentContacts } = await contactsQuery

    // Recent leads (for raw/lead families)
    let recentLeadsData: SourceDrilldownResult["recent_leads"] = []
    if (sourceFamily !== "contact_direct") {
      let leadsQuery = supabase
        .from("leads")
        .select("id, first_name, last_name, lead_stage, created_at")
        .eq("brokerage_id", brokerageId)
        .eq("source", sourceName)
        .gte("created_at", fromDate)
        .order("created_at", { ascending: false })
        .limit(15)
      if (agentId) leadsQuery = leadsQuery.eq("agent_id", agentId)
      const { data: leadsData } = await leadsQuery
      recentLeadsData = leadsData?.map(l => ({
        id: l.id,
        first_name: l.first_name ?? "",
        last_name: l.last_name ?? "",
        lead_stage: l.lead_stage ?? null,
        created_at: l.created_at,
      })) ?? []
    }

    // Recent transactions
    let txQuery = supabase
      .from("transactions")
      .select("id, deal_name, purchase_price, status, close_date, agent_id")
      .eq("brokerage_id", brokerageId)
      .eq("source", sourceName)
      .gte("created_at", fromDate)
      .order("created_at", { ascending: false })
      .limit(10)
    if (agentId) txQuery = txQuery.eq("agent_id", agentId)
    const { data: txData } = await txQuery

    // Agent name lookup
    const agentIds = [...new Set([
      ...(recentContacts?.map(c => c.agent_id).filter(Boolean) ?? []),
      ...(txData?.map(t => t.agent_id).filter(Boolean) ?? []),
    ])]
    let agentNames: Record<string, string> = {}
    if (agentIds.length > 0) {
      const { data: agentRows } = await supabase
        .from("users")
        .select("id, first_name, last_name")
        .in("id", agentIds.slice(0, 50))
      agentRows?.forEach(a => { agentNames[a.id] = `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() })
    }

    // Monthly timeline
    const timelineMap = new Map<string, { contacts: number; leads: number; transactions: number; revenue: number }>()
    recentContacts?.forEach(c => {
      const month = c.created_at.slice(0, 7)
      const entry = timelineMap.get(month) ?? { contacts: 0, leads: 0, transactions: 0, revenue: 0 }
      entry.contacts++
      timelineMap.set(month, entry)
    })
    recentLeadsData.forEach(l => {
      const month = l.created_at.slice(0, 7)
      const entry = timelineMap.get(month) ?? { contacts: 0, leads: 0, transactions: 0, revenue: 0 }
      entry.leads++
      timelineMap.set(month, entry)
    })
    txData?.forEach(t => {
      const month = (t.close_date ?? "").slice(0, 7)
      if (!month) return
      const entry = timelineMap.get(month) ?? { contacts: 0, leads: 0, transactions: 0, revenue: 0 }
      entry.transactions++
      entry.revenue += t.purchase_price ? t.purchase_price * 0.03 : 0
      timelineMap.set(month, entry)
    })
    const timeline = Array.from(timelineMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, ...data }))

    // Agent breakdown
    const agentPerfMap = new Map<string, { contact_count: number; transaction_count: number; revenue: number }>()
    recentContacts?.forEach(c => {
      if (!c.agent_id) return
      const entry = agentPerfMap.get(c.agent_id) ?? { contact_count: 0, transaction_count: 0, revenue: 0 }
      entry.contact_count++
      agentPerfMap.set(c.agent_id, entry)
    })
    txData?.forEach(t => {
      if (!t.agent_id) return
      const entry = agentPerfMap.get(t.agent_id) ?? { contact_count: 0, transaction_count: 0, revenue: 0 }
      entry.transaction_count++
      entry.revenue += t.purchase_price ? t.purchase_price * 0.03 : 0
      agentPerfMap.set(t.agent_id, entry)
    })
    const agents = Array.from(agentPerfMap.entries())
      .map(([agent_id, data]) => ({
        agent_id,
        agent_name: agentNames[agent_id] ?? "Unknown",
        ...data,
      }))
      .sort((a, b) => b.contact_count - a.contact_count)

    return {
      success: true,
      source,
      recent_contacts: recentContacts?.map(c => ({
        id: c.id,
        first_name: c.first_name ?? "",
        last_name: c.last_name ?? "",
        email: c.email ?? null,
        created_at: c.created_at,
        status: c.status ?? null,
        agent_name: c.agent_id ? agentNames[c.agent_id] ?? null : null,
      })) ?? [],
      recent_leads: recentLeadsData,
      recent_transactions: txData?.map(t => ({
        id: t.id,
        deal_name: t.deal_name ?? null,
        purchase_price: t.purchase_price ?? null,
        status: t.status,
        close_date: t.close_date ?? null,
        agent_name: t.agent_id ? agentNames[t.agent_id] ?? null : null,
      })) ?? [],
      timeline,
      agents,
      ai_summary: null,
    }
  } catch (err) {
    console.error("[source-analytics] getSourceDrilldown error:", err)
    return {
      success: false,
      source: null,
      recent_contacts: [],
      recent_leads: [],
      recent_transactions: [],
      timeline: [],
      agents: [],
      ai_summary: null,
      error: err instanceof Error ? err.message : "Failed to load source drilldown",
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// generateSourceAIInsights — AI natural language summary
// ─────────────────────────────────────────────────────────────────────────────

export async function generateSourceAIInsights(
  brokerageId: string,
  sources: SourceMetrics[],
  summaryContext?: string
): Promise<{ success: boolean; insights: string; error?: string }> {
  try {
    const topRoi = sources.filter(s => s.roi_multiple > 0).sort((a, b) => b.roi_multiple - a.roi_multiple).slice(0, 3)
    const topVolume = [...sources].sort((a, b) => b.contact_count - a.contact_count).slice(0, 3)
    const directSources = sources.filter(s => s.source_family === "contact_direct")
    const rawSources = sources.filter(s => s.source_family === "raw")
    const paidSources = sources.filter(s => s.total_spend > 0 && s.roi_multiple < 2)

    const prompt = `You are analyzing source analytics for a real estate brokerage. Provide natural language insights (3-5 paragraphs) explaining performance patterns.

Source Performance Data:
${JSON.stringify({
  total_sources: sources.length,
  top_roi_sources: topRoi.map(s => ({ source: s.source, family: s.source_family, roi: `${s.roi_multiple}x`, revenue: `$${s.revenue_attributed.toFixed(0)}` })),
  top_volume_sources: topVolume.map(s => ({ source: s.source, family: s.source_family, contacts: s.contact_count, close_rate: `${s.close_rate}%` })),
  direct_contact_sources: directSources.map(s => ({ source: s.source, contacts: s.contact_count, appt_rate: `${s.contact_to_appt_rate}%`, close_rate: `${s.close_rate}%` })),
  raw_acquisition_sources: rawSources.map(s => ({ source: s.source, raw: s.raw_record_count, promoted_to_lead: s.lead_count, converted_to_contact: s.contact_count })),
  underperforming_paid: paidSources.map(s => ({ source: s.source, spend: `$${s.total_spend.toFixed(0)}`, roi: `${s.roi_multiple}x`, cost_per_contact: `$${s.cost_per_contact.toFixed(0)}` })),
}, null, 2)}

${summaryContext ? `Additional context: ${summaryContext}` : ""}

Explain:
1. Which source family is performing strongest and why (raw vs lead vs direct-contact)
2. Where in the funnel breakdown is occurring for underperforming sources
3. How agent response time or assignment speed is affecting direct-contact source performance
4. Where AI ISA or automation may be helping or hurting specific sources
5. Cost efficiency comparisons between paid and organic sources

Keep the tone analytical and actionable. Reference specific source names and numbers.`

    const { text } = await generateTextRouted({
      feature: "unspecified",
      system: "You are a real estate analytics expert providing source attribution insights for brokers and agents.",
      prompt,
      temperature: 0.4,
      brokerageId,
    })

    return { success: true, insights: text }
  } catch (err) {
    return {
      success: false,
      insights: "",
      error: err instanceof Error ? err.message : "AI insights generation failed",
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// generateSourceAISummaryForSource — per-source AI summary
// ─────────────────────────────────────────────────────────────────────────────

export async function generateSourceAISummaryForSource(
  brokerageId: string,
  source: SourceMetrics,
  timeline: Array<{ month: string; contacts: number; leads: number; transactions: number; revenue: number }>,
  agents: Array<{ agent_id: string; agent_name: string; contact_count: number; transaction_count: number; revenue: number }>
): Promise<{ success: boolean; summary: string; error?: string }> {
  try {
    const prompt = `Analyze this single real estate acquisition source and provide a 2-3 paragraph performance summary.

Source: ${source.source}
Source Family: ${source.source_family} (${source.source_family === "raw" ? "pre-consent acquisition, requires enrichment and qualification" : source.source_family === "lead" ? "lead-level entry, pre-contact qualification" : "direct consented contact entry, customer-facing"})
Funnel:
${source.source_family === "raw" ? `- Raw records: ${source.raw_record_count}
- Promoted to lead: ${source.lead_count} (${source.raw_record_count > 0 ? Math.round(source.lead_count / source.raw_record_count * 100) : 0}%)` : ""}
${source.source_family !== "contact_direct" ? `- Converted to contact: ${source.contact_count} (${source.lead_to_contact_rate}% of leads)` : `- Direct contacts created: ${source.contact_count}`}
- Appointments: ${source.appointment_count} (${source.contact_to_appt_rate}% of contacts)
- Transactions: ${source.transaction_count}
- Closed: ${source.closed_count} (${source.close_rate}% close rate)

Financial:
- Total spend: $${source.total_spend.toFixed(0)}
- Revenue attributed: $${source.revenue_attributed.toFixed(0)}
- ROI: ${source.roi_multiple}x
- Cost per contact: $${source.cost_per_contact.toFixed(0)}

Agents working this source: ${agents.length}
Top agent: ${agents[0]?.agent_name ?? "N/A"} (${agents[0]?.contact_count ?? 0} contacts)

Monthly trend: ${JSON.stringify(timeline.slice(-6))}

Explain what's working, where breakdown is happening, and what action should be taken.`

    const { text } = await generateTextRouted({
      feature: "unspecified",
      system: "You are a real estate analytics expert providing source performance summaries.",
      prompt,
      temperature: 0.3,
      brokerageId,
    })

    return { success: true, summary: text }
  } catch (err) {
    return {
      success: false,
      summary: "",
      error: err instanceof Error ? err.message : "Failed to generate source summary",
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// exportSourceCSV — returns CSV string
// ──────────────────────────────────────────────────────────────────────────���──

export async function exportSourceCSV(
  filter: SourceAnalyticsFilter
): Promise<{ success: boolean; csv: string; error?: string }> {
  try {
    const result = await getSourcePerformance(filter)
    if (!result.success) return { success: false, csv: "", error: result.error }

    const headers = [
      "Source", "Source Family", "Channel", "Subtype",
      "Raw Records", "Leads", "Contacts", "Appointments", "Transactions", "Closed",
      "Lead→Contact Rate", "Contact→Appt Rate", "Close Rate",
      "Total Spend", "Revenue Attributed", "ROI Multiple", "Cost Per Contact",
      "Top Agent", "Campaign",
    ]

    const rows = result.sources.map(s => [
      s.source, s.source_family, s.source_channel ?? "", s.source_subtype ?? "",
      s.raw_record_count, s.lead_count, s.contact_count, s.appointment_count, s.transaction_count, s.closed_count,
      `${s.lead_to_contact_rate}%`, `${s.contact_to_appt_rate}%`, `${s.close_rate}%`,
      `$${s.total_spend.toFixed(2)}`, `$${s.revenue_attributed.toFixed(2)}`, `${s.roi_multiple}x`, `$${s.cost_per_contact.toFixed(2)}`,
      s.top_agent_name ?? "", s.campaign_name ?? "",
    ])

    const csv = [headers, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n")
    return { success: true, csv }
  } catch (err) {
    return { success: false, csv: "", error: err instanceof Error ? err.message : "Export failed" }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// emailSourceReport — queue report email via email_queue
// ─────────────────────────────────────────────────────────────────────────────

export async function emailSourceReport(
  brokerageId: string,
  toEmail: string,
  toName: string,
  reportType: "brokerage" | "agent" | "team",
  filter: SourceAnalyticsFilter
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const result = await getSourcePerformance(filter)
    if (!result.success) return { success: false, error: result.error }

    const topSources = result.sources.slice(0, 5)
    const body = `
<h2>Source Analytics Report</h2>
<p>Report Type: ${reportType}</p>
<p>Period: ${filter.dateFrom ?? "last 12 months"} to ${filter.dateTo ?? "today"}</p>

<h3>Summary</h3>
<ul>
  <li>Total Sources: ${result.summary.total_sources}</li>
  <li>Total Contacts: ${result.summary.total_contacts}</li>
  <li>Total Leads: ${result.summary.total_leads}</li>
  <li>Total Transactions: ${result.summary.total_transactions}</li>
  <li>Total Revenue: $${result.summary.total_revenue.toFixed(0)}</li>
  <li>Top ROI Source: ${result.summary.top_roi_source ?? "N/A"}</li>
  <li>Top Volume Source: ${result.summary.top_volume_source ?? "N/A"}</li>
</ul>

<h3>Top 5 Sources</h3>
<table border="1" cellpadding="4">
  <tr><th>Source</th><th>Family</th><th>Contacts</th><th>Close Rate</th><th>Revenue</th><th>ROI</th></tr>
  ${topSources.map(s => `<tr>
    <td>${s.source}</td>
    <td>${s.source_family}</td>
    <td>${s.contact_count}</td>
    <td>${s.close_rate}%</td>
    <td>$${s.revenue_attributed.toFixed(0)}</td>
    <td>${s.roi_multiple}x</td>
  </tr>`).join("")}
</table>
`

    await supabase.from("email_queue").insert({
      brokerage_id: brokerageId,
      to_email: toEmail,
      to_name: toName,
      subject: `Source Analytics Report - ${new Date().toLocaleDateString()}`,
      body,
      status: "pending",
      attempts: 0,
    })

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Email failed" }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getSourceComparison — compare 2-4 sources side by side
// ─────────────────────────────────────────────────────────────────────────────

export async function getSourceComparison(
  brokerageId: string,
  sourceKeys: string[], // ["source_name::family", ...]
  filter: SourceAnalyticsFilter
): Promise<SourceComparisonResult> {
  try {
    const result = await getSourcePerformance({ ...filter, brokerageId })
    const sources = result.sources.filter(s => sourceKeys.includes(`${s.source}::${s.source_family}`))
    return { success: true, sources }
  } catch (err) {
    return { success: false, sources: [], error: err instanceof Error ? err.message : "Comparison failed" }
  }
}
