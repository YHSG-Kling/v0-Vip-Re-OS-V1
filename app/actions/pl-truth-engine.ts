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

  // DESTRUCTURED DELIBERATELY. supabase-js RESOLVES a refused query, so
  // `const { data: row }` alone reads "permission denied" as "no such user" and
  // this gate cannot tell the two apart. It fails closed either way, but the
  // caller is told WHICH, because "your row is missing" and "you may not read
  // your row" send an operator to two different places.
  const { data: row, error: userError } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (userError) return { ok: false as const, error: `Identity read refused: ${userError.message}` }
  if (!row?.brokerage_id) return { ok: false as const, error: "Brokerage not configured" }
  if (!ADMIN_ROLES.has(row.user_type as string)) return { ok: false as const, error: "Forbidden" }

  return {
    ok: true as const,
    brokerageId: row.brokerage_id as string,
    // Platform admins see every tenant's cron runs and the raw failure text.
    // Everyone else is confined to their own tenant plus the untenanted
    // platform sweeps — see getCronHealth.
    isPlatformAdmin: row.user_type === "superadmin",
  }
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
  /**
   * True when `last_error_message` was WITHHELD rather than absent.
   *
   * `cron_health_snapshot` is keyed on `cron_name` alone (upserted
   * `onConflict: "cron_name"` by lib/kernel/cron-logging.ts) and carries NO
   * `brokerage_id` column, so one row per cron is shared by every tenant and
   * its `last_error_message` is whatever the most recent failing run wrote —
   * possibly another tenant's. A null that means "withheld" and a null that
   * means "this cron has not failed" are opposite facts, so the surface is told
   * which one it is holding instead of rendering a clean bill of health.
   */
  error_message_redacted: boolean
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

  // ── WHAT A BROKER SEES vs WHAT A PLATFORM ADMIN SEES ──────────────────────
  //
  // This reader runs on a SERVICE client, which bypasses RLS entirely — so the
  // tenant boundary here is the query predicate, not the policy. The predicate
  // is written to compute exactly what `cron_execution_logs`' own SELECT policy
  // computes for a session client, so the two can never disagree:
  //
  //     (brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())
  //
  //   · PLATFORM ADMIN (superadmin): no predicate. Every tenant's runs, plus the
  //     untenanted platform sweeps, plus the raw failure text.
  //   · EVERYONE ELSE (broker, broker_admin, admin, team_lead): their OWN
  //     tenant's runs AND the untenanted platform sweeps — never another
  //     tenant's. A cron that ran FOR this brokerage is theirs to see; a cron
  //     that swept every brokerage is nobody's in particular and is shown to all
  //     of them, which is what it has always been for.
  //
  // THE `.or()` IS LOAD-BEARING AND IS NOT A `.eq()` IN DISGUISE. An `.eq(
  // "brokerage_id", …)` here would be strictly WRONG, not merely stricter:
  // `NULL = <uuid>` is NULL, so it would drop every untenanted platform sweep —
  // and as of this writing ALL 130 `createCronRunContextAction` call sites pass
  // no brokerage_id at all, and both remaining direct writers stamp an explicit
  // `brokerage_id: null`. An `.eq()` would therefore show a broker an EMPTY cron
  // health page, which is a worse regression than the over-sharing it fixes.
  const tenantScope = `brokerage_id.is.null,brokerage_id.eq.${auth.brokerageId}`

  // The tenant disjunction is applied while the chain is still a FILTER builder.
  // `.or()` is declared on PostgrestFilterBuilder; `.order()` / `.limit()` return
  // a PostgrestTransformBuilder, which does not declare it — so scoping after
  // those would still run but would not type-check.
  const runsBase = svc.from("cron_execution_logs").select("cron_name, status")

  const [snapshotResult, recentRunsResult] = await Promise.all([
    svc
      .from("cron_health_snapshot")
      .select("*")
      .order("cron_name", { ascending: true }),
    (auth.isPlatformAdmin ? runsBase : runsBase.or(tenantScope))
      .gte("started_at", sevenDaysAgo)
      .not("cron_name", "is", null),
  ])

  if (snapshotResult.error) return { ok: false, error: snapshotResult.error.message }

  // A REFUSED LEDGER READ IS NOT A QUIET ZERO. This error was previously
  // dropped on the floor and `recentRunsResult.data ?? []` turned the refusal
  // into `run_count_7d: 0` on every row — a cron that has run 500 times and one
  // whose history could not be read rendered identically, and the second is the
  // one an operator has to act on.
  if (recentRunsResult.error) {
    return { ok: false, error: `cron_execution_logs read was refused: ${recentRunsResult.error.message}` }
  }

  // Aggregate 7d counts per cron
  const run7d:     Record<string, number> = {}
  const failure7d: Record<string, number> = {}
  //
  // TWO VOCABULARIES MEET IN THIS FUNCTION AND THEY ARE NOT THE SAME WORDS.
  // `cron_execution_logs.status` is CHECK-constrained to
  // 'started' | 'completed' | 'failed' | 'timeout' (verified against
  // pg_constraint), while `cron_health_snapshot.last_status` is written
  // 'success' | 'failure' by lib/kernel/cron-logging.ts. This loop tested the
  // SNAPSHOT's word against the LEDGER's column, and 'failure' is not a value
  // the ledger's CHECK will even admit — so `failure_count_7d` could never be
  // anything but 0, on every cron, forever. A health board whose failure column
  // is hard-wired to zero is worse than one that is absent.
  //
  // A timeout is counted as a failure: the run did not complete, and a board
  // that shows it as neither run-nor-failed loses it entirely.
  const LEDGER_FAILURE_STATUSES = new Set(["failed", "timeout"])
  for (const row of recentRunsResult.data ?? []) {
    const name = row.cron_name as string
    run7d[name]     = (run7d[name] ?? 0) + 1
    if (LEDGER_FAILURE_STATUSES.has(row.status as string)) {
      failure7d[name] = (failure7d[name] ?? 0) + 1
    }
  }

  // Update snapshot rows with 7d counts (in-memory — don't write back to avoid noise)
  // `cron_health_snapshot` HAS NO TENANT COLUMN AND CANNOT BE SCOPED BY ONE.
  // Verified against pg_attribute: there is no `brokerage_id` on this table, and
  // cron-logging.ts upserts it `onConflict: "cron_name"` — one row per cron
  // name, shared by the whole platform. Every one of this tree's 130 cron routes
  // is a platform-wide sweep, so the SET of rows is genuinely platform
  // infrastructure and a broker seeing "daily-briefing is stale" is seeing a
  // fact about the platform they run on, not about another tenant.
  //
  // `last_error_message` IS THE EXCEPTION, because it is free text copied from
  // whichever run failed most recently — and `recordCronFailure` writes it for
  // ANY cron with a name, including a tenant-scoped one. That is the one column
  // on this table that can carry another tenant's data, so it is withheld from
  // everyone but a platform admin, and the withholding is REPORTED rather than
  // rendered as a null that reads like "no failure".
  const rows: CronHealthRow[] = (snapshotResult.data ?? []).map((r: any) => {
    const intervalMs = (r.expected_interval_hours ?? 24) * 60 * 60 * 1000
    const isStale = !r.last_run_at
      || Date.now() - new Date(r.last_run_at).getTime() > intervalMs
    const rawError = r.last_error_message ?? null
    const withheld = !auth.isPlatformAdmin && rawError !== null
    return {
      cron_name:               r.cron_name,
      cron_path:               r.cron_path ?? null,
      last_run_at:             r.last_run_at ?? null,
      last_status:             r.last_status ?? null,
      last_duration_ms:        r.last_duration_ms ?? null,
      last_records_processed:  r.last_records_processed ?? null,
      last_error_message:      withheld ? null : rawError,
      error_message_redacted:  withheld,
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
