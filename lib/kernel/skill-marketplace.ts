/**
 * lib/kernel/skill-marketplace.ts — THE SKILL MARKETPLACE RUNTIME + THE ONE SKILL RUN PATH (wave 108, lane 108A).
 *
 * Owner: "approved third-party / tenant skills run through the kernel — not unrestricted plugins: policy,
 * authority, capability access, usage metering, audit, evaluation."
 *
 * A marketplace skill is a DATA declaration (lib/kernel/skill-registry.ts SkillDeclaration) in m727
 * skill_marketplace_listings. Lifecycle: submitted → evaluated (its evaluation suite passed) → approved →
 * published → revoked; a failed evaluation lands `rejected`. Platform staff decide third-party / platform
 * listings; a tenant admin decides its OWN tenant's listings (canDecideSkillListing).
 *
 * runSkill is the ONE path a skill — built-in or marketplace — runs on, and it composes survivors only:
 *   tenant isolation   the verified brokerageId (never a body); a tenant listing runs only inside its tenant
 *   evaluation         an unpublished / unevaluated / digest-drifted listing is NOT runnable (fails closed)
 *   entitlement        mayUseAndAfford ("app.access" or "feature.use" + the declared feature_flags key)
 *   metering           mayUseAndAfford on the declared cost lane ("ai.generate" tokens / "comms.send" USD) and
 *                      agent_action_ledger.cost_usd at settle
 *   authority          resolveAgentAuthorityLevel(manager_owner) ≥ authority_requirement (the ladder)
 *   policy + audit     withActionLedger (risk_class, policy_ref authority_level:<owner>, who / why / cost)
 *   capability access  requestDelegation — the owning manager is ASKED for each capability (capability ownership,
 *                      review, entitlement per lane, delegation ledger + event) — never a direct call, never code.
 * Writes use the service client the caller passes (gate first — app/actions/skill-marketplace.ts).
 */
import { createHash } from "node:crypto"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { AuthorityLevel } from "@/lib/ai-isa/persona-tool-policy"
import type { AppCapability } from "@/lib/agentic-os/app-capability-registry"
import {
  BASE_PLAN_ENTITLEMENT, SKILL_EVALUATORS, builtinSkill, canDecideSkillListing, canSkillListingTransition,
  isSkillListingRunnableBy, knownEvaluationSuites, skillRef, stableSkillJson, validateSkillDeclaration, validateSkillInputs,
  type SkillApprover, type SkillDeclaration, type SkillEvaluationEvidence, type SkillListingStatus, type SkillPublisher,
} from "@/lib/kernel/skill-registry"

type Client = { from: (table: string) => any }

const LISTING_COLS = "id, skill_id, publisher, publisher_name, brokerage_id, version, declaration, declaration_digest, status, evaluation_evidence, evaluated_at, submitted_by, approved_by, approved_at, published_at, revoked_at, revoked_reason, created_at, updated_at"

export interface SkillListingRow {
  id: string
  skill_id: string
  publisher: SkillPublisher
  publisher_name: string | null
  brokerage_id: string | null
  version: number
  declaration: SkillDeclaration
  declaration_digest: string
  status: SkillListingStatus
  evaluation_evidence: SkillEvaluationEvidence | null
  evaluated_at: string | null
  submitted_by: string | null
  approved_by: string | null
  approved_at: string | null
  published_at: string | null
  revoked_at: string | null
  revoked_reason: string | null
}

export type ListingResult = { ok: true; listing: SkillListingRow } | { ok: false; reason: string; errors?: string[] }

interface LedgerInput {
  brokerageId: string
  action: string
  actor: { type: "manager" | "user" | "system"; userId?: string | null; managerKey?: string | null }
  subjectRef: string
  subjectId?: string | null
  riskClass: string
  policyKey?: string | null
  reasonDetail: string
  detail: Record<string, unknown>
  costUsd: number | null
}

