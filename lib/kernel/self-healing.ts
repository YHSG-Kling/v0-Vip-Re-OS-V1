// lib/kernel/self-healing.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SELF-HEALING ENGINE — GENERALIZED TROUBLESHOOTING (wave 138, lane 138B; owner: "the whole platform
// heals itself; AI is the troubleshooting tool; NEVER for money, cross-tenant, or a security breach —
// those go to a human").
//
// NOT A FOURTH SYSTEM (LAW 1/2). This file is the OS-health supervisor's PLAYBOOK half
// (lib/kernel/os-health.ts decideRecovery is the policy; runOsHealthSupervisor calls troubleshootIncident
// for exactly the incidents decideRecovery maps to "unknown → human"). It owns four things nothing had:
//   1. a DECLARED PLAYBOOK LIBRARY (SELF_HEAL_PLAYBOOKS) and which playbooks each OS domain may use
//      (DOMAIN_PLAYBOOKS, DETECTOR_DOMAIN — typed over HEALTH_DETECTORS, so a new detector without a
//      domain does not compile);
//   2. a HARD GATE (classifyForbidden) that runs FIRST: money / tenant boundary / security / data
//      deletion → a human, with the diagnosis attached, and no automatic action;
//   3. a BOUNDED AI DIAGNOSIS (runBoundedModel — AI Gateway model, structured output, cost-capped
//      BEFORE the call, mayUseAndAfford-gated, booked to ai_tool_usage through logAIUsage). The model
//      SELECTS and PARAMETERISES a declared playbook; validatePlaybookSelection refuses anything else
//      (an invented action, an undeclared parameter, SQL in a parameter — never LLM → SQL, LAW 4);
//   4. BOUNDED ATTEMPTS — SELF_HEAL_PLAYBOOK_ATTEMPT_CAP playbook runs per incident per 24h, then a
//      healing PROPOSAL (connector_healing_proposals, the one healing-proposal queue — written by
//      lib/agentic-os/connector-healer.ts recordHealingProposal) and a human, never a loop.
// Every step is ledgered (withActionLedger, OS_HEALTH_RECOVERY, cost_usd booked), evented
// (emitKernelEvent os_health.incident, audit-only) and lands a self_heal_events row the Exception
// Center folds (lib/kernel/os-health.ts foldIncidentHistory counts the os_health_playbook:* rows).
//
// Wave 139A — THE SIX OWNING-RAIL PLAYBOOKS ARE EXECUTABLE (§4b): failover, reroute, requeue, re_sync,
// rebuild_cache and reconcile_counts each run a TYPED, bounded executor THROUGH the survivor that owns
// the work, VERIFY the outcome by re-reading that survivor, and return a HARD STOP (money, tenant
// boundary, credential, legal loosening, destructive canonical change, an external action that could
// repeat) instead of acting. A failed remediation keeps its evidence on the self_heal_events row and
// escalates (proposal + human) on the last allowed attempt; a hard stop escalates at once.

import { z } from "zod"
import type { HealthDetector, HealthIncident } from "@/lib/kernel/os-health"
import { HEALING_POLICY_DEFAULTS, HEALING_POLICY_KEY, type HealingPolicy } from "@/lib/kernel/healing-policy"

type Svc = any

// ── 1. The declared playbook library ─────────────────────────────────────────────────────────

type ParamSpec = { type: "int"; min: number; max: number } | { type: "string"; max: number }
interface PlaybookSpec {
  label: string
  /** false = the playbook HANDS OFF (a notice to a person / manager) — its row stays escalated. */
  acts: boolean
  /** Who performs it: the supervisor's own recovery, this module, or the rail that owns the work. */
  runner: "supervisor" | "self" | "owning_rail"
  rail: string
  params: Record<string, ParamSpec>
}

/** @proofSeam the proof iterates the library to prove only declared keys can ever execute */
export const SELF_HEAL_PLAYBOOKS = {
  retry:                { label: "Retry the idempotent recovery", acts: true, runner: "supervisor", rail: "lib/kernel/os-health.ts defaultRetry (signal reaper / reconciler re-run)", params: {} },
  backoff:              { label: "Back off and let the owning rail retry", acts: true, runner: "self", rail: "the owning rail's own schedule", params: { minutes: { type: "int", min: 5, max: 360 } } },
  resume:               { label: "Resume a chain whose next step never started", acts: true, runner: "supervisor", rail: "lib/workflow-orchestrator/engine.ts advanceRun (via os-health defaultResume)", params: {} },
  requeue:              { label: "Requeue failed sequence steps the provider provably never received", acts: true, runner: "owning_rail", rail: "lib/campaign-sequences/step-executor.ts — the enrollment's own step pointer (the SAME step re-runs through dispatch, as its over-touch deferral does)", params: { maxSteps: { type: "int", min: 1, max: 20 } } },
  re_sync:              { label: "Re-run a sync through its canonical sync service", acts: true, runner: "owning_rail", rail: "RESYNC_RAILS (lib/transactions/sync-from-provider.ts syncTransactionDocumentsFromProvider)", params: { sync: { type: "string", max: 40 } } },
  re_render:            { label: "Requeue a failed render once", acts: true, runner: "self", rail: "app/api/cron/composition-render-queue (guarded failed→queued flip)", params: {} },
  refresh_token_prompt: { label: "Ask the account owner to reconnect a credential", acts: false, runner: "self", rail: "notifications (org recipients)", params: { provider: { type: "string", max: 40 } } },
  failover:             { label: "Fail over to the next healthy provider", acts: true, runner: "owning_rail", rail: "lib/ai-isa/property-lookup-rail.ts routeCapability + lib/agentic-os/connector-healer.ts healProviderFailure", params: { capability: { type: "string", max: 60 } } },
  // 139A: a HAND-OFF (acts: false) — the dark capability's work goes to the manager accountable for it.
  reroute:              { label: "Reroute a dark capability to the manager accountable for it", acts: false, runner: "owning_rail", rail: "lib/agentic-os/capability-ownership.ts routeDarkCapability → capability_dark (publishManagerSignal)", params: { capability: { type: "string", max: 60 } } },
  rebuild_cache:        { label: "Rebuild a derived cache from its authoritative tables", acts: true, runner: "owning_rail", rail: "REBUILD_CACHES (lib/kernel/command-center.ts buildAndPersistBrokerageTwin — the one twin builder)", params: { cache: { type: "string", max: 60 } } },
  re_enqueue_webhook:   { label: "Re-enqueue dead webhook deliveries once", acts: true, runner: "self", rail: "lib/platform/tenant-webhooks.ts drainTenantWebhookDeliveries (signed, idempotency-keyed)", params: { maxDeliveries: { type: "int", min: 1, max: 20 } } },
  reconcile_counts:     { label: "Recompute a derived count from its authoritative table", acts: true, runner: "owning_rail", rail: "RECONCILE_COUNTS (lib/documents/auto-filer.ts recomputeDocumentChecklist)", params: { counts: { type: "string", max: 40 } } },
  notify_owner_manager: { label: "Hand the diagnosis to the owning manager's humans", acts: false, runner: "self", rail: "notifications (org recipients)", params: { message: { type: "string", max: 280 } } },
  read_only_diagnosis:  { label: "Attach a read-only diagnosis (no action)", acts: false, runner: "self", rail: "the Exception Center (self_heal_events)", params: {} },
} as const satisfies Record<string, PlaybookSpec>
type PlaybookKey = keyof typeof SELF_HEAL_PLAYBOOKS

/** @proofSeam the proof asserts every domain lists only declared playbooks */
export const PLAYBOOK_DOMAINS = [
  "provider", "sequences", "portal", "esign", "video_render", "direct_mail", "webhooks", "crons",
  "transactions", "accounting_sync", "enrichment", "scraping", "events", "ai", "workflows", "data",
] as const
type PlaybookDomain = (typeof PLAYBOOK_DOMAINS)[number]

