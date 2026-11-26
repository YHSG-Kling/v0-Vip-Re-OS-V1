/**
 * lib/kernel/skill-marketplace.ts — THE EXTENSION RUNTIME: ONE LIFECYCLE + THE ONE RUN PATH (wave 108 lane 108A;
 * generalised wave 137 lane 137D — skills AND custom managers, one lifecycle, tenant extension control).
 *
 * Owner: "approved third-party / tenant skills run through the kernel — not unrestricted plugins: policy,
 * authority, capability access, usage metering, audit, evaluation." Wave 137 CONSTITUTION: an extension may never
 * bypass tenant isolation, authorization, the authority ladder, usage/cost booking, withActionLedger or evidence.
 *
 * An extension is a DATA declaration in skill_marketplace_listings (m727 → m738: extension_kind skill | strategy |
 * provider_adapter | custom_manager | webhook_app). ONE lifecycle (lib/kernel/skill-registry.ts EXTENSION_STATUSES):
 * draft → validated (its platform-owned evaluation suite passed; a failure lands disabled with the evidence) →
 * approved → enabled (enablement checks: contract, evaluation, risk classification, dependencies, digest, and for a
 * tenant listing the tenant's entitlement) → suspended / deprecated → disabled. The KILL SWITCH is suspended /
 * disabled: a status move that keeps the declaration, digest, evidence and ledger — never a delete. Platform staff
 * decide global listings and may suspend / disable ANY listing; a tenant admin decides its own tenant's listings.
 * A GLOBAL extension runs for a tenant only after that tenant's admin enables it (tenant policy `extensions`).
 *
 * runSkill and runCustomManagerCapability are the ONLY run paths, and they compose survivors only:
 *   tenant isolation   the verified brokerageId (never a body); a tenant listing runs only inside its tenant
 *   lifecycle          only enabled / deprecated executes; suspended / disabled / unevaluated / digest-drifted refuse
 *   tenant enablement  a global extension needs THIS tenant's opt-in (fails closed when unreadable)
 *   entitlement        mayUseAndAfford ("app.access" or "feature.use" + the derived feature_flags key)
 *   metering           mayUseAndAfford on the cost lane at the declared MAXIMUM; agent_action_ledger.cost_usd at settle
 *   authority          resolveAgentAuthorityLevel (the ladder) — a custom manager runs at min(its ceiling, its owner's rung)
 *   policy + audit     withActionLedger (risk_class, policy_ref authority_level:<owner>, who / why / cost)
 *   capability access  requestExtensionCapability → capabilityCallRefusal (the RUNTIME bound) → requestDelegation to
 *                      the owning manager — never a direct call, never code, never raw DB.
 * Writes use the service client the caller passes (gate first — app/actions/skill-marketplace.ts).
 */
import { createHash } from "node:crypto"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import { MIN_AUTHORITY_FOR_RISK, type AuthorityLevel } from "@/lib/ai-isa/persona-tool-policy"
import { APP_CAPABILITY_REGISTRY, type AppCapability } from "@/lib/agentic-os/app-capability-registry"
import { CAPABILITY_MANAGER } from "@/lib/agentic-os/capability-ownership"
import { parseInputSpec } from "@/lib/agentic-os/invoke-planner"
import { capabilityRiskClass } from "@/lib/kernel/mission-controller"
import {
  BASE_PLAN_ENTITLEMENT, CAPABILITY_ENTITLEMENT, EXTENSION_KINDS, builtinSkill, canDecideSkillListing, canExtensionTransition,
  capabilityCallRefusal, evaluateExtension, extensionEnablementChecks, isExtensionExecutableBy, knownEvaluationSuites,
  registerCustomManager, skillContractOf, skillRef, stableSkillJson, tenantEnablementRefusal, validateExtensionDeclaration,
  validateSkillDeclaration, validateSkillInputs,
  type CustomManagerDeclaration, type CustomManagerEntry, type ExtensionKind, type ExtensionStatus, type SkillApprover,
  type SkillContract, type SkillDeclaration, type SkillEvaluationEvidence, type SkillPublisher,
  PLATFORM_ONLY_EXTENSION_KINDS,
  type ProviderAdapterExtensionDeclaration, type StrategyExtensionDeclaration, type WebhookAppDeclaration,
} from "@/lib/kernel/skill-registry"
import type { CompileInput, CompileResult } from "@/lib/kernel/mission-context"

/** Every kind's declaration (wave 138D: strategy / provider_adapter / webhook_app envelopes joined the union). */
export type ExtensionDeclaration = SkillDeclaration | CustomManagerDeclaration | StrategyExtensionDeclaration | ProviderAdapterExtensionDeclaration | WebhookAppDeclaration

type Client = { from: (table: string) => any }

const LISTING_COLS = "id, extension_kind, skill_id, publisher, publisher_name, brokerage_id, version, declaration, declaration_digest, status, evaluation_evidence, evaluated_at, submitted_by, approved_by, approved_at, enabled_at, suspended_at, suspended_reason, deprecated_at, disabled_at, disabled_reason, created_at, updated_at"

// TOMBSTONE (m738): SkillListingRow → ExtensionListingRow (published_at / revoked_at / revoked_reason renamed
// enabled_at / disabled_at / disabled_reason). SURVIVOR: the interface directly below.
export interface ExtensionListingRow {
  id: string
  extension_kind: ExtensionKind
  skill_id: string
  publisher: SkillPublisher
  publisher_name: string | null
  brokerage_id: string | null
  version: number
  declaration: ExtensionDeclaration
  declaration_digest: string
  status: ExtensionStatus
  evaluation_evidence: SkillEvaluationEvidence | null
  evaluated_at: string | null
  submitted_by: string | null
  approved_by: string | null
  approved_at: string | null
  enabled_at: string | null
  suspended_at: string | null
  suspended_reason: string | null
  deprecated_at: string | null
  disabled_at: string | null
  disabled_reason: string | null
}

