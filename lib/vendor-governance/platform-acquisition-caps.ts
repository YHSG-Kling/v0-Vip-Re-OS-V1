// lib/vendor-governance/platform-acquisition-caps.ts
//
// THE PLATFORM'S INTERNAL ACQUISITION BUDGET — OWNER-CONFIGURABLE CAPS, NO MADE-UP DEFAULT (wave 151, lane 151F; directive
// 151F "The platform may use a small controlled internal acquisition budget … 'Small' is not an authorized dollar amount:
// implement owner-configurable caps and stop-before-spend approvals, not made-up defaults.").
//
// SURVIVORS EXTENDED, NONE REPLACED: the caps are ONE jsonb column on the platform_settings SINGLETON (m976
// acquisition_budget_caps — the m753 self_healing_ceilings idiom: NULL = never set), read and written by the same shape of
// loader / validator / counted writer lib/kernel/healing-policy.ts uses, edited by the superadmin through
// app/actions/superadmin/platform-controls.ts (audited in superadmin_audit_log). The decision rides the EXISTING paid-call
// gate and backpressure: the pooled lane asks paidPullApproval first, then decideSpendBackpressure
// (lib/vendor-governance/budget-eval.ts) — which now takes `platformCapRemainingUsd`, the remaining dollars this module
// computes — so a platform-paid want is sized against the owner's cap in the same cycle, and a NULL cap REFUSES
// (stop-before-spend) rather than defaulting to any number. Spend is read from the ONE cost ledger (vendor_usage_tracking,
// the lead_scraping system source bookSourceSpend writes, platform_covered rows only — a tenant-paid row is the tenant's).
//
// WHAT IS NOT HERE: a price, a per-lead charge, a tenant invoice line, a default dollar figure of any kind.

type Svc = { from: (table: string) => any }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const ABSENT_COLUMN = new Set(["42703", "PGRST204"])

/** The owner's caps. EVERY field is nullable and NULL means "not configured → stop before spend". No default exists. */
export interface PlatformAcquisitionCaps {
  /** The platform's whole internal acquisition spend per calendar month (USD). */
  monthly_usd: number | null
  /** The most the platform spends on ANY ONE tenant's territory per calendar month (USD). */
  per_tenant_monthly_usd: number | null
  /** The most one paid pull may cost (USD). */
  per_pull_usd: number | null
  set_by: string | null
  set_at: string | null
}

export const ACQUISITION_CAP_FIELDS = ["monthly_usd", "per_tenant_monthly_usd", "per_pull_usd"] as const
type CapField = (typeof ACQUISITION_CAP_FIELDS)[number]

export const ACQUISITION_CAP_LABELS: Readonly<Record<CapField, string>> = Object.freeze({
  monthly_usd: "Platform acquisition spend per month (USD)",
  per_tenant_monthly_usd: "Per-tenant territory spend per month (USD)",
  per_pull_usd: "Per paid pull (USD)",
})

/** The booked system source the acquisition ledger rows carry (lib/lead-pipeline/source-cost-ledger.ts bookSourceSpend). */
export const ACQUISITION_LEDGER_SYSTEM_SOURCE = "lead_scraping"

export interface PlatformAcquisitionSpendInput {
  /** null = unreadable / not configured. */
  caps: PlatformAcquisitionCaps | null
  /** Platform-covered acquisition spend booked this calendar month (USD). null = the ledger could not be read. */
  platformSpentMonthUsd: number | null
  /** The same, for the tenant whose territory this want serves. null = unreadable (or no tenant → 0 is the caller's call). */
  tenantSpentMonthUsd: number | null
  /** What this want would cost at its documented price (USD). */
  wantUsd: number
}

export interface PlatformAcquisitionSpendVerdict {
  action: "proceed" | "throttle" | "refuse"
  /** Dollars that may be spent now (0 on refuse). */
  allowedUsd: number
  /** The binding remainder (null when it cannot be computed — a cap or a ledger figure is missing). */
  remainingUsd: number | null
  reasons: string[]
  /** A manager hears of it THIS cycle. */
  escalate: boolean
}

