/**
 * lib/kernel/strategy-engine.ts — THE STRATEGY ENGINE runtime (wave 107, lane 107E; m725).
 *
 * Three doors over the pure library (lib/kernel/strategy-library.ts):
 *   · selectStrategies(context)      — which strategies apply here, ranked: the tenant's ACTIVE strategies
 *                                      (activated platform versions, adapted; the tenant's own), eligibility
 *                                      judged deterministically on the caller's facts, learned performance
 *                                      through the LAZY 107F seam (absent = "unlearned", never a silent 0).
 *                                      Managers call this instead of inventing a plan: the ISA engage path
 *                                      (app/actions/ai-isa/engage-contact.ts), the Campaign Orchestrator's
 *                                      plan step (lib/agents/campaign-orchestrator.ts kickoff), and the
 *                                      mission controller reads the strategy a mission runs (105B).
 *   · activateStrategy(...)          — a selected strategy becomes a MISSION (lib/kernel/missions.ts — the only
 *                                      writer of missions) owned by the strategy's owner manager, with its
 *                                      participating managers, approval per authority (APPROVAL_REQUIRED when the
 *                                      strategy's rung exceeds the owner's ladder ceiling or the strategy says
 *                                      "always"), and one 105A DELEGATION per step capability another manager owns
 *                                      (lib/kernel/manager-delegation.ts). Idempotent per (subject, strategy key).
 *                                      The activation is a ledger row whose detail.strategy = {key, version, tier}
 *                                      — the key 107F's attribution reads.
 *   · activateLibraryStrategy(...)   — a TENANT activates a PLATFORM version: the version is published to
 *                                      strategy_library (insert-only; digest-verified — the platform version is
 *                                      immutable, a drifted row is refused), the local adaptation (tenant policy
 *                                      `strategy_overrides` + tenant history from the 107F seam) is computed and
 *                                      RECORDED on strategy_activations, superseding the previous activation.
 *
 * TENANT: every door takes the VERIFIED brokerageId (session — app/actions/admin/strategy-library.ts through
 * requireCallerTenant — or the anchored row / the cron). Every read and write is pinned to it. Platform rows
 * carry no tenant and are read-only to tenants (m725 RLS).
 *
 * No `import "server-only"`: the proof (scripts/strategy-engine-guard.ts) drives it through an in-memory client.
 */
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { AppCapability } from "@/lib/agentic-os/app-capability-registry"
import { MIN_AUTHORITY_FOR_RISK, type AuthorityLevel } from "@/lib/ai-isa/persona-tool-policy"
import { capabilityRiskClass } from "@/lib/kernel/mission-controller"
import {
  activeMissionsFor, attachEvidence, createMission, transitionMission,
  MISSION_LIFECYCLE_REASON, type MissionDeps, type MissionRow,
} from "@/lib/kernel/missions"
import { requestDelegation, DELEGATION_WORKERS, type DelegationDeps } from "@/lib/kernel/manager-delegation"
import {
  adaptStrategy, participatingManagers, platformStrategy, rankStrategies, strategyCapabilities, strategyDigest,
  strategyGaps, strategyOwnershipOf, strategyRef, STRATEGY_EVIDENCE_KIND, PLATFORM_STRATEGY_LIBRARY,
  PLATFORM_STRATEGY_LIBRARY_EDITION, STRATEGY_DOMAINS, type OsDomain,
  type RankedStrategy, type StrategyAdaptation, type StrategyCandidate, type StrategyDefinition, type StrategyFacts,
  type StrategyHistory, type StrategyPerformance, type StrategyPolicyOverride, type StrategySubjectType,
} from "@/lib/kernel/strategy-library"

type Client = { from: (table: string) => any }