export type ListingResult = { ok: true; listing: ExtensionListingRow } | { ok: false; reason: string; errors?: string[] }

interface LedgerInput {
  brokerageId: string
  action: string
  actor: { type: "manager" | "user" | "system"; userId?: string | null; managerKey?: string | null }
  subjectType?: "skill" | "extension"
  subjectRef: string
  subjectId?: string | null
  riskClass: string
  policyKey?: string | null
  reasonDetail: string
  detail: Record<string, unknown>
  costUsd: number | null
}

interface DelegateInput { brokerageId: string; requestingManager: ManagerKey; assignedManager: ManagerKey; capability: AppCapability; objective: string; inputEntities: Record<string, unknown>; authority: AuthorityLevel; budget: { usd?: number; tokens?: number }; missionId?: string | null }

/** A tenant's opt-ins, read from tenant policy `extensions`. `ok: false` = unreadable → nothing enabled (fail closed). */
export type TenantEnablementRead = { ok: true; enabled: Record<string, Record<string, unknown>> } | { ok: false; error: string }

/** Test seams — every default is THE survivor, lazily imported. Production never passes deps. */
export interface SkillMarketplaceDeps {
  now?: () => Date
  afford?: (input: { brokerageId: string; capability: string; estCostUsd?: number; estTokens?: number; featureKey?: string }, client: Client) => Promise<{ allowed: boolean; reason: string }>
  authority?: (brokerageId: string, manager: ManagerKey, client: Client) => Promise<AuthorityLevel>
  /** Runs `act` inside the ledger claim; returns what `act` returned (or null on a non-acting replay). */
  ledger?: <T>(input: LedgerInput, act: () => Promise<T>, client: Client) => Promise<T | null>
  delegate?: (input: DelegateInput, client: Client) => Promise<{ ok: boolean; reason?: string; delegationId?: string }>
  tenantEnablement?: (brokerageId: string, client: Client) => Promise<TenantEnablementRead>
  /** The ONE brokerage_settings writer (versioned tenant policy). */
  mergeSettings?: (brokerageId: string, patch: (current: Record<string, unknown>) => Record<string, unknown>, actor: { userId: string; reason: string }, client: Client) => Promise<{ ok: boolean; error?: string }>
  /** THE context compiler (lib/kernel/mission-context.ts compileManagerContext) — enforces a custom manager's memory_access. */
  compileContext?: (input: CompileInput) => Promise<CompileResult>
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
        subject: { type: input.subjectType ?? "skill", id: input.subjectId ?? null, ref: input.subjectRef },
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
  compileContext: async (input) => (await import("@/lib/kernel/mission-context")).compileManagerContext(input),
  delegate: async (i, client) => {
    const { requestDelegation } = await import("@/lib/kernel/manager-delegation")
    const r = await requestDelegation({ ...i, actor: { type: "manager", id: i.requestingManager } }, client)
    return r.ok ? { ok: true, delegationId: r.delegation.id } : { ok: false, reason: r.reason }
  },
  tenantEnablement: (brokerageId, client) => loadTenantExtensionEnablement(client, brokerageId),
  mergeSettings: async (brokerageId, patch, actor, client) => {
    const { mergeBrokerageSettings } = await import("@/lib/settings/brokerage-settings-merge")
    const r = await mergeBrokerageSettings(client, brokerageId, patch, { policy: { type: "user", userId: actor.userId, reason: actor.reason } })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  },
}

function withDeps(deps: SkillMarketplaceDeps): Required<SkillMarketplaceDeps> { return { ...defaultDeps, ...deps } }

/** PURE — the declaration digest the listing stores and every later read re-verifies.
 *  @proofSeam the proof asserts the stored digest equals this over the submitted declaration */
export function skillDeclarationDigest(d: ExtensionDeclaration): string {
  return createHash("sha256").update(stableSkillJson(d)).digest("hex")
}

async function getListing(svc: Client, listingId: string): Promise<ExtensionListingRow | null> {
  const { data, error } = await svc.from("skill_marketplace_listings").select(LISTING_COLS).eq("id", listingId).maybeSingle()
  if (error) { console.error(`[skill-marketplace] listing read refused: ${error.message}`); return null }
  return (data as ExtensionListingRow | null) ?? null
}

/** The ledger tenant for a lifecycle move: the listing's own tenant, else the acting tenant (platform moves
 *  carry the deciding staff's context only when they have one — a null tenant is ledgered as unledgered). */
function lifecycleTenant(listing: ExtensionListingRow, actorBrokerageId: string | null): string | null {
  return listing.brokerage_id ?? actorBrokerageId
}

function extRef(l: Pick<ExtensionListingRow, "extension_kind" | "skill_id" | "version">): string {
  return l.extension_kind === "skill" ? skillRef({ name: l.skill_id, version: l.version }) : `${l.extension_kind}:${l.skill_id}@v${l.version}`
}

// ─── tenant enablement (tenant policy `extensions`) ─────────────────────────────────────────────
/** THE reader of a tenant's extension opt-ins. A refused read is `ok: false` — every caller fails closed. */
async function loadTenantExtensionEnablement(svc: Client, brokerageId: string): Promise<TenantEnablementRead> {
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: error.message }
  const en = (((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}).extensions as { enabled?: unknown } | undefined)?.enabled
  return { ok: true, enabled: en && typeof en === "object" && !Array.isArray(en) ? (en as Record<string, Record<string, unknown>>) : {} }
}