/**
 * PURE — THE ONE platform acquisition spend decision. Fails closed on every missing input: no caps row, any NULL cap
 * (no default is ever substituted), an unreadable ledger. Otherwise the binding remainder is the smallest of the three
 * headrooms; a want that fits proceeds, a want that partly fits is throttled to the remainder, an exhausted cap refuses.
 * Reached in product through platformCapRemainingFor below (the console and the pooled lane's `platformCapRemainingUsd`).
 * @proofSeam scripts/spend-backpressure-guard.ts section E drives every refuse / throttle / proceed branch directly
 */
export function decidePlatformAcquisitionSpend(input: PlatformAcquisitionSpendInput): PlatformAcquisitionSpendVerdict {
  const reasons: string[] = []
  const want = Math.max(0, input.wantUsd)
  if (!input.caps) return { action: "refuse", allowedUsd: 0, remainingUsd: null, reasons: ["platform acquisition caps are not configured — null means stop before spend; the owner sets them on the platform console"], escalate: true }
  for (const f of ACQUISITION_CAP_FIELDS) {
    const v = input.caps[f]
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) reasons.push(`${ACQUISITION_CAP_LABELS[f]} is not set — a null cap stops spend (no made-up default)`)
  }
  if (reasons.length > 0) return { action: "refuse", allowedUsd: 0, remainingUsd: null, reasons, escalate: true }
  if (input.platformSpentMonthUsd === null) return { action: "refuse", allowedUsd: 0, remainingUsd: null, reasons: ["the platform acquisition ledger could not be read — nothing is spent until it can be"], escalate: true }
  if (input.tenantSpentMonthUsd === null) return { action: "refuse", allowedUsd: 0, remainingUsd: null, reasons: ["the tenant's acquisition ledger could not be read — nothing is spent until it can be"], escalate: true }
  const caps = input.caps as Record<CapField, number>
  const heads: Array<{ f: CapField; left: number }> = [
    { f: "monthly_usd", left: caps.monthly_usd - Math.max(0, input.platformSpentMonthUsd) },
    { f: "per_tenant_monthly_usd", left: caps.per_tenant_monthly_usd - Math.max(0, input.tenantSpentMonthUsd) },
    { f: "per_pull_usd", left: caps.per_pull_usd },
  ]
  const binding = heads.reduce((a, b) => (b.left < a.left ? b : a))
  const remaining = Math.max(0, Math.round(binding.left * 100) / 100)
  if (want === 0) return { action: "proceed", allowedUsd: 0, remainingUsd: remaining, reasons: ["nothing wanted"], escalate: false }
  if (remaining <= 0) return { action: "refuse", allowedUsd: 0, remainingUsd: 0, reasons: [`${ACQUISITION_CAP_LABELS[binding.f]} is exhausted ($${caps[binding.f].toFixed(2)} cap)`], escalate: true }
  if (want > remaining) return { action: "throttle", allowedUsd: remaining, remainingUsd: remaining, reasons: [`${ACQUISITION_CAP_LABELS[binding.f]} binds: $${remaining.toFixed(2)} of the $${want.toFixed(2)} wanted fits`], escalate: true }
  return { action: "proceed", allowedUsd: want, remainingUsd: remaining, reasons: [`$${want.toFixed(2)} fits under ${ACQUISITION_CAP_LABELS[binding.f]} ($${remaining.toFixed(2)} left)`], escalate: false }
}

/** PURE — parse a stored caps object. A field absent or not a finite non-negative number reads NULL (never a default).
 *  @proofSeam scripts/spend-backpressure-guard.ts section E drives the null-never-default reading directly */
function parseAcquisitionCaps(raw: unknown): PlatformAcquisitionCaps | null {
  if (!isObj(raw)) return null
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null)
  return {
    monthly_usd: num(raw.monthly_usd), per_tenant_monthly_usd: num(raw.per_tenant_monthly_usd), per_pull_usd: num(raw.per_pull_usd),
    set_by: typeof raw.set_by === "string" ? raw.set_by : null, set_at: typeof raw.set_at === "string" ? raw.set_at : null,
  }
}