/** The literal column lists (one read shape each — a column-list variable hides columns from the census). */
const ACTIVATION_COLS = "id, brokerage_id, strategy_key, version, tier, library_id, status, adaptation, adapted_from_digest, activated_by, created_at, updated_at, deactivated_at"
const LIBRARY_COLS = "id, tier, brokerage_id, strategy_key, version, title, definition, definition_digest"

export interface StrategyActivationRow {
  id: string; brokerage_id: string; strategy_key: string; version: number; tier: "platform" | "tenant"; library_id: string | null
  status: "active" | "superseded" | "deactivated"; adaptation: StrategyAdaptation; adapted_from_digest: string
  activated_by: string | null; created_at: string; updated_at: string; deactivated_at: string | null
}

// ─── the 107F seam (lazy; degrades to "unlearned") ────────────────────────────────────────────
export interface StrategyLearningSeam {
  /** Learned performance + the tenant's history vs the platform benchmark, per strategy key. */
  performance: (brokerageId: string, keys: string[], client: Client) => Promise<{ performance: Record<string, StrategyPerformance>; history: Record<string, StrategyHistory>; benchmarks: Record<string, { conversionRate: number | null; sample: number }> }>
}
const learningSeam: Partial<StrategyLearningSeam> = {}
/** @proofSeam lane 107F (strategy learning + network benchmarks) registers its reader here at integration — the
 *  same lazy-seam shape as registerTwinSeam; until then selection reads "unlearned" and the card says so. */
export function registerStrategyLearningSeam(fn: StrategyLearningSeam["performance"]): void { learningSeam.performance = fn }

async function readLearning(brokerageId: string, keys: string[], client: Client): Promise<{ status: "learned" | "unlearned" | "refused"; reason: string | null; data: Awaited<ReturnType<StrategyLearningSeam["performance"]>> | null }> {
  // Wave 107 integration: the default reader IS lib/intelligence/strategy-learning.ts (lazy — no import cycle);
  // registerStrategyLearningSeam stays a @proofSeam injection for the in-memory proof.
  const reader = learningSeam.performance ?? (await import("@/lib/intelligence/strategy-learning")).strategyLearningForSelection
  try { return { status: "learned", reason: null, data: await reader(brokerageId, keys, client) } }
  catch (e) { return { status: "refused", reason: e instanceof Error ? e.message : String(e), data: null } }
}

export interface StrategyEngineDeps {
  now?: () => Date
  ledger?: (ctx: { brokerageId: string; action: string; actor: { type: "user" | "manager" | "system"; id?: string | null }; subject: { type: string; id: string }; reason: string; reasonCode: string; detail: Record<string, unknown> }, client: Client) => Promise<void>
  mission?: MissionDeps
  delegation?: DelegationDeps
}
const defaultLedger: Required<StrategyEngineDeps>["ledger"] = async (ctx, client) => {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  await withActionLedger(
    {
      brokerageId: ctx.brokerageId, action: ctx.action,
      actor: { type: ctx.actor.type, userId: ctx.actor.type === "user" ? ctx.actor.id ?? null : null, managerKey: ctx.actor.type === "manager" ? ctx.actor.id ?? null : null },
      subject: ctx.subject, reasonCode: ctx.reasonCode, reasonDetail: ctx.reason,
      riskClass: "LOW_RISK_WRITE", systemSource: "strategy_engine", detail: ctx.detail,
    },
    async () => ({ status: "executed" as const, outcome: ctx.action }),
    { settle: (r) => ({ status: r.status, outcome: r.outcome }), replay: () => ({ status: "executed" as const, outcome: "replay" }) },
    { client: client as any },
  )
}

async function svcOf(client?: Client): Promise<Client> {
  if (client) return client
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient() as unknown as Client
}

// ─── tenant policy: brokerage_settings.settings.strategy_overrides (versioned key) ────────────
async function readStrategyOverrides(svc: Client, brokerageId: string): Promise<{ overrides: Record<string, StrategyPolicyOverride>; refused: string | null }> {
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { overrides: {}, refused: error.message }
  const raw = (data as { settings?: Record<string, unknown> } | null)?.settings?.strategy_overrides
  return { overrides: raw && typeof raw === "object" ? (raw as Record<string, StrategyPolicyOverride>) : {}, refused: null }
}