/** Which playbooks each OS domain may use. Money-adjacent domains are read-only by declaration. */
/** @proofSeam the proof walks the domain map (breadth across the OS) */
export const DOMAIN_PLAYBOOKS: Readonly<Record<PlaybookDomain, readonly PlaybookKey[]>> = {
  provider:        ["retry", "backoff", "failover", "reroute", "refresh_token_prompt", "notify_owner_manager"],
  sequences:       ["backoff", "requeue", "refresh_token_prompt", "notify_owner_manager"],
  portal:          ["notify_owner_manager", "read_only_diagnosis"],
  // a signature request is never re-sent blind; 139A: its documents may be re-PULLED and its checklist recounted
  esign:           ["re_sync", "reconcile_counts", "notify_owner_manager", "read_only_diagnosis"],
  video_render:    ["re_render", "notify_owner_manager"],
  direct_mail:     ["read_only_diagnosis", "notify_owner_manager"], // never re-mail (postage is money)
  webhooks:        ["re_enqueue_webhook", "backoff", "refresh_token_prompt", "notify_owner_manager"],
  crons:           ["retry", "backoff", "resume", "notify_owner_manager"],
  transactions:    ["notify_owner_manager", "read_only_diagnosis"],
  accounting_sync: ["read_only_diagnosis"], // books: diagnosis only, Finance acts
  enrichment:      ["retry", "backoff", "failover", "reroute", "notify_owner_manager"],
  scraping:        ["retry", "backoff", "reroute", "notify_owner_manager"],
  events:          ["retry", "rebuild_cache", "notify_owner_manager", "read_only_diagnosis"],
  ai:              ["failover", "notify_owner_manager", "read_only_diagnosis"],
  workflows:       ["resume", "notify_owner_manager"],
  data:            ["reconcile_counts", "re_sync", "rebuild_cache", "notify_owner_manager"],
}

/** Every os-health detector's domain (typed over HEALTH_DETECTORS — a new detector must declare one). */
/** @proofSeam the proof derives detector → domain completeness from HEALTH_DETECTORS */
export const DETECTOR_DOMAIN: Readonly<Record<HealthDetector, PlaybookDomain>> = {
  provider_failures: "provider", stale_missions: "workflows", stuck_workflows: "workflows", failed_webhooks: "webhooks",
  missing_reconciliations: "data", usage_inconsistencies: "accounting_sync", billing_drift: "accounting_sync",
  event_backlog: "events", ai_anomalies: "ai", media_render_failures: "video_render", compliance_flags: "transactions",
  portal_invites: "portal", esign_requests: "esign", direct_mail_returns: "direct_mail", sequence_send_failures: "sequences",
  transaction_deadlines: "transactions", payments_sync: "accounting_sync",
}

// ── 2. The hard gate (runs FIRST) ────────────────────────────────────────────────────────────

type ForbiddenClass = "money" | "tenant_boundary" | "security" | "data_deletion"
type GateVerdict = { forbidden: false } | { forbidden: true; class: ForbiddenClass; reason: string }

const MONEY_DETECTORS: ReadonlySet<HealthDetector> = new Set(["billing_drift", "usage_inconsistencies", "payments_sync"])
const MONEY_RE = /\b(commissions?|payouts?|invoices?|refunds?|chargebacks?|payments?|stripe|escrow|wire transfers?|gci|earnings|billing|disbursements?|postage)\b/i
const TENANT_RE = /\b(cross[- ]tenant|another tenant|other tenant|tenant mismatch|row[- ]level security|rls|brokerage_id mismatch|permission denied)\b/i
const SECURITY_RE = /\b(breach(?:ed)?|hack(?:ed|ing)?|intrusion|injection|exfiltrat\w*|leak(?:ed)?|exposed|compromised?|brute[- ]?force|suspicious|unauthori[sz]ed access|credentials?|secrets?|private key|api key|impersonat\w*|privilege escalation)\b/i
const DELETION_RE = /\b(delete[ds]?|deletion|truncated?|purged?|wiped?|erased?|drop (?:table|column|schema|index|database))\b/i
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function foreignTenant(i: HealthIncident): string | null {
  const ev = i.evidence ?? {}
  for (const k of ["brokerage_id", "brokerageId", "tenant_id", "tenantId"]) {
    const v = (ev as Record<string, unknown>)[k]
    if (typeof v === "string" && UUID_RE.test(v) && v !== i.brokerageId) return v
  }
  return null
}

/**
 * PURE — THE HARD GATE. Money (a financial class, a money detector, a financial writer or money in the
 * evidence), the tenant boundary (evidence naming another tenant, RLS / permission refusals), a
 * security signal (breach, credential, secret, injection …) or a data deletion → FORBIDDEN: a human
 * decides, nothing runs automatically. A model's own flags are honored too (it can only ADD a gate).
 * Fail closed: a keyword match is enough — a false positive costs a human glance, a false negative money.
 */
/** @proofSeam the proof drives every forbidden class with a positive control */
export function classifyForbidden(i: HealthIncident, modelFlags?: { money?: boolean; tenantBoundary?: boolean; security?: boolean; dataDeletion?: boolean } | null): GateVerdict {
  const text = `${i.summary} ${JSON.stringify(i.evidence ?? {}).slice(0, 4000)}`
  if (i.class === "financial_discrepancy" || MONEY_DETECTORS.has(i.detector) || i.financialWriter || MONEY_RE.test(text) || modelFlags?.money)
    return { forbidden: true, class: "money", reason: "touches MONEY — the OS never acts on money; Finance / a human decides" }
  const foreign = foreignTenant(i)
  if (foreign || TENANT_RE.test(text) || modelFlags?.tenantBoundary)
    return { forbidden: true, class: "tenant_boundary", reason: `crosses the TENANT boundary${foreign ? " (evidence names another tenant)" : ""} — a human decides` }
  if (SECURITY_RE.test(text) || modelFlags?.security)
    return { forbidden: true, class: "security", reason: "a SECURITY / credential signal — never auto-remediated; a human decides" }
  if (DELETION_RE.test(text) || modelFlags?.dataDeletion)
    return { forbidden: true, class: "data_deletion", reason: "involves DATA DELETION — never auto-remediated; a human decides" }
  return { forbidden: false }
}

// ── 3. The selection validator (the model selects; it never invents) ────────────────────────

const SQL_RE = /\b(select|insert|update|delete|drop|alter|truncate|grant|revoke|create)\b[\s\S]{0,200}\b(from|into|table|set|on|where|to)\b|;\s*--|\/\*/i

type SelectionVerdict =
  | { ok: true; playbook: PlaybookKey; params: Record<string, string | number> }
  | { ok: false; reason: string }

/**
 * PURE — refuse anything the library does not declare for this domain: an invented playbook, a
 * declared one this domain may not use, one with no executor this tick, an undeclared / mistyped /
 * out-of-range parameter, or SQL in any parameter (never LLM → SQL).
 */
/** @proofSeam the proof feeds invented actions and SQL params and asserts refusal */
export function validatePlaybookSelection(domain: PlaybookDomain, sel: { playbook: string; params?: Record<string, unknown> | null }, available: ReadonlySet<string>): SelectionVerdict {
  const key = sel.playbook
  if (!Object.prototype.hasOwnProperty.call(SELF_HEAL_PLAYBOOKS, key)) return { ok: false, reason: `"${String(key).slice(0, 60)}" is not a declared playbook — an invented action is refused` }
  const pk = key as PlaybookKey
  if (!DOMAIN_PLAYBOOKS[domain].includes(pk)) return { ok: false, reason: `playbook ${pk} is not declared for the ${domain} domain` }
  if (!available.has(pk)) return { ok: false, reason: `playbook ${pk} has no executor this tick` }
  const spec: Record<string, ParamSpec> = SELF_HEAL_PLAYBOOKS[pk].params
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(sel.params ?? {})) {
    const ps = spec[k]
    if (!ps) return { ok: false, reason: `parameter "${k.slice(0, 40)}" is not declared for ${pk}` }
    if (ps.type === "int") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < ps.min || v > ps.max) return { ok: false, reason: `parameter ${k} must be an integer ${ps.min}..${ps.max}` }
      out[k] = v
    } else {
      if (typeof v !== "string" || v.length > ps.max) return { ok: false, reason: `parameter ${k} must be a string ≤ ${ps.max}` }
      if (SQL_RE.test(v)) return { ok: false, reason: `parameter ${k} carries SQL — never LLM → SQL` }
      out[k] = v
    }
  }
  return { ok: true, playbook: pk, params: out }
}

// ── 4. The bounded model call (Gateway, structured, cost-capped, gated, booked) ──────────────

const SELF_HEAL_MODEL = "claude-haiku"
// TOMBSTONE (wave 139, lane 139F): the per-incident diagnosis cap constant (0.05) moved onto the tenant / platform
// SELF-HEALING POLICY — lib/kernel/healing-policy.ts HEALING_POLICY_DEFAULTS.diagnosis_cap_usd is the default, and
// troubleshootIncident reads the effective cap through loadHealingPolicy (tenant policy under the platform ceiling).
const SELF_HEAL_MAX_OUTPUT_TOKENS = 700

export interface BoundedModelDeps {
  model?: (a: { system: string; prompt: string; schema: z.ZodType }) => Promise<{ object: unknown; usage: { inputTokens: number; outputTokens: number; model: string | null } }>
  afford?: (p: { brokerageId: string; estTokens: number }) => Promise<{ allowed: boolean; reason: string }>
  book?: (p: { brokerageId: string; model: string; inputTokens: number; outputTokens: number; feature: string }) => Promise<void>
}

type BoundedModelResult<T> =
  | { ok: true; object: T; costUsd: number; booked: boolean; model: string }
  | { ok: false; reason: string; costUsd: number }

