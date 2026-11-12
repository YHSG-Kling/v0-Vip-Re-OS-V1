// lib/platform/saas-operations.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM SELF-OPERATION (wave 108B) — VIPAgents operates ITSELF on its own architecture.
//
// SURVIVORS (extended, none replaced):
//   · lib/platform/platform-sentinel.ts + app/api/cron/platform-sentinel — the platform manager
//     (PLATFORM_MANAGERS.platform_sentinel) and its daily fleet cron (cron-dispatch, "12 12 * * *").
//     It already watches engagement, connections, dunning, SLA, trials, NPS and A2P and drafts
//     staff outreach. What it lacked: per-tenant USAGE (7-day vs trailing baseline), AI spend vs
//     plan, onboarding, feature adoption, seat changes, a DIAGNOSIS of an anomaly, and a durable
//     MISSION for the support work. This module adds exactly those, as ONE step on that cron.
//   · lib/kernel/missions.ts — the one mission service. A support mission is a PLATFORM-SCOPE
//     mission (subject_type PLATFORM_SUPPORT_SUBJECT_TYPE, owner platform_sentinel, brokerage_id =
//     the subject tenant, authority pinned at Draft) — no new table (m728 only narrows RLS).
//   · Evidence readers reused, never re-derived: classifySubscription's trial rule (subscriptions.
//     trial_end ?? brokerages.trial_ends_at), evaluateTicketSla (lib/support/support-sla),
//     getAIOverageStatus (lib/billing/ai-overage — THE included-vs-used derivation), classifyEngagement
//     tiers + connection expiry from the sentinel cron's own facts (passed in, not re-read).
//
// RULES:
//   · Every signal names its EVIDENCE READER (SIGNAL_READERS). A refused reader is a BLIND SPOT
//     published beside the numbers; its signals read "unknown", never "ok".
//   · An anomaly is DIAGNOSED deterministically, in a fixed order (billing failure → provider issue →
//     onboarding stall → seat change → unexplained). A blind cause is "undetermined", not ruled out.
//   · A diagnosed anomaly opens a SUPPORT MISSION in PROPOSED — platform staff approve it. Nothing
//     here sends to, messages or notifies the tenant (the mission's ceiling is Draft).
//   · Idempotent: one open support mission per (tenant, usage anomaly) — the subject id is the stable
//     derivation in missions.ts; a re-run attaches the week's diagnosis once (attachEvidence dedupes).
//   · Platform-only: runSaasOperations is reached from the cron (verifyCronAuth) and the gated staff
//     board (requirePlatformCapability("sentinel")); tenants never see another tenant — nor this.

import { classifyEngagement, daysSinceActivity, type EngagementTier } from "@/lib/platform/engagement-risk"
import { evaluateTicketSla } from "@/lib/support/support-sla"
import type { PlatformManagerKey } from "@/lib/kernel/manager-registry"
import {
  PLATFORM_SUPPORT_SUBJECT_TYPE, activeMissionsFor, attachEvidence, createMission, recordMissionProgress,
  stableMissionSubjectId, type MissionActor, type MissionDeps,
} from "@/lib/kernel/missions"

type Svc = { from: (table: string) => any }

/** The platform manager that owns platform support missions (PLATFORM_MANAGERS). */
export const SAAS_OPS_OWNER: PlatformManagerKey = "platform_sentinel"
export const SAAS_OPS_ACTOR: MissionActor = { type: "manager", id: SAAS_OPS_OWNER, scope: "platform" }

const DAY_MS = 86_400_000
export const USAGE_WINDOW_DAYS = 7
export const USAGE_BASELINE_DAYS = 28
/** A 7-day volume at or below −70% of the trailing weekly baseline is an anomaly. */
export const USAGE_DROP_THRESHOLD = 0.7
/** Below this weekly baseline there is no baseline to fall from (a quiet tenant is not an anomaly). */
export const USAGE_MIN_BASELINE_PER_WEEK = 20
/** Recovery: the window is back above half its baseline. */
export const USAGE_RECOVERY_RATIO = 0.5
export const USAGE_ROW_CAP = 50_000
export const ONBOARDING_STALL_DAYS = 14
export const PROVIDER_FAILURE_RATE = 0.25
export const PROVIDER_MIN_CALLS = 10
export const SEAT_CHANGE_DAYS = 14
export const TENANT_CAP = 500