// ─── the tenant's active strategies ───────────────────────────────────────────────────────────
async function activeStrategyCandidates(brokerageId: string, client?: Client): Promise<{ candidates: StrategyCandidate[]; activations: StrategyActivationRow[]; readRefused: string | null; skipped: string[] }> {
  const svc = await svcOf(client)
  if (!brokerageId) return { candidates: [], activations: [], readRefused: "no tenant", skipped: [] }
  const { data, error } = await svc.from("strategy_activations").select(ACTIVATION_COLS).eq("brokerage_id", brokerageId).eq("status", "active")
  if (error) return { candidates: [], activations: [], readRefused: error.message, skipped: [] }
  const activations = (data ?? []) as StrategyActivationRow[]
  const candidates: StrategyCandidate[] = [], skipped: string[] = []
  const tenantIds = activations.filter((a) => a.tier === "tenant" && a.library_id).map((a) => a.library_id!)
  const tenantDefs = new Map<string, StrategyDefinition>()
  if (tenantIds.length) {
    const { data: rows, error: e2 } = await svc.from("strategy_library").select(LIBRARY_COLS).eq("brokerage_id", brokerageId).eq("tier", "tenant").in("id", tenantIds)
    if (e2) return { candidates: [], activations, readRefused: e2.message, skipped }
    for (const r of (rows ?? []) as Array<{ id: string; definition: StrategyDefinition }>) tenantDefs.set(r.id, r.definition)
  }
  for (const a of activations) {
    const def = a.tier === "platform" ? platformStrategy(a.strategy_key, a.version) : tenantDefs.get(a.library_id ?? "") ?? null
    if (!def) { skipped.push(`${a.strategy_key}@v${a.version}: definition not found`); continue }
    if (a.tier === "platform" && strategyDigest(def) !== a.adapted_from_digest) { skipped.push(`${a.strategy_key}@v${a.version}: platform digest drifted — refused`); continue }
    candidates.push({ definition: def, adaptation: a.adaptation, activationId: a.id })
  }
  return { candidates, activations, readRefused: null, skipped }
}

// ─── selectStrategies ─────────────────────────────────────────────────────────────────────────
export interface StrategyContext {
  brokerageId: string
  /** Only strategies this manager participates in (null = all). */
  manager?: ManagerKey | null
  /** The subject's facts; null = brokerage scope (a manager's weekly plan — eligibility judged per subject). */
  facts: StrategyFacts | null
}
export interface StrategySelection { ranked: RankedStrategy[]; learning: "learned" | "unlearned" | "refused"; learningReason: string | null; readRefused: string | null; skipped: string[] }

export async function selectStrategies(ctx: StrategyContext, client?: Client): Promise<StrategySelection> {
  const svc = await svcOf(client)
  const act = await activeStrategyCandidates(ctx.brokerageId, svc)
  if (act.readRefused) return { ranked: [], learning: "unlearned", learningReason: null, readRefused: act.readRefused, skipped: act.skipped }
  const keys = [...new Set(act.candidates.map((c) => c.definition.key))]
  const learn = keys.length ? await readLearning(ctx.brokerageId, keys, svc) : { status: "unlearned" as const, reason: "no active strategy", data: null }
  const ranked = rankStrategies(act.candidates, ctx.facts, { manager: ctx.manager ?? null, performance: learn.data?.performance })
  return { ranked, learning: learn.status, learningReason: learn.reason, readRefused: null, skipped: act.skipped }
}

// ─── activateStrategy → mission + delegations ─────────────────────────────────────────────────
/** PURE: the rung the strategy's capabilities need (the ladder's MIN_AUTHORITY_FOR_RISK over each capability's
    risk class — the controller's own rule). */
