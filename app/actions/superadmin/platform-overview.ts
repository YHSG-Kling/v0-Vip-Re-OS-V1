"use server"

/**
 * Superadmin platform-wide overview actions.
 *
 * Returns cross-tenant aggregates for the platform CFO dashboard:
 *  - per-brokerage margin (MRR − AI cost) from v_platform_margin (1055)
 *  - fair-use violators (warning + blocked) from v_brokerage_ai_quota (1054)
 *  - cron-health rollup (stale + recent failures) from cron_health_snapshot (1053)
 *  - tenant-isolation feed (unresolved findings) from tenant_safety_findings (1033)
 *
 * Every action requires user_type='superadmin'; non-superadmin returns
 * { ok: false, error: "Forbidden" } so the page can render an inline
 * permission error instead of a 403.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

async function requireSuperadmin(): Promise<
  | { ok: true; userId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (data?.user_type !== "superadmin") return { ok: false, error: "Forbidden" }
  return { ok: true, userId: user.id }
}

// ─────────────────────────────────────────────────────────────────────────────
// MARGIN PER TENANT
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformMarginRow {
  brokerage_id:        string
  brokerage_name:      string | null
  plan_tier:           "solo_agent" | "team" | "brokerage" | "multi_location"
  tier_display_name:   string | null
  mrr_cents:           number
  ai_cost_cents:       number
  ai_tokens:           number
  margin_cents:        number
  margin_percent:      number | null
  quota_status:        "ok" | "warning" | "blocked" | "unlimited" | null
  quota_percent_used:  number | null
  /** MTD telephony spend (cents) from the EXISTING vendor_usage_tracking ledger
   *  (twilio/telnyx/bandwidth voice+SMS metering) — NOT part of margin_cents
   *  (the view's MRR − AI number); rendered as its own labeled line. */
  telephony_cost_cents: number
}

// Telephony vendor names as they appear in vendor_usage_tracking. Writers store
// either the resolved provider key (dispatch.ts → 'twilio'/'telnyx'/'bandwidth')
// or the lane key ('twilio_voice'/'twilio_sms' via the cost normalizer /
// message-persister). Matching the whole family keeps the number honest.
const TELEPHONY_VENDOR_NAMES = [
  "twilio", "twilio_voice", "twilio_sms", "telnyx", "bandwidth", "plivo", "sinch",
]

export interface PlatformOverviewResult {
  ok: true
  totals: {
    brokerage_count:   number
    total_mrr_cents:   number
    total_ai_cents:    number
    /** MTD telephony spend across all tenants (vendor_usage_tracking ledger). */
    total_telephony_cents: number
    total_margin_cents: number
    margin_percent:    number | null
    by_tier: Record<
      "solo_agent" | "team" | "brokerage" | "multi_location",
      { count: number; mrr_cents: number; ai_cost_cents: number }
    >
  }
  rows: PlatformMarginRow[]
  fair_use_violators: PlatformMarginRow[]   // warning or blocked
  losing_money:       PlatformMarginRow[]   // ai_cost > mrr
}