// ── signals + their evidence readers ─────────────────────────────────────────

export type SaasSignalKey =
  | "onboarding" | "trial_conversion" | "usage" | "churn_risk" | "billing"
  | "ai_spend" | "provider_performance" | "support" | "feature_adoption" | "seats"

export type ReaderKey =
  | "tenants" | "subscriptions" | "usage_events" | "dunning" | "support_tickets" | "seats" | "ai_spend" | "sentinel_facts"

/** Every reader, named by the table / survivor it reads. */
export const READERS: Record<ReaderKey, string> = {
  tenants: "brokerages (id, name, created_at, onboarding_status, plan_tier, trial_ends_at)",
  subscriptions: "subscriptions (status, trial_end) — the subscription-oversight trial reconciliation",
  usage_events: "ai_tool_usage (brokerage_id, created_at, success, feature) — 35-day window",
  dunning: "platform_dunning_events (step, last 14 days) + subscriptions.status past_due",
  support_tickets: "support_tickets lane tenant_to_platform, open|in_progress — evaluateTicketSla",
  seats: "agents (is_active, updated_at) — seats active / deactivated in the last 14 days",
  ai_spend: "getAIOverageStatus (lib/billing/ai-overage) — usage_counters vs plan_limits + approved overrides",
  sentinel_facts: "platform-sentinel cron loadSentinelFacts — sign-in engagement + connection expiry",
}

/** Which readers each signal's evidence comes from — the proof asserts every signal names ≥1. */
export const SIGNAL_READERS: Record<SaasSignalKey, ReaderKey[]> = {
  onboarding: ["tenants"],
  trial_conversion: ["subscriptions", "tenants"],
  usage: ["usage_events"],
  churn_risk: ["usage_events", "dunning", "support_tickets", "subscriptions", "sentinel_facts"],
  billing: ["dunning"],
  ai_spend: ["ai_spend"],
  provider_performance: ["usage_events", "sentinel_facts"],
  support: ["support_tickets"],
  feature_adoption: ["usage_events"],
  seats: ["seats"],
}

export interface ReaderOutcome { reader: ReaderKey; source: string; ok: boolean; refused: string | null; rows: number; truncated: boolean }

export type SignalStatus = "ok" | "watch" | "alert" | "unknown"
export interface SignalValue { status: SignalStatus; value: string; readers: ReaderKey[] }

// ── facts (plain data) ───────────────────────────────────────────────────────

export interface TenantFacts {
  brokerageId: string
  name: string
  createdAt: string | null
  onboardingStatus: string | null
  planTier: string | null
  subscriptionStatus: string | null
  trialEnd: string | null
  /** Usage event timestamps inside the 35-day window. */
  usageAt: string[]
  aiCalls7d: number
  aiFailures7d: number
  features30d: string[]
  dunningMaxStep: number | null
  openTickets: number
  slaBreaches: number
  aiSpend: { usedTokens: number; includedTokens: number; overageTokens: number } | null
  activeSeats: number
  seatsRemoved: number
  engagementTier: EngagementTier | null
  connectionsExpired: number
}

export interface SentinelSupplied {
  engagement?: Array<{ brokerageId: string; lastSignInAt: string | null; tenantCreatedAt: string | null }>
  connections?: Array<{ brokerageId: string; status: "expiring_soon" | "expired" }>
}

// ── PURE: usage anomaly ──────────────────────────────────────────────────────

export interface UsageAnomaly {
  recent: number
  baselineWeekly: number
  /** (recent − baseline) / baseline; null when there is no baseline. */
  change: number | null
  anomalous: boolean
  recovered: boolean
  reason: string
}

/** PURE: 7-day volume vs the trailing 28-day weekly baseline; −70% (or worse) flags.
 *  @proofSeam the proof asserts the threshold boundary directly */