function requiredAuthority(s: Pick<StrategyDefinition, "steps">): AuthorityLevel {
  let req: AuthorityLevel = 0
  for (const c of strategyCapabilities(s)) { const m = MIN_AUTHORITY_FOR_RISK[capabilityRiskClass(c)]; if (m !== null && m > req) req = m }
  return req
}

export interface ActivateStrategyInput {
  brokerageId: string
  candidate: StrategyCandidate
  subject: { type: StrategySubjectType; id: string }
  actor?: { type: "user" | "manager" | "system"; id?: string | null }
  createdBy?: string | null
}
export type ActivateStrategyResult =
  | { ok: true; duplicate: boolean; mission: MissionRow; needsApproval: boolean; delegations: Array<{ manager: ManagerKey; capability: AppCapability; ok: boolean; reason?: string; id?: string }>; deferred: Array<{ manager: ManagerKey; capability: AppCapability; why: string }>; gaps: Array<{ manager: ManagerKey; gap: string }> }
  | { ok: false; reason: string }

export async function activateStrategy(input: ActivateStrategyInput, client?: Client, deps: StrategyEngineDeps = {}): Promise<ActivateStrategyResult> {
  const svc = await svcOf(client)
  const now = (deps.now ?? (() => new Date()))()
  const def = input.candidate.definition, adapt = input.candidate.adaptation
  if (!input.brokerageId) return { ok: false, reason: "no_tenant" }
  if (!def.eligibility.subjectTypes.includes(input.subject.type)) return { ok: false, reason: `subject_type_not_eligible:${input.subject.type}` }
  const ref = strategyRef(def)

  // Idempotent per (subject, strategy key): an open mission already running this strategy is returned.
  const open = await activeMissionsFor(input.brokerageId, { subject: input.subject }, svc)
  if (open.readRefused) return { ok: false, reason: `read_refused:${open.readRefused}` }
  const running = open.active.find((m) => strategyOwnershipOf(m.evidence as unknown as Array<Record<string, unknown>>)?.ref.startsWith(`${def.key}@`))
  if (running) return { ok: true, duplicate: true, mission: running, needsApproval: running.state === "APPROVAL_REQUIRED", delegations: [], deferred: [], gaps: strategyGaps(def) }

  const managers = participatingManagers(def)
  const actor = input.actor ?? { type: "manager" as const, id: def.ownerManager }
  const created = await createMission({
    brokerageId: input.brokerageId, objective: `${def.title}: ${def.objective}`, missionType: def.missionType,
    ownerManager: def.ownerManager, participatingManagers: managers, subject: input.subject,
    successCriteria: def.exitCriteria.map((c) => ({ ...c })), budget: { usd: adapt.budget.usd, tokens: adapt.budget.tokens ?? null, on_exhausted: "APPROVAL_REQUIRED" },
    deadline: new Date(now.getTime() + adapt.timing.horizonDays * 86_400_000).toISOString(),
    createdBy: input.createdBy ?? null, actor, initialState: "PLANNING",
  }, svc, deps.mission)
  if (!created.ok) return { ok: false, reason: `mission:${created.reason}` }
  let mission = created.mission

  // APPROVAL PER AUTHORITY: the effective ceiling is the lower of the owner's ladder rung and the adapted
  // recommended rung; a strategy needing more (or marked "always") waits for a human.
  const required = requiredAuthority(def)
  const ceiling = Math.min(mission.authority_ceiling, adapt.authority.recommended) as AuthorityLevel
  const needsApproval = adapt.authority.approval === "always" || required > ceiling
  const caps = strategyCapabilities(def), gaps = strategyGaps(def)
  const ev = await attachEvidence({ brokerageId: input.brokerageId, missionId: mission.id, actor, evidence: {
    kind: STRATEGY_EVIDENCE_KIND, ref, tier: def.tier, digest: adapt.digest, owner: def.ownerManager, managers, capabilities: caps,
    activation_id: input.candidate.activationId, required_authority: required, effective_ceiling: ceiling, needs_approval: needsApproval,
    adaptation_changes: adapt.changes, gaps,
  } }, svc, deps.mission)
  if (!ev.ok) return { ok: false, reason: `evidence:${ev.reason}` }
  const moved = await transitionMission({ brokerageId: input.brokerageId, missionId: mission.id, to: needsApproval ? "APPROVAL_REQUIRED" : "ACTIVE", actor,
    reason: needsApproval ? `strategy ${ref} needs rung ${required} (ceiling ${ceiling}${adapt.authority.approval === "always" ? ", approval always" : ""}) — a human approves` : `strategy ${ref} within authority (needs ${required}, ceiling ${ceiling})` }, svc, deps.mission)
  if (!moved.ok) return { ok: false, reason: `transition:${moved.reason}` }
  mission = moved.mission

  // LAW 5 + the 107F hook: the activation is a ledger row naming the strategy.
  await (deps.ledger ?? defaultLedger)({ brokerageId: input.brokerageId, action: "strategy.activate", actor, subject: { type: input.subject.type, id: input.subject.id }, reasonCode: MISSION_LIFECYCLE_REASON,
    reason: `${ref} → mission ${mission.id} (${mission.state})`,
    detail: { strategy: { key: def.key, version: def.version, tier: def.tier, ref }, mission_id: mission.id, activation_id: input.candidate.activationId, needs_approval: needsApproval, required_authority: required } }, svc)

  // ONE DELEGATION PER STEP CAPABILITY another manager owns (105A). The owner's own steps are its job;
  // a capability above the effective ceiling waits for the approval (deferred, recorded).
  const delegations: Array<{ manager: ManagerKey; capability: AppCapability; ok: boolean; reason?: string; id?: string }> = []
  const deferred: Array<{ manager: ManagerKey; capability: AppCapability; why: string }> = []
  for (const [i, step] of def.steps.entries()) {
    const ownStep = step.manager === def.ownerManager
    for (const capability of step.capabilities) {
      // The owner's own step is the mission itself — EXCEPT a capability with a worker on its survivor
      // (wave 108: recruit outreach, the lender handoff), which becomes the owner's WORK ORDER on the
      // same delegation machine (a human accepts it; the transitions leave the evidence).
      if (ownStep && !DELEGATION_WORKERS[capability]) continue
      const rung = (MIN_AUTHORITY_FOR_RISK[capabilityRiskClass(capability)] ?? 6) as AuthorityLevel
      if (rung > ceiling) { deferred.push({ manager: step.manager, capability, why: `needs rung ${rung} > ceiling ${ceiling} — requested once the mission is approved` }); continue }
      const r = await requestDelegation({
        brokerageId: input.brokerageId, missionId: mission.id, requestingManager: def.ownerManager, assignedManager: step.manager, capability,
        objective: `${def.title} — step ${i + 1}: ${step.purpose}`, authority: rung, deadline: mission.deadline, ownerWorkOrder: ownStep,
        inputEntities: { subject_type: input.subject.type, subject_id: input.subject.id, strategy: ref, step: i + 1, playbooks: step.playbooks, ...(input.subject.type === "contact" ? { contactId: input.subject.id } : {}), ...(input.subject.type === "listing" ? { listingId: input.subject.id } : {}) },
        actor: { type: "manager", id: def.ownerManager },
      }, svc, { ...(deps.delegation ?? {}), mission: deps.delegation?.mission ?? deps.mission })
      delegations.push(r.ok ? { manager: step.manager, capability, ok: true, id: r.delegation.id } : { manager: step.manager, capability, ok: false, reason: r.reason })
      if (!r.ok) console.error(`[strategy-engine] ${ref} step ${i + 1} delegation ${capability} → ${step.manager} refused: ${r.reason}`)
    }
  }
  return { ok: true, duplicate: false, mission, needsApproval, delegations, deferred, gaps }
}

