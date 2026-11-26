// lib/usage/metric-labels.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE tenant-facing vocabulary for plan_limits.metric — pure (no I/O, no
// client), so the usage page, the billing page, the upgrade modal and the
// feature-certification guard all read the SAME table (CLAUDE.md §6).
//
// WHY THIS FILE EXISTS (wave 143, lane 143J). `app/actions/usage-overview.ts` is a
// "use server" module — every export of one is a public endpoint and must be an
// async function — so the label table that lived in it could not be imported by
// the three other surfaces that talk about the same limits. Each of them grew its
// own answer instead:
//   · app/settings/billing/page.tsx read `features.ai_calls_monthly || 1000`,
//     `features.storage_gb || 5`, `features.video_minutes_monthly || 60` — keys the
//     live subscription_tiers.features object does not carry (it holds eight boolean
//     flags), so EVERY tenant was shown an invented 1,000-call / 5 GB / 60-minute
//     allowance beside real usage, whatever their plan, and "Limit reached! Upgrade
//     to continue." was drawn against numbers nobody set;
//   · app/settings/billing/upgrade-modal.tsx listed the same absent keys, so the
//     plan-comparison cards promised no allowance at all.
// The real allowances are plan_limits rows (measured live 2026-10-23: 17 metrics ×
// 4 tiers). Moving the labels here lets all four surfaces render those rows.
//
// THE MEASUREMENT RULE (the reason `measuredMetric` exists). A plan limit is only
// worth showing as "0 of N" when something WRITES the "0". Of the 17 live metrics:
//   · FLOW metrics are counted by usage_counters writers — lib/usage.ts
//     incrementUsage (ai_tokens_monthly, llm_calls) and lib/usage/log-media-usage.ts
//     logMediaUsage (the media metrics incl. video_minutes). A flow metric no writer
//     increments (emails_sent, sms_sent, storage_gb, ai_voice_minutes and
//     live_assistant_minutes at the time of writing) used to render a green "0 / 500"
//     for the whole month while real volume went out. (AI calling minutes ARE metered
//     — on the phone-plan rail, usage_logs 'voice_call' → loadTenantPhoneMeter — under
//     a different allowance spelling, features.limits.included_voice_minutes; the
//     plan_limits spelling has no writer. One vocabulary per function, §6: the owner
//     decides which spelling is the allowance of record — recorded in
//     docs/architecture/FEATURE-CERTIFICATION.md.)
//   · STOCK metrics (contacts_count, active_transactions, active_users) are not
//     flows: nothing should "increment" them. They are counted live from the
//     tenant's own rows when the page is read (app/actions/usage-overview.ts).
// scripts/feature-certification-guard.ts DERIVES the writer set from the code and
// holds COUNTER_BACKED_METRICS equal to it, so adding a writer without updating
// this set (or the reverse) fails — the set cannot lie in either direction.

export const METRIC_LABELS: Readonly<Record<string, string>> = Object.freeze({
  // llm_calls is NOT "every AI request": it is the counter incrementUsage bumps in exactly two places — the agent copilot's
  // AI summary (app/actions/copilot.ts) and the seller-offer assistant (app/actions/seller-offers.ts). All other AI use is
  // metered in tokens (ai_tokens_monthly, via lib/ai/cost-tracking.ts), so a label that said "AI requests" under-reported
  // the tenant's AI use by every other path.
  llm_calls: "Copilot & offer-assistant requests",
  ai_tokens_monthly: "AI usage (tokens)",
  video_minutes: "Video generation",
  active_users: "Seats in use",
  contacts_count: "Contacts",
  active_transactions: "Active transactions",
  sms_sent: "SMS sent",
  emails_sent: "Emails sent",
  storage_gb: "Storage (GB)",
  live_avatar_minutes: "Live AI minutes",
  live_avatar_sessions: "Live AI sessions",
  live_assistant_minutes: "Live assistant minutes",
  live_assistant_sessions: "Live assistant sessions",
  tts_characters: "Voice synthesis (chars)",
  voice_clones_created: "Twin voices created",
  avatars_created: "Twin avatars created",
  ai_voice_minutes: "AI calling (min)",
})

/** Flow metrics some code path INCREMENTS in usage_counters (derived + held by the certification guard). */
export const COUNTER_BACKED_METRICS: ReadonlySet<string> = new Set([
  "ai_tokens_monthly",
  "llm_calls",
  "video_minutes",
  "live_avatar_minutes",
  "live_avatar_sessions",
  "live_assistant_sessions",
  "tts_characters",
  "voice_clones_created",
  "avatars_created",
])

/** Stock metrics counted LIVE from the tenant's own rows at read time (never incremented). */
export const LIVE_STOCK_METRICS: ReadonlySet<string> = new Set(["contacts_count", "active_transactions", "active_users"])

/** PURE: is anything measuring this metric? false → the UI says "Not measured yet" instead of drawing 0%. */
function measuredMetric(metric: string): boolean {
  return COUNTER_BACKED_METRICS.has(metric) || LIVE_STOCK_METRICS.has(metric)
}

/**
 * The allowances a PLAN CARD may name — measured metrics only, in the order a buyer
 * reads them. An allowance nothing measures is not a promise the product can keep, so
 * it is not advertised (storage, email and SMS volume return here the day a writer
 * lands and the guard's derived set moves).
 */
export const PLAN_CARD_METRICS: readonly string[] = Object.freeze([
  "ai_tokens_monthly", "video_minutes", "live_avatar_minutes", "contacts_count", "active_transactions",
])

export interface PlanAllowance {
  metric: string
  label: string
  /** null = unlimited (plan_limits stores -1). */
  limit: number | null
}

/** PURE: plan_limits rows for ONE tier → the measured allowances a plan card shows (unknown metrics and unmeasured ones are dropped). */
export function planCardAllowances(rows: ReadonlyArray<{ metric: string; limit_value: number | string | null }>): PlanAllowance[] {
  const byMetric = new Map(rows.map((r) => [r.metric, r.limit_value]))
  const out: PlanAllowance[] = []
  for (const metric of PLAN_CARD_METRICS) {
    if (!measuredMetric(metric) || !byMetric.has(metric)) continue
    const raw = Number(byMetric.get(metric))
    if (!Number.isFinite(raw)) continue
    out.push({ metric, label: METRIC_LABELS[metric] ?? metric, limit: raw < 0 ? null : raw })
  }
  return out
}

/** PURE: "AI usage (tokens): 10,000,000 / mo" · "Video generation: Unlimited". */
export function allowanceLine(a: PlanAllowance): string {
  const label = METRIC_LABELS[a.metric] ?? a.metric
  if (a.limit === null) return `${label}: Unlimited`
  const per = a.metric === "contacts_count" || a.metric === "active_transactions" ? "" : " / mo"
  return `${label}: ${a.limit.toLocaleString("en-US")}${per}`
}