async function priceUsd(model: string, inTok: number, outTok: number): Promise<number> {
  const { calculateCost } = await import("@/lib/ai/cost-tracking")
  return calculateCost(model as Parameters<typeof calculateCost>[0], inTok, outTok) / 100
}

/**
 * ONE bounded model call. The cost cap is enforced BEFORE the call (prompt + max output priced at the
 * model's rate); the tenant's entitlement + AI budget (mayUseAndAfford "ai.generate") gate it; the
 * output must parse against the schema; the real usage is booked (logAIUsage → ai_tool_usage, manager
 * cron_manager). Never throws.
 */
export async function runBoundedModel<T>(input: { brokerageId: string; feature: string; system: string; prompt: string; schema: z.ZodType<T>; capUsd: number }, deps: BoundedModelDeps = {}): Promise<BoundedModelResult<T>> {
  try {
    const estIn = Math.ceil((input.system.length + input.prompt.length) / 4)
    const estUsd = await priceUsd(SELF_HEAL_MODEL, estIn, SELF_HEAL_MAX_OUTPUT_TOKENS)
    if (!(input.capUsd > 0) || estUsd > input.capUsd) return { ok: false, reason: `cost cap: estimated $${estUsd.toFixed(4)} > cap $${Math.max(0, input.capUsd).toFixed(4)} — not called`, costUsd: 0 }
    const afford = deps.afford ?? (async (p) => {
      const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
      const d = await mayUseAndAfford({ brokerageId: p.brokerageId, capability: "ai.generate", estTokens: p.estTokens })
      return { allowed: d.allowed, reason: d.reason }
    })
    const gate = await afford({ brokerageId: input.brokerageId, estTokens: estIn + SELF_HEAL_MAX_OUTPUT_TOKENS })
    if (!gate.allowed) return { ok: false, reason: `entitlement refused (${gate.reason}) — not called`, costUsd: 0 }
    const model = deps.model ?? (async (a) => {
      const { generateObject } = await import("@/lib/ai/generate")
      const r = await generateObject({ model: SELF_HEAL_MODEL, schema: a.schema, system: a.system, prompt: a.prompt, temperature: 0 })
      return { object: r.object, usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, model: r.usage.model } }
    })
    const r = await model({ system: input.system, prompt: input.prompt, schema: input.schema })
    const served = r.usage.model ?? SELF_HEAL_MODEL
    const costUsd = await priceUsd(served, r.usage.inputTokens, r.usage.outputTokens)
    const book = deps.book ?? (async (p) => {
      const { logAIUsage } = await import("@/lib/ai/cost-tracking")
      await logAIUsage({ userId: null, brokerageId: p.brokerageId, model: p.model as Parameters<typeof logAIUsage>[0]["model"], inputTokens: p.inputTokens, outputTokens: p.outputTokens, feature: p.feature, manager: "cron_manager" })
    })
    let booked = false
    try { await book({ brokerageId: input.brokerageId, model: served, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, feature: input.feature }); booked = true }
    catch (e) { console.error(`[self-healing] ${input.feature}: usage NOT booked: ${(e as Error).message}`) }
    const parsed = input.schema.safeParse(r.object)
    if (!parsed.success) return { ok: false, reason: "model output failed the schema — discarded", costUsd }
    return { ok: true, object: parsed.data, costUsd, booked, model: served }
  } catch (e) {
    return { ok: false, reason: `model unavailable: ${(e as Error).message}`.slice(0, 300), costUsd: 0 }
  }
}

// ── 5. Troubleshoot one incident ─────────────────────────────────────────────────────────────

const DiagnosisSchema = z.object({
  diagnosis: z.string().max(800),
  rootCause: z.enum(["transient", "rate_limit", "provider_change", "configuration", "data", "code_defect", "external_outage", "unknown"]),
  touches: z.object({ money: z.boolean(), tenantBoundary: z.boolean(), security: z.boolean(), dataDeletion: z.boolean() }),
  playbook: z.string().max(60),
  params: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean()])).optional(),
  confidence: z.number().min(0).max(1),
})
type Diagnosis = z.infer<typeof DiagnosisSchema>

/** The DEFAULT most playbook runs one incident gets in 24h before it becomes a proposal + a human. The
 *  effective bound is the tenant's `self_healing` policy under the platform ceiling (loadHealingPolicy). */
/** @proofSeam the proof drives the attempt bound to exactly this cap */
export const SELF_HEAL_PLAYBOOK_ATTEMPT_CAP = HEALING_POLICY_DEFAULTS.max_attempts_per_day
// TOMBSTONE (139F): SELF_HEAL_MIN_CONFIDENCE (0.5) — the auto-fix-vs-approval threshold is now the policy's
// auto_fix_min_confidence (lib/kernel/healing-policy.ts HEALING_POLICY_DEFAULTS; a tenant may only raise it).

/** 139A — a remediation that must NOT run automatically: the wave-138 forbidden classes plus a
 *  legal/compliance loosening and an external action (send / call / mail / payment) that could repeat. */
type HardStop = ForbiddenClass | "legal_compliance" | "external_duplicate"
/** 139A — what the executor saw when it RE-READ the survivor after acting. */
type Verification = { verified: boolean; detail: string }
type ExecResult = { ok: boolean; outcome: string; verification?: Verification; hardStop?: HardStop }
type ExecCtx = { cycle: string; attempt: number }
type PlaybookExecutor = (svc: Svc, i: HealthIncident, params: Record<string, string | number>, ctx: ExecCtx) => Promise<ExecResult>

type ProviderHealthLite = { state: string; routeAround: boolean; reason: string }
/** 139A — the canonical services the owning-rail executors call (production resolves each survivor by
 *  dynamic import; a proof injects a spy for the ones that reach a network or the env). */
interface RemediationServices {
  providerHealth?: (provider: string) => Promise<ProviderHealthLite | null>
  healProviderFailure?: (input: { connector: string; brokerageId: string; failures: Array<{ status: number | null; path: string | null; error: string | null }>; cycle: string },
    deps: { client: Svc; derivedHealth: (k: string) => Promise<ProviderHealthLite | null> }) => Promise<{ decision: { step: string; reason: string; proposalKind?: string } }>
  publishManagerSignal?: (input: Record<string, unknown>, svc: Svc) => Promise<{ ok: boolean; signalId?: string; reason?: string }>
  syncTransactionDocumentsFromProvider?: (input: { brokerageId: string; transactionId: string; contactId: string; staleAfterSec?: number }) => Promise<{ ok: boolean; synced: number; skipped: string | null; error: string | null }>
  buildBrokerageTwin?: (brokerageId: string, at: Date, opts: { svc: Svc; persist: boolean }) => Promise<{ twin: { digest: string }; persist: { snapshotId: string | null; error: string | null } }>
  recomputeDocumentChecklist?: (svc: Svc, transactionId: string, brokerageId: string | null) => Promise<void>
  /** Proof seam — the rebuild set the executor validates before it runs (production: REBUILD_CACHES). */
  rebuildSet?: Readonly<Record<string, { table: string; rail: string }>>
  now?: () => Date
}

export interface TroubleshootDeps extends BoundedModelDeps {
  /** A seam may LOWER the diagnosis cap; it can never raise it above the policy's (min of the two). */
  capUsd?: number
  /** The resolved self-healing policy (default: loadHealingPolicy — the ONE reader). */
  policy?: HealingPolicy
  /** Executors the supervisor hands in (retry / resume) and test seams for the rest. */
  executors?: Partial<Record<PlaybookKey, PlaybookExecutor>>
  /** 139A — the canonical services behind the owning-rail executors (§4b). */
  services?: RemediationServices
  /** Bell a human (the supervisor's notifier). */
  notify?: (svc: Svc, i: HealthIncident, reason: string) => Promise<void>
  /** The healing-proposal writer (connector-healer recordHealingProposal). */
  propose?: (p: { connector: string; signature: string; summary: string; payload: Record<string, unknown>; sample: unknown[] }) => Promise<{ id: string | null; error: string | null }>
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
  emit?: (input: Record<string, unknown>) => Promise<{ error: string | null }>
}

type TroubleshootResult =
  | { kind: "escalate"; reason: string; diagnosis: Diagnosis | null; gate: HardStop | null; proposalId: string | null; costUsd: number }
  | { kind: "playbook"; playbook: PlaybookKey; acts: boolean; ok: boolean; outcome: string; diagnosis: Diagnosis; costUsd: number }

