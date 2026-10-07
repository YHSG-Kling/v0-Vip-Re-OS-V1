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

import { z } from "zod"
import type { HealthDetector, HealthIncident } from "@/lib/kernel/os-health"

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
  requeue:              { label: "Requeue failed sequence steps", acts: true, runner: "owning_rail", rail: "the sequence step executor's own retry", params: { maxSteps: { type: "int", min: 1, max: 20 } } },
  re_sync:              { label: "Re-run a sync from its rail", acts: true, runner: "owning_rail", rail: "the sync rail's next run", params: {} },
  re_render:            { label: "Requeue a failed render once", acts: true, runner: "self", rail: "app/api/cron/composition-render-queue (guarded failed→queued flip)", params: {} },
  refresh_token_prompt: { label: "Ask the account owner to reconnect a credential", acts: false, runner: "self", rail: "notifications (org recipients)", params: { provider: { type: "string", max: 40 } } },
  failover:             { label: "Fail over to the next healthy provider", acts: true, runner: "owning_rail", rail: "lib/ai-isa/property-lookup-rail.ts routeCapability", params: { capability: { type: "string", max: 60 } } },
  reroute:              { label: "Reroute the capability to another provider", acts: true, runner: "owning_rail", rail: "lib/ai-isa/property-lookup-rail.ts routeCapability", params: { capability: { type: "string", max: 60 } } },
  rebuild_cache:        { label: "Rebuild a derived cache", acts: true, runner: "owning_rail", rail: "the cache's generator", params: { cache: { type: "string", max: 60 } } },
  re_enqueue_webhook:   { label: "Re-enqueue dead webhook deliveries once", acts: true, runner: "self", rail: "lib/platform/tenant-webhooks.ts drainTenantWebhookDeliveries (signed, idempotency-keyed)", params: { maxDeliveries: { type: "int", min: 1, max: 20 } } },
  reconcile_counts:     { label: "Re-run a counts reconciler", acts: true, runner: "owning_rail", rail: "the reconciler that owns the counts", params: {} },
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
  esign:           ["notify_owner_manager", "read_only_diagnosis"], // a signature request is never re-sent blind
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
/** Per-incident ceiling for one diagnosis (USD). */
const SELF_HEAL_DIAGNOSIS_CAP_USD = 0.05
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

/** The most playbook runs one incident gets in 24h before it becomes a proposal + a human. */
/** @proofSeam the proof drives the attempt bound to exactly this cap */
export const SELF_HEAL_PLAYBOOK_ATTEMPT_CAP = 2
const SELF_HEAL_MIN_CONFIDENCE = 0.5

type PlaybookExecutor = (svc: Svc, i: HealthIncident, params: Record<string, string | number>) => Promise<{ ok: boolean; outcome: string }>

export interface TroubleshootDeps extends BoundedModelDeps {
  capUsd?: number
  /** Executors the supervisor hands in (retry / resume) and test seams for the rest. */
  executors?: Partial<Record<PlaybookKey, PlaybookExecutor>>
  /** Bell a human (the supervisor's notifier). */
  notify?: (svc: Svc, i: HealthIncident, reason: string) => Promise<void>
  /** The healing-proposal writer (connector-healer recordHealingProposal). */
  propose?: (p: { connector: string; signature: string; summary: string; payload: Record<string, unknown>; sample: unknown[] }) => Promise<{ id: string | null; error: string | null }>
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
  emit?: (input: Record<string, unknown>) => Promise<{ error: string | null }>
}

