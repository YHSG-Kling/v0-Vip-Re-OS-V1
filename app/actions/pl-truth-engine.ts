"use server"

/**
 * P&L Truth Engine — server actions
 *
 * Exposes per-agent P&L data (from agent_pl_snapshot) and per-agent AI cost
 * attribution (from ai_tool_usage) to broker/admin dashboards.
 *
 * Role gate: broker | broker_admin | admin | superadmin | team_lead only.
 * All queries are brokerage-scoped (tenant safety).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

const ADMIN_ROLES = new Set([
  "broker", "broker_admin", "admin", "superadmin", "team_lead",
])

async function requireBrokerAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, error: "Unauthorized" }

  const { data: row } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!row?.brokerage_id) return { ok: false as const, error: "Brokerage not configured" }
  if (!ADMIN_ROLES.has(row.user_type as string)) return { ok: false as const, error: "Forbidden" }

  return { ok: true as const, brokerageId: row.brokerage_id as string }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentPLRow {
  agent_id:              string
  agent_name:            string
  month_year:            string
  gci_gross:             number
  agent_payout:          number
  brokerage_gross:       number
  ai_cost_cents:         number
  fee_income_cents:      number
  net_brokerage_margin:  number
  roi_multiple:          number | null
  transaction_count:     number
  computed_at:           string
}

export interface AgentAICostRow {
  agent_id:      string
  agent_name:    string
  cost_cents:    number
  token_count:   number
  gci_gross:     number
  roi_multiple:  number | null
  top_feature:   string | null
}

export interface CronHealthRow {
  cron_name:              string
  cron_path:              string | null
  last_run_at:            string | null
  last_status:            string | null
  last_duration_ms:       number | null
  last_records_processed: number | null
  last_error_message:     string | null
  expected_interval_hours: number
  is_stale:               boolean
  run_count_7d:           number
  failure_count_7d:       number
  updated_at:             string
}

// ─── Action 1: getAgentPLSummary ──────────────────────────────────────────────

export async function getAgentPLSummary(monthYear?: string): Promise<
  | { ok: true; rows: AgentPLRow[]; monthYear: string }
  | { ok: false; error: string }
> {
  const auth = await requireBrokerAdmin()
  if (!auth.ok) return auth

  const now = new Date()
  const target = monthYear ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`

  const svc = createServiceClient()

  const { data, error } = await svc
    .from("agent_pl_snapshot")
    .select(`
      agent_id, month_year,
      gci_gross, agent_payout, brokerage_gross,
      ai_cost_cents, fee_income_cents, net_brokerage_margin,
      roi_multiple, transaction_count, computed_at,
      agents:agent_id (
        users:user_id (full_name, email)
      )
    `)
    .eq("brokerage_id", auth.brokerageId)
    .eq("month_year", target)
    .order("gci_gross", { ascending: false })
    .limit(100)

  if (error) return { ok: false, error: error.message }

  const rows: AgentPLRow[] = (data ?? []).map((r: any) => {
    const user = r.agents?.users
    return {
      agent_id:             r.agent_id,
      agent_name:           user?.full_name ?? user?.email ?? "Unknown Agent",
      month_year:           r.month_year,
      gci_gross:            r.gci_gross ?? 0,
      agent_payout:         r.agent_payout ?? 0,
      brokerage_gross:      r.brokerage_gross ?? 0,
      ai_cost_cents:        r.ai_cost_cents ?? 0,
      fee_income_cents:     r.fee_income_cents ?? 0,
      net_brokerage_margin: r.net_brokerage_margin ?? 0,
      roi_multiple:         r.roi_multiple ?? null,
      transaction_count:    r.transaction_count ?? 0,
      computed_at:          r.computed_at,
    }
  })

  return { ok: true, rows, monthYear: target }
}

// ─── Action 2: getAgentAICostRanking ─────────────────────────────────────────

export async function getAgentAICostRanking(monthYear?: string): Promise<
  | { ok: true; rows: AgentAICostRow[] }
  | { ok: false; error: string }
> {
  const auth = await requireBrokerAdmin()
  if (!auth.ok) return auth

  const now = new Date()
  const target = monthYear ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const monthStart = `${target}-01T00:00:00Z`
  // Last day of month
  const [yr, mo] = target.split("-").map(Number)
  const monthEnd = new Date(yr, mo, 0).toISOString().slice(0, 10) + "T23:59:59Z"

  const svc = createServiceClient()

  // Aggregate AI costs per agent for the month
  const { data: usageRows, error: usageErr } = await svc
    .from("ai_tool_usage")
    .select("agent_id, cost_cents, tokens_used, feature")
    .eq("brokerage_id", auth.brokerageId)
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd)
    .not("agent_id", "is", null)

  if (usageErr) return { ok: false, error: usageErr.message }

  // Aggregate per agent
  const byAgent: Record<string, { cost: number; tokens: number; features: Record<string, number> }> = {}
  for (const row of usageRows ?? []) {
    const aid = row.agent_id as string
    if (!byAgent[aid]) byAgent[aid] = { cost: 0, tokens: 0, features: {} }
    byAgent[aid].cost   += row.cost_cents ?? 0
    byAgent[aid].tokens += row.tokens_used ?? 0
    const feat = (row.feature as string) ?? "unknown"
    byAgent[aid].features[feat] = (byAgent[aid].features[feat] ?? 0) + 1
  }

  // Get agent names + their GCI from pl_snapshot
  const agentIds = Object.keys(byAgent)
  if (agentIds.length === 0) return { ok: true, rows: [] }

  const { data: plRows } = await svc
    .from("agent_pl_snapshot")
    .select("agent_id, gci_gross")
    .eq("brokerage_id", auth.brokerageId)
    .eq("month_year", target)
    .in("agent_id", agentIds)

  const gciByAgent: Record<string, number> = {}
  for (const r of plRows ?? []) gciByAgent[r.agent_id] = r.gci_gross ?? 0

  const { data: agentUsers } = await svc
    .from("agents")
    .select("id, users:user_id (full_name, email)")
    .in("id", agentIds)

  const nameByAgent: Record<string, string> = {}
  for (const a of agentUsers ?? []) {
    const u = (a as any).users
    nameByAgent[a.id] = u?.full_name ?? u?.email ?? "Unknown"
  }

  const rows: AgentAICostRow[] = Object.entries(byAgent)
    .map(([agentId, data]) => {
      const gci = gciByAgent[agentId] ?? 0
      const totalSpend = data.cost / 100
      const topFeature = Object.entries(data.features).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      return {
        agent_id:     agentId,
        agent_name:   nameByAgent[agentId] ?? "Unknown",
        cost_cents:   data.cost,
        token_count:  data.tokens,
        gci_gross:    gci,
        roi_multiple: totalSpend > 0 ? gci / totalSpend : null,
        top_feature:  topFeature,
      }
    })
    .sort((a, b) => b.cost_cents - a.cost_cents)

  return { ok: true, rows }
}

// ─── Action 3: getCronHealth ──────────────────────────────────────────────────

export async function getCronHealth(): Promise<
  | { ok: true; rows: CronHealthRow[]; staleCount: number; failedCount: number }
  | { ok: false; error: string }
> {
  const auth = await requireBrokerAdmin()
  if (!auth.ok) return auth

  // Compute 7-day run/failure counts from cron_execution_logs
  const svc = createServiceClient()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [snapshotResult, recentRunsResult] = await Promise.all([
    svc
      .from("cron_health_snapshot")
      .select("*")
      .order("cron_name", { ascending: true }),
    svc
      .from("cron_execution_logs")
      .select("cron_name, status")
      .gte("started_at", sevenDaysAgo)
      .not("cron_name", "is", null),
  ])

  if (snapshotResult.error) return { ok: false, error: snapshotResult.error.message }

  // Aggregate 7d counts per cron
  const run7d:     Record<string, number> = {}
  const failure7d: Record<string, number> = {}
  for (const row of recentRunsResult.data ?? []) {
    const name = row.cron_name as string
    run7d[name]     = (run7d[name] ?? 0) + 1
    if (row.status === "failure") failure7d[name] = (failure7d[name] ?? 0) + 1
  }

  // Update snapshot rows with 7d counts (in-memory — don't write back to avoid noise)
  const rows: CronHealthRow[] = (snapshotResult.data ?? []).map((r: any) => {
    const intervalMs = (r.expected_interval_hours ?? 24) * 60 * 60 * 1000
    const isStale = !r.last_run_at
      || Date.now() - new Date(r.last_run_at).getTime() > intervalMs
    return {
      cron_name:               r.cron_name,
      cron_path:               r.cron_path ?? null,
      last_run_at:             r.last_run_at ?? null,
      last_status:             r.last_status ?? null,
      last_duration_ms:        r.last_duration_ms ?? null,
      last_records_processed:  r.last_records_processed ?? null,
      last_error_message:      r.last_error_message ?? null,
      expected_interval_hours: r.expected_interval_hours ?? 24,
      is_stale:                isStale,
      run_count_7d:            run7d[r.cron_name] ?? 0,
      failure_count_7d:        failure7d[r.cron_name] ?? 0,
      updated_at:              r.updated_at,
    }
  })

  const staleCount  = rows.filter(r => r.is_stale).length
  const failedCount = rows.filter(r => r.last_status === "failure").length

  return { ok: true, rows, staleCount, failedCount }
}