export async function getPlatformOverviewAction(): Promise<
  PlatformOverviewResult | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // Same window as the view: the current UTC month.
  const now = new Date()
  const monthStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

  const [{ data, error }, telRes] = await Promise.all([
    svc
      .from("v_platform_margin")
      .select("*")
      .order("margin_cents", { ascending: true }),   // worst-margin first
    // TELEPHONY (MTD) — cheap ledger read (vendor_usage_tracking); no vendor API.
    svc
      .from("vendor_usage_tracking")
      .select("brokerage_id, total_cost")
      .in("vendor_name", TELEPHONY_VENDOR_NAMES)
      .gte("created_at", monthStartIso)
      .limit(10000),
  ])

  if (error) return { ok: false, error: error.message }
  const telephonyByBrokerage = new Map<string, number>()
  for (const t of (telRes.data ?? []) as Array<{ brokerage_id: string | null; total_cost: number | string | null }>) {
    if (!t.brokerage_id) continue
    const cents = Math.round(Number(t.total_cost ?? 0) * 100)
    if (!(cents > 0)) continue
    telephonyByBrokerage.set(t.brokerage_id, (telephonyByBrokerage.get(t.brokerage_id) ?? 0) + cents)
  }
  const rows = ((data ?? []) as Omit<PlatformMarginRow, "telephony_cost_cents">[]).map((r) => ({
    ...r,
    telephony_cost_cents: telephonyByBrokerage.get(r.brokerage_id) ?? 0,
  })) as PlatformMarginRow[]

  const totals = {
    brokerage_count:    rows.length,
    total_mrr_cents:    rows.reduce((s, r) => s + (r.mrr_cents ?? 0), 0),
    total_ai_cents:     rows.reduce((s, r) => s + (r.ai_cost_cents ?? 0), 0),
    total_telephony_cents: rows.reduce((s, r) => s + (r.telephony_cost_cents ?? 0), 0),
    total_margin_cents: 0,
    margin_percent:     null as number | null,
    by_tier: {
      solo_agent:     { count: 0, mrr_cents: 0, ai_cost_cents: 0 },
      team:           { count: 0, mrr_cents: 0, ai_cost_cents: 0 },
      brokerage:      { count: 0, mrr_cents: 0, ai_cost_cents: 0 },
      multi_location: { count: 0, mrr_cents: 0, ai_cost_cents: 0 },
    },
  }
  totals.total_margin_cents = totals.total_mrr_cents - totals.total_ai_cents
  totals.margin_percent = totals.total_mrr_cents > 0
    ? Math.round((totals.total_margin_cents / totals.total_mrr_cents) * 1000) / 10
    : null
  for (const r of rows) {
    const t = r.plan_tier
    if (t in totals.by_tier) {
      totals.by_tier[t].count        += 1
      totals.by_tier[t].mrr_cents    += r.mrr_cents ?? 0
      totals.by_tier[t].ai_cost_cents += r.ai_cost_cents ?? 0
    }
  }

  return {
    ok: true,
    totals,
    rows,
    fair_use_violators: rows.filter(r => r.quota_status === "warning" || r.quota_status === "blocked"),
    losing_money:       rows.filter(r => (r.ai_cost_cents ?? 0) > (r.mrr_cents ?? 0) && (r.mrr_cents ?? 0) > 0),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON HEALTH ROLLUP
// ─────────────────────────────────────────────────────────────────────────────

export interface CronHealthRow {
  cron_name:               string
  cron_path:               string | null
  last_run_at:             string | null
  last_status:             string | null
  last_duration_ms:        number | null
  last_records_processed:  number | null
  last_error_message:      string | null
  expected_interval_hours: number
  run_count_7d:            number
  failure_count_7d:        number
  is_stale:                boolean
}

export interface CronHealthResult {
  ok: true
  rows:     CronHealthRow[]
  totals: {
    total:    number
    stale:    number
    failing:  number
    running:  number
  }
}

export async function getCronHealthAction(): Promise<
  CronHealthResult | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const { data, error } = await svc
    .from("cron_health_snapshot")
    .select("*")
    .order("last_run_at", { ascending: false, nullsFirst: true })

  if (error) return { ok: false, error: error.message }

  const now = Date.now()
  const rows: CronHealthRow[] = (data ?? []).map((r: Record<string, unknown>) => {
    const intervalMs = (Number(r.expected_interval_hours ?? 24)) * 3600 * 1000
    const lastRun    = r.last_run_at ? new Date(r.last_run_at as string).getTime() : null
    const is_stale   = lastRun === null || (now - lastRun) > intervalMs
    return {
      cron_name:               r.cron_name as string,
      cron_path:               (r.cron_path as string | null) ?? null,
      last_run_at:             (r.last_run_at as string | null) ?? null,
      last_status:             (r.last_status as string | null) ?? null,
      last_duration_ms:        (r.last_duration_ms as number | null) ?? null,
      last_records_processed:  (r.last_records_processed as number | null) ?? null,
      last_error_message:      (r.last_error_message as string | null) ?? null,
      expected_interval_hours: Number(r.expected_interval_hours ?? 24),
      run_count_7d:            Number(r.run_count_7d ?? 0),
      failure_count_7d:        Number(r.failure_count_7d ?? 0),
      is_stale,
    }
  })

  return {
    ok: true,
    rows,
    totals: {
      total:   rows.length,
      stale:   rows.filter(r => r.is_stale).length,
      failing: rows.filter(r => r.last_status === "failure" || r.failure_count_7d > 0).length,
      running: rows.filter(r => r.last_status === "running").length,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TENANT ISOLATION FEED
// ─────────────────────────────────────────────────────────────────────────────

export interface TenantSafetyFindingRow {
  id:            string
  finding_type:  string
  table_name:    string
  severity:      "low" | "medium" | "high" | "critical"
  affected_rows: number | null
  resolved:      boolean
  details:       Record<string, unknown>
  created_at:    string
}

export async function getTenantSafetyFeedAction(limit = 20): Promise<
  | { ok: true; rows: TenantSafetyFindingRow[]; unresolved_count: number }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const [{ data: rows, error }, { count: unresolved }] = await Promise.all([
    svc
      .from("tenant_safety_findings")
      .select("id, finding_type, table_name, severity, affected_rows, resolved, details, created_at")
      .order("created_at", { ascending: false })
      .limit(limit),
    svc
      .from("tenant_safety_findings")
      .select("*", { count: "exact", head: true })
      .eq("resolved", false),
  ])
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    rows: (rows ?? []) as TenantSafetyFindingRow[],
    unresolved_count: unresolved ?? 0,
  }
}