/** The stored caps (null = never set / column not applied). Reads its error (CLAUDE.md §3). */
export async function loadPlatformAcquisitionCaps(svc: Svc): Promise<{ ok: true; caps: PlatformAcquisitionCaps | null; applied: boolean } | { ok: false; error: string }> {
  try {
    const { data, error } = await svc.from("platform_settings").select("acquisition_budget_caps").order("created_at", { ascending: true }).limit(1).maybeSingle()
    if (error) {
      if (ABSENT_COLUMN.has(String(error.code ?? ""))) return { ok: true, caps: null, applied: false }
      return { ok: false, error: `platform acquisition caps unreadable: ${error.message ?? error.code}` }
    }
    return { ok: true, caps: parseAcquisitionCaps((data as { acquisition_budget_caps?: unknown } | null)?.acquisition_budget_caps), applied: true }
  } catch (e) {
    return { ok: false, error: `platform acquisition caps unreadable: ${(e as Error).message}` }
  }
}

/**
 * PURE — a superadmin's edit → the stored object. Each field: a finite number ≥ 0, or explicit null (stop), or blank =
 * keep the current value. A negative, NaN or non-numeric value is an error, never clamped.
 * @proofSeam scripts/spend-backpressure-guard.ts section E drives bounds, blank-keeps and the explicit-null STOP
 */
function validateAcquisitionCapsEdit(input: Record<string, unknown>, current: PlatformAcquisitionCaps | null, actor: { userId: string; now?: Date }): { ok: true; value: PlatformAcquisitionCaps } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const value: PlatformAcquisitionCaps = { monthly_usd: current?.monthly_usd ?? null, per_tenant_monthly_usd: current?.per_tenant_monthly_usd ?? null, per_pull_usd: current?.per_pull_usd ?? null, set_by: actor.userId, set_at: (actor.now ?? new Date()).toISOString() }
  for (const f of ACQUISITION_CAP_FIELDS) {
    if (!(f in input)) continue
    const raw = input[f]
    if (raw === null) { value[f] = null; continue }
    if (raw === undefined || String(raw).trim() === "") continue
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) { errors.push(`${ACQUISITION_CAP_LABELS[f]}: a number ≥ 0, or null to stop spend`); continue }
    value[f] = Math.round(n * 100) / 100
  }
  return errors.length ? { ok: false, errors } : { ok: true, value }
}

/** Write the caps on the singleton (the caller is superadmin-gated and audits). `.select()`-counted (§3). */
export async function setPlatformAcquisitionCaps(svc: Svc, input: Record<string, unknown>, actor: { userId: string; now?: Date }): Promise<{ ok: true; before: PlatformAcquisitionCaps | null; after: PlatformAcquisitionCaps } | { ok: false; error: string }> {
  const cur = await loadPlatformAcquisitionCaps(svc)
  if (!cur.ok) return { ok: false, error: cur.error }
  if (!cur.applied) return { ok: false, error: "The platform acquisition caps column is not applied yet (m976) — nothing written; every platform-paid pull stops." }
  const v = validateAcquisitionCapsEdit(input, cur.caps, actor)
  if (!v.ok) return { ok: false, error: v.errors.join("; ") }
  const { data: row, error: rowErr } = await svc.from("platform_settings").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle()
  if (rowErr) return { ok: false, error: `platform settings unreadable: ${rowErr.message}` }
  if (!row) return { ok: false, error: "No platform_settings row exists — the caps were not written." }
  const { data: moved, error } = await svc.from("platform_settings").update({ acquisition_budget_caps: v.value, updated_at: new Date().toISOString() }).eq("id", (row as { id: unknown }).id).select("id")
  if (error) return { ok: false, error: `Acquisition caps NOT saved: ${error.message}` }
  if (!Array.isArray(moved) || moved.length !== 1) return { ok: false, error: "Acquisition caps NOT saved: the update matched no platform_settings row." }
  return { ok: true, before: cur.caps, after: v.value }
}

// ─── the spend half: what the platform has already spent on acquisition this month ───────────────────────────────

export interface AcquisitionLedgerRow {
  brokerage_id: string | null
  total_cost: number | string | null
  request_metadata: Record<string, unknown> | null
  created_at?: string
}

/** PURE — a ledger row the PLATFORM paid for acquisition: the lead_scraping system source, not a tenant-paid row. */
function isPlatformAcquisitionRow(r: AcquisitionLedgerRow): boolean {
  const m = r.request_metadata ?? {}
  if (m.system_source !== ACQUISITION_LEDGER_SYSTEM_SOURCE) return false
  return (m.coverage ?? "platform_covered") !== "tenant_paid"
}