/** PURE — the plan + meter asks an extension run (or a tenant opt-in) must pass, DERIVED from the contract. */
function entitlementAndBudgetAsks(kind: ExtensionKind, decl: ExtensionDeclaration): Array<{ gate: "entitlement" | "budget"; label: string; ask: { capability: string; featureKey?: string; estCostUsd?: number; estTokens?: number } }> {
  const out: ReturnType<typeof entitlementAndBudgetAsks> = []
  if (kind === "skill") {
    const s = skillContractOf(decl as SkillDeclaration)
    out.push(s.tenant_entitlement === BASE_PLAN_ENTITLEMENT
      ? { gate: "entitlement", label: BASE_PLAN_ENTITLEMENT, ask: { capability: "app.access" } }
      : { gate: "entitlement", label: s.tenant_entitlement, ask: { capability: "feature.use", featureKey: s.tenant_entitlement } })
    if (s.cost_estimate.budget === "ai_tokens") out.push({ gate: "budget", label: "ai_tokens", ask: { capability: "ai.generate", estTokens: s.max_cost.tokens } })
    else if (s.cost_estimate.budget === "vendor_spend") out.push({ gate: "budget", label: "vendor_spend", ask: { capability: "comms.send", estCostUsd: s.max_cost.usd } })
    return out
  }
  // Wave 138D: a strategy asks the plan features its capabilities' actions gate on + its declared budget; a webhook
  // app and a provider adapter ask the base plan (a provider adapter's spend is booked per call by bookAdapterUsage).
  if (kind === "strategy") {
    const s = (decl as StrategyExtensionDeclaration).strategy
    const caps = (s?.steps ?? []).flatMap((st) => st.capabilities ?? [])
    out.push({ gate: "entitlement", label: BASE_PLAN_ENTITLEMENT, ask: { capability: "app.access" } })
    for (const f of new Set(caps.map((c) => CAPABILITY_ENTITLEMENT[c]?.feature).filter((x): x is string => !!x))) out.push({ gate: "entitlement", label: f, ask: { capability: "feature.use", featureKey: f } })
    if ((s?.budget?.tokens ?? 0) > 0) out.push({ gate: "budget", label: "ai_tokens", ask: { capability: "ai.generate", estTokens: s.budget.tokens } })
    if ((s?.budget?.usd ?? 0) > 0) out.push({ gate: "budget", label: "vendor_spend", ask: { capability: "comms.send", estCostUsd: s.budget.usd } })
    return out
  }
  if (kind === "webhook_app" || kind === "provider_adapter") return [{ gate: "entitlement", label: BASE_PLAN_ENTITLEMENT, ask: { capability: "app.access" } }]
  const m = decl as CustomManagerDeclaration
  out.push({ gate: "entitlement", label: BASE_PLAN_ENTITLEMENT, ask: { capability: "app.access" } })
  for (const f of new Set((m.allowed_capabilities ?? []).map((c) => CAPABILITY_ENTITLEMENT[c]?.feature).filter((x): x is string => !!x))) {
    out.push({ gate: "entitlement", label: f, ask: { capability: "feature.use", featureKey: f } })
  }
  if ((m.budget?.max_tokens_per_run ?? 0) > 0) out.push({ gate: "budget", label: "ai_tokens", ask: { capability: "ai.generate", estTokens: m.budget.max_tokens_per_run } })
  if ((m.budget?.max_usd_per_run ?? 0) > 0) out.push({ gate: "budget", label: "vendor_spend", ask: { capability: "comms.send", estCostUsd: m.budget.max_usd_per_run } })
  return out
}

async function passAsks(d: Required<SkillMarketplaceDeps>, brokerageId: string, asks: ReturnType<typeof entitlementAndBudgetAsks>, svc: Client): Promise<string | null> {
  for (const a of asks) {
    const r = await d.afford({ brokerageId, ...a.ask }, svc)
    if (!r.allowed) return `${a.gate}:${a.label}:${r.reason}`
  }
  return null
}

// ─── submit + evaluate ───────────────────────────────────────────────────────────────────────
export interface SubmitSkillInput {
  /** Default "skill". */
  kind?: ExtensionKind
  publisher: SkillPublisher
  /** VERIFIED tenant (session) for a tenant-authored listing; null for platform / third-party. */
  brokerageId: string | null
  submittedBy: string | null
  publisherName?: string | null
  declaration: ExtensionDeclaration
}