/** Test seams — every default is THE survivor, lazily imported. Production never passes deps. */
export interface SkillMarketplaceDeps {
  now?: () => Date
  afford?: (input: { brokerageId: string; capability: string; estCostUsd?: number; estTokens?: number; featureKey?: string }, client: Client) => Promise<{ allowed: boolean; reason: string }>
  authority?: (brokerageId: string, manager: ManagerKey, client: Client) => Promise<AuthorityLevel>
  /** Runs `act` inside the ledger claim; returns what `act` returned (or null on a non-acting replay). */
  ledger?: <T>(input: LedgerInput, act: () => Promise<T>, client: Client) => Promise<T | null>
  delegate?: (input: { brokerageId: string; requestingManager: ManagerKey; assignedManager: ManagerKey; capability: AppCapability; objective: string; inputEntities: Record<string, unknown>; authority: AuthorityLevel; budget: { usd?: number; tokens?: number }; missionId?: string | null }, client: Client) => Promise<{ ok: boolean; reason?: string; delegationId?: string }>
}

const defaultDeps: Required<SkillMarketplaceDeps> = {
  now: () => new Date(),
  // Default afford reads plan + budget through THE kernel resolver (lib/billing/billing-access.ts).
  afford: async (i, client) => {
    const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
    const d = await mayUseAndAfford({
      brokerageId: i.brokerageId, capability: i.capability, estCostUsd: i.estCostUsd, estTokens: i.estTokens, client,
      // A tenant-gated rail: the feature is asked for the TENANT (canAccessFeature's tenant contract).
      feature: i.featureKey ? { userId: i.brokerageId, featureKey: i.featureKey, client } : undefined,
    })
    return { allowed: d.allowed, reason: d.reason }
  },
  authority: async (brokerageId, manager, client) => {
    const { resolveAgentAuthorityLevel } = await import("@/lib/managers/autonomy-gate")
    return resolveAgentAuthorityLevel(brokerageId, manager, client as any)
  },
  ledger: async (input, act, client) => {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    let out: unknown = null
    await withActionLedger(
      {
        brokerageId: input.brokerageId, action: input.action,
        actor: { type: input.actor.type, userId: input.actor.userId ?? null, managerKey: input.actor.managerKey ?? null },
        subject: { type: "skill", id: input.subjectId ?? null, ref: input.subjectRef },
        reasonDetail: input.reasonDetail, riskClass: input.riskClass, policyKey: input.policyKey ?? null,
        systemSource: "skill-marketplace", detail: input.detail,
      },
      async () => {
        out = await act()
        // A refused composition is settled FAILED with its reason — never recorded as executed.
        const refused = out && typeof out === "object" && (out as { ok?: unknown }).ok === false
        return { status: refused ? ("failed" as const) : ("executed" as const), outcome: refused ? String((out as { reason?: unknown }).reason ?? "refused") : input.action }
      },
      { settle: (r) => ({ status: r.status, outcome: r.outcome, costUsd: r.status === "executed" ? input.costUsd : null }), replay: () => ({ status: "executed" as const, outcome: "replay" }) },
      { client },
    )
    return out as any
  },
  delegate: async (i, client) => {
    const { requestDelegation } = await import("@/lib/kernel/manager-delegation")
    const r = await requestDelegation({ ...i, actor: { type: "manager", id: i.requestingManager } }, client)
    return r.ok ? { ok: true, delegationId: r.delegation.id } : { ok: false, reason: r.reason }
  },
}

function withDeps(deps: SkillMarketplaceDeps): Required<SkillMarketplaceDeps> { return { ...defaultDeps, ...deps } }

/** PURE — the declaration digest the listing stores and every later read re-verifies.
 *  @proofSeam the proof asserts the stored digest equals this over the submitted declaration */
export function skillDeclarationDigest(d: SkillDeclaration): string {
  return createHash("sha256").update(stableSkillJson(d)).digest("hex")
}

async function getListing(svc: Client, listingId: string): Promise<SkillListingRow | null> {
  const { data, error } = await svc.from("skill_marketplace_listings").select(LISTING_COLS).eq("id", listingId).maybeSingle()
  if (error) { console.error(`[skill-marketplace] listing read refused: ${error.message}`); return null }
  return (data as SkillListingRow | null) ?? null
}