/** The executors this module performs itself (each re-checks the tenant and counts what it moved). */
function selfExecutors(deps: TroubleshootDeps): Partial<Record<PlaybookKey, PlaybookExecutor>> {
  const notify = deps.notify
  return {
    backoff: async (_svc, _i, p) => ({ ok: true, outcome: `backing off ${Number(p.minutes ?? 30)} min — the owning rail's next run retries` }),
    notify_owner_manager: async (svc, i, p) => {
      if (!notify) return { ok: false, outcome: "no notifier" }
      await notify(svc, i, `self-healing diagnosis: ${String(p.message ?? i.summary)}`)
      return { ok: true, outcome: "diagnosis handed to the owning manager's humans" }
    },
    refresh_token_prompt: async (svc, i, p) => {
      if (!notify) return { ok: false, outcome: "no notifier" }
      await notify(svc, i, `reconnect ${String(p.provider ?? "the integration")} — its credential needs a refresh (Settings → Integrations)`)
      return { ok: true, outcome: "reconnect prompt sent to the account owner" }
    },
    read_only_diagnosis: async (svc, i) => {
      if (notify) await notify(svc, i, "read-only diagnosis attached in the Exception Center — no automatic action")
      return { ok: true, outcome: "read-only diagnosis attached (no action)" }
    },
    re_enqueue_webhook: async (svc, i, p) => {
      if (i.subjectType !== "tenant_webhook_subscription" || !i.subjectId) return { ok: false, outcome: "not a webhook subscription incident" }
      const { data: dead, error } = await svc.from("tenant_webhook_deliveries").select("id")
        .eq("brokerage_id", i.brokerageId).eq("subscription_id", i.subjectId).eq("status", "dead").limit(Number(p.maxDeliveries ?? 10))
      if (error) return { ok: false, outcome: `dead deliveries unreadable: ${error.message}` }
      const ids = ((dead ?? []) as Array<{ id: string }>).map((r) => r.id)
      if (!ids.length) return { ok: false, outcome: "no dead deliveries left to re-enqueue" }
      const { data: moved, error: upErr } = await svc.from("tenant_webhook_deliveries").update({ status: "failed", next_attempt_at: new Date().toISOString() })
        .in("id", ids).eq("brokerage_id", i.brokerageId).eq("status", "dead").select("id")
      if (upErr) return { ok: false, outcome: `re-enqueue refused: ${upErr.message}` }
      const n = Array.isArray(moved) ? moved.length : 0
      return { ok: n > 0, outcome: `${n}/${ids.length} dead deliveries re-enqueued for the drain (signed, idempotency-keyed)` }
    },
    re_render: async (svc, i) => {
      if (i.subjectType !== "remotion_composition_render" || !i.subjectId) return { ok: false, outcome: "not a composition render incident" }
      const { data: row, error } = await svc.from("remotion_composition_renders").select("id, retry_count").eq("id", i.subjectId).eq("brokerage_id", i.brokerageId).eq("render_status", "failed").maybeSingle()
      if (error || !row) return { ok: false, outcome: `render not requeueable (${error?.message ?? "not failed / not this tenant"})` }
      const { data: moved, error: upErr } = await svc.from("remotion_composition_renders").update({ render_status: "queued", retry_count: (Number((row as any).retry_count) || 0) + 1, error_message: null })
        .eq("id", i.subjectId).eq("brokerage_id", i.brokerageId).eq("render_status", "failed").select("id")
      if (upErr) return { ok: false, outcome: `requeue refused: ${upErr.message}` }
      return { ok: Array.isArray(moved) && moved.length === 1, outcome: Array.isArray(moved) && moved.length === 1 ? "render requeued once (guarded failed→queued)" : "requeue matched no row" }
    },
  }
}

// ── 4b. OWNING-RAIL EXECUTORS (wave 139A) ────────────────────────────────────────────────────
// The six playbooks 138B declared with no executor. Each one is TYPED (its parameter must name a key
// of a declared registry or route table — never free text that reaches a query), BOUNDED (its own row
// limit; SELF_HEAL_PLAYBOOK_ATTEMPT_CAP runs per incident per 24h), runs THROUGH the survivor that owns
// the work, re-checks the tenant on every read and write, and VERIFIES by re-reading that survivor after
// acting. A hard stop is RETURNED, never acted on.
//   failover          routeCapability (the canonical router) + healProviderFailure (probe-first heal)
//   reroute           routeDarkCapability → capability_dark on the bus, deduped on payload.capability
//                     exactly as lib/agentic-os/escalate-dark-capabilities.ts does (a hand-off)
//   requeue           the sequence enrollment's own step pointer — ONLY steps the sent-marker proves
//                     never reached a provider (requeueVerdict); renders / webhooks keep re_render /
//                     re_enqueue_webhook, a cron re-run keeps `retry` (one door each)
//   re_sync           RESYNC_RAILS · rebuild_cache REBUILD_CACHES · reconcile_counts RECONCILE_COUNTS

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidIn = (v: unknown): string | null => (typeof v === "string" && UUID_ONLY.test(v) ? v : null)

/** The canonical sync service per key. `stop` = a human's call, never re-run by the OS. */
/** @proofSeam the proof asserts every live rail is a canonical sync service and every stopped one stays a human's */
export const RESYNC_RAILS = {
  transaction_documents: { rail: "lib/transactions/sync-from-provider.ts syncTransactionDocumentsFromProvider (a tenant-scoped read-PULL, stamps last_provider_sync_at)", stop: null },
  accounting:            { rail: "lib/finance/accounting-egress.ts (accounting_sync_log) — a re-run could double a journal entry", stop: "money" },
  commission_ledger:     { rail: "lib/commission/ledger-sync.ts syncStampToAgentLedger", stop: "money" },
  social_analytics:      { rail: "lib/social/analytics-sync.ts syncSocialAnalytics — a PLATFORM-WIDE sweep, never run from one tenant's incident", stop: "tenant_boundary" },
  crm_contact:           { rail: "lib/crm/sync.ts syncContactToCRM — a PUSH into the tenant's CRM", stop: "external_duplicate" },
} as const satisfies Record<string, { rail: string; stop: HardStop | null }>

/** Derived caches only — rebuilt from authoritative tables by their own generator, append/upsert only. */
/** @proofSeam the proof asserts every entry is a live derived table and a canonical one is refused */
export const REBUILD_CACHES = {
  brokerage_twin_snapshot: { table: "brokerage_twin_snapshots", rail: "lib/kernel/brokerage-twin.ts buildBrokerageTwin (append-only snapshot of the tenant's authoritative tables)" },
} as const satisfies Record<string, { table: string; rail: string }>

/** PURE — a rebuildable table is a DERIVED one by shape (`*_snapshot(s)` / `*_cache`); anything else is
 *  canonical data and a rebuild is never run against it (fail closed: an unknown shape is canonical). */
/** @proofSeam the proof feeds canonical live tables and asserts refusal */
export function isDerivedCacheTable(table: string): boolean {
  return /^[a-z][a-z0-9_]*_(?:snapshots?|cache)$/.test(table)
}

/** A derived count, the authoritative table it is recomputed FROM, and its recomputer. */
/** @proofSeam the proof asserts every live entry recounts from its authoritative source and money stays a human's */
export const RECONCILE_COUNTS = {
  document_checklist: { table: "document_checklist", source: "transaction_documents", rail: "lib/documents/auto-filer.ts recomputeDocumentChecklist", stop: null },
  agent_ytd_stats:    { table: "agents", source: "agent_commissions", rail: "lib/commission/payment-tracker.ts syncAgentYtdStats (GCI)", stop: "money" },
  usage_meters:       { table: "meter_readings", source: "ai_tool_usage", rail: "lib/finance/usage-metering.ts runUsageMeteringRollup (an invoice line)", stop: "money" },
} as const satisfies Record<string, { table: string; source: string; rail: string; stop: HardStop | null }>

/** Sequence channels whose step SPENDS money — never requeued, whatever the sent-marker says. */
const MONEY_STEP_CHANNELS: ReadonlySet<string> = new Set(["send_gift", "ad_campaign", "direct_mail"])
const DELIVERED_STEP_STATUSES: ReadonlySet<string> = new Set(["sent", "delivered", "opened", "clicked", "replied"])
type StepExecRow = { id: string; enrollment_id: string | null; step_id: string | null; channel: string | null; status: string | null; provider_message_id: string | null; sent_at: string | null; blocked_reason: string | null; error_message: string | null }

/**
 * PURE — THE SENT-MARKER (step-executor.ts writes two different facts: `blocked_reason` = an OS gate
 * refused and the provider was NEVER called; `error_message` = the provider was called and refused).
 * A failed step is requeueable ONLY when its row proves the provider was never reached AND no sibling
 * execution of the same enrollment step reached it. A provider-side failure is AMBIGUOUS (an accepted
 * send whose answer was lost looks the same) — never requeued; a money channel never at all.
 */