// ─── the platform library + a tenant's activation of a version ────────────────────────────────
/** Publish a platform version to strategy_library (insert-only) and return its row id. A row whose digest
 *  differs from the code version is REFUSED — a published version is immutable (m725 trigger holds it live). */
async function ensurePlatformVersionPublished(svc: Client, def: StrategyDefinition): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const digest = strategyDigest(def)
  const read = async () => svc.from("strategy_library").select(LIBRARY_COLS).eq("tier", "platform").eq("strategy_key", def.key).eq("version", def.version).maybeSingle()
  let { data, error } = await read()
  if (error) return { ok: false, reason: `read_refused:${error.message}` }
  if (!data) {
    const ins = await svc.from("strategy_library").insert({ tier: "platform", brokerage_id: null, strategy_key: def.key, version: def.version, title: def.title, definition: def, definition_digest: digest }).select("id")
    // A concurrent publisher may have won the unique key — re-read rather than trust the insert error.
    if (ins.error) { ({ data, error } = await read()); if (error || !data) return { ok: false, reason: `publish_refused:${ins.error.message}` } }
    else return { ok: true, id: (ins.data as Array<{ id: string }>)[0].id }
  }
  const row = data as { id: string; definition_digest: string }
  if (row.definition_digest !== digest) return { ok: false, reason: `platform_version_drift:${strategyRef(def)}:${row.definition_digest}≠${digest}` }
  return { ok: true, id: row.id }
}