/** The ledger tenant for a lifecycle move: the listing's own tenant, else the acting tenant (platform moves
 *  carry the deciding staff's context only when they have one — a null tenant is ledgered as unledgered). */
function lifecycleTenant(listing: SkillListingRow, actorBrokerageId: string | null): string | null {
  return listing.brokerage_id ?? actorBrokerageId
}

// ─── submit + evaluate ───────────────────────────────────────────────────────────────────────
export interface SubmitSkillInput {
  publisher: SkillPublisher
  /** VERIFIED tenant (session) for a tenant-authored listing; null for platform / third-party. */
  brokerageId: string | null
  submittedBy: string | null
  publisherName?: string | null
  declaration: SkillDeclaration
}

export async function submitSkillListing(input: SubmitSkillInput, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<ListingResult> {
  const d = withDeps(deps)
  if (input.publisher === "tenant" && !input.brokerageId) return { ok: false, reason: "no_tenant" }
  if (input.publisher !== "tenant" && input.brokerageId) return { ok: false, reason: "tenant_id_on_global_listing" }
  if (builtinSkill(input.declaration?.name)) return { ok: false, reason: `name_reserved_by_builtin:${input.declaration.name}` }
  const v = validateSkillDeclaration(input.declaration, { knownEvaluationSuites: new Set(Object.keys(SKILL_EVALUATORS)) })
  if (!v.ok) return { ok: false, reason: "declaration_invalid", errors: v.errors }
  const { data, error } = await svc.from("skill_marketplace_listings").insert({
    skill_id: input.declaration.name, publisher: input.publisher, publisher_name: input.publisherName ?? null,
    brokerage_id: input.brokerageId, version: input.declaration.version, declaration: input.declaration,
    declaration_digest: skillDeclarationDigest(input.declaration), status: "submitted", submitted_by: input.submittedBy,
  }).select(LISTING_COLS).single()
  if (error || !data) return { ok: false, reason: `insert_refused:${error?.message ?? "no row"}` }
  const listing = data as SkillListingRow
  const tenant = lifecycleTenant(listing, input.brokerageId)
  if (tenant) await d.ledger({ brokerageId: tenant, action: "skill.listing.submit", actor: { type: "user", userId: input.submittedBy }, subjectRef: skillRef(listing.declaration), subjectId: listing.id, riskClass: "LOW_RISK_WRITE", reasonDetail: `submitted ${listing.publisher} skill ${skillRef(listing.declaration)}`, detail: { listing_id: listing.id, publisher: listing.publisher }, costUsd: null }, async () => null, svc)
  return { ok: true, listing }
}

/** Status move — the ONE writer of `status` (compare-and-set on the old status; the returned rows are counted). */
async function moveListing(svc: Client, listing: SkillListingRow, to: SkillListingStatus, patch: Record<string, unknown>): Promise<ListingResult> {
  if (!canSkillListingTransition(listing.status, to)) return { ok: false, reason: `invalid_transition:${listing.status}->${to}` }
  const { data, error } = await svc.from("skill_marketplace_listings").update({ ...patch, status: to }).eq("id", listing.id).eq("status", listing.status).select(LISTING_COLS)
  if (error) return { ok: false, reason: `update_refused:${error.message}` }
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "raced:status_moved_under_us" }
  return { ok: true, listing: data[0] as SkillListingRow }
}