export function detectUsageAnomaly(usageAt: string[], now: Date): UsageAnomaly {
  const nowMs = now.getTime()
  const winStart = nowMs - USAGE_WINDOW_DAYS * DAY_MS
  const baseStart = winStart - USAGE_BASELINE_DAYS * DAY_MS
  let recent = 0, base = 0
  for (const iso of usageAt) {
    const t = new Date(iso).getTime()
    if (!Number.isFinite(t) || t > nowMs) continue
    if (t > winStart) recent++
    else if (t > baseStart) base++
  }
  const baselineWeekly = base / (USAGE_BASELINE_DAYS / USAGE_WINDOW_DAYS)
  if (baselineWeekly < USAGE_MIN_BASELINE_PER_WEEK) {
    return { recent, baselineWeekly, change: null, anomalous: false, recovered: true, reason: `no baseline to fall from (${baselineWeekly.toFixed(1)}/wk < ${USAGE_MIN_BASELINE_PER_WEEK})` }
  }
  const change = (recent - baselineWeekly) / baselineWeekly
  const anomalous = change <= -USAGE_DROP_THRESHOLD
  return {
    recent, baselineWeekly, change, anomalous,
    recovered: recent >= baselineWeekly * USAGE_RECOVERY_RATIO,
    reason: `${recent} events in 7d vs ${baselineWeekly.toFixed(1)}/wk baseline (${Math.round(change * 100)}%)${anomalous ? ` — at or below −${Math.round(USAGE_DROP_THRESHOLD * 100)}%` : ""}`,
  }
}

// ── PURE: per-tenant signals ─────────────────────────────────────────────────

export type TenantSignals = Record<SaasSignalKey, SignalValue>

function blindOf(keys: ReaderKey[], blind: ReadonlySet<ReaderKey>): boolean { return keys.some((k) => blind.has(k)) }

/** PURE: every signal for one tenant; a signal whose reader is blind reads "unknown".
 *  @proofSeam the proof drives every signal and the blind path directly */