export interface ActivateLibraryInput { brokerageId: string; key: string; version?: number; actorUserId: string }
export type ActivateLibraryResult = { ok: true; activation: StrategyActivationRow; superseded: number; duplicate: boolean } | { ok: false; reason: string }

export async function activateLibraryStrategy(input: ActivateLibraryInput, client?: Client, deps: StrategyEngineDeps = {}): Promise<ActivateLibraryResult> {
  const svc = await svcOf(client)
  if (!input.brokerageId) return { ok: false, reason: "no_tenant" }
  const def = platformStrategy(input.key, input.version)
  if (!def) return { ok: false, reason: `unknown_platform_strategy:${input.key}${input.version ? `@v${input.version}` : ""}` }
  const pub = await ensurePlatformVersionPublished(svc, def)
  if (!pub.ok) return { ok: false, reason: pub.reason }

  const pol = await readStrategyOverrides(svc, input.brokerageId)
  if (pol.refused) return { ok: false, reason: `policy_read_refused:${pol.refused}` }
  const learn = await readLearning(input.brokerageId, [def.key], svc)
  const adaptation = adaptStrategy(def, pol.overrides[def.key] ?? null, learn.data?.history?.[def.key] ?? null)

  const { data: prior, error: priorErr } = await svc.from("strategy_activations").select(ACTIVATION_COLS).eq("brokerage_id", input.brokerageId).eq("strategy_key", def.key).eq("status", "active")
  if (priorErr) return { ok: false, reason: `read_refused:${priorErr.message}` }
  const same = ((prior ?? []) as StrategyActivationRow[]).find((p) => p.version === def.version && JSON.stringify(p.adaptation) === JSON.stringify(adaptation))
  if (same) return { ok: true, activation: same, superseded: 0, duplicate: true }

  let superseded = 0
  if ((prior ?? []).length) {
    const { data: sup, error: supErr } = await svc.from("strategy_activations").update({ status: "superseded", deactivated_at: new Date().toISOString() })
      .eq("brokerage_id", input.brokerageId).eq("strategy_key", def.key).eq("status", "active").select("id")
    if (supErr) return { ok: false, reason: `supersede_refused:${supErr.message}` }
    superseded = (sup ?? []).length
    if (superseded !== (prior ?? []).length) return { ok: false, reason: `supersede_mismatch:${superseded}/${(prior ?? []).length}` }
  }
  const { data: row, error } = await svc.from("strategy_activations").insert({
    brokerage_id: input.brokerageId, strategy_key: def.key, version: def.version, tier: "platform", library_id: pub.id,
    status: "active", adaptation, adapted_from_digest: adaptation.digest, activated_by: input.actorUserId,
  }).select(ACTIVATION_COLS).single()
  if (error || !row) return { ok: false, reason: `insert_refused:${error?.message ?? "no row"}` }
  const activation = row as StrategyActivationRow
  await (deps.ledger ?? defaultLedger)({ brokerageId: input.brokerageId, action: "strategy.library.activate", actor: { type: "user", id: input.actorUserId }, subject: { type: "strategy_activation", id: activation.id },
    reasonCode: "HUMAN_REQUESTED", reason: `activated ${strategyRef(def)} (${adaptation.changes.length} local adaptation${adaptation.changes.length === 1 ? "" : "s"}; superseded ${superseded})`,
    detail: { strategy: { key: def.key, version: def.version, tier: "platform", ref: strategyRef(def) }, adaptation_changes: adaptation.changes, learning: learn.status, superseded } }, svc)
  return { ok: true, activation, superseded, duplicate: false }
}