/** @proofSeam the proof drives every refusal and the one requeueable shape */
export function requeueVerdict(row: StepExecRow, siblings: readonly StepExecRow[]): { requeue: true } | { requeue: false; reason: string; stop: HardStop } {
  const ch = String(row.channel ?? "")
  if (MONEY_STEP_CHANNELS.has(ch)) return { requeue: false, reason: `${ch} spends money — never requeued`, stop: "money" }
  if (row.status !== "failed") return { requeue: false, reason: `status ${row.status} is not a failure`, stop: "external_duplicate" }
  if (row.provider_message_id || row.sent_at) return { requeue: false, reason: "the provider holds a message id / sent_at — it may have delivered", stop: "external_duplicate" }
  if (row.error_message) return { requeue: false, reason: "the PROVIDER refused (it was called) — delivery is unknowable, never re-sent", stop: "external_duplicate" }
  if (!row.blocked_reason) return { requeue: false, reason: "no gate refusal recorded — cannot prove the provider was never reached", stop: "external_duplicate" }
  const hit = siblings.find((s) => s.id !== row.id && (DELIVERED_STEP_STATUSES.has(String(s.status)) || !!s.provider_message_id || !!s.sent_at))
  if (hit) return { requeue: false, reason: `a sibling execution (${hit.status}) already reached the provider for this step`, stop: "external_duplicate" }
  return { requeue: true }
}

/** The transaction an incident is about — its subject, or the evidence's transaction_id. */
const transactionOf = (i: HealthIncident): string | null =>
  (i.subjectType === "transaction" ? uuidIn(i.subjectId) : null) ?? uuidIn((i.evidence as Record<string, unknown>).transaction_id)

/** Re-check the tenant: a transaction this tenant does not hold is a TENANT-BOUNDARY stop (nothing touched). */
async function ownTransaction(svc: Svc, i: HealthIncident, txnId: string): Promise<{ row: Record<string, unknown>; stop: null } | { row: null; stop: ExecResult }> {
  const { data, error } = await svc.from("transactions").select("id, buyer_contact_id, seller_contact_id, contact_id").eq("id", txnId).eq("brokerage_id", i.brokerageId).maybeSingle()
  if (error) return { row: null, stop: { ok: false, outcome: `transaction unreadable: ${error.message}` } }
  if (!data) return { row: null, stop: { ok: false, outcome: `transaction ${txnId} is not this tenant's — nothing touched`, hardStop: "tenant_boundary" } }
  return { row: data as Record<string, unknown>, stop: null }
}

const isDown = (h: ProviderHealthLite | null | undefined) => !!h && (h.routeAround || h.state === "failing" || h.state === "rate_limited")