export function computeTenantSignals(f: TenantFacts, blind: ReadonlySet<ReaderKey>, now: Date): TenantSignals {
  const sig = (key: SaasSignalKey, status: SignalStatus, value: string, readers = SIGNAL_READERS[key]): SignalValue =>
    blindOf(readers, blind) ? { status: "unknown", value: `unknown — reader refused: ${readers.filter((r) => blind.has(r)).join(", ")}`, readers } : { status, value, readers }
  const ageDays = f.createdAt ? daysSinceActivity(f.createdAt, now) : Infinity

  const onboardingDone = f.onboardingStatus === "completed"
  const onboarding = sig("onboarding", onboardingDone ? "ok" : ageDays > ONBOARDING_STALL_DAYS ? "alert" : "watch",
    `onboarding_status ${f.onboardingStatus ?? "none"}; tenant ${Number.isFinite(ageDays) ? Math.floor(ageDays) : "?"}d old`)

  const trialEndMs = f.trialEnd ? new Date(f.trialEnd).getTime() : NaN
  const trial = f.subscriptionStatus === "trialing"
    ? sig("trial_conversion", Number.isFinite(trialEndMs) && trialEndMs - now.getTime() <= 7 * DAY_MS ? "watch" : "ok", `trialing, ends ${f.trialEnd ?? "unknown"}`)
    : f.subscriptionStatus === "active"
      ? sig("trial_conversion", "ok", f.trialEnd ? "converted (trial → paid)" : "paid (no trial)")
      : Number.isFinite(trialEndMs) && trialEndMs < now.getTime()
        ? sig("trial_conversion", "alert", `trial ended ${f.trialEnd} without conversion (status ${f.subscriptionStatus ?? "none"})`)
        : sig("trial_conversion", f.subscriptionStatus ? "watch" : "ok", `status ${f.subscriptionStatus ?? "none"}`)

  const ua = detectUsageAnomaly(f.usageAt, now)
  const usage = sig("usage", ua.anomalous ? "alert" : ua.change !== null && ua.change <= -0.4 ? "watch" : "ok", ua.reason)

  const billingFailed = (f.dunningMaxStep ?? 0) >= 1 || f.subscriptionStatus === "past_due"
  const billing = sig("billing", billingFailed ? ((f.dunningMaxStep ?? 0) >= 3 ? "alert" : "watch") : "ok",
    billingFailed ? `billing failure: dunning step ${f.dunningMaxStep ?? 0}${f.subscriptionStatus === "past_due" ? ", subscription past_due" : ""}` : "no dunning in 14d")

  const aiSpend = !f.aiSpend
    ? sig("ai_spend", "unknown", "no AI spend status")
    : f.aiSpend.includedTokens < 0
      ? sig("ai_spend", "ok", `${f.aiSpend.usedTokens} tokens used; plan uncapped`)
      : sig("ai_spend", f.aiSpend.overageTokens > 0 ? "alert" : f.aiSpend.usedTokens >= f.aiSpend.includedTokens * 0.8 ? "watch" : "ok",
        `${f.aiSpend.usedTokens} of ${f.aiSpend.includedTokens} included tokens${f.aiSpend.overageTokens > 0 ? ` — ${f.aiSpend.overageTokens} over plan` : ""}`)

  const failRate = f.aiCalls7d > 0 ? f.aiFailures7d / f.aiCalls7d : 0
  const providerBad = (f.aiCalls7d >= PROVIDER_MIN_CALLS && failRate >= PROVIDER_FAILURE_RATE) || f.connectionsExpired > 0
  const provider = sig("provider_performance", providerBad ? "alert" : "ok",
    `${f.aiFailures7d}/${f.aiCalls7d} AI calls failed in 7d (${Math.round(failRate * 100)}%); ${f.connectionsExpired} expired connection(s)`)

  const support = sig("support", f.slaBreaches > 0 ? "alert" : f.openTickets >= 3 ? "watch" : "ok", `${f.openTickets} open platform ticket(s), ${f.slaBreaches} past SLA`)
  const adoption = sig("feature_adoption", f.features30d.length <= 1 && ageDays > 30 ? "watch" : "ok", `${f.features30d.length} distinct AI feature(s) used in 30d`)
  const seats = sig("seats", f.seatsRemoved > 0 ? "watch" : "ok", `${f.activeSeats} active seat(s); ${f.seatsRemoved} deactivated in ${SEAT_CHANGE_DAYS}d`)

  // CHURN RISK — a composite of the factors above (each already evidenced) + sign-in engagement.
  const factors: string[] = []
  if (usage.status === "alert") factors.push("usage fell ≥70%")
  if (billing.status !== "ok" && billing.status !== "unknown") factors.push("billing failure")
  if (trial.status === "alert") factors.push("trial lapsed unconverted")
  if (support.status === "alert") factors.push("support past SLA")
  if (f.engagementTier === "at_risk") factors.push("no team sign-in (engagement at risk)")
  const engagementBlind = blind.has("sentinel_facts")
  const churn: SignalValue = {
    status: factors.length >= 2 ? "alert" : factors.length === 1 ? "watch" : engagementBlind ? "unknown" : "ok",
    value: factors.length ? factors.join("; ") : engagementBlind ? "no risk factor found, but sign-in engagement was not supplied (blind)" : "no risk factor",
    readers: SIGNAL_READERS.churn_risk,
  }

  return { onboarding, trial_conversion: trial, usage, churn_risk: churn, billing, ai_spend: aiSpend, provider_performance: provider, support, feature_adoption: adoption, seats }
}

// ── PURE: deterministic diagnosis ────────────────────────────────────────────

export type DiagnosisCause = "billing_failure" | "provider_issue" | "onboarding_stall" | "seat_change" | "unexplained"
export const DIAGNOSIS_ORDER: ReadonlyArray<{ cause: Exclude<DiagnosisCause, "unexplained">; signal: SaasSignalKey; positive: (s: SignalValue) => boolean }> = [
  { cause: "billing_failure", signal: "billing", positive: (s) => s.status === "watch" || s.status === "alert" },
  { cause: "provider_issue", signal: "provider_performance", positive: (s) => s.status === "alert" },
  { cause: "onboarding_stall", signal: "onboarding", positive: (s) => s.status === "alert" },
  { cause: "seat_change", signal: "seats", positive: (s) => s.status === "watch" || s.status === "alert" },
]

export interface Diagnosis {
  cause: DiagnosisCause
  /** "full" = every higher-priority cause was READ and ruled out; "partial" = one was blind. */
  confidence: "full" | "partial"
  evidence: string[]
  ruledOut: DiagnosisCause[]
  undetermined: DiagnosisCause[]
}

/** PURE: the fixed-order diagnosis of a usage anomaly. Never an LLM; a blind check is undetermined.
 *  @proofSeam the proof asserts each branch directly */
