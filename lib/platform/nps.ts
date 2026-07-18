// lib/platform/nps.ts
// ─────────────────────────────────────────────────────────────────────────────
// TENANT → PLATFORM NPS — the OS asking its own subscribers the question it
// teaches them to ask their clients: "how likely are you to recommend us?"
//
// PURE half (top of file): classification (0–6 detractor / 7–8 passive / 9–10
// promoter), the NPS formula (% promoters − % detractors, integer, with the
// sample size always carried alongside — an NPS without its n is a lie),
// period math ("YYYY-MM", matching the platform_nps_responses.period CHECK),
// and the eligibility rule.
//
// ELIGIBILITY RULE (the whole rule, in one place):
//   • a tenant user is prompted at most ONCE PER QUARTER — eligible only when
//     they have no response in ANY of the current quarter's three periods
//     (so answering in July silences the prompt through September), AND
//   • only after 30+ days of tenancy — users.created_at (their own tenure,
//     falling back to brokerages.created_at when the user row predates the
//     column) must be at least 30 days old. A first-week user has no informed
//     answer yet; asking them poisons the sample.
//   Dismissing the card stores NOTHING (session-only hide, client-side) — the
//   user simply becomes promptable again next visit / next quarter. Honest:
//   no shadow "skipped" ledger.
//
// SERVER half (bottom): shouldPromptNps / submitNps / rollupNpsByPeriod over
// platform_nps_responses (id, brokerage_id, user_id, score 0–10, verbatim,
// period 'YYYY-MM', created_at, UNIQUE(user_id, period)). The UNIQUE
// constraint IS the idempotency guard for submits — a duplicate submit in the
// same period is treated as already-recorded, not an error.
//
// CONSUMERS: app/actions/nps.ts (tenant survey card), the superadmin
// engagement page (rollup section), and the platform-sentinel cron (detractor
// feed → 'engagement_risk' proposals with a drafted check-in).

import { createServiceClient } from "@/lib/supabase/service"

// ─── PURE: classification ────────────────────────────────────────────────────

export type NpsBucket = "detractor" | "passive" | "promoter"

/** PURE: standard NPS buckets — 0–6 detractor, 7–8 passive, 9–10 promoter. */
export function classifyNps(score: number): NpsBucket {
  if (score <= 6) return "detractor"
  if (score <= 8) return "passive"
  return "promoter"
}

/** Detractor ceiling — shared with the sentinel feed (score ≤ 6). */
export const NPS_DETRACTOR_MAX_SCORE = 6

export interface NpsRollup {
  /** % promoters − % detractors, rounded to an integer. null when sample = 0. */
  nps: number | null
  promoters: number
  passives: number
  detractors: number
  /** Total responses behind the number — always report it next to the score. */
  sample: number
}

/** PURE: fold scored rows into an NPS rollup. Empty in → nps null, honestly. */
export function computeNps(rows: Array<{ score: number }>): NpsRollup {
  let promoters = 0, passives = 0, detractors = 0
  for (const r of rows) {
    const b = classifyNps(r.score)
    if (b === "promoter") promoters++
    else if (b === "passive") passives++
    else detractors++
  }
  const sample = rows.length
  const nps = sample === 0 ? null : Math.round(((promoters - detractors) / sample) * 100)
  return { nps, promoters, passives, detractors, sample }
}

// ─── PURE: period math ("YYYY-MM", UTC — matches the period CHECK) ───────────

/** PURE: the current survey period, "YYYY-MM" (UTC). */
export function currentPeriod(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
}

/** PURE: the three "YYYY-MM" periods of `now`'s calendar quarter (UTC). */
export function quarterPeriods(now: Date): string[] {
  const q0 = Math.floor(now.getUTCMonth() / 3) * 3 // first month of the quarter, 0-based
  const y = now.getUTCFullYear()
  return [0, 1, 2].map((i) => `${y}-${String(q0 + i + 1).padStart(2, "0")}`)
}