type TroubleshootResult =
  | { kind: "escalate"; reason: string; diagnosis: Diagnosis | null; gate: ForbiddenClass | null; proposalId: string | null; costUsd: number }
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
  const step = <T>(name: string, detail: Record<string, unknown>, run: () => Promise<T>, settle: (r: T) => { ok: boolean; note: string; costUsd?: number }) =>
    ledger<T>(
      {
        brokerageId: i.brokerageId,
        action: `os_health.${i.detector}.${name}`,
        actor: { type: "manager", managerKey: "cron_manager" },
        subject: { type: i.subjectType, id: i.subjectId, ref: i.subjectKey },
        reasonCode: "OS_HEALTH_RECOVERY",
        reasonDetail: String(detail.reason ?? name).slice(0, 500),
        idempotencyKey: `os_health_troubleshoot:${i.brokerageId}:${subject}:${name}:${ctx.attempt}:${ctx.cycle}`,
        riskClass: "LOW_RISK_WRITE",
        systemSource: "os_health",
        detail: { domain, ...detail },
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

  // 2. THE BOUND — exhausted playbooks become a proposal + a human, never a loop.
  if (!gate0.forbidden && ctx.playbookAttempts24h >= SELF_HEAL_PLAYBOOK_ATTEMPT_CAP) {
    const propose = deps.propose ?? (async (p) => {
      const { recordHealingProposal } = await import("@/lib/agentic-os/connector-healer")
      return recordHealingProposal(svc, { connector: p.connector, failure_signature: p.signature, failure_sample: p.sample, proposal_kind: "playbook_exhausted", proposal_summary: p.summary, proposal_payload: p.payload, docs_evidence: [], confidence: 0 })
    })
    const reason = `self-healing playbooks exhausted (${ctx.playbookAttempts24h}/${SELF_HEAL_PLAYBOOK_ATTEMPT_CAP} in 24h) — a healing proposal for platform staff + a human, not another loop`
    const r = await step("propose", { reason }, () => propose({ connector: subject, signature: `${i.detector}: ${i.summary}`.slice(0, 300), summary: reason, payload: { brokerage_id: i.brokerageId, domain, detector: i.detector, subject: i.subjectKey, class: i.class }, sample: [{ summary: i.summary, evidence: i.evidence }] }),
      (x) => ({ ok: !!x?.id, note: x?.id ? `proposal ${x.id}` : `proposal not written: ${x?.error ?? "no result"}` }))
    return { kind: "escalate", reason, diagnosis: null, gate: null, proposalId: r?.id ?? null, costUsd: 0 }
  }

  // 3. DIAGNOSE (bounded) — offered playbooks are the domain's declared ones that can run this tick
  //    (none for a forbidden incident: the diagnosis is for the human).
  const executors: Partial<Record<PlaybookKey, PlaybookExecutor>> = { ...selfExecutors(deps), ...(deps.executors ?? {}) }
  const offered = gate0.forbidden ? [] : DOMAIN_PLAYBOOKS[domain].filter((k) => !!executors[k])
  const { system, prompt } = incidentPrompt(i, domain, offered)
  const capUsd = deps.capUsd ?? SELF_HEAL_DIAGNOSIS_CAP_USD
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
  if (diagnosis.confidence < SELF_HEAL_MIN_CONFIDENCE) return { kind: "escalate", reason: `diagnosis confidence ${Math.round(diagnosis.confidence * 100)}% below ${SELF_HEAL_MIN_CONFIDENCE * 100}% — a human decides${attach}`, diagnosis, gate: null, proposalId: null, costUsd }

  // 4. VALIDATE — the model selected; the library decides.
  const sel = validatePlaybookSelection(domain, { playbook: diagnosis.playbook, params: diagnosis.params ?? {} }, new Set(offered))
  if (!sel.ok) {
    await step("playbook_refused", { reason: sel.reason, selected: diagnosis.playbook }, async () => sel, () => ({ ok: false, note: sel.reason }))
    return { kind: "escalate", reason: `model selection refused: ${sel.reason}${attach}`, diagnosis, gate: null, proposalId: null, costUsd }
  }

  // 5. RUN the declared playbook through its executor.
  const spec = SELF_HEAL_PLAYBOOKS[sel.playbook]
  const run = await step(`playbook_${sel.playbook}`, { reason: `${spec.label} — ${diagnosis.diagnosis.slice(0, 200)}`, playbook: sel.playbook, params: sel.params, rail: spec.rail, diagnosis },
    () => executors[sel.playbook]!(svc, i, sel.params).catch((e: Error) => ({ ok: false, outcome: `executor threw: ${e.message}` })),
    (x) => ({ ok: !!x?.ok, note: x?.outcome ?? "no result" }))
  const ok = !!run?.ok
  const outcome = run?.outcome ?? "replayed — already recorded for this attempt"
  const { error: rowErr } = await svc.from("self_heal_events").insert({
    brokerage_id: i.brokerageId, domain: "data_flow", subject, action: `os_health_playbook:${sel.playbook}`,
    outcome: !spec.acts ? "escalated" : ok ? "healed" : "failed",
    detail: { flow: `os_health_${i.detector}`, class: i.class, playbook: sel.playbook, params: sel.params, rail: spec.rail, outcome, diagnosis: diagnosis.diagnosis.slice(0, 500), root_cause: diagnosis.rootCause, confidence: diagnosis.confidence, cost_usd: costUsd, attempt: ctx.playbookAttempts24h + 1 },
  })
  if (rowErr) console.error(`[self-healing] incident row refused for ${subject}: ${rowErr.message}`)
  const ev = await emit({
    event: "os_health.incident", brokerageId: i.brokerageId, entityType: "os_health_incident", entityId: null, source: "cron", auditOnly: true, client: svc,
    dedupeKey: `${subject}:playbook:${sel.playbook}:${ctx.playbookAttempts24h + 1}`, dedupeWindowSec: 86_400,
    metadata: { subject, detector: i.detector, class: i.class, recovery: "playbook", playbook: sel.playbook, ok, outcome, root_cause: diagnosis.rootCause, cost_usd: costUsd },
  })
  if (ev.error) console.error(`[self-healing] event not recorded for ${subject}: ${ev.error}`)
  return { kind: "playbook", playbook: sel.playbook, acts: spec.acts, ok, outcome, diagnosis, costUsd }
}