export async function submitSkillListing(input: SubmitSkillInput, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<ListingResult> {
  const d = withDeps(deps)
  const kind: ExtensionKind = input.kind ?? "skill"
  if (!(EXTENSION_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `extension_kind_invalid:${String(kind)}` }
  if (input.publisher === "tenant" && !input.brokerageId) return { ok: false, reason: "no_tenant" }
  if (input.publisher !== "tenant" && input.brokerageId) return { ok: false, reason: "tenant_id_on_global_listing" }
  // Provider routing stays platform-controlled: a tenant never authors a provider adapter (wave 138D).
  if (input.publisher === "tenant" && PLATFORM_ONLY_EXTENSION_KINDS.has(kind)) return { ok: false, reason: `platform_controlled:${kind}` }
  const name = (input.declaration as { name?: unknown } | null)?.name
  if (kind === "skill" && typeof name === "string" && builtinSkill(name)) return { ok: false, reason: `name_reserved_by_builtin:${name}` }
  // No self-granted provenance: the ROW publisher is the session's, and a declaration claiming another is refused.
  const claimed = (input.declaration as { publisher?: unknown } | null)?.publisher
  if (claimed !== undefined && claimed !== input.publisher) return { ok: false, reason: `publisher_mismatch:${String(claimed)}!=${input.publisher}` }
  const v = validateExtensionDeclaration(kind, input.declaration)
  // A kind whose contract lives in another survivor may be DRAFTED (it can never validate until that contract is plugged in).
  if (!v.ok && !v.errors.every((e) => e.startsWith("contract_validator_not_registered:"))) return { ok: false, reason: "declaration_invalid", errors: v.errors }
  if (typeof name !== "string" || !Number.isInteger((input.declaration as { version?: unknown }).version)) return { ok: false, reason: "declaration_invalid", errors: ["name_or_version_missing"] }
  const { data, error } = await svc.from("skill_marketplace_listings").insert({
    extension_kind: kind, skill_id: name, publisher: input.publisher, publisher_name: input.publisherName ?? null,
    brokerage_id: input.brokerageId, version: (input.declaration as { version: number }).version, declaration: input.declaration,
    declaration_digest: skillDeclarationDigest(input.declaration), status: "draft", submitted_by: input.submittedBy,
  }).select(LISTING_COLS).single()
  if (error || !data) return { ok: false, reason: `insert_refused:${error?.message ?? "no row"}` }
  const listing = data as ExtensionListingRow
  const tenant = lifecycleTenant(listing, input.brokerageId)
  if (tenant) await d.ledger({ brokerageId: tenant, action: "extension.listing.submit", actor: { type: "user", userId: input.submittedBy }, subjectType: "extension", subjectRef: extRef(listing), subjectId: listing.id, riskClass: "LOW_RISK_WRITE", reasonDetail: `submitted ${listing.publisher} ${kind} ${extRef(listing)}`, detail: { listing_id: listing.id, publisher: listing.publisher, extension_kind: kind }, costUsd: null }, async () => null, svc)
  return { ok: true, listing }
}

/** Status move — the ONE writer of `status` (compare-and-set on the old status; the returned rows are counted).
 *  It never deletes: the declaration, digest and evidence survive every move, the kill switch included. */
async function moveListing(svc: Client, listing: ExtensionListingRow, to: ExtensionStatus, patch: Record<string, unknown>): Promise<ListingResult> {
  if (!canExtensionTransition(listing.status, to)) return { ok: false, reason: `invalid_transition:${listing.status}->${to}` }
  const { data, error } = await svc.from("skill_marketplace_listings").update({ ...patch, status: to }).eq("id", listing.id).eq("status", listing.status).select(LISTING_COLS)
  if (error) return { ok: false, reason: `update_refused:${error.message}` }
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "raced:status_moved_under_us" }
  return { ok: true, listing: data[0] as ExtensionListingRow }
}

/** Runs the declared platform-owned evaluation suite — passed → validated; failed → disabled WITH the evidence. */
export async function evaluateSkillListing(input: { listingId: string; actorBrokerageId: string | null }, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<ListingResult> {
  const d = withDeps(deps)
  const listing = await getListing(svc, input.listingId)
  if (!listing) return { ok: false, reason: "not_found" }
  if (listing.publisher === "tenant" && listing.brokerage_id !== input.actorBrokerageId) return { ok: false, reason: "not_found" }
  if (skillDeclarationDigest(listing.declaration) !== listing.declaration_digest) return { ok: false, reason: "digest_mismatch" }
  const evidence = evaluateExtension(listing.extension_kind, listing.declaration)
  if (!evidence) return { ok: false, reason: `no_evaluation_suite:${listing.extension_kind}:${String((listing.declaration as { evaluation_suite?: unknown }).evaluation_suite)}` }
  const now = d.now().toISOString()
  const moved = evidence.passed
    ? await moveListing(svc, listing, "validated", { evaluation_evidence: evidence, evaluated_at: now })
    : await moveListing(svc, listing, "disabled", { evaluation_evidence: evidence, evaluated_at: now, disabled_at: now, disabled_reason: `validation_failed:${evidence.checks.filter((c) => !c.ok).map((c) => c.name).join(",")}` })
  const tenant = lifecycleTenant(listing, input.actorBrokerageId)
  if (moved.ok && tenant) await d.ledger({ brokerageId: tenant, action: "extension.listing.evaluate", actor: { type: "system" }, subjectType: "extension", subjectRef: extRef(listing), subjectId: listing.id, riskClass: "READ", reasonDetail: `${evidence.suite} ${evidence.passed ? "passed" : "failed"}`, detail: { listing_id: listing.id, evidence }, costUsd: null }, async () => null, svc)
  return moved
}

// ─── decide: approve / enable / suspend / resume / deprecate / disable ──────────────────────────
// TOMBSTONE (m738): the decisions "publish" / "revoke" are retired — publish → enable, revoke → disable.
export type SkillDecision = "approve" | "enable" | "suspend" | "resume" | "deprecate" | "disable"
const DECISION_TARGET: Readonly<Record<SkillDecision, ExtensionStatus>> = { approve: "approved", enable: "enabled", suspend: "suspended", resume: "enabled", deprecate: "deprecated", disable: "disabled" }

export async function decideSkillListing(input: { listingId: string; decision: SkillDecision; actor: SkillApprover & { userId: string | null }; reason?: string | null }, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<ListingResult & { checks?: Array<{ name: string; ok: boolean; detail?: string }> }> {
  const d = withDeps(deps)
  const target = DECISION_TARGET[input.decision]
  if (!target) return { ok: false, reason: `decision_invalid:${String(input.decision)}` }
  const listing = await getListing(svc, input.listingId)
  if (!listing) return { ok: false, reason: "not_found" }
  // Tenant isolation: another tenant's listing reads as absent, not as forbidden.
  if (listing.publisher === "tenant" && listing.brokerage_id !== input.actor.brokerageId && !input.actor.isPlatformStaff) return { ok: false, reason: "not_found" }
  if (!canDecideSkillListing(listing, input.actor, input.decision)) return { ok: false, reason: listing.publisher === "tenant" ? "tenant_admin_of_this_tenant_only" : "platform_staff_only" }
  const digestOk = skillDeclarationDigest(listing.declaration) === listing.declaration_digest
  // The kill switch never waits on a digest: a tampered row is exactly what suspend / disable is for.
  if (!digestOk && input.decision !== "suspend" && input.decision !== "disable") return { ok: false, reason: "digest_mismatch" }
  const reason = input.reason?.trim() || null
  if ((input.decision === "suspend" || input.decision === "disable") && !reason) return { ok: false, reason: `${input.decision}_reason_required` }
  const now = d.now().toISOString()
  let patch: Record<string, unknown> = {}
  if (input.decision === "approve") {
    // Evaluation BEFORE approval: only a validated listing whose evidence passed may be approved.
    if (listing.status !== "validated" || !listing.evaluation_evidence?.passed) return { ok: false, reason: "evaluation_not_passed" }
    patch = { approved_by: input.actor.userId, approved_at: now }
  } else if (input.decision === "enable" || input.decision === "resume") {
    if (!canExtensionTransition(listing.status, "enabled") || (input.decision === "resume") !== (listing.status === "suspended")) return { ok: false, reason: `invalid_transition:${listing.status}->enabled(${input.decision})` }
    const checks = extensionEnablementChecks(listing, digestOk)
    if (!checks.every((c) => c.ok)) return { ok: false, reason: `enablement_refused:${checks.filter((c) => !c.ok).map((c) => c.name).join(",")}`, checks }
    // Tenant compatibility + entitlement: a tenant listing is enabled FOR its tenant, so its plan must cover it now.
    if (listing.publisher === "tenant" && listing.brokerage_id) {
      const refused = await passAsks(d, listing.brokerage_id, entitlementAndBudgetAsks(listing.extension_kind, listing.declaration).filter((a) => a.gate === "entitlement"), svc)
      if (refused) return { ok: false, reason: `enablement_refused:${refused}` }
    }
    patch = { enabled_at: now }
  } else if (input.decision === "suspend") patch = { suspended_at: now, suspended_reason: reason }
  else if (input.decision === "deprecate") patch = { deprecated_at: now }
  else patch = { disabled_at: now, disabled_reason: reason }
  const moved = await moveListing(svc, listing, target, patch)
  const tenant = lifecycleTenant(listing, input.actor.brokerageId)
  if (moved.ok && tenant) await d.ledger({ brokerageId: tenant, action: `extension.listing.${input.decision}`, actor: { type: "user", userId: input.actor.userId }, subjectType: "extension", subjectRef: extRef(listing), subjectId: listing.id, riskClass: "LOW_RISK_WRITE", reasonDetail: `${input.decision} ${listing.publisher} ${listing.extension_kind}${reason ? `: ${reason}` : ""}`, detail: { listing_id: listing.id, from_status: listing.status, to_status: moved.listing.status, approver: input.actor.isPlatformStaff ? "platform_staff" : "tenant_admin" }, costUsd: null }, async () => null, svc)
  return moved
}

// ─── tenant extension control ─────────────────────────────────────────────────────────────────
/** A tenant admin opts THEIR tenant in to (or out of) an ENABLED global extension. Through the existing
 *  survivors only: tenant from the caller's session, tenant-admin authority, the plan (entitlement) and the meter
 *  (budget) via mayUseAndAfford, the versioned tenant policy `extensions` (mergeBrokerageSettings →
 *  appendTenantPolicyVersion), and a ledger row. A platform-only kind or a tenant listing is refused. */
export async function setTenantExtensionEnabled(input: { brokerageId: string; listingId: string; enable: boolean; actor: { userId: string; isTenantAdmin: boolean } }, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<{ ok: true; enabled: boolean } | { ok: false; reason: string }> {
  const d = withDeps(deps)
  if (!input.brokerageId) return { ok: false, reason: "no_tenant" }
  if (!input.actor.isTenantAdmin) return { ok: false, reason: "tenant_admin_only" }
  const listing = await getListing(svc, input.listingId)
  if (!listing || (listing.publisher === "tenant" && listing.brokerage_id !== input.brokerageId)) return { ok: false, reason: "not_found" }
  const refusal = tenantEnablementRefusal(listing, input.enable)
  if (refusal) return { ok: false, reason: refusal }
  if (input.enable) {
    if (skillDeclarationDigest(listing.declaration) !== listing.declaration_digest) return { ok: false, reason: "digest_mismatch" }
    if (!listing.evaluation_evidence?.passed) return { ok: false, reason: "evaluation_not_passed" }
    const v = validateExtensionDeclaration(listing.extension_kind, listing.declaration)
    if (!v.ok) return { ok: false, reason: `declaration_invalid:${v.errors[0]}` }
    const refused = await passAsks(d, input.brokerageId, entitlementAndBudgetAsks(listing.extension_kind, listing.declaration), svc)
    if (refused) return { ok: false, reason: refused }
  }
  const now = d.now().toISOString()
  const write = await d.mergeSettings(input.brokerageId, (current) => {
    const prior = ((current.extensions as { enabled?: Record<string, unknown> } | undefined)?.enabled ?? {}) as Record<string, unknown>
    const enabled = { ...prior }
    if (input.enable) enabled[listing.id] = { kind: listing.extension_kind, name: listing.skill_id, version: listing.version, set_by: input.actor.userId, set_at: now }
    else delete enabled[listing.id]
    return { extensions: { ...((current.extensions as Record<string, unknown> | undefined) ?? {}), enabled } }
  }, { userId: input.actor.userId, reason: `${input.enable ? "enabled" : "disabled"} ${extRef(listing)}` }, svc)
  if (!write.ok) return { ok: false, reason: `policy_write_refused:${write.error ?? "unknown"}` }
  const enablementAction = input.enable ? "extension.tenant_enablement.enable" : "extension.tenant_enablement.disable"
  await d.ledger({ brokerageId: input.brokerageId, action: enablementAction, actor: { type: "user", userId: input.actor.userId }, subjectType: "extension", subjectRef: extRef(listing), subjectId: listing.id, riskClass: "LOW_RISK_WRITE", policyKey: "extensions", reasonDetail: `tenant ${input.enable ? "enabled" : "disabled"} ${extRef(listing)}`, detail: { listing_id: listing.id, extension_kind: listing.extension_kind }, costUsd: null }, async () => null, svc)
  return { ok: true, enabled: input.enable }
}

// ─── reads ────────────────────────────────────────────────────────────────────────────────────
/** Listings this tenant can see: every enabled / deprecated global listing + all of its own. */
export async function listVisibleSkillListings(brokerageId: string, svc: Client): Promise<{ listings: ExtensionListingRow[]; readRefused: string | null }> {
  const [globalRes, ownRes] = await Promise.all([
    svc.from("skill_marketplace_listings").select(LISTING_COLS).in("publisher", ["platform", "third_party"]).in("status", ["enabled", "deprecated"]).order("skill_id", { ascending: true }),
    svc.from("skill_marketplace_listings").select(LISTING_COLS).eq("publisher", "tenant").eq("brokerage_id", brokerageId).order("created_at", { ascending: false }),
  ])
  const refused = globalRes.error?.message ?? ownRes.error?.message ?? null
  return { listings: [...((globalRes.data ?? []) as ExtensionListingRow[]), ...((ownRes.data ?? []) as ExtensionListingRow[])], readRefused: refused }
}

export interface TenantExtensionView { listing: ExtensionListingRow; tenantEnabled: boolean; executable: boolean; control: "tenant" | "own_lifecycle" | "platform" ; controlNote: string | null }

/** The tenant extension panel's read: each visible extension with whether it runs HERE and who controls it. */
export async function listTenantExtensions(brokerageId: string, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<{ extensions: TenantExtensionView[]; readRefused: string | null }> {
  const d = withDeps(deps)
  const [vis, en] = await Promise.all([listVisibleSkillListings(brokerageId, svc), d.tenantEnablement(brokerageId, svc)])
  const enabled = en.ok ? en.enabled : {}
  const extensions = vis.listings.map((l) => {
    const tenantEnabled = l.publisher === "tenant" ? l.status === "enabled" : !!enabled[l.id]
    const note = tenantEnablementRefusal(l, true)
    const control: TenantExtensionView["control"] = l.publisher === "tenant" ? "own_lifecycle" : note?.startsWith("platform_controlled") ? "platform" : "tenant"
    return { listing: l, tenantEnabled, executable: isExtensionExecutableBy(l, brokerageId, !!enabled[l.id]), control, controlNote: note }
  })
  return { extensions, readRefused: vis.readRefused ?? (en.ok ? null : `tenant enablement unreadable: ${en.error}`) }
}

/** The platform approval queue: every third-party / platform listing, any status (platform staff only — the
 *  caller gates). */
export async function listPlatformSkillListings(svc: Client, scope: "global" | "tenant" = "global"): Promise<{ listings: ExtensionListingRow[]; readRefused: string | null }> {
  // scope "tenant" (wave 138D) = every TENANT-authored listing, for the platform kill switch (suspend / disable only —
  // canDecideSkillListing). Platform staff are cross-tenant by role; the door gates on requirePlatformStaff.
  const publishers = scope === "tenant" ? ["tenant"] : ["platform", "third_party"]
  const { data, error } = await svc.from("skill_marketplace_listings").select(LISTING_COLS).in("publisher", publishers).order("created_at", { ascending: false })
  return { listings: (data ?? []) as ExtensionListingRow[], readRefused: error?.message ?? null }
}

/** The highest EXECUTABLE version of a named extension of one kind for this tenant (status, tenant opt-in,
 *  digest, evaluation evidence, contract). Anything else is not executable — fails closed. */
async function resolveExecutableListing(brokerageId: string, kind: ExtensionKind, name: string, svc: Client, d: Required<SkillMarketplaceDeps>): Promise<{ ok: true; listing: ExtensionListingRow } | { ok: false; reason: string }> {
  const { data, error } = await svc.from("skill_marketplace_listings").select(LISTING_COLS).eq("skill_id", name).eq("extension_kind", kind).order("version", { ascending: false })
  if (error) return { ok: false, reason: `read_refused:${error.message}` }
  const visible = ((data ?? []) as ExtensionListingRow[]).filter((r) => r.publisher !== "tenant" || r.brokerage_id === brokerageId)
  if (!visible.length) return { ok: false, reason: `unknown_${kind}` }
  let enabled: Record<string, unknown> = {}
  if (visible.some((r) => r.publisher !== "tenant")) {
    const en = await d.tenantEnablement(brokerageId, svc)
    if (!en.ok) return { ok: false, reason: `tenant_enablement_unreadable:${en.error}` }
    enabled = en.enabled
  }
  const runnable = visible.find((r) => isExtensionExecutableBy(r, brokerageId, !!enabled[r.id]))
  if (!runnable) {
    const notOptedIn = visible.find((r) => r.publisher !== "tenant" && r.status === "enabled")
    return { ok: false, reason: notOptedIn ? "not_enabled_for_tenant" : `not_executable:${visible[0].status}` }
  }
  if (skillDeclarationDigest(runnable.declaration) !== runnable.declaration_digest) return { ok: false, reason: "digest_mismatch" }
  if (!runnable.evaluation_evidence?.passed) return { ok: false, reason: "evaluation_not_passed" }
  return { ok: true, listing: runnable }
}

export type RunnableSkill =
  | { ok: true; declaration: SkillContract; source: "builtin" | "marketplace"; listingId: string | null; publisher: SkillPublisher }
  | { ok: false; reason: string }

/** A built-in skill, or the highest EXECUTABLE marketplace skill for this tenant. runSkill is its caller.
 *  @proofSeam the proof asserts cross-tenant visibility + tenant opt-in of a third-party listing directly */
export async function resolveRunnableSkill(brokerageId: string, skillName: string, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<RunnableSkill> {
  const builtin = builtinSkill(skillName)
  if (builtin) return { ok: true, declaration: skillContractOf(builtin, "platform"), source: "builtin", listingId: null, publisher: "platform" }
  const r = await resolveExecutableListing(brokerageId, "skill", skillName, svc, withDeps(deps))
  if (!r.ok) return { ok: false, reason: r.reason === "unknown_skill" ? "unknown_skill" : r.reason }
  const decl = r.listing.declaration as SkillDeclaration
  const v = validateSkillDeclaration(decl, { knownEvaluationSuites: knownEvaluationSuites() })
  if (!v.ok) return { ok: false, reason: `declaration_invalid:${v.errors[0]}` }
  return { ok: true, declaration: skillContractOf(decl, r.listing.publisher), source: "marketplace", listingId: r.listing.id, publisher: r.listing.publisher }
}

// ─── the bounded capability door ──────────────────────────────────────────────────────────────
/**
 * THE ONLY WAY AN EXTENSION RUN REACHES A CAPABILITY. The runtime bound (capabilityCallRefusal) is asked at CALL
 * time — an undeclared / unknown / never-AI / ownership-moved capability is refused before any delegation — then
 * the owning manager is ASKED (requestDelegation). Called only inside a withActionLedger claim (the proof's census).
 * @proofSeam the proof calls it with an undeclared capability and asserts nothing was delegated
 */
export async function requestExtensionCapability(scope: { declared: readonly string[]; owner: ManagerKey | null }, req: Omit<DelegateInput, "capability" | "assignedManager"> & { capability: string }, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<{ ok: boolean; reason?: string; delegationId?: string }> {
  const refusal = capabilityCallRefusal(scope.declared, scope.owner, req.capability)
  if (refusal) return { ok: false, reason: refusal }
  const cap = req.capability as AppCapability
  return withDeps(deps).delegate({ ...req, capability: cap, assignedManager: CAPABILITY_MANAGER[cap] }, svc)
}

// ─── run: a skill ─────────────────────────────────────────────────────────────────────────────
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
  const resolved = await resolveRunnableSkill(input.brokerageId, input.skill, svc, deps)
  if (!resolved.ok) return { ok: false, reason: `skill_not_runnable:${resolved.reason}` }
  const skill = resolved.declaration
  if (input.requestingManager === skill.manager_owner) return { ok: false, reason: "self_run:the_owner_runs_its_capabilities_directly" }
  const inputErrors = validateSkillInputs(skill.inputs, input.inputs)
  if (inputErrors.length) return { ok: false, reason: "inputs_invalid", errors: inputErrors }

  // ENTITLEMENT (the plan) + METERING (the cost lane at the declared MAXIMUM) — fail closed.
  const refused = await passAsks(d, input.brokerageId, entitlementAndBudgetAsks("skill", skill), svc)
  if (refused) return { ok: false, reason: refused }
  // AUTHORITY — the owner's ladder rung for this tenant.
  const rung = await d.authority(input.brokerageId, skill.manager_owner, svc)
  if (rung < skill.authority_requirement) return { ok: false, reason: `authority:${rung}<${skill.authority_requirement}` }

  // AUDIT + CAPABILITY ACCESS — one ledger row for the skill run; one bounded delegation per capability inside it.
  const ref = skillRef(skill)
  const delegated = await d.ledger(
    {
      brokerageId: input.brokerageId, action: "skill.manager_skill.run", actor: { type: "manager", managerKey: input.requestingManager },
      subjectRef: ref, subjectId: resolved.listingId, riskClass: skill.risk_class, policyKey: `authority_level:${skill.manager_owner}`,
      reasonDetail: `${input.requestingManager} runs ${ref} (${resolved.source}) via ${skill.manager_owner}: ${input.objective.trim()}`.slice(0, 900),
      detail: { skill: skill.name, version: skill.version, source: resolved.source, publisher: resolved.publisher, listing_id: resolved.listingId, capabilities: skill.required_capabilities, entitlement: skill.tenant_entitlement, cost_estimate: skill.cost_estimate, max_cost: skill.max_cost, external_write: skill.external_write, authority_requirement: skill.authority_requirement, evaluation_suite: skill.evaluation_suite, mission_id: input.missionId ?? null },
      costUsd: skill.cost_estimate.usd,
    },
    async () => {
      const ids: string[] = []
      for (const capability of skill.required_capabilities) {
        const r = await requestExtensionCapability({ declared: skill.required_capabilities, owner: skill.manager_owner }, {
          brokerageId: input.brokerageId, requestingManager: input.requestingManager, capability,
          objective: `${ref}: ${input.objective.trim()}`, inputEntities: { ...input.inputs, skill: ref }, authority: skill.authority_requirement,
          budget: { usd: skill.max_cost.usd || undefined, tokens: skill.max_cost.tokens || undefined }, missionId: input.missionId ?? null,
        }, svc, deps)
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

// ─── run: a custom manager ────────────────────────────────────────────────────────────────────
export interface RunCustomManagerInput {
  /** VERIFIED tenant — never a body. */
  brokerageId: string
  customManager: string
  capability: string
  inputs: Record<string, unknown>
  objective: string
  missionId?: string | null
  missionType?: string | null
}

/** `context` = what the custom manager RECEIVED: the compiled mission context, only its declared memory_access slices. */
export type RunCustomManagerResult = { ok: true; manager: string; delegationId: string | null; costUsd: number; context: { slices: string[]; tokens: number; section: string } | null } | { ok: false; reason: string; errors?: string[] }

/** The custom-manager path: an ENABLED custom_manager extension asks the owning manager for ONE allowed capability,
 *  as its escalation owner, at min(its ceiling, its owner's ladder rung), metered and ledgered. */
export async function runCustomManagerCapability(input: RunCustomManagerInput, svc: Client, deps: SkillMarketplaceDeps = {}): Promise<RunCustomManagerResult> {
  const d = withDeps(deps)
  if (!input.brokerageId) return { ok: false, reason: "no_tenant" }
  if (!input.objective?.trim()) return { ok: false, reason: "objective_required" }
  const r = await resolveExecutableListing(input.brokerageId, "custom_manager", input.customManager, svc, d)
  if (!r.ok) return { ok: false, reason: `custom_manager_not_runnable:${r.reason}` }
  const reg = registerCustomManager(r.listing.declaration as CustomManagerDeclaration)
  if (!reg.ok) return { ok: false, reason: "declaration_invalid", errors: reg.errors }
  const m: CustomManagerEntry = reg.entry
  if (input.missionType && !(m.mission_types as readonly string[]).includes(input.missionType)) return { ok: false, reason: `mission_type_not_declared:${input.missionType}` }
  // The runtime bound FIRST — nothing is asked for a capability this manager did not declare.
  const bound = capabilityCallRefusal(m.allowed_capabilities, null, input.capability)
  if (bound) return { ok: false, reason: bound }
  const cap = input.capability as AppCapability
  if (CAPABILITY_MANAGER[cap] === m.escalation_owner) return { ok: false, reason: `escalation_owner_owns_capability:${cap}` }
  const inputErrors: string[] = []
  for (const k of Object.keys(input.inputs ?? {})) if (/^(brokerage|tenant)_?[iI]d$/.test(k)) inputErrors.push(`tenant_from_input:${k}`)
  for (const s of parseInputSpec(APP_CAPABILITY_REGISTRY[cap].inputs)) if (s.required && s.name !== "brokerageId" && (input.inputs ?? {})[s.name] == null) inputErrors.push(`input_missing:${s.name}`)
  if (inputErrors.length) return { ok: false, reason: "inputs_invalid", errors: inputErrors }
  const refused = await passAsks(d, input.brokerageId, entitlementAndBudgetAsks("custom_manager", r.listing.declaration), svc)
  if (refused) return { ok: false, reason: refused }
  // AUTHORITY — never above its own ceiling, never above its escalation owner's rung for this tenant.
  const risk = capabilityRiskClass(cap)
  const min = MIN_AUTHORITY_FOR_RISK[risk] ?? 7
  const rung = await d.authority(input.brokerageId, m.escalation_owner, svc)
  const effective = Math.min(rung, m.authority_ceiling) as AuthorityLevel
  if (effective < min) return { ok: false, reason: `authority:${effective}<${min}` }
  // CONTEXT (wave 138D) — compiled by THE compiler under the declared memory_access: an undeclared slice is never read.
  // A mission of another tenant is not_found there, so the run is refused.
  let context: { slices: string[]; tokens: number; section: string } | null = null
  if (input.missionId) {
    const tokenBudget = m.budget.max_tokens_per_run > 0 ? Math.min(m.budget.max_tokens_per_run, 2000) : 1200
    const cx = await d.compileContext({ brokerageId: input.brokerageId, missionId: input.missionId, manager: m.escalation_owner, tokenBudget, memoryAccess: m.memory_access, client: svc })
    if (!cx.ok) return { ok: false, reason: `mission_context_refused:${cx.reason}` }
    const ctx = cx.context as unknown as Record<string, { data?: unknown; reader?: unknown } | null>
    const slices = Object.keys(ctx).filter((k) => !!ctx[k] && typeof ctx[k] === "object" && typeof ctx[k]!.reader === "string" && ctx[k]!.data != null)
    context = { slices, tokens: cx.tokens, section: cx.section }
  }
  // COST — booked on the run's ledger row: the per-run amount the meter was asked to afford (its declared ceiling).
  const costUsd = m.budget.max_usd_per_run
  const ref = `${m.key}@v${m.version}`
  const out = await d.ledger(
    {
      brokerageId: input.brokerageId, action: "extension.custom_manager.run", actor: { type: "manager", managerKey: m.escalation_owner },
      subjectType: "extension", subjectRef: ref, subjectId: r.listing.id, riskClass: risk, policyKey: `authority_level:${m.escalation_owner}`,
      reasonDetail: `${ref} (escalates to ${m.escalation_owner}) asks ${CAPABILITY_MANAGER[cap]} for ${cap}: ${input.objective.trim()}`.slice(0, 900),
      detail: { custom_manager: m.key, version: m.version, listing_id: r.listing.id, publisher: r.listing.publisher, capability: cap, authority: effective, authority_ceiling: m.authority_ceiling, budget: m.budget, policy_requirements: m.policy_requirements, memory_access: m.memory_access, context_slices: context?.slices ?? null, cost_basis: "per_run_budget_ceiling_metered", mission_id: input.missionId ?? null, mission_type: input.missionType ?? null, evaluation_suite: m.evaluation_suite },
      costUsd,
    },
    () => requestExtensionCapability({ declared: m.allowed_capabilities, owner: null }, {
      brokerageId: input.brokerageId, requestingManager: m.escalation_owner, capability: cap,
      objective: `${ref}: ${input.objective.trim()}`, inputEntities: { ...input.inputs, custom_manager: ref }, authority: effective,
      budget: { usd: m.budget.max_usd_per_run || undefined, tokens: m.budget.max_tokens_per_run || undefined }, missionId: input.missionId ?? null,
    }, svc, deps),
    svc,
  )
  if (!out) return { ok: false, reason: "ledger_replay:already_run" }
  if (!out.ok) return { ok: false, reason: `delegation_refused:${cap}:${out.reason}` }
  return { ok: true, manager: m.key, delegationId: out.delegationId ?? null, costUsd, context }
}