/** PURE: the last N "YYYY-MM" periods, newest first (current month included). */
export function lastNPeriods(n: number, now: Date): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`)
  }
  return out
}

/** Minimum tenancy age before the survey ever shows. */
export const NPS_MIN_TENANCY_DAYS = 30

const DAY_MS = 86_400_000

/**
 * PURE: the eligibility rule. Prompt when (a) tenancy started 30+ days ago and
 * (b) no response exists in any of the current quarter's three periods.
 */
export function isEligibleForNps(input: {
  /** users.created_at (fallback brokerages.created_at). null = unknown → not eligible. */
  tenancyStartedAt: string | null
  /** Periods ("YYYY-MM") this user has already responded in. */
  respondedPeriods: string[]
  now: Date
}): boolean {
  if (!input.tenancyStartedAt) return false
  const startedMs = new Date(input.tenancyStartedAt).getTime()
  if (!Number.isFinite(startedMs)) return false
  if (input.now.getTime() - startedMs < NPS_MIN_TENANCY_DAYS * DAY_MS) return false
  const quarter = new Set(quarterPeriods(input.now))
  return !input.respondedPeriods.some((p) => quarter.has(p))
}

// ─── SERVER half (service client; callers gate auth) ─────────────────────────

/**
 * Should this tenant user see the NPS prompt right now?
 * Applies the full eligibility rule above. Never throws — an unknown state
 * answers false (a lost prompt is cheaper than a broken dashboard).
 */
export async function shouldPromptNps(userId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const svc = createServiceClient()
    const { data: userRow } = await svc
      .from("users")
      .select("id, brokerage_id, created_at, is_contact")
      .eq("id", userId)
      .is("deleted_at", null)
      .maybeSingle()
    // Only tenant team members are surveyed — no brokerage (platform staff /
    // incomplete accounts) or contact-portal logins never see the prompt.
    if (!userRow?.brokerage_id || userRow.is_contact === true) return false

    let tenancyStartedAt: string | null = userRow.created_at ?? null
    if (!tenancyStartedAt) {
      const { data: brk } = await svc
        .from("brokerages")
        .select("created_at")
        .eq("id", userRow.brokerage_id)
        .maybeSingle()
      tenancyStartedAt = brk?.created_at ?? null
    }

    const { data: responses } = await svc
      .from("platform_nps_responses")
      .select("period")
      .eq("user_id", userId)
      .in("period", quarterPeriods(now))
    const respondedPeriods = ((responses ?? []) as Array<{ period: string }>).map((r) => r.period)

    return isEligibleForNps({ tenancyStartedAt, respondedPeriods, now })
  } catch {
    return false
  }
}

export interface SubmitNpsResult {
  ok: boolean
  /** True when a row for (user, period) already existed — treated as success. */
  alreadySubmitted?: boolean
  error?: string
}

/**
 * Record one response for the CURRENT period. The UNIQUE(user_id, period)
 * constraint is the idempotency guard: a duplicate insert (double-click,
 * second tab) comes back ok with alreadySubmitted — never a user-facing error.
 */
export async function submitNps(params: {
  userId: string
  brokerageId: string
  score: number
  verbatim?: string | null
  now?: Date
}): Promise<SubmitNpsResult> {
  const score = Math.trunc(params.score)
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    return { ok: false, error: "Score must be a whole number from 0 to 10" }
  }
  const verbatim = (params.verbatim ?? "").trim().slice(0, 1000) || null
  const svc = createServiceClient()
  const { error } = await svc.from("platform_nps_responses").insert({
    user_id: params.userId,
    brokerage_id: params.brokerageId,
    score,
    verbatim,
    period: currentPeriod(params.now ?? new Date()),
  })
  if (error) {
    if (error.code === "23505") return { ok: true, alreadySubmitted: true } // UNIQUE(user_id, period)
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

export interface NpsResponseRow {
  id: string
  brokerageId: string | null
  userId: string
  score: number
  verbatim: string | null
  period: string
  createdAt: string
}

export interface NpsPeriodRollup extends NpsRollup {
  period: string
}

export interface NpsRollupByPeriod {
  /** One rollup per requested period (every period present, sample may be 0). */
  platform: NpsPeriodRollup[]
  /** Per-tenant rollup across ALL requested periods combined. */
  byTenant: Array<{ brokerageId: string; rollup: NpsRollup }>
  /** Every raw response in the window, newest first (verbatims, detractors). */
  responses: NpsResponseRow[]
}

/**
 * Platform-wide + per-tenant rollup over the given "YYYY-MM" periods.
 * Throws on a read error — the callers (superadmin page, cron) surface it.
 */
export async function rollupNpsByPeriod(periods: string[]): Promise<NpsRollupByPeriod> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("platform_nps_responses")
    .select("id, brokerage_id, user_id, score, verbatim, period, created_at")
    .in("period", periods)
    .order("created_at", { ascending: false })
    .limit(5000)
  if (error) throw new Error(`Failed to load NPS responses: ${error.message}`)

  const responses: NpsResponseRow[] = ((data ?? []) as any[]).map((r) => ({
    id: r.id as string,
    brokerageId: (r.brokerage_id as string | null) ?? null,
    userId: r.user_id as string,
    score: Number(r.score),
    verbatim: (r.verbatim as string | null) ?? null,
    period: r.period as string,
    createdAt: r.created_at as string,
  }))

  const platform = periods.map((period) => ({
    period,
    ...computeNps(responses.filter((r) => r.period === period)),
  }))

  const byTenantRows = new Map<string, NpsResponseRow[]>()
  for (const r of responses) {
    if (!r.brokerageId) continue
    const list = byTenantRows.get(r.brokerageId) ?? []
    list.push(r)
    byTenantRows.set(r.brokerageId, list)
  }
  const byTenant = [...byTenantRows.entries()]
    .map(([brokerageId, rows]) => ({ brokerageId, rollup: computeNps(rows) }))
    .sort((a, b) => (a.rollup.nps ?? 0) - (b.rollup.nps ?? 0)) // lowest NPS first — the ones to worry about

  return { platform, byTenant, responses }
}