export function diagnoseAnomaly(s: TenantSignals): Diagnosis {
  const ruledOut: DiagnosisCause[] = [], undetermined: DiagnosisCause[] = []
  for (const step of DIAGNOSIS_ORDER) {
    const v = s[step.signal]
    if (v.status === "unknown") { undetermined.push(step.cause); continue }
    if (step.positive(v)) {
      return { cause: step.cause, confidence: undetermined.length ? "partial" : "full", evidence: [`${step.signal}: ${v.value} [${v.readers.map((r) => READERS[r]).join(" + ")}]`, `usage: ${s.usage.value}`], ruledOut, undetermined }
    }
    ruledOut.push(step.cause)
  }
  return { cause: "unexplained", confidence: undetermined.length ? "partial" : "full", evidence: [`usage: ${s.usage.value}`, "billing, provider, onboarding and seats all read and none explains the drop — a human should look"], ruledOut, undetermined }
}

export const CAUSE_LABEL: Record<DiagnosisCause, string> = {
  billing_failure: "billing failure", provider_issue: "provider issue", onboarding_stall: "onboarding stall",
  seat_change: "seat change", unexplained: "unexplained (needs a human)",
}

/** PURE: the stable subject of a tenant's usage-anomaly support mission (one open per tenant).
 *  @proofSeam the proof asserts idempotency keys on this exact subject (test:saas-operations E3) */
export function supportMissionSubjectId(brokerageId: string): string {
  return stableMissionSubjectId(`platform_support|${brokerageId}|usage_anomaly`)
}