/** Runs the declared evaluation suite (platform-owned evaluator) — passed → evaluated, failed → rejected. */
export async function evaluateSkillListing(input: { listingId: string; actorBrokerageId: string | null }, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<ListingResult> {
  const d = withDeps(deps)
  const listing = await getListing(svc, input.listingId)
  if (!listing) return { ok: false, reason: "not_found" }
  if (listing.publisher === "tenant" && listing.brokerage_id !== input.actorBrokerageId) return { ok: false, reason: "not_found" }
  if (skillDeclarationDigest(listing.declaration) !== listing.declaration_digest) return { ok: false, reason: "digest_mismatch" }
  const evaluator = SKILL_EVALUATORS[listing.declaration.evaluation_suite]
  if (!evaluator) return { ok: false, reason: `no_evaluation_suite:${listing.declaration.evaluation_suite}` }
  const evidence = evaluator(listing.declaration)
  const moved = await moveListing(svc, listing, evidence.passed ? "evaluated" : "rejected", { evaluation_evidence: evidence, evaluated_at: d.now().toISOString() })
  const tenant = lifecycleTenant(listing, input.actorBrokerageId)
  if (moved.ok && tenant) await d.ledger({ brokerageId: tenant, action: "skill.listing.evaluate", actor: { type: "system" }, subjectRef: skillRef(listing.declaration), subjectId: listing.id, riskClass: "READ", reasonDetail: `${evidence.suite} ${evidence.passed ? "passed" : "failed"}`, detail: { listing_id: listing.id, evidence }, costUsd: null }, async () => null, svc)
  return moved
}

// ─── decide: approve / publish / revoke ──────────────────────────────────────────────────────
export type SkillDecision = "approve" | "publish" | "revoke"

export async function decideSkillListing(input: { listingId: string; decision: SkillDecision; actor: SkillApprover & { userId: string | null }; reason?: string | null }, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<ListingResult> {
  const d = withDeps(deps)
  const listing = await getListing(svc, input.listingId)
  if (!listing) return { ok: false, reason: "not_found" }
  // Tenant isolation: another tenant's listing reads as absent, not as forbidden.
  if (listing.publisher === "tenant" && listing.brokerage_id !== input.actor.brokerageId && !input.actor.isPlatformStaff) return { ok: false, reason: "not_found" }
  if (!canDecideSkillListing(listing, input.actor)) return { ok: false, reason: listing.publisher === "tenant" ? "tenant_admin_of_this_tenant_only" : "platform_staff_only" }
  if (skillDeclarationDigest(listing.declaration) !== listing.declaration_digest) return { ok: false, reason: "digest_mismatch" }
  const now = d.now().toISOString()
  let moved: ListingResult
  if (input.decision === "approve") {
    // Evaluation BEFORE approval: only an evaluated listing whose evidence passed may be approved.
    if (listing.status !== "evaluated" || !listing.evaluation_evidence?.passed) return { ok: false, reason: "evaluation_not_passed" }
    moved = await moveListing(svc, listing, "approved", { approved_by: input.actor.userId, approved_at: now })
  } else if (input.decision === "publish") {
    moved = await moveListing(svc, listing, "published", { published_at: now })
  } else {
    if (!input.reason?.trim()) return { ok: false, reason: "revoke_reason_required" }
    moved = await moveListing(svc, listing, "revoked", { revoked_at: now, revoked_reason: input.reason.trim() })
  }
  const tenant = lifecycleTenant(listing, input.actor.brokerageId)
  if (moved.ok && tenant) await d.ledger({ brokerageId: tenant, action: `skill.listing.${input.decision}`, actor: { type: "user", userId: input.actor.userId }, subjectRef: skillRef(listing.declaration), subjectId: listing.id, riskClass: "LOW_RISK_WRITE", reasonDetail: `${input.decision} ${listing.publisher} skill${input.reason ? `: ${input.reason}` : ""}`, detail: { listing_id: listing.id, from_status: listing.status, to_status: moved.listing.status, approver: input.actor.isPlatformStaff ? "platform_staff" : "tenant_admin" }, costUsd: null }, async () => null, svc)
  return moved
}

// ─── reads ────────────────────────────────────────────────────────────────────────────────────
/** Marketplace listings this tenant can see: every published global listing + all of its own. */
export async function listVisibleSkillListings(brokerageId: string, svc: Client): Promise<{ listings: SkillListingRow[]; readRefused: string | null }> {
  const [globalRes, ownRes] = await Promise.all([
    svc.from("skill_marketplace_listings").select(LISTING_COLS).in("publisher", ["platform", "third_party"]).eq("status", "published").order("skill_id", { ascending: true }),
    svc.from("skill_marketplace_listings").select(LISTING_COLS).eq("publisher", "tenant").eq("brokerage_id", brokerageId).order("created_at", { ascending: false }),
  ])
  const refused = globalRes.error?.message ?? ownRes.error?.message ?? null
  return { listings: [...((globalRes.data ?? []) as SkillListingRow[]), ...((ownRes.data ?? []) as SkillListingRow[])], readRefused: refused }
}

/** The platform approval queue: every third-party / platform listing, any status (platform staff only — the
 *  caller gates). */
export async function listPlatformSkillListings(svc: Client): Promise<{ listings: SkillListingRow[]; readRefused: string | null }> {
  const { data, error } = await svc.from("skill_marketplace_listings").select(LISTING_COLS).in("publisher", ["platform", "third_party"]).order("created_at", { ascending: false })
  return { listings: (data ?? []) as SkillListingRow[], readRefused: error?.message ?? null }
}

export type RunnableSkill =
  | { ok: true; declaration: SkillDeclaration; source: "builtin" | "marketplace"; listingId: string | null; publisher: SkillPublisher }
  | { ok: false; reason: string }

/** A built-in skill, or the highest PUBLISHED marketplace version visible to this tenant whose digest and
 *  evaluation evidence still hold. Anything else is not runnable (fails closed). runSkill is its caller.
 *  @proofSeam the proof asserts cross-tenant visibility of a published third-party listing directly */
export async function resolveRunnableSkill(brokerageId: string, skillName: string, svc: Client): Promise<RunnableSkill> {
  const builtin = builtinSkill(skillName)
  if (builtin) return { ok: true, declaration: builtin, source: "builtin", listingId: null, publisher: "platform" }
  const { data, error } = await svc.from("skill_marketplace_listings").select(LISTING_COLS).eq("skill_id", skillName).order("version", { ascending: false })
  if (error) return { ok: false, reason: `read_refused:${error.message}` }
  const rows = (data ?? []) as SkillListingRow[]
  const visible = rows.filter((r) => r.publisher !== "tenant" || r.brokerage_id === brokerageId)
  if (!visible.length) return { ok: false, reason: "unknown_skill" }
  const runnable = visible.find((r) => isSkillListingRunnableBy(r, brokerageId))
  if (!runnable) return { ok: false, reason: `not_published:${visible[0].status}` }
  if (skillDeclarationDigest(runnable.declaration) !== runnable.declaration_digest) return { ok: false, reason: "digest_mismatch" }
  if (!runnable.evaluation_evidence?.passed) return { ok: false, reason: "evaluation_not_passed" }
  const v = validateSkillDeclaration(runnable.declaration, { knownEvaluationSuites: knownEvaluationSuites() })
  if (!v.ok) return { ok: false, reason: `declaration_invalid:${v.errors[0]}` }
  return { ok: true, declaration: runnable.declaration, source: "marketplace", listingId: runnable.id, publisher: runnable.publisher }
}

// ─── run ──────────────────────────────────────────────────────────────────────────────────────
export interface RunSkillInput {
  /** VERIFIED tenant — session / event / the anchored row. Never a request body. */
  brokerageId: string
  skill: string
  /** The manager asking for the skill; the skill's manager_owner is asked for each capability. */
  requestingManager: ManagerKey
  inputs: Record<string, unknown>
  objective: string
  missionId?: string | null
}

export type RunSkillResult =
  | { ok: true; skill: string; source: "builtin" | "marketplace"; delegationIds: string[]; costUsd: number }
  | { ok: false; reason: string; errors?: string[] }

export async function runSkill(input: RunSkillInput, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<RunSkillResult> {
  const d = withDeps(deps)
  if (!input.brokerageId) return { ok: false, reason: "no_tenant" }
  if (!input.objective?.trim()) return { ok: false, reason: "objective_required" }
  const resolved = await resolveRunnableSkill(input.brokerageId, input.skill, svc)
  if (!resolved.ok) return { ok: false, reason: `skill_not_runnable:${resolved.reason}` }
  const skill = resolved.declaration
  if (input.requestingManager === skill.manager_owner) return { ok: false, reason: "self_run:the_owner_runs_its_capabilities_directly" }
  const inputErrors = validateSkillInputs(skill.inputs, input.inputs)
  if (inputErrors.length) return { ok: false, reason: "inputs_invalid", errors: inputErrors }

  // ENTITLEMENT — the plan (fail closed: a refused answer is a refusal).
  const ent = skill.tenant_entitlement === BASE_PLAN_ENTITLEMENT
    ? await d.afford({ brokerageId: input.brokerageId, capability: "app.access" }, svc)
    : await d.afford({ brokerageId: input.brokerageId, capability: "feature.use", featureKey: skill.tenant_entitlement }, svc)
  if (!ent.allowed) return { ok: false, reason: `entitlement:${skill.tenant_entitlement}:${ent.reason}` }
  // METERING — the declared cost lane.
  if (skill.cost_estimate.budget !== "none") {
    const lane = skill.cost_estimate.budget === "ai_tokens"
      ? await d.afford({ brokerageId: input.brokerageId, capability: "ai.generate", estTokens: skill.cost_estimate.tokens }, svc)
      : await d.afford({ brokerageId: input.brokerageId, capability: "comms.send", estCostUsd: skill.cost_estimate.usd }, svc)
    if (!lane.allowed) return { ok: false, reason: `budget:${skill.cost_estimate.budget}:${lane.reason}` }
  }
  // AUTHORITY — the owner's ladder rung for this tenant.
  const rung = await d.authority(input.brokerageId, skill.manager_owner, svc)
  if (rung < skill.authority_requirement) return { ok: false, reason: `authority:${rung}<${skill.authority_requirement}` }

  // AUDIT + CAPABILITY ACCESS — one ledger row for the skill run; one delegation per capability inside it.
  const ref = skillRef(skill)
  const delegated = await d.ledger(
    {
      brokerageId: input.brokerageId, action: "skill.manager_skill.run", actor: { type: "manager", managerKey: input.requestingManager },
      subjectRef: ref, subjectId: resolved.listingId, riskClass: skill.risk_class, policyKey: `authority_level:${skill.manager_owner}`,
      reasonDetail: `${input.requestingManager} runs ${ref} (${resolved.source}) via ${skill.manager_owner}: ${input.objective.trim()}`.slice(0, 900),
      detail: { skill: skill.name, version: skill.version, source: resolved.source, publisher: resolved.publisher, listing_id: resolved.listingId, capabilities: skill.required_capabilities, entitlement: skill.tenant_entitlement, cost_estimate: skill.cost_estimate, authority_requirement: skill.authority_requirement, evaluation_suite: skill.evaluation_suite, mission_id: input.missionId ?? null },
      costUsd: skill.cost_estimate.usd,
    },
    async () => {
      const ids: string[] = []
      for (const capability of skill.required_capabilities) {
        const r = await d.delegate({
          brokerageId: input.brokerageId, requestingManager: input.requestingManager, assignedManager: skill.manager_owner, capability,
          objective: `${ref}: ${input.objective.trim()}`, inputEntities: { ...input.inputs, skill: ref }, authority: skill.authority_requirement,
          budget: { usd: skill.cost_estimate.usd || undefined, tokens: skill.cost_estimate.tokens || undefined }, missionId: input.missionId ?? null,
        }, svc)
        if (!r.ok) return { ok: false as const, reason: `delegation_refused:${capability}:${r.reason}`, ids }
        if (r.delegationId) ids.push(r.delegationId)
      }
      return { ok: true as const, ids }
    },
    svc,
  )
  if (!delegated) return { ok: false, reason: "ledger_replay:already_run" }
  if (!delegated.ok) return { ok: false, reason: delegated.reason }
  return { ok: true, skill: ref, source: resolved.source, delegationIds: delegated.ids, costUsd: skill.cost_estimate.usd }
}