/** The owning-rail executors, each over its canonical service (seams: RemediationServices). */
function owningRailExecutors(s: RemediationServices): Partial<Record<PlaybookKey, PlaybookExecutor>> {
  const now = s.now ?? (() => new Date())
  const providerHealth = s.providerHealth ?? (async (p: string) => (await import("@/lib/agentic-os/connector-gateway")).loadProviderHealth(p, now()))
  return {
    // FAILOVER — through the CANONICAL ROUTER, then the provider goes to the canonical healer.
    failover: async (svc, i, p, ctx) => {
      const { CONTACT_PROVIDER_ROUTES, routeCapability } = await import("@/lib/ai-isa/property-lookup-rail")
      const cap = String(p.capability ?? "")
      if (!hasOwn(CONTACT_PROVIDER_ROUTES, cap)) return { ok: false, outcome: `"${cap.slice(0, 60)}" is not a capability on the router's table (CONTACT_PROVIDER_ROUTES)` }
      const capability = cap as keyof typeof CONTACT_PROVIDER_ROUTES
      const chain = CONTACT_PROVIDER_ROUTES[capability].map((e) => e.provider as string)
      const provider = String((i.evidence as Record<string, unknown>).provider ?? "")
      if (!chain.includes(provider)) return { ok: false, outcome: `${provider || "no provider in the evidence"} does not serve ${capability} — nothing to fail over` }
      const healthOf = async () => { const h: Record<string, ProviderHealthLite | null> = {}; for (const x of chain) h[x] = await providerHealth(x).catch(() => null); return h }
      const routed = routeCapability(capability, (await healthOf()) as Parameters<typeof routeCapability>[1], new Set([provider]))
      if (routed.providers.length === 0) return { ok: false, outcome: `no healthy alternate serves ${capability} (${routed.skipped.map((x) => `${x.provider}: ${x.reason}`).join("; ").slice(0, 200)})` }
      const heal = s.healProviderFailure ?? (async (input, d) => {
        const m = await import("@/lib/agentic-os/connector-healer")
        return m.healProviderFailure({ ...input, research: { capUsd: m.PROVIDER_RESEARCH_CAP_USD } }, d as never)
      })
      const h = await heal({ connector: provider, brokerageId: i.brokerageId, failures: [{ status: null, path: null, error: String((i.evidence as Record<string, unknown>).reason ?? i.summary).slice(0, 300) }], cycle: `${ctx.cycle}.failover.${ctx.attempt}` },
        { client: svc, derivedHealth: (k) => providerHealth(k) })
      if ((h.decision as { proposalKind?: string }).proposalKind === "rotate_key") return { ok: false, outcome: `${provider} refused its credential — a key rotation is a human's call (${h.decision.reason})`.slice(0, 400), hardStop: "security" }
      // VERIFY — the router itself (no exclusion) on FRESH health must now serve the capability from a provider that is not down.
      const fresh = await healthOf()
      const after = routeCapability(capability, fresh as Parameters<typeof routeCapability>[1])
      const first = after.providers[0] ?? null
      const verified = !!first && !isDown(fresh[first])
      return {
        ok: true, outcome: `routeCapability(${capability}) → ${routed.providers.join(" > ")} (around ${provider}); provider heal: ${h.decision.step} — ${h.decision.reason}`.slice(0, 500),
        verification: { verified, detail: first ? `the router now serves ${capability} from ${first} (${fresh[first]?.state ?? "no health evidence"})` : `the router serves ${capability} from nobody` },
      }
    },

    // REROUTE — capability routing: the dark capability's work goes to the manager accountable for it.
    reroute: async (svc, i, p) => {
      const { APP_CAPABILITY_REGISTRY } = await import("@/lib/agentic-os/app-capability-registry")
      const cap = String(p.capability ?? "")
      if (!hasOwn(APP_CAPABILITY_REGISTRY, cap)) return { ok: false, outcome: `"${cap.slice(0, 60)}" is not a catalogued app capability (APP_CAPABILITY_REGISTRY)` }
      const { routeDarkCapability, darkCapabilityBrief } = await import("@/lib/agentic-os/capability-ownership")
      const capability = cap as keyof typeof APP_CAPABILITY_REGISTRY
      const provider = typeof (i.evidence as Record<string, unknown>).provider === "string" ? String((i.evidence as Record<string, unknown>).provider) : null
      let healingInFlight = false
      if (provider) {
        const { data, error } = await svc.from("connector_healing_proposals").select("id").eq("connector", provider).eq("status", "pending").limit(1)
        if (error) return { ok: false, outcome: `healing queue unreadable: ${error.message}` }
        healingInFlight = ((data ?? []) as unknown[]).length > 0
      }
      const route = routeDarkCapability({ capability, reason: null, healingInFlight, missing: provider ? [provider] : [] })
      if (route.action === "hold_for_healer") return { ok: true, outcome: route.reason, verification: { verified: healingInFlight, detail: `an open healing proposal for ${provider} owns the repair` } }
      const openFor = async () => {
        const { data, error } = await svc.from("manager_signals").select("id, to_manager, payload").eq("brokerage_id", i.brokerageId).eq("signal_type", "capability_dark").eq("status", "open").limit(200)
        if (error) return { rows: null, error: error.message as string }
        return { rows: ((data ?? []) as Array<{ id: string; to_manager: string; payload: Record<string, unknown> | null }>).filter((r) => r.payload?.capability === cap), error: null }
      }
      const before = await openFor()
      if (!before.rows) return { ok: false, outcome: `open signals unreadable: ${before.error}` }
      if (!before.rows.length) {
        const publish = s.publishManagerSignal ?? (async (input, c) => (await import("@/lib/kernel/manager-signals")).publishManagerSignal(input as never, c))
        const r = await publish({
          brokerageId: i.brokerageId, fromManager: route.to === "data_steward" ? "cron_manager" : "data_steward", toManager: route.to,
          signalType: "capability_dark", message: darkCapabilityBrief(capability, route), entityType: "app_capability", entityId: null, dedupe: false,
          payload: { capability: cap, reason: null, missing: provider ? [provider] : [], escalation: route.action, source: "self_healing_reroute", incident: `${i.detector}:${i.subjectKey}` },
        }, svc)
        if (!r.ok) return { ok: false, outcome: `reroute signal refused: ${r.reason ?? "unknown"}` }
      }
      const after = await openFor()
      const landed = after.rows?.find((r) => r.to_manager === route.to) ?? null
      return { ok: true, outcome: `${cap} rerouted to ${route.to} (${route.action})${before.rows.length ? " — already open" : ""}`, verification: { verified: !!landed, detail: landed ? `open capability_dark ${landed.id} → ${route.to}` : `no open signal reached ${route.to}${after.error ? ` (${after.error})` : ""}` } }
    },

    // REQUEUE — the SAME sequence step re-runs through dispatch (which re-gates), only when provably unsent.
    requeue: async (svc, i, p) => {
      const max = Number(p.maxSteps ?? 5)
      const provider = typeof (i.evidence as Record<string, unknown>).provider === "string" ? String((i.evidence as Record<string, unknown>).provider) : null
      const cols = "id, enrollment_id, step_id, channel, status, provider_key, provider_message_id, sent_at, blocked_reason, error_message"
      const { data: failed, error } = await svc.from("sequence_step_executions").select(cols)
        .eq("brokerage_id", i.brokerageId).eq("status", "failed").gte("created_at", new Date(now().getTime() - 24 * 3_600_000).toISOString()).limit(200)
      if (error) return { ok: false, outcome: `failed steps unreadable: ${error.message}` }
      const rows = ((failed ?? []) as Array<StepExecRow & { provider_key: string | null }>).filter((r) => !provider || r.provider_key === provider || r.channel === provider)
      if (!rows.length) return { ok: false, outcome: "no failed sequence step in 24h for this incident" }
      const enrollmentIds = [...new Set(rows.map((r) => r.enrollment_id).filter((x): x is string => !!x))]
      const { data: sib, error: sibErr } = await svc.from("sequence_step_executions").select(cols).eq("brokerage_id", i.brokerageId).in("enrollment_id", enrollmentIds).limit(2000)
      if (sibErr) return { ok: false, outcome: `sent-marker unreadable: ${sibErr.message} — nothing requeued` }
      const siblings = (sib ?? []) as StepExecRow[]
      const refused: Array<{ reason: string; stop: HardStop }> = []
      const picked = new Map<string, StepExecRow>()
      for (const r of rows) {
        const v = requeueVerdict(r, siblings.filter((x) => x.enrollment_id === r.enrollment_id && x.step_id === r.step_id))
        if (!v.requeue) refused.push({ reason: `${r.channel}: ${v.reason}`, stop: v.stop })
        else if (r.enrollment_id && !picked.has(r.enrollment_id) && picked.size < max) picked.set(r.enrollment_id, r)
      }
      const why = refused.slice(0, 3).map((x) => x.reason).join("; ")
      if (!picked.size) return { ok: false, outcome: `nothing provably unsent to requeue — ${refused.length} refused (${why})`.slice(0, 500), hardStop: refused.some((x) => x.stop === "money") ? "money" : "external_duplicate" }
      const { data: steps, error: stepErr } = await svc.from("campaign_sequence_steps").select("id, sequence_id, step_number").in("id", [...picked.values()].map((r) => r.step_id))
      if (stepErr) return { ok: false, outcome: `sequence steps unreadable: ${stepErr.message}` }
      const stepOf = new Map(((steps ?? []) as Array<{ id: string; sequence_id: string; step_number: number }>).map((x) => [x.id, x]))
      const moved: Array<{ id: string; to: number }> = []
      for (const r of picked.values()) {
        const st = stepOf.get(String(r.step_id))
        if (!st) continue
        const { data: en, error: enErr } = await svc.from("sequence_enrollments").select("id, sequence_id, current_step, status, step_outputs").eq("id", r.enrollment_id).eq("brokerage_id", i.brokerageId).maybeSingle()
        if (enErr || !en) continue
        const e = en as { sequence_id: string; current_step: number | null; status: string; step_outputs: Record<string, unknown> | null }
        const key = `step_${st.step_number}`
        const requeues = (e.step_outputs?.__requeues as Record<string, number> | undefined) ?? {}
        // Only an ACTIVE enrollment sitting exactly past this step (its next step has not run), once per step.
        if (e.status !== "active" || e.sequence_id !== st.sequence_id || e.current_step !== st.step_number || requeues[key]) continue
        const { data: up, error: upErr } = await svc.from("sequence_enrollments")
          .update({ current_step: st.step_number - 1, next_step_at: now().toISOString(), step_outputs: { ...(e.step_outputs ?? {}), __requeues: { ...requeues, [key]: 1 } } })
          .eq("id", r.enrollment_id).eq("brokerage_id", i.brokerageId).eq("status", "active").eq("current_step", st.step_number).select("id")
        if (!upErr && Array.isArray(up) && up.length === 1) moved.push({ id: String(r.enrollment_id), to: st.step_number - 1 })
      }
      if (!moved.length) return { ok: false, outcome: `no enrollment could be moved back onto its failed step (${picked.size} candidate(s); ${refused.length} refused)` }
      // VERIFY — re-read the enrollments: each sits on the failed step again, still active.
      const { data: back, error: backErr } = await svc.from("sequence_enrollments").select("id, current_step, status").in("id", moved.map((m) => m.id)).eq("brokerage_id", i.brokerageId)
      const ok2 = !backErr && moved.every((m) => ((back ?? []) as Array<{ id: string; current_step: number; status: string }>).some((b) => b.id === m.id && b.current_step === m.to && b.status === "active"))
      return { ok: true, outcome: `${moved.length} provably-unsent step(s) requeued through the enrollment's own pointer (dispatch re-gates); ${refused.length} refused${why ? ` (${why})` : ""}`.slice(0, 500),
        verification: { verified: ok2, detail: ok2 ? `${moved.length} enrollment(s) back on their failed step` : `re-read disagrees (${backErr?.message ?? "pointer moved"})` } }
    },

    // RE-SYNC — the canonical sync service for the key; a stopped key is a human's call.
    re_sync: async (svc, i, p) => {
      const key = String(p.sync ?? "")
      if (!hasOwn(RESYNC_RAILS, key)) return { ok: false, outcome: `"${key.slice(0, 40)}" is not a declared sync rail (RESYNC_RAILS)` }
      const spec: { rail: string; stop: HardStop | null } = RESYNC_RAILS[key as keyof typeof RESYNC_RAILS]
      if (spec.stop) return { ok: false, outcome: `${key} re-sync is a human's call (${spec.stop}) — ${spec.rail}`, hardStop: spec.stop }
      const txn = transactionOf(i)
      if (!txn) return { ok: false, outcome: "no transaction on this incident to re-sync" }
      const own = await ownTransaction(svc, i, txn)
      if (own.stop) return own.stop
      const contactId = String(own.row.buyer_contact_id ?? own.row.seller_contact_id ?? own.row.contact_id ?? "")
      if (!contactId) return { ok: false, outcome: `transaction ${txn} has no contact to file documents under` }
      const started = now().getTime()
      const sync = s.syncTransactionDocumentsFromProvider ?? (await import("@/lib/transactions/sync-from-provider")).syncTransactionDocumentsFromProvider
      const r = await sync({ brokerageId: i.brokerageId, transactionId: txn, contactId, staleAfterSec: 0 })
      if (!r.ok) return { ok: false, outcome: `transaction document sync refused: ${r.error ?? r.skipped ?? "unknown"}` }
      // VERIFY — the core stamps last_provider_sync_at only on a completed pull.
      const { data: after, error } = await svc.from("transactions").select("last_provider_sync_at").eq("id", txn).eq("brokerage_id", i.brokerageId).maybeSingle()
      const stamp = (after as { last_provider_sync_at?: string | null } | null)?.last_provider_sync_at ?? null
      const verified = !error && !!stamp && Date.parse(stamp) >= started - 1000
      return { ok: true, outcome: `transaction documents re-pulled from the provider (${r.synced} document(s)${r.skipped ? `, ${r.skipped}` : ""})`, verification: { verified, detail: verified ? `last_provider_sync_at ${stamp}` : `the sync was not stamped (${error?.message ?? stamp ?? "no stamp"})` } }
    },

    // REBUILD — derived caches only; a canonical table in the rebuild set is refused before anything runs.
    rebuild_cache: async (svc, i, p) => {
      const set = s.rebuildSet ?? REBUILD_CACHES
      const key = String(p.cache ?? "")
      if (!hasOwn(set, key)) return { ok: false, outcome: `"${key.slice(0, 60)}" is not a declared derived cache (REBUILD_CACHES)` }
      const spec = (set as Record<string, { table: string; rail: string }>)[key]
      if (!isDerivedCacheTable(spec.table)) return { ok: false, outcome: `${spec.table} is CANONICAL data, not a derived cache — a rebuild never runs against it`, hardStop: "data_deletion" }
      if (key !== "brokerage_twin_snapshot") return { ok: false, outcome: `no rebuilder wired for ${key}` }
      // Through the Command Center's ONE builder (seams loaded, snapshot persisted) — never a second builder.
      const build = s.buildBrokerageTwin ?? (async (b, at, o) => (await import("@/lib/kernel/command-center")).buildAndPersistBrokerageTwin(b, at, { svc: o.svc }))
      const r = await build(i.brokerageId, now(), { svc, persist: true })
      if (!r.persist.snapshotId) return { ok: false, outcome: `twin rebuilt but its snapshot was not persisted: ${r.persist.error ?? "no id"}` }
      // VERIFY — the persisted snapshot is THIS tenant's and carries the digest just built.
      const { data: row, error } = await svc.from(spec.table).select("id, brokerage_id, digest").eq("id", r.persist.snapshotId).eq("brokerage_id", i.brokerageId).maybeSingle()
      const verified = !error && !!row && (row as { digest?: string }).digest === r.twin.digest
      return { ok: true, outcome: `${spec.table} rebuilt from the authoritative tables (${r.persist.snapshotId})`, verification: { verified, detail: verified ? `snapshot ${r.persist.snapshotId} digest ${r.twin.digest}` : `snapshot re-read disagrees (${error?.message ?? "missing / digest mismatch"})` } }
    },

    // RECONCILE COUNTS — recompute a derived count, then VERIFY it against a FRESH count of the authoritative table.
    reconcile_counts: async (svc, i, p) => {
      const key = String(p.counts ?? "")
      if (!hasOwn(RECONCILE_COUNTS, key)) return { ok: false, outcome: `"${key.slice(0, 40)}" is not a declared derived count (RECONCILE_COUNTS)` }
      const spec: { table: string; source: string; rail: string; stop: HardStop | null } = RECONCILE_COUNTS[key as keyof typeof RECONCILE_COUNTS]
      if (spec.stop) return { ok: false, outcome: `${key} is a human's call (${spec.stop}) — ${spec.rail}`, hardStop: spec.stop }
      const txn = transactionOf(i)
      if (!txn) return { ok: false, outcome: "no transaction on this incident to recount" }
      const own = await ownTransaction(svc, i, txn)
      if (own.stop) return own.stop
      const recompute = s.recomputeDocumentChecklist ?? (await import("@/lib/documents/auto-filer")).recomputeDocumentChecklist
      await recompute(svc, txn, i.brokerageId)
      const [src, agg] = await Promise.all([
        svc.from(spec.source).select("id, status").eq("transaction_id", txn).eq("brokerage_id", i.brokerageId).limit(500),
        svc.from(spec.table).select("total_count, verified_count").eq("transaction_id", txn).eq("brokerage_id", i.brokerageId).maybeSingle(),
      ])
      if (src.error || agg.error) return { ok: true, outcome: `${spec.table} recomputed`, verification: { verified: false, detail: `recount unreadable: ${(src.error ?? agg.error).message}` } }
      const docs = (src.data ?? []) as Array<{ status: string | null }>
      const total = docs.length, approved = docs.filter((d) => d.status === "approved").length
      const a = agg.data as { total_count?: number; verified_count?: number } | null
      const verified = !!a && Number(a.total_count) === total && Number(a.verified_count) === approved
      return { ok: true, outcome: `${spec.table} recomputed from ${spec.source}`, verification: { verified, detail: `authoritative ${spec.source}: ${total} total / ${approved} approved; derived ${spec.table}: ${a ? `${a.total_count} / ${a.verified_count}` : "no row"}` } }
    },
  }
}