function weekBucket(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

// ── readers (I/O) ────────────────────────────────────────────────────────────

export interface SaasOpsDeps {
  aiSpend?: (brokerageId: string, now: Date, svc: Svc) => Promise<{ ok: true; usedTokens: number; includedTokens: number; overageTokens: number } | { ok: false; error: string }>
  missions?: MissionDeps
}

const defaultAiSpend: NonNullable<SaasOpsDeps["aiSpend"]> = async (brokerageId, now, svc) => {
  const { getAIOverageStatus } = await import("@/lib/billing/ai-overage")
  const r = await getAIOverageStatus(brokerageId, now, undefined, svc)
  return r.ok ? { ok: true, usedTokens: r.usedTokens, includedTokens: r.includedTokens, overageTokens: r.overageTokens } : { ok: false, error: r.error }
}

export interface TenantReport {
  brokerageId: string
  name: string
  signals: TenantSignals
  usage: UsageAnomaly
  diagnosis: Diagnosis | null
  mission: { action: "created" | "existing" | "recovered_progress" | "refused" | "not_written"; missionId: string | null; detail: string } | null
}

export interface SaasOperationsReport {
  at: string
  tenants: TenantReport[]
  readers: ReaderOutcome[]
  /** Readers that refused or truncated, with the signals they blind — published beside the numbers. */
  blindSpots: string[]
  counts: { tenants: number; anomalies: number; missionsCreated: number; missionsExisting: number; refused: number }
}

async function read<T>(outcomes: ReaderOutcome[], reader: ReaderKey, q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>, cap?: number): Promise<T[] | null> {
  const { data, error } = await q
  const rows = (data ?? []) as T[]
  outcomes.push({ reader, source: READERS[reader], ok: !error, refused: error ? error.message : null, rows: error ? 0 : rows.length, truncated: !error && cap !== undefined && rows.length >= cap })
  return error ? null : rows
}

/**
 * THE PLATFORM HEALTH READER + SUPPORT-MISSION STEP. `write: false` (the staff board) only reads;
 * `write: true` (the platform-sentinel cron) opens / advances support missions. The service client
 * is the caller's (cron or gated page) — this module never decides who may call it.
 */
export async function runSaasOperations(
  svc: Svc,
  now: Date = new Date(),
  opts: { write: boolean; sentinel?: SentinelSupplied; deps?: SaasOpsDeps } = { write: false },
): Promise<SaasOperationsReport> {
  const outcomes: ReaderOutcome[] = []
  const report: SaasOperationsReport = { at: now.toISOString(), tenants: [], readers: outcomes, blindSpots: [], counts: { tenants: 0, anomalies: 0, missionsCreated: 0, missionsExisting: 0, refused: 0 } }
  const since35 = new Date(now.getTime() - (USAGE_WINDOW_DAYS + USAGE_BASELINE_DAYS) * DAY_MS).toISOString()
  const since14 = new Date(now.getTime() - 14 * DAY_MS).toISOString()
  const since7Ms = now.getTime() - USAGE_WINDOW_DAYS * DAY_MS
  const since30Ms = now.getTime() - 30 * DAY_MS

  const tenants = await read<any>(outcomes, "tenants", svc.from("brokerages").select("id, name, created_at, onboarding_status, plan_tier, trial_ends_at").is("deleted_at", null).order("created_at", { ascending: true }).limit(TENANT_CAP), TENANT_CAP)
  if (!tenants) { report.blindSpots.push(`tenants: ${outcomes[0].refused} — NO tenant could be evaluated (fail closed: nothing reads as healthy)`); return report }

  const [subs, usage, dunning, tickets, agents] = await Promise.all([
    read<any>(outcomes, "subscriptions", svc.from("subscriptions").select("brokerage_id, status, trial_end").limit(5000)),
    read<any>(outcomes, "usage_events", svc.from("ai_tool_usage").select("brokerage_id, created_at, success, feature").gte("created_at", since35).order("created_at", { ascending: false }).limit(USAGE_ROW_CAP), USAGE_ROW_CAP),
    read<any>(outcomes, "dunning", svc.from("platform_dunning_events").select("brokerage_id, step, created_at").gte("created_at", since14).limit(5000)),
    read<any>(outcomes, "support_tickets", svc.from("support_tickets").select("id, brokerage_id, created_at, priority, status, first_response_at, resolved_at").eq("lane", "tenant_to_platform").in("status", ["open", "in_progress"]).limit(2000)),
    read<any>(outcomes, "seats", svc.from("agents").select("brokerage_id, is_active, updated_at").limit(50_000)),
  ])
  const sentinelSupplied = !!(opts.sentinel?.engagement || opts.sentinel?.connections)
  outcomes.push({ reader: "sentinel_facts", source: READERS.sentinel_facts, ok: sentinelSupplied, refused: sentinelSupplied ? null : "not supplied (only the platform-sentinel cron reads auth sign-ins)", rows: (opts.sentinel?.engagement?.length ?? 0) + (opts.sentinel?.connections?.length ?? 0), truncated: false })

  const blind = new Set<ReaderKey>(outcomes.filter((o) => !o.ok).map((o) => o.reader))
  for (const o of outcomes) {
    const blinds = (Object.keys(SIGNAL_READERS) as SaasSignalKey[]).filter((k) => SIGNAL_READERS[k].includes(o.reader))
    if (!o.ok) report.blindSpots.push(`${o.reader} (${o.source}) refused: ${o.refused} — blinds ${blinds.join(", ")}`)
    else if (o.truncated) report.blindSpots.push(`${o.reader} hit its ${o.rows}-row cap — ${blinds.join(", ")} may under-count the busiest tenants`)
  }
  if (tenants.length >= TENANT_CAP) report.blindSpots.push(`tenants capped at ${TENANT_CAP} per sweep (oldest first)`)

  const by = <T extends { brokerage_id?: string | null }>(rows: T[] | null) => {
    const m = new Map<string, T[]>()
    for (const r of rows ?? []) { if (!r.brokerage_id) continue; const l = m.get(r.brokerage_id) ?? []; l.push(r); m.set(r.brokerage_id, l) }
    return m
  }
  const subsBy = by(subs), usageBy = by(usage), dunBy = by(dunning), ticketsBy = by(tickets), agentsBy = by(agents)
  const engBy = new Map((opts.sentinel?.engagement ?? []).map((e) => [e.brokerageId, e]))
  const connBy = new Map<string, number>()
  for (const c of opts.sentinel?.connections ?? []) if (c.status === "expired") connBy.set(c.brokerageId, (connBy.get(c.brokerageId) ?? 0) + 1)
  const aiSpend = opts.deps?.aiSpend ?? defaultAiSpend
  let aiSpendRefused = 0
  const actor = SAAS_OPS_ACTOR

  for (const t of tenants) {
    const id = t.id as string
    const sub = (subsBy.get(id) ?? [])[0] ?? null
    const ev = usageBy.get(id) ?? []
    const recent = ev.filter((e: any) => new Date(e.created_at).getTime() > since7Ms)
    const agentRows = agentsBy.get(id) ?? []
    const tickets7 = ticketsBy.get(id) ?? []
    const eng = engBy.get(id)
    const spend = await aiSpend(id, now, svc)
    if (!spend.ok) aiSpendRefused++
    const facts: TenantFacts = {
      brokerageId: id, name: (t.name as string | null) ?? "(unnamed)", createdAt: t.created_at ?? null,
      onboardingStatus: t.onboarding_status ?? null, planTier: t.plan_tier ?? null,
      subscriptionStatus: sub?.status ?? null, trialEnd: sub?.trial_end ?? t.trial_ends_at ?? null,
      usageAt: ev.map((e: any) => e.created_at as string),
      aiCalls7d: recent.length, aiFailures7d: recent.filter((e: any) => e.success === false).length,
      features30d: [...new Set(ev.filter((e: any) => new Date(e.created_at).getTime() > since30Ms && e.feature).map((e: any) => String(e.feature)))] as string[],
      dunningMaxStep: (dunBy.get(id) ?? []).reduce((mx: number | null, e: any) => Math.max(mx ?? 0, Number(e.step) || 0), null),
      openTickets: tickets7.length, slaBreaches: tickets7.filter((x: any) => evaluateTicketSla(x, now).breaches.length > 0).length,
      aiSpend: spend.ok ? { usedTokens: spend.usedTokens, includedTokens: spend.includedTokens, overageTokens: spend.overageTokens } : null,
      activeSeats: agentRows.filter((a: any) => a.is_active !== false).length,
      seatsRemoved: agentRows.filter((a: any) => a.is_active === false && a.updated_at && new Date(a.updated_at).getTime() > now.getTime() - SEAT_CHANGE_DAYS * DAY_MS).length,
      engagementTier: eng ? classifyEngagement({ lastActivityAt: eng.lastSignInAt, createsLast30d: 0, createsPrior30d: 0 }, now) : null,
      connectionsExpired: connBy.get(id) ?? 0,
    }
    const tenantBlind = new Set(blind)
    if (!spend.ok) tenantBlind.add("ai_spend")
    const signals = computeTenantSignals(facts, tenantBlind, now)
    const ua = detectUsageAnomaly(facts.usageAt, now)
    const row: TenantReport = { brokerageId: id, name: facts.name, signals, usage: ua, diagnosis: null, mission: null }
    if (ua.anomalous && !blind.has("usage_events")) {
      report.counts.anomalies++
      row.diagnosis = diagnoseAnomaly(signals)
      row.mission = opts.write ? await openOrAdvanceSupportMission(svc, facts, ua, row.diagnosis, now, actor, opts.deps?.missions) : { action: "not_written", missionId: null, detail: "read-only board — the platform-sentinel cron opens missions" }
    } else if (opts.write && !ua.anomalous && ua.recovered) {
      row.mission = await recordRecovery(svc, id, ua, actor, opts.deps?.missions)
    }
    if (row.mission?.action === "created") report.counts.missionsCreated++
    if (row.mission?.action === "existing") report.counts.missionsExisting++
    if (row.mission?.action === "refused") report.counts.refused++
    report.tenants.push(row)
  }
  if (aiSpendRefused > 0) report.blindSpots.push(`ai_spend refused for ${aiSpendRefused} of ${tenants.length} tenant(s) — their AI-spend signal reads unknown`)
  report.counts.tenants = tenants.length
  return report
}

/** Open the tenant's usage-anomaly support mission (PROPOSED, staff approve) — or, when one is open,
 *  attach this week's diagnosis to it once. Never contacts the tenant. */
async function openOrAdvanceSupportMission(svc: Svc, f: TenantFacts, ua: UsageAnomaly, dx: Diagnosis, now: Date, actor: MissionActor, deps?: MissionDeps): Promise<NonNullable<TenantReport["mission"]>> {
  const subjectId = supportMissionSubjectId(f.brokerageId)
  const evidence = {
    kind: "platform_diagnosis", ref: `${dx.cause}:${weekBucket(now)}`,
    cause: dx.cause, confidence: dx.confidence, evidence: dx.evidence, ruled_out: dx.ruledOut, undetermined: dx.undetermined,
    usage: { recent_7d: ua.recent, baseline_weekly: Number(ua.baselineWeekly.toFixed(2)), change: ua.change },
    readers: Object.fromEntries(Object.entries(SIGNAL_READERS).map(([k, r]) => [k, r.map((x) => READERS[x])])),
  }
  const open = await activeMissionsFor(f.brokerageId, { subject: { type: PLATFORM_SUPPORT_SUBJECT_TYPE, id: subjectId }, scope: "platform", limit: 5 }, svc)
  if (open.readRefused) return { action: "refused", missionId: null, detail: `open-mission read refused: ${open.readRefused} (no mission written — idempotency could not be proven)` }
  if (open.active.length > 0) {
    const m = open.active[0]
    const r = await attachEvidence({ brokerageId: f.brokerageId, missionId: m.id, evidence, actor }, svc, deps)
    return { action: "existing", missionId: m.id, detail: r.ok ? (r.duplicate ? "open mission already carries this week's diagnosis" : `diagnosis ${dx.cause} attached`) : `evidence refused: ${r.reason}` }
  }
  const pct = ua.change === null ? "?" : `${Math.round(-ua.change * 100)}%`
  const created = await createMission({
    brokerageId: f.brokerageId,
    objective: `Platform support: ${f.name} usage fell ${pct} (${ua.recent} in 7d vs ${ua.baselineWeekly.toFixed(1)}/wk) — diagnosed ${CAUSE_LABEL[dx.cause]}`,
    missionType: "custom", ownerManager: SAAS_OPS_OWNER,
    subject: { type: PLATFORM_SUPPORT_SUBJECT_TYPE, id: subjectId },
    priority: dx.cause === "billing_failure" || dx.cause === "unexplained" ? "high" : "normal",
    successCriteria: [{ metric: "usage_recovered", op: ">=", target: 1 }],
    initialState: "PROPOSED", actor,
  }, svc, deps)
  if (!created.ok) return { action: "refused", missionId: null, detail: created.reason }
  const ev = await attachEvidence({ brokerageId: f.brokerageId, missionId: created.mission.id, evidence, actor }, svc, deps)
  return { action: "created", missionId: created.mission.id, detail: ev.ok ? `PROPOSED — awaiting platform staff (${dx.cause}, ${dx.confidence})` : `created; diagnosis evidence refused: ${ev.reason}` }
}

/** A tenant whose usage recovered: record it on the open support mission (an ACTIVE one completes
 *  deterministically through recordMissionProgress; a PROPOSED one stays for staff to dismiss). */
async function recordRecovery(svc: Svc, brokerageId: string, ua: UsageAnomaly, actor: MissionActor, deps?: MissionDeps): Promise<TenantReport["mission"]> {
  const open = await activeMissionsFor(brokerageId, { subject: { type: PLATFORM_SUPPORT_SUBJECT_TYPE, id: supportMissionSubjectId(brokerageId) }, scope: "platform", limit: 5 }, svc)
  if (open.readRefused || open.active.length === 0) return null
  const m = open.active[0]
  if ((m.progress ?? {}).usage_recovered === 1) return { action: "existing", missionId: m.id, detail: "recovery already recorded" }
  const r = await recordMissionProgress({ brokerageId, missionId: m.id, progress: { usage_recovered: 1 }, actor }, svc, deps)
  return { action: "recovered_progress", missionId: m.id, detail: r.ok ? `usage recovered (${ua.reason})${r.completed ? " — mission completed" : ""}` : `progress refused: ${r.reason}` }
}

/** Open + recent platform support missions for the staff board (cross-tenant, platform read). */
export async function listPlatformSupportMissions(svc: Svc, limit = 50): Promise<{ rows: Array<{ id: string; brokerage_id: string; objective: string; state: string; priority: string; created_at: string; evidence: unknown[] }>; refused: string | null }> {
  const { data, error } = await svc.from("missions").select("id, brokerage_id, objective, state, priority, created_at, evidence")
    .eq("subject_type", PLATFORM_SUPPORT_SUBJECT_TYPE).order("created_at", { ascending: false }).limit(limit)
  if (error) return { rows: [], refused: error.message }
  return { rows: (data ?? []) as any[], refused: null }
}