/** The library card read: every platform version with the tenant's activation (if any), benchmark (107F
 *  seam) and recommended authority. */
export interface StrategyLibraryEntry {
  key: string; version: number; title: string; label: string; objective: string; audience: string; marketSuitability: readonly string[]
  averageCostUsd: number; recommendedAuthority: AuthorityLevel; approval: "per_authority" | "always"; managers: ManagerKey[]; capabilities: AppCapability[]
  gaps: Array<{ manager: ManagerKey; gap: string }>; latest: boolean
  /** Wave 137E: the OS domains the strategy serves (tagged beside the definition — never part of its digest). */
  domains: readonly OsDomain[]
  benchmark: { conversionRate: number | null; sample: number } | null
  activation: { id: string; version: number; changes: StrategyAdaptation["changes"]; since: string } | null
}
export async function listStrategyLibrary(brokerageId: string, client?: Client): Promise<{ entries: StrategyLibraryEntry[]; edition: number; learning: "learned" | "unlearned" | "refused"; learningReason: string | null; readRefused: string | null }> {
  const svc = await svcOf(client)
  const { data, error } = await svc.from("strategy_activations").select(ACTIVATION_COLS).eq("brokerage_id", brokerageId).eq("status", "active")
  const acts = error ? [] : ((data ?? []) as StrategyActivationRow[])
  const keys = [...new Set(PLATFORM_STRATEGY_LIBRARY.map((s) => s.key))]
  const learn = await readLearning(brokerageId, keys, svc)
  const entries = PLATFORM_STRATEGY_LIBRARY.map((s): StrategyLibraryEntry => {
    const a = acts.find((x) => x.strategy_key === s.key && x.tier === "platform")
    return {
      key: s.key, version: s.version, title: s.title, label: `${s.title} v${s.version}`, objective: s.objective, audience: s.audience, marketSuitability: s.marketSuitability,
      averageCostUsd: s.averageCostUsd, recommendedAuthority: s.authority.recommended, approval: s.authority.approval,
      managers: participatingManagers(s), capabilities: strategyCapabilities(s), gaps: strategyGaps(s),
      latest: platformStrategy(s.key)?.version === s.version, domains: STRATEGY_DOMAINS[s.key] ?? [],
      benchmark: learn.data?.benchmarks?.[s.key] ?? null,
      activation: a ? { id: a.id, version: a.version, changes: a.adaptation?.changes ?? [], since: a.created_at } : null,
    }
  })
  return { entries, edition: PLATFORM_STRATEGY_LIBRARY_EDITION, learning: learn.status, learningReason: learn.reason, readRefused: error ? error.message : null }
}