/** PURE — platform acquisition spend this month, in total and for one tenant. Tenant-paid rows never count. */
function foldPlatformAcquisitionSpend(rows: readonly AcquisitionLedgerRow[], tenantId: string | null): { platformUsd: number; tenantUsd: number; rows: number } {
  let platform = 0, tenant = 0, n = 0
  for (const r of rows) {
    if (!isPlatformAcquisitionRow(r)) continue
    const c = Number(r.total_cost) || 0
    platform += c; n++
    if (tenantId && r.brokerage_id === tenantId) tenant += c
  }
  return { platformUsd: Math.round(platform * 100) / 100, tenantUsd: Math.round(tenant * 100) / 100, rows: n }
}

/**
 * The month's acquisition ledger rows, read ONCE (the pooled lane folds them per tenant from one read — lane 151F's
 * "per-tenant cap reading", built by lane 151L). A refused read is `null` (every caller refuses), never an empty list.
 */
export async function loadPlatformAcquisitionLedgerRows(svc: Svc, now: Date = new Date()): Promise<{ rows: AcquisitionLedgerRow[] | null; error: string | null }> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const { data, error } = await svc.from("vendor_usage_tracking").select("brokerage_id, total_cost, request_metadata, created_at").gte("created_at", monthStart).limit(50000)
  if (error) return { rows: null, error: `vendor_usage_tracking read refused: ${error.message}` }
  return { rows: (data ?? []) as AcquisitionLedgerRow[], error: null }
}

/** The month-to-date read. A refused read is `null` figures (the decision refuses), never zeros. */
export async function loadPlatformAcquisitionSpend(svc: Svc, opts: { tenantId: string | null; now?: Date }): Promise<{ platformUsd: number | null; tenantUsd: number | null; rows: number; error: string | null }> {
  const ledger = await loadPlatformAcquisitionLedgerRows(svc, opts.now ?? new Date())
  if (ledger.rows === null) return { platformUsd: null, tenantUsd: null, rows: 0, error: ledger.error }
  const f = foldPlatformAcquisitionSpend(ledger.rows, opts.tenantId)
  return { platformUsd: f.platformUsd, tenantUsd: f.tenantUsd, rows: f.rows, error: null }
}

/**
 * PURE — THE ONE composition of caps × the month's ledger for ONE tenant (lane 151F's per-tenant cap reading, built by
 * lane 151L): the platform month total and THIS tenant's month share are folded from the same rows, and the owner's
 * monthly / per-tenant / per-pull caps are judged by decidePlatformAcquisitionSpend. `rows === null` (an unreadable ledger)
 * refuses, never reads as zero spend. platformCapRemainingFor is this function over a live read; the pooled lane calls it
 * per want over ONE read per cycle, so two tenants under one platform cap each see their own remainder.
 */
export function platformCapRemainingFromLedger(caps: PlatformAcquisitionCaps | null, rows: readonly AcquisitionLedgerRow[] | null, tenantId: string | null): { remainingUsd: number | null; verdict: PlatformAcquisitionSpendVerdict } {
  const f = rows === null ? null : foldPlatformAcquisitionSpend(rows, tenantId)
  const verdict = decidePlatformAcquisitionSpend({
    caps,
    platformSpentMonthUsd: f ? f.platformUsd : null,
    tenantSpentMonthUsd: f ? (tenantId ? f.tenantUsd : 0) : null,
    wantUsd: 0,
  })
  return { remainingUsd: verdict.action === "refuse" ? null : verdict.remainingUsd, verdict }
}

/**
 * The remaining platform acquisition dollars for ONE tenant's want this cycle — the figure the pooled lane hands
 * decideSpendBackpressure as `platformCapRemainingUsd`. null = caps unconfigured or ledger unreadable (backpressure refuses).
 */
export async function platformCapRemainingFor(svc: Svc, tenantId: string | null, now: Date = new Date()): Promise<{ remainingUsd: number | null; verdict: PlatformAcquisitionSpendVerdict }> {
  const [caps, ledger] = await Promise.all([loadPlatformAcquisitionCaps(svc), loadPlatformAcquisitionLedgerRows(svc, now)])
  return platformCapRemainingFromLedger(caps.ok ? caps.caps : null, ledger.rows, tenantId)
}