function incidentPrompt(i: HealthIncident, domain: PlaybookDomain, offered: PlaybookKey[]): { system: string; prompt: string } {
  const system =
    "You are the VIP Agents OS self-healing troubleshooter. Diagnose ONE operational incident from its evidence. " +
    "You may only SELECT one playbook from the offered list and fill only its declared parameters. " +
    "Never propose SQL, code, credentials, deletions, refunds or any money movement. Flag touches.* honestly. " +
    "If no offered playbook fits, select notify_owner_manager when offered, else read_only_diagnosis."
  const lib = offered.map((k) => `- ${k}: ${SELF_HEAL_PLAYBOOKS[k].label}; params ${JSON.stringify(SELF_HEAL_PLAYBOOKS[k].params)}`).join("\n")
  const prompt =
    `DOMAIN: ${domain}\nDETECTOR: ${i.detector}\nCLASS: ${i.class}\nIDEMPOTENT: ${i.idempotent}\nSUMMARY: ${i.summary.slice(0, 400)}\n` +
    `EVIDENCE: ${JSON.stringify(i.evidence ?? {}).slice(0, 1500)}\n\nOFFERED PLAYBOOKS:\n${lib || "(none — diagnosis only, a human decides)"}\n\n` +
    "Return the structured diagnosis."
  return { system, prompt }
}

/**
 * Troubleshoot ONE incident decideRecovery sent to a human. Gate → bound → diagnose (bounded model) →
 * gate again on the model's own flags → validate the selection → run the declared playbook through its
 * executor. Every step is ledgered; a playbook run lands a self_heal_events row and an event. Anything
 * not run returns `escalate` with the reason (and the diagnosis) for the supervisor's escalation path.
 * Never throws.
 */
export async function troubleshootIncident(svc: Svc, i: HealthIncident, ctx: { playbookAttempts24h: number; cycle: string; attempt: number }, deps: TroubleshootDeps = {}): Promise<TroubleshootResult> {
  const domain = DETECTOR_DOMAIN[i.detector]
  const subject = `os_health:${i.detector}:${i.subjectKey}`
  const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
  const emit = deps.emit ?? (async (input: Record<string, unknown>) => (await import("@/lib/kernel/emit")).emitKernelEvent(input as any))
  /** The ledger row's idempotency key per step — also written onto the incident row (incident ↔ action link). */
  const keyFor = (name: string) => `os_health_troubleshoot:${i.brokerageId}:${subject}:${name}:${ctx.attempt}:${ctx.cycle}`
  const step = <T>(name: string, detail: Record<string, unknown>, run: () => Promise<T>, settle: (r: T) => { ok: boolean; note: string; costUsd?: number }) =>
    ledger<T>(
      {
        brokerageId: i.brokerageId,
        action: `os_health.${i.detector}.${name}`,
        actor: { type: "manager", managerKey: "cron_manager" },
        subject: { type: i.subjectType, id: i.subjectId, ref: i.subjectKey },
        reasonCode: "OS_HEALTH_RECOVERY",
        reasonDetail: String(detail.reason ?? name).slice(0, 500),
        idempotencyKey: keyFor(name),
        riskClass: "LOW_RISK_WRITE",
        systemSource: "os_health",
        // LAW 5 — which policy permitted: the self-healing policy key (the ledger stamps self_healing@<version>).
        policyKey: HEALING_POLICY_KEY,
        detail: { domain, class: i.class, detector: i.detector, ...detail },
      },
      run,
      {
        settle: (r) => { const s = settle(r); return { status: s.ok ? "executed" : "failed", outcome: s.note.slice(0, 300), error: s.ok ? null : s.note.slice(0, 300), costUsd: s.costUsd ?? null } },
        replay: () => null as T,
      },
      { client: svc },
    )

  // 1. THE HARD GATE (before any model or playbook).
  const gate0 = classifyForbidden(i)

  // 1b. THE POLICY (wave 139F) — tenant self-healing policy under the platform ceiling, through the ONE reader.
  //     Unreadable → nothing autonomous runs: the incident goes to a human with the reason (fail closed).
  const policy = deps.policy ?? await (await import("@/lib/kernel/healing-policy")).loadHealingPolicy(svc, i.brokerageId)
  if (!policy.readable) return { kind: "escalate", reason: `self-healing policy unreadable (${policy.note ?? "no detail"}) — a human decides`, diagnosis: null, gate: gate0.forbidden ? gate0.class : null, proposalId: null, costUsd: 0 }
  const attemptCap = policy.maxAttemptsPerDay

  /** The ONE healing-proposal writer; the proposal carries the incident's evidence (+ the failed attempt's). */
  const proposeToHuman = async (reason: string, failedAttempt: Record<string, unknown> | null) => {
    const propose = deps.propose ?? (async (p) => {
      const { recordHealingProposal } = await import("@/lib/agentic-os/connector-healer")
      return recordHealingProposal(svc, { connector: p.connector, failure_signature: p.signature, failure_sample: p.sample, proposal_kind: "playbook_exhausted", proposal_summary: p.summary, proposal_payload: p.payload, docs_evidence: [], confidence: 0 })
    })
    const r = await step("propose", { reason }, () => propose({ connector: subject, signature: `${i.detector}: ${i.summary}`.slice(0, 300), summary: reason, payload: { brokerage_id: i.brokerageId, domain, detector: i.detector, subject: i.subjectKey, class: i.class, ...(failedAttempt ? { failed_attempt: failedAttempt } : {}) }, sample: [{ summary: i.summary, evidence: i.evidence }] }),
      (x) => ({ ok: !!x?.id, note: x?.id ? `proposal ${x.id}` : `proposal not written: ${x?.error ?? "no result"}` }))
    return r?.id ?? null
  }

  // 2. THE BOUND — exhausted playbooks become a proposal + a human, never a loop.
  if (!gate0.forbidden && ctx.playbookAttempts24h >= attemptCap) {
    const reason = `self-healing playbooks exhausted (${ctx.playbookAttempts24h}/${attemptCap} in 24h, policy) — a healing proposal for platform staff + a human, not another loop`
    return { kind: "escalate", reason, diagnosis: null, gate: null, proposalId: await proposeToHuman(reason, null), costUsd: 0 }
  }

  // 3. DIAGNOSE (bounded) — offered playbooks are the domain's declared ones that can run this tick
  //    (none for a forbidden incident: the diagnosis is for the human).
  const executors: Partial<Record<PlaybookKey, PlaybookExecutor>> = { ...selfExecutors(deps), ...owningRailExecutors(deps.services ?? {}), ...(deps.executors ?? {}) }
  //    The policy's allowed remediation classes govern ACTING playbooks; a hand-off (acts: false) is always offered.
  const allowed = policy.allowedRemediationClasses
  const offered = gate0.forbidden ? [] : DOMAIN_PLAYBOOKS[domain].filter((k) => !!executors[k] && (!SELF_HEAL_PLAYBOOKS[k].acts || allowed === null || allowed.includes(k)))
  const { system, prompt } = incidentPrompt(i, domain, offered)
  const capUsd = Math.min(deps.capUsd ?? policy.diagnosisCapUsd, policy.diagnosisCapUsd)
  const dx = await step("diagnose", { reason: `bounded AI diagnosis (cap $${capUsd})`, offered, gate: gate0.forbidden ? gate0.class : null },
    () => runBoundedModel({ brokerageId: i.brokerageId, feature: "os_self_heal_diagnosis", system, prompt, schema: DiagnosisSchema, capUsd }, deps),
    (x) => x && x.ok ? { ok: true, note: `${x.object.rootCause} → ${x.object.playbook} (${Math.round(x.object.confidence * 100)}%)`, costUsd: x.costUsd } : { ok: false, note: x ? x.reason : "no result", costUsd: x?.costUsd ?? 0 })
  const costUsd = dx?.costUsd ?? 0
  const diagnosis = dx && dx.ok ? dx.object : null
  const attach = diagnosis ? ` · AI diagnosis (${diagnosis.rootCause}, ${Math.round(diagnosis.confidence * 100)}%): ${diagnosis.diagnosis.slice(0, 300)}` : ""

  if (gate0.forbidden) return { kind: "escalate", reason: `${gate0.reason}${attach}`, diagnosis, gate: gate0.class, proposalId: null, costUsd }
  if (!diagnosis) return { kind: "escalate", reason: `AI diagnosis unavailable (${dx && !dx.ok ? dx.reason : "no result"}) — a human decides`, diagnosis: null, gate: null, proposalId: null, costUsd }
  const gate1 = classifyForbidden(i, diagnosis.touches)
  if (gate1.forbidden) return { kind: "escalate", reason: `${gate1.reason} (flagged by the diagnosis)${attach}`, diagnosis, gate: gate1.class, proposalId: null, costUsd }
  if (diagnosis.confidence < policy.autoFixMinConfidence) return { kind: "escalate", reason: `diagnosis confidence ${Math.round(diagnosis.confidence * 100)}% below the auto-fix threshold ${Math.round(policy.autoFixMinConfidence * 100)}% (policy) — a human approves${attach}`, diagnosis, gate: null, proposalId: null, costUsd }

  // 4. VALIDATE — the model selected; the library decides.
  const sel = validatePlaybookSelection(domain, { playbook: diagnosis.playbook, params: diagnosis.params ?? {} }, new Set(offered))
  if (!sel.ok) {
    await step("playbook_refused", { reason: sel.reason, selected: diagnosis.playbook }, async () => sel, () => ({ ok: false, note: sel.reason }))
    return { kind: "escalate", reason: `model selection refused: ${sel.reason}${attach}`, diagnosis, gate: null, proposalId: null, costUsd }
  }

  // 5. RUN the declared playbook through its executor.
  const spec = SELF_HEAL_PLAYBOOKS[sel.playbook]
  //    139A: an owning-rail playbook counts as done only when its executor VERIFIED the outcome by
  //    re-reading the survivor; a hard stop is never "done".
  const attemptNo = ctx.playbookAttempts24h + 1
  const verifyRequired = spec.runner === "owning_rail"
  const run = await step(`playbook_${sel.playbook}`, { reason: `${spec.label} — ${diagnosis.diagnosis.slice(0, 200)}`, playbook: sel.playbook, params: sel.params, rail: spec.rail, diagnosis },
    () => executors[sel.playbook]!(svc, i, sel.params, { cycle: ctx.cycle, attempt: attemptNo }).catch((e: Error): ExecResult => ({ ok: false, outcome: `executor threw: ${e.message}` })),
    (x) => ({ ok: !!x?.ok && !x.hardStop && (!verifyRequired || !!x.verification?.verified), note: x ? `${x.outcome}${x.verification ? ` · verified: ${x.verification.verified}` : ""}` : "no result" }))
  const verification = run?.verification ?? null
  const hardStop = run?.hardStop ?? null
  const ok = !!run?.ok && !hardStop && (!verifyRequired || !!verification?.verified)
  const outcome = run
    ? `${run.outcome}${verification ? ` · verify ${verification.verified ? "OK" : "FAILED"}: ${verification.detail}` : verifyRequired ? " · verify FAILED: the executor returned no verification" : ""}`.slice(0, 800)
    : "replayed — already recorded for this attempt"
  // incident ↔ evidence ↔ action (ledger key) ↔ attempt ↔ outcome (+ verification) on ONE Exception-Center row.
  const { error: rowErr } = await svc.from("self_heal_events").insert({
    brokerage_id: i.brokerageId, domain: "data_flow", subject, action: `os_health_playbook:${sel.playbook}`,
    outcome: !ok ? "failed" : !spec.acts ? "escalated" : "healed",
    detail: { flow: `os_health_${i.detector}`, class: i.class, playbook: sel.playbook, params: sel.params, rail: spec.rail, outcome, diagnosis: diagnosis.diagnosis.slice(0, 500), root_cause: diagnosis.rootCause, confidence: diagnosis.confidence, cost_usd: costUsd, attempt: attemptNo,
      attempt_ceiling: attemptCap, evidence: i.evidence, verification, hard_stop: hardStop, ledger_key: keyFor(`playbook_${sel.playbook}`) },
  })
  if (rowErr) console.error(`[self-healing] incident row refused for ${subject}: ${rowErr.message}`)
  const ev = await emit({
    event: "os_health.incident", brokerageId: i.brokerageId, entityType: "os_health_incident", entityId: null, source: "cron", auditOnly: true, client: svc,
    dedupeKey: `${subject}:playbook:${sel.playbook}:${attemptNo}`, dedupeWindowSec: 86_400,
    metadata: { subject, detector: i.detector, class: i.class, recovery: "playbook", playbook: sel.playbook, ok, outcome, root_cause: diagnosis.rootCause, cost_usd: costUsd, verified: verification?.verified ?? null, hard_stop: hardStop, attempt: attemptNo },
  })
  if (ev.error) console.error(`[self-healing] event not recorded for ${subject}: ${ev.error}`)

  // 6. A FAILED REMEDIATION keeps its evidence (the row above) and ESCALATES: a hard stop at once (a human,
  //    never retried); otherwise on the LAST allowed attempt (proposal + human) — earlier failures retry next tick.
  if (!ok && run) {
    if (hardStop) return { kind: "escalate", reason: `hard stop (${hardStop}) — ${outcome}${attach}`.slice(0, 1200), diagnosis, gate: hardStop, proposalId: null, costUsd }
    if (attemptNo >= attemptCap) {
      const reason = `remediation ${sel.playbook} failed on the last allowed attempt (${attemptNo}/${attemptCap}, policy) — ${outcome}`.slice(0, 900)
      const proposalId = await proposeToHuman(reason, { playbook: sel.playbook, params: sel.params, outcome, verification, ledger_key: keyFor(`playbook_${sel.playbook}`) })
      return { kind: "escalate", reason: `${reason}${attach}`.slice(0, 1200), diagnosis, gate: null, proposalId, costUsd }
    }
  }
  return { kind: "playbook", playbook: sel.playbook, acts: spec.acts, ok, outcome, diagnosis, costUsd }
}
