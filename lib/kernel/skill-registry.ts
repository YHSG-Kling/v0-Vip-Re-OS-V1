/**
 * lib/kernel/skill-registry.ts — THE MANAGER SKILL DECLARATION + VALIDATOR + MARKETPLACE RULES (wave 108, lane 108A).
 *
 * Owner: "SKILL REGISTRY EXPANSION — every manager skill declares name, version, manager_owner, inputs, outputs,
 * required_capabilities, risk_class, authority_requirement, cost_estimate, tenant_entitlement, evaluation_suite"
 * + "AGENT/SKILL MARKETPLACE — approved third-party / tenant skills run through the kernel, not unrestricted
 * plugins: policy, authority, capability access, usage metering, audit, evaluation."
 *
 * EXTENDS THE EXISTING REGISTRY, REPLACES NOTHING (audit in the lane notes). A manager's skills already
 * existed as the capability catalogue: APP_CAPABILITY_REGISTRY (what each operation is, its inputs, whether it
 * mutates, what it needs) + CAPABILITY_MANAGER (whose skill it is). They had no version, no risk class, no
 * authority rung, no cost, no entitlement and no evaluation suite in ONE declaration. This file is that
 * declaration — every field DERIVED from the survivor that already answers it:
 *   inputs                ← APP_CAPABILITY_REGISTRY[c].inputs (the invoke planner's "name?" spec, parseInputSpec)
 *   manager_owner         ← CAPABILITY_MANAGER[c]
 *   risk_class            ← capabilityRiskClass (lib/kernel/mission-controller.ts — the ladder's vocabulary,
 *                           ToolRiskClass in lib/ai-isa/persona-tool-policy.ts; the ledger's risk_class column)
 *   authority_requirement ← MIN_AUTHORITY_FOR_RISK[risk_class] (the authority ladder)
 *   cost_estimate.budget  ← the meter lane paidCapabilitiesFor already charges a delegation of that capability
 *   tenant_entitlement    ← the feature_flags key the capability's existing server action gates on
 *                           (mayUseFeature call sites, cited per entry), else the base plan "app.access"
 *   evaluation_suite      ← the proof that already exercises the capability (a package.json test:<key>)
 * Nothing is invented: a capability with no measured per-call cost declares 0 with basis "unmeasured".
 *
 * MARKETPLACE skills are the SAME declaration stored as DATA (m727 skill_marketplace_listings) — they compose
 * registered capabilities only; there is no code field and the validator refuses one. Their evaluation suite is
 * a runtime evaluator below (SKILL_EVALUATORS), never a script the submitter supplies.
 *
 * PURE — no I/O — so the proof asserts every rule directly. The runtime (submit / evaluate / approve / enable /
 * suspend / deprecate / disable, tenant opt-in, runSkill, runCustomManagerCapability) is lib/kernel/skill-marketplace.ts.
 *
 * WAVE 137 (lane 137D): the FULL skill contract (publisher, max_cost, external_write — optional with derivation,
 * skillContractOf), the RUNTIME capability bound (capabilityCallRefusal), the CUSTOM MANAGER contract
 * (CustomManagerDeclaration → registerCustomManager) and ONE EXTENSION LIFECYCLE (EXTENSION_STATUSES, m738).
 */
import { MANAGERS, PLATFORM_MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { APP_CAPABILITY_REGISTRY, type AppCapability } from "@/lib/agentic-os/app-capability-registry"
import { CAPABILITY_MANAGER } from "@/lib/agentic-os/capability-ownership"
import { parseInputSpec } from "@/lib/agentic-os/invoke-planner"
import { MIN_AUTHORITY_FOR_RISK, isAuthorityLevel, type AuthorityLevel, type ToolRiskClass } from "@/lib/ai-isa/persona-tool-policy"
import { capabilityRiskClass } from "@/lib/kernel/mission-controller"
import { paidCapabilitiesFor } from "@/lib/kernel/manager-delegation"
import { MISSION_TYPES, type MissionType } from "@/lib/kernel/missions"
import { TENANT_POLICY_SETTINGS_KEYS } from "@/lib/kernel/tenant-policy"
// Wave 138D — the three kinds whose contract lives in another survivor are validated AGAINST that survivor
// (import only; 138A owns provider-adapters.ts, 138E owns strategy-library.ts, 137B's tenant-webhooks-core.ts).
import { PLATFORM_STRATEGY_LIBRARY, STRATEGY_SUBJECT_TYPES, STRATEGY_TIERS, platformStrategy, strategyCapabilities, type StrategyDefinition } from "@/lib/kernel/strategy-library"
import { adapterFor, routedProviders, validateProviderAdapter, type ProviderAdapter } from "@/lib/kernel/provider-adapters"
import { WEBHOOK_EVENT_CATALOG, buildWebhookPayload, validateWebhookEventFilter } from "@/lib/platform/tenant-webhooks-core"

// ─── the declaration ──────────────────────────────────────────────────────────────────────────
export const SKILL_FIELD_TYPES = ["string", "number", "boolean", "uuid", "iso_datetime", "object", "array"] as const
export type SkillFieldType = (typeof SKILL_FIELD_TYPES)[number]
export interface SkillField { name: string; type: SkillFieldType; required: boolean; description?: string }
export interface SkillSchema { fields: readonly SkillField[] }

/** The meter lane — mayUseAndAfford's PAID_CAPABILITIES budget vocabulary (lib/billing/billing-access.ts). */
export const SKILL_COST_BUDGETS = ["none", "ai_tokens", "vendor_spend"] as const
export type SkillCostBudget = (typeof SKILL_COST_BUDGETS)[number]
export interface SkillCostEstimate {
  usd: number
  tokens: number
  budget: SkillCostBudget
  /** "unmeasured" = no per-call figure exists in the repo yet (the lane is still metered by mayUseAndAfford). */
  basis: "unmeasured" | "declared" | "measured"
}

export interface SkillDeclaration {
  name: string
  version: number
  manager_owner: ManagerKey
  purpose: string
  inputs: SkillSchema
  outputs: SkillSchema
  required_capabilities: readonly AppCapability[]
  risk_class: ToolRiskClass
  authority_requirement: AuthorityLevel
  cost_estimate: SkillCostEstimate
  /** "app.access" (the base plan) or a feature_flags.feature_key the run asks mayUseAndAfford "feature.use" for. */
  tenant_entitlement: string
  /** Built-in: a package.json proof key (test:<name>). Marketplace: a SKILL_EVALUATORS id. */
  evaluation_suite: string
  /** Marketplace only — sample inputs the evaluation suite runs the contract against. */
  evaluation_fixtures?: readonly Record<string, unknown>[]
  // ── wave 137 (lane 137D) — the full minimum contract. OPTIONAL WITH DERIVATION so every declaration written
  //    against the wave-108 shape stays valid: skillContractOf fills each from the survivors that answer it.
  //    (manager_owner is the RESPONSIBLE manager — always an existing MANAGERS key owning every capability.) ──
  /** Owner / publisher. A marketplace listing's ROW publisher is authoritative — a declaration claiming another
   *  publisher is refused at submission (publisher_mismatch). Default: the listing's publisher (built-ins: platform). */
  publisher?: SkillPublisher
  publisher_name?: string
  /** The hard ceiling on ONE run (≥ cost_estimate). The run is metered against THIS, settled at the estimate.
   *  Default: the estimate is the ceiling. */
  max_cost?: { usd: number; tokens: number }
  /** What the skill does outside the tenant's own rows — DERIVED from its capabilities (externalWriteOf);
   *  a declaration may overstate, never understate (external_write_understated). */
  external_write?: SkillExternalWrite
}

/** External-write behaviour in escalating order: reads only → writes the tenant's own rows → sends a message
 *  outside the OS → spends money / moves funds. Derived per capability (APP_CAPABILITY_REGISTRY.mutates +
 *  capabilityRiskClass), never chosen. */
export const SKILL_EXTERNAL_WRITES = ["none", "internal_write", "external_message", "external_spend"] as const
export type SkillExternalWrite = (typeof SKILL_EXTERNAL_WRITES)[number]

/** The base plan entitlement (mayUseAndAfford "app.access"). */
export const BASE_PLAN_ENTITLEMENT = "app.access"

/** Risk classes in escalating order (the ladder's MIN_AUTHORITY_FOR_RISK keys). */
export const SKILL_RISK_ORDER: readonly ToolRiskClass[] = ["READ", "LOW_RISK_WRITE", "COMMUNICATION", "FINANCIAL", "LEGAL", "IRREVERSIBLE"]

/** The run receipt every skill returns — the capability catalogue declares no per-capability output shape,
 *  so a skill's output IS the kernel receipt: which delegations were opened and the ledger row. */
export const SKILL_RUN_RECEIPT_SCHEMA: SkillSchema = Object.freeze({
  fields: Object.freeze([
    { name: "status", type: "string", required: true, description: "executed | refused" },
    { name: "delegation_ids", type: "array", required: true, description: "one manager_delegations row per required capability" },
    { name: "ledger_entry", type: "string", required: false, description: "agent_action_ledger subject ref skill:<name>@v<version>" },
  ] as SkillField[]),
}) as SkillSchema

// ─── derivation (backfill) ────────────────────────────────────────────────────────────────────
/** Tenant comes from the SESSION / verified context, never an input (CLAUDE.md §4). */
const TENANT_INPUT_NAMES: ReadonlySet<string> = new Set(["brokerageId", "brokerage_id", "tenantId", "tenant_id"])

function fieldTypeFor(name: string): SkillFieldType {
  if (/Id$/.test(name)) return "uuid"
  if (/At$/.test(name)) return "iso_datetime"
  if (name === "amount" || /Min$/.test(name)) return "number"
  if (name === "channels") return "array"
  if (name === "filters") return "object"
  return "string"
}

/**
 * The plan feature each capability's EXISTING server action already gates on (mayUseFeature(<user>, "<key>") —
 * cited so the mapping is a derivation, not a choice). Any capability absent here rides the base plan.
 * @proofSeam the proof reads each cited file for the mayUseFeature(…, "<key>") call (stripped source)
 */
export const CAPABILITY_ENTITLEMENT: Readonly<Partial<Record<AppCapability, { feature: string; gate: string }>>> = Object.freeze({
  direct_mail_send:  { feature: "direct_mail",        gate: "app/actions/direct-mail.ts" },
  podcast_publish:   { feature: "podcast_generation", gate: "app/actions/podcast-generation.ts" },
  blog_publish:      { feature: "seo_blog_engine",    gate: "app/actions/blog.ts" },
  social_post_publish: { feature: "social_automation", gate: "app/actions/social-media-automation.ts" },
})

/** The proof that already exercises each capability; default = the capability-contract proof (every key). */
export const DEFAULT_SKILL_PROOF = "test:capability-contract"
export const CAPABILITY_PROOF: Readonly<Partial<Record<AppCapability, string>>> = Object.freeze({
  listing_appointment_prep: "test:manager-delegation",
  connectivity_scan: "test:capability-ownership",
})

/** The meter lane a delegation of this capability is charged on (paidCapabilitiesFor — the ONE rule). */
function budgetLaneFor(cap: AppCapability): SkillCostBudget {
  const lanes = paidCapabilitiesFor(cap, { usd: 1, tokens: 0 }).map((l) => l.capability)
  return lanes.includes("comms.send") && APP_CAPABILITY_REGISTRY[cap].mutates ? "vendor_spend" : "none"
}

/** PURE — the declaration a catalogue capability already implies (version 1). */
function deriveCapabilitySkill(cap: AppCapability): SkillDeclaration {
  const def = APP_CAPABILITY_REGISTRY[cap]
  const risk = capabilityRiskClass(cap)
  const min = MIN_AUTHORITY_FOR_RISK[risk]
  const inputs = parseInputSpec(def.inputs)
    .filter((s) => !TENANT_INPUT_NAMES.has(s.name))
    .map((s) => ({ name: s.name, type: fieldTypeFor(s.name), required: s.required }))
  return {
    name: cap,
    version: 1,
    manager_owner: CAPABILITY_MANAGER[cap],
    purpose: def.purpose,
    inputs: { fields: inputs },
    outputs: SKILL_RUN_RECEIPT_SCHEMA,
    required_capabilities: [cap],
    risk_class: risk,
    authority_requirement: (min ?? 6) as AuthorityLevel,
    cost_estimate: { usd: 0, tokens: 0, budget: budgetLaneFor(cap), basis: "unmeasured" },
    tenant_entitlement: CAPABILITY_ENTITLEMENT[cap]?.feature ?? BASE_PLAN_ENTITLEMENT,
    evaluation_suite: CAPABILITY_PROOF[cap] ?? DEFAULT_SKILL_PROOF,
    publisher: "platform",
    max_cost: { usd: 0, tokens: 0 },
    external_write: externalWriteOf([cap]),
  }
}

/** PURE — the external-write class a capability set implies (the max over its capabilities). */
function externalWriteOf(caps: readonly AppCapability[]): SkillExternalWrite {
  let idx = 0
  for (const c of caps) {
    if (!APP_CAPABILITY_REGISTRY[c]?.mutates) continue
    const risk = capabilityRiskClass(c)
    const w: SkillExternalWrite = risk === "FINANCIAL" ? "external_spend" : risk === "COMMUNICATION" ? "external_message" : "internal_write"
    idx = Math.max(idx, SKILL_EXTERNAL_WRITES.indexOf(w))
  }
  return SKILL_EXTERNAL_WRITES[idx]
}

/** PURE — the ceilings a capability set imposes, DERIVED from the registry. A declaration may meet or exceed the
 *  risk / external-write class and must carry the plan feature its capabilities' own actions gate on; it can
 *  never lower them (no self-granted scope, authority or entitlement). */
function derivedSkillCeilings(caps: readonly AppCapability[]): { risk: ToolRiskClass; externalWrite: SkillExternalWrite; features: string[] } {
  const known = caps.filter((c) => c in APP_CAPABILITY_REGISTRY)
  let r = 0
  const features = new Set<string>()
  for (const c of known) {
    r = Math.max(r, SKILL_RISK_ORDER.indexOf(capabilityRiskClass(c)))
    const f = CAPABILITY_ENTITLEMENT[c]?.feature
    if (f) features.add(f)
  }
  return { risk: SKILL_RISK_ORDER[r], externalWrite: externalWriteOf(known), features: [...features].sort() }
}

/** The full contract: every wave-137 field present (derived where the declaration left it out). */
export type SkillContract = SkillDeclaration & Required<Pick<SkillDeclaration, "publisher" | "max_cost" | "external_write">>

/** PURE — fill every optional wave-137 field from its derivation. The runtime reads this, never the raw optional
 *  fields. `listingPublisher` (the row's publisher) wins over anything the declaration says. */
export function skillContractOf(d: SkillDeclaration, listingPublisher?: SkillPublisher): SkillContract {
  return {
    ...d,
    publisher: listingPublisher ?? d.publisher ?? "platform",
    max_cost: d.max_cost ?? { usd: d.cost_estimate.usd, tokens: d.cost_estimate.tokens },
    external_write: d.external_write ?? externalWriteOf(d.required_capabilities),
  }
}

/**
 * PURE — THE RUNTIME CAPABILITY BOUND (call time, not only validation). Every capability call an extension makes
 * passes this first: a capability absent from its declaration, unknown to the registry, LEGAL / IRREVERSIBLE, or
 * (for a skill) no longer owned by its manager is refused before anything is asked. `owner` null = a custom
 * manager — it never owns a capability, it requests it from CAPABILITY_MANAGER[c].
 */
export function capabilityCallRefusal(declared: readonly string[], owner: ManagerKey | null, capability: string): string | null {
  if (!declared.includes(capability)) return `undeclared_capability:${capability}`
  if (!(capability in APP_CAPABILITY_REGISTRY)) return `unknown_capability:${capability}`
  const cap = capability as AppCapability
  if (MIN_AUTHORITY_FOR_RISK[capabilityRiskClass(cap)] === null) return `risk_never_ai:${cap}`
  if (owner && CAPABILITY_MANAGER[cap] !== owner) return `capability_owner_moved:${cap}:${CAPABILITY_MANAGER[cap]}`
  return null
}

/** THE BUILT-IN MANAGER SKILLS — one per catalogue capability, derived (never restated). */
export const MANAGER_SKILLS: readonly SkillDeclaration[] = Object.freeze(
  (Object.keys(APP_CAPABILITY_REGISTRY) as AppCapability[]).map(deriveCapabilitySkill),
)

export function builtinSkill(name: string): SkillDeclaration | null {
  return MANAGER_SKILLS.find((s) => s.name === name) ?? null
}

// ─── the validator ────────────────────────────────────────────────────────────────────────────
export interface SkillValidation { ok: boolean; errors: string[] }

/** Fields a DATA skill may carry — anything else (code, script, url, endpoint …) is refused. */
const DECLARATION_KEYS: ReadonlySet<string> = new Set([
  "name", "version", "manager_owner", "purpose", "inputs", "outputs", "required_capabilities", "risk_class",
  "authority_requirement", "cost_estimate", "tenant_entitlement", "evaluation_suite", "evaluation_fixtures",
  "publisher", "publisher_name", "max_cost", "external_write",
])

/** The rung band a risk class occupies: [its minimum, the next class's minimum − 1]. Above = the skill claims
 *  authority its risk class does not account for; below = an agent at too low a rung could run it.
 *  @proofSeam the proof asserts the band rule directly (LEGAL / IRREVERSIBLE carry none) */
export function authorityBandFor(risk: ToolRiskClass): { min: AuthorityLevel; max: AuthorityLevel } | null {
  const min = MIN_AUTHORITY_FOR_RISK[risk]
  if (min === null) return null
  const higher = SKILL_RISK_ORDER.slice(SKILL_RISK_ORDER.indexOf(risk) + 1).map((r) => MIN_AUTHORITY_FOR_RISK[r]).filter((n): n is AuthorityLevel => n !== null)
  const next = higher.length ? Math.min(...higher) : 7
  return { min, max: (next - 1) as AuthorityLevel }
}

function validSchema(s: unknown, label: string, errors: string[]): s is SkillSchema {
  const fields = (s as SkillSchema | null)?.fields
  if (!Array.isArray(fields)) { errors.push(`${label}_schema_missing`); return false }
  const seen = new Set<string>()
  for (const f of fields) {
    if (!f || typeof f.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(f.name)) { errors.push(`${label}_field_name_invalid`); continue }
    if (seen.has(f.name)) errors.push(`${label}_field_duplicate:${f.name}`)
    seen.add(f.name)
    if (!(SKILL_FIELD_TYPES as readonly string[]).includes(f.type)) errors.push(`${label}_field_type_invalid:${f.name}`)
    if (typeof f.required !== "boolean") errors.push(`${label}_field_required_flag:${f.name}`)
  }
  return true
}

/**
 * PURE — the ONE gate a skill passes before it is registered, approved or run.
 * Rejects (among the structural checks): a capability its manager does not own; an authority outside its risk
 * class's band (exceeds or falls below); a risk class understated against its capabilities; LEGAL /
 * IRREVERSIBLE (no AI skill may carry them); no evaluation suite (or one not in `knownEvaluationSuites`);
 * a tenant id as an input; any non-declaration (code) field.
 */
export function validateSkillDeclaration(d: SkillDeclaration, opts: { knownEvaluationSuites: ReadonlySet<string> }): SkillValidation {
  const errors: string[] = []
  if (!d || typeof d !== "object") return { ok: false, errors: ["declaration_missing"] }
  for (const k of Object.keys(d)) if (!DECLARATION_KEYS.has(k)) errors.push(`not_data:${k}`)
  if (typeof d.name !== "string" || !/^[a-z][a-z0-9_]{2,63}$/.test(d.name)) errors.push("name_invalid")
  if (!Number.isInteger(d.version) || d.version < 1) errors.push("version_invalid")
  if (typeof d.purpose !== "string" || !d.purpose.trim()) errors.push("purpose_missing")
  const ownerKnown = typeof d.manager_owner === "string" && d.manager_owner in MANAGERS
  if (!ownerKnown) errors.push(`unknown_manager:${String(d.manager_owner)}`)

  const caps: readonly AppCapability[] = Array.isArray(d.required_capabilities) ? d.required_capabilities : []
  if (!caps.length) errors.push("no_capabilities")
  let derivedRisk = 0
  for (const c of caps) {
    if (!(c in APP_CAPABILITY_REGISTRY)) { errors.push(`unknown_capability:${String(c)}`); continue }
    if (ownerKnown && CAPABILITY_MANAGER[c] !== d.manager_owner) errors.push(`capability_not_owned:${c}:${CAPABILITY_MANAGER[c]}`)
    derivedRisk = Math.max(derivedRisk, SKILL_RISK_ORDER.indexOf(capabilityRiskClass(c)))
  }

  const riskIdx = SKILL_RISK_ORDER.indexOf(d.risk_class)
  if (riskIdx < 0) errors.push(`risk_class_invalid:${String(d.risk_class)}`)
  else {
    if (riskIdx < derivedRisk) errors.push(`risk_understated:${d.risk_class}<${SKILL_RISK_ORDER[derivedRisk]}`)
    const band = authorityBandFor(d.risk_class)
    if (!band) errors.push(`risk_never_ai:${d.risk_class}`)
    else if (!isAuthorityLevel(d.authority_requirement)) errors.push("authority_invalid")
    else if (d.authority_requirement > band.max) errors.push(`authority_exceeds_risk_class:${d.authority_requirement}>${band.max}:${d.risk_class}`)
    else if (d.authority_requirement < band.min) errors.push(`authority_below_risk_class:${d.authority_requirement}<${band.min}:${d.risk_class}`)
  }

  const cost = d.cost_estimate
  if (!cost || typeof cost.usd !== "number" || cost.usd < 0 || typeof cost.tokens !== "number" || cost.tokens < 0) errors.push("cost_estimate_invalid")
  else if (!(SKILL_COST_BUDGETS as readonly string[]).includes(cost.budget)) errors.push(`cost_budget_invalid:${String(cost.budget)}`)
  else if (cost.budget === "ai_tokens" && cost.tokens <= 0) errors.push("cost_tokens_missing_for_ai_lane")

  if (typeof d.tenant_entitlement !== "string" || !(d.tenant_entitlement === BASE_PLAN_ENTITLEMENT || /^[a-z][a-z0-9_]*$/.test(d.tenant_entitlement))) errors.push("tenant_entitlement_invalid")

  // wave 137 — the full contract; ceilings DERIVED from the registry (never raised or lowered by the declaration).
  const ceil = derivedSkillCeilings(caps)
  if (ceil.features.length > 1) errors.push(`entitlement_multiple_features:${ceil.features.join("+")}`)
  else if (ceil.features.length === 1 && d.tenant_entitlement !== ceil.features[0]) errors.push(`entitlement_understated:${ceil.features[0]}`)
  if (d.publisher !== undefined && !(SKILL_PUBLISHERS as readonly string[]).includes(d.publisher)) errors.push(`publisher_invalid:${String(d.publisher)}`)
  if (d.max_cost !== undefined) {
    const m = d.max_cost
    if (!m || !Number.isFinite(m.usd) || !Number.isFinite(m.tokens) || m.usd < 0 || m.tokens < 0) errors.push("max_cost_invalid")
    else if (cost && (m.usd < cost.usd || m.tokens < cost.tokens)) errors.push("max_cost_below_estimate")
  }
  if (d.external_write !== undefined) {
    const w = SKILL_EXTERNAL_WRITES.indexOf(d.external_write)
    if (w < 0) errors.push(`external_write_invalid:${String(d.external_write)}`)
    else if (w < SKILL_EXTERNAL_WRITES.indexOf(ceil.externalWrite)) errors.push(`external_write_understated:${d.external_write}<${ceil.externalWrite}`)
  }

  if (typeof d.evaluation_suite !== "string" || !d.evaluation_suite.trim()) errors.push("no_evaluation_suite")
  else if (!opts.knownEvaluationSuites.has(d.evaluation_suite)) errors.push(`unknown_evaluation_suite:${d.evaluation_suite}`)

  if (validSchema(d.inputs, "inputs", errors)) {
    const names = new Set(d.inputs.fields.map((f) => f.name))
    for (const f of d.inputs.fields) if (TENANT_INPUT_NAMES.has(f.name)) errors.push(`tenant_from_input:${f.name}`)
    for (const c of caps) {
      if (!(c in APP_CAPABILITY_REGISTRY)) continue
      for (const s of parseInputSpec(APP_CAPABILITY_REGISTRY[c].inputs)) {
        if (s.required && !TENANT_INPUT_NAMES.has(s.name) && !names.has(s.name)) errors.push(`capability_input_uncovered:${c}.${s.name}`)
      }
    }
  }
  validSchema(d.outputs, "outputs", errors)
  return { ok: errors.length === 0, errors }
}

/** PURE — do these inputs satisfy the schema (required present, types match, no tenant key)? */
export function validateSkillInputs(schema: SkillSchema, inputs: Record<string, unknown>): string[] {
  const errors: string[] = []
  const declared = new Map(schema.fields.map((f) => [f.name, f]))
  for (const k of Object.keys(inputs ?? {})) {
    if (TENANT_INPUT_NAMES.has(k)) errors.push(`tenant_from_input:${k}`)
    else if (!declared.has(k)) errors.push(`undeclared_input:${k}`)
  }
  for (const f of schema.fields) {
    const v = (inputs ?? {})[f.name]
    if (v === undefined || v === null) { if (f.required) errors.push(`input_missing:${f.name}`); continue }
    const ok =
      f.type === "string" ? typeof v === "string" :
      f.type === "number" ? typeof v === "number" && Number.isFinite(v) :
      f.type === "boolean" ? typeof v === "boolean" :
      f.type === "uuid" ? typeof v === "string" && /^[0-9a-f-]{8,64}$/i.test(v) :
      f.type === "iso_datetime" ? typeof v === "string" && !Number.isNaN(Date.parse(v)) :
      f.type === "array" ? Array.isArray(v) :
      typeof v === "object" && !Array.isArray(v)
    if (!ok) errors.push(`input_type:${f.name}:${f.type}`)
  }
  return errors
}

// ─── evaluation suites (marketplace) ──────────────────────────────────────────────────────────
export interface SkillEvaluationEvidence {
  suite: string
  passed: boolean
  checks: Array<{ name: string; ok: boolean; detail?: string }>
}

/** The runtime evaluators a marketplace skill may name. Deterministic, platform-owned — a submitter never
 *  supplies the evaluator, only the fixtures it is judged on. */
export const SKILL_EVALUATORS: Readonly<Record<string, (d: SkillDeclaration) => SkillEvaluationEvidence>> = Object.freeze({
  "skill_eval:contract_v1": (d: SkillDeclaration): SkillEvaluationEvidence => {
    const suite = "skill_eval:contract_v1"
    const v = validateSkillDeclaration(d, { knownEvaluationSuites: knownEvaluationSuites() })
    const fixtures = Array.isArray(d.evaluation_fixtures) ? d.evaluation_fixtures : []
    const checks: SkillEvaluationEvidence["checks"] = [
      { name: "declaration_valid", ok: v.ok, detail: v.errors.join(", ") || undefined },
      { name: "has_fixtures", ok: fixtures.length > 0, detail: `${fixtures.length} fixture(s)` },
      { name: "outputs_are_the_kernel_receipt", ok: JSON.stringify(d.outputs) === JSON.stringify(SKILL_RUN_RECEIPT_SCHEMA) },
    ]
    fixtures.forEach((f, i) => {
      const errs = d.inputs?.fields ? validateSkillInputs(d.inputs, f) : ["inputs_schema_missing"]
      checks.push({ name: `fixture_${i + 1}_satisfies_inputs`, ok: errs.length === 0, detail: errs.join(", ") || undefined })
    })
    return { suite, passed: checks.every((c) => c.ok), checks }
  },
})

/** Every evaluation suite id the validator accepts: the built-ins' proof keys + the runtime evaluators. */
export function knownEvaluationSuites(): ReadonlySet<string> {
  return new Set<string>([DEFAULT_SKILL_PROOF, ...Object.values(CAPABILITY_PROOF).filter((x): x is string => !!x), ...Object.keys(SKILL_EVALUATORS)])
}

// ─── THE CUSTOM MANAGER CONTRACT (wave 137, lane 137D) ────────────────────────────────────────
// A tenant / third-party "manager" is a CONTRACT, never a new seat: it never becomes a ManagerKey, never owns a
// capability, never changes MANAGERS / CAPABILITY_MANAGER / another manager's authority. It REQUESTS capabilities
// from their owning managers (requestDelegation) under a ceiling no higher than its escalation owner's, and every
// registration goes through registerCustomManager below, which validates against the EXISTING manager registry
// (lib/kernel/manager-registry.ts MANAGERS + PLATFORM_MANAGERS — that module is import-free by design so the UI can
// share it, so the validated door lives here beside the skill contract) and returns a FROZEN registry entry.

/** Context a custom manager may read — each one an existing reader (no raw DB access):
 *  mission_context = lib/kernel/mission-context.ts compileManagerContext; contact_memory = lib/kernel/
 *  conversation-memory.ts loadContactMemoryForPrompt (via the compiler's memory slice). ENFORCED (wave 138D) by the
 *  compiler itself: CONTEXT_SLICES_BY_MEMORY_ACCESS in mission-context.ts — an undeclared slice is never read. */
export const CUSTOM_MANAGER_MEMORY_ACCESS = ["none", "mission_context", "contact_memory"] as const
export type CustomManagerMemoryAccess = (typeof CUSTOM_MANAGER_MEMORY_ACCESS)[number]

export interface CustomManagerDeclaration {
  name: string
  version: number
  /** Responsibility (one sentence) + the domain it works in. */
  responsibility: string
  domain: string
  /** The capabilities it may REQUEST (each still executed by CAPABILITY_MANAGER[c] through delegation). */
  allowed_capabilities: readonly AppCapability[]
  /** Built-in manager skills it may run (each skill's capability must be allowed). */
  tools: readonly string[]
  /** Its authority ceiling — ≤ its escalation owner's ceiling (managerAuthorityCeiling). */
  authority_ceiling: AuthorityLevel
  /** Tenant operating-policy keys it is governed by (lib/kernel/tenant-policy.ts TENANT_POLICY_SETTINGS_KEYS). */
  policy_requirements: readonly string[]
  /** Per-run spend ceiling, metered through mayUseAndAfford (comms.send USD / ai.generate tokens). */
  budget: { max_usd_per_run: number; max_tokens_per_run: number }
  memory_access: CustomManagerMemoryAccess
  /** lib/kernel/missions.ts MISSION_TYPES it may serve. */
  mission_types: readonly MissionType[]
  /** The EXISTING manager it escalates to and requests as (a MANAGERS key). */
  escalation_owner: ManagerKey
  /** A CUSTOM_MANAGER_EVALUATORS id (platform-owned). */
  evaluation_suite: string
}

const CUSTOM_MANAGER_KEYS: ReadonlySet<string> = new Set([
  "name", "version", "responsibility", "domain", "allowed_capabilities", "tools", "authority_ceiling", "policy_requirements",
  "budget", "memory_access", "mission_types", "escalation_owner", "evaluation_suite",
])

/** PURE — a manager's authority CEILING, derived from what it owns: the highest rung any of its capabilities'
 *  risk bands reaches (CAPABILITY_MANAGER × capabilityRiskClass × authorityBandFor). 0 = owns nothing AI-runnable.
 *  @proofSeam the proof asserts a custom manager's ceiling is refused one rung above its escalation owner's */
export function managerAuthorityCeiling(m: ManagerKey): number {
  let ceiling = 0
  for (const c of Object.keys(APP_CAPABILITY_REGISTRY) as AppCapability[]) {
    if (CAPABILITY_MANAGER[c] !== m) continue
    const band = authorityBandFor(capabilityRiskClass(c))
    if (band) ceiling = Math.max(ceiling, band.max)
  }
  return ceiling
}

/** PURE — the custom-manager contract validator (the ONE gate before registration, evaluation and every run).
 *  @proofSeam the proof asserts each refusal code directly (production reaches it through registerCustomManager) */
export function validateCustomManagerDeclaration(d: CustomManagerDeclaration): SkillValidation {
  const errors: string[] = []
  if (!d || typeof d !== "object") return { ok: false, errors: ["declaration_missing"] }
  for (const k of Object.keys(d)) if (!CUSTOM_MANAGER_KEYS.has(k)) errors.push(`not_data:${k}`)
  if (typeof d.name !== "string" || !/^[a-z][a-z0-9_]{2,63}$/.test(d.name)) errors.push("name_invalid")
  else if (d.name in MANAGERS || d.name in PLATFORM_MANAGERS) errors.push(`name_shadows_manager:${d.name}`)
  if (!Number.isInteger(d.version) || d.version < 1) errors.push("version_invalid")
  if (typeof d.responsibility !== "string" || !d.responsibility.trim()) errors.push("responsibility_missing")
  if (typeof d.domain !== "string" || !d.domain.trim()) errors.push("domain_missing")
  const ownerKnown = typeof d.escalation_owner === "string" && d.escalation_owner in MANAGERS
  if (!ownerKnown) errors.push(`unknown_escalation_owner:${String(d.escalation_owner)}`)
  const ownerCeiling = ownerKnown ? managerAuthorityCeiling(d.escalation_owner) : 0
  if (!isAuthorityLevel(d.authority_ceiling)) errors.push("authority_ceiling_invalid")
  else if (d.authority_ceiling > ownerCeiling) errors.push(`authority_ceiling_exceeds_escalation_owner:${d.authority_ceiling}>${ownerCeiling}`)
  const caps: readonly string[] = Array.isArray(d.allowed_capabilities) ? d.allowed_capabilities : []
  if (!caps.length) errors.push("no_capabilities")
  for (const c of caps) {
    if (!(c in APP_CAPABILITY_REGISTRY)) { errors.push(`unknown_capability:${c}`); continue }
    const min = MIN_AUTHORITY_FOR_RISK[capabilityRiskClass(c as AppCapability)]
    if (min === null) errors.push(`risk_never_ai:${c}`)
    else if (isAuthorityLevel(d.authority_ceiling) && min > d.authority_ceiling) errors.push(`capability_above_ceiling:${c}:${min}>${d.authority_ceiling}`)
  }
  for (const t of Array.isArray(d.tools) ? d.tools : ["<not an array>"]) {
    const sk = builtinSkill(t)
    if (!sk) errors.push(`unknown_tool:${t}`)
    else if (!sk.required_capabilities.every((c) => caps.includes(c))) errors.push(`tool_outside_allowed_capabilities:${t}`)
  }
  for (const p of Array.isArray(d.policy_requirements) ? d.policy_requirements : ["<not an array>"]) {
    if (!(p in TENANT_POLICY_SETTINGS_KEYS)) errors.push(`unknown_policy_key:${p}`)
  }
  const b = d.budget
  if (!b || !Number.isFinite(b.max_usd_per_run) || !Number.isFinite(b.max_tokens_per_run) || b.max_usd_per_run < 0 || b.max_tokens_per_run < 0) errors.push("budget_invalid")
  if (!(CUSTOM_MANAGER_MEMORY_ACCESS as readonly string[]).includes(d.memory_access)) errors.push(`memory_access_invalid:${String(d.memory_access)}`)
  const types: readonly string[] = Array.isArray(d.mission_types) ? d.mission_types : []
  if (!types.length) errors.push("no_mission_types")
  for (const t of types) if (!(MISSION_TYPES as readonly string[]).includes(t)) errors.push(`unknown_mission_type:${t}`)
  if (typeof d.evaluation_suite !== "string" || !d.evaluation_suite.trim()) errors.push("no_evaluation_suite")
  else if (!(d.evaluation_suite in CUSTOM_MANAGER_EVALUATORS)) errors.push(`unknown_evaluation_suite:${d.evaluation_suite}`)
  return { ok: errors.length === 0, errors }
}

/** A REGISTERED custom manager — frozen; a key in its own `custom:` namespace, never a ManagerKey. */
export interface CustomManagerEntry {
  readonly key: string
  readonly name: string
  readonly version: number
  readonly responsibility: string
  readonly domain: string
  readonly escalation_owner: ManagerKey
  readonly escalation_label: string
  readonly authority_ceiling: AuthorityLevel
  readonly allowed_capabilities: readonly AppCapability[]
  /** Who EXECUTES each allowed capability — read from CAPABILITY_MANAGER, never written. */
  readonly capability_owners: Readonly<Record<string, ManagerKey>>
  readonly tools: readonly string[]
  readonly policy_requirements: readonly string[]
  readonly budget: Readonly<{ max_usd_per_run: number; max_tokens_per_run: number }>
  readonly memory_access: CustomManagerMemoryAccess
  readonly mission_types: readonly MissionType[]
  readonly evaluation_suite: string
}

/**
 * THE ONE REGISTRATION DOOR for a custom manager: validates against the existing registry and returns a frozen
 * entry. It writes NOTHING into MANAGERS, PLATFORM_MANAGERS or CAPABILITY_MANAGER (the proof snapshots them) — a
 * custom manager exists only as this entry, materialised from an ENABLED extension row at run time.
 */
export function registerCustomManager(d: CustomManagerDeclaration): { ok: true; entry: CustomManagerEntry } | { ok: false; errors: string[] } {
  const v = validateCustomManagerDeclaration(d)
  if (!v.ok) return { ok: false, errors: v.errors }
  const caps = Object.freeze([...d.allowed_capabilities])
  return {
    ok: true,
    entry: Object.freeze({
      key: `custom:${d.name}`, name: d.name, version: d.version, responsibility: d.responsibility, domain: d.domain,
      escalation_owner: d.escalation_owner, escalation_label: MANAGERS[d.escalation_owner].label, authority_ceiling: d.authority_ceiling,
      allowed_capabilities: caps,
      capability_owners: Object.freeze(Object.fromEntries(caps.map((c) => [c, CAPABILITY_MANAGER[c]]))),
      tools: Object.freeze([...d.tools]), policy_requirements: Object.freeze([...d.policy_requirements]),
      budget: Object.freeze({ ...d.budget }), memory_access: d.memory_access,
      mission_types: Object.freeze([...d.mission_types]), evaluation_suite: d.evaluation_suite,
    }),
  }
}

/** Platform-owned evaluators a custom manager may name (deterministic; the submitter never supplies one). */
export const CUSTOM_MANAGER_EVALUATORS: Readonly<Record<string, (d: CustomManagerDeclaration) => SkillEvaluationEvidence>> = Object.freeze({
  "extension_eval:custom_manager_contract_v1": (d: CustomManagerDeclaration): SkillEvaluationEvidence => {
    const before = stableSkillJson({ m: Object.keys(MANAGERS), p: Object.keys(PLATFORM_MANAGERS), c: CAPABILITY_MANAGER })
    const reg = registerCustomManager(d)
    const after = stableSkillJson({ m: Object.keys(MANAGERS), p: Object.keys(PLATFORM_MANAGERS), c: CAPABILITY_MANAGER })
    const checks: SkillEvaluationEvidence["checks"] = [
      { name: "contract_valid", ok: reg.ok, detail: reg.ok ? undefined : reg.errors.join(", ") },
      { name: "registry_unaltered", ok: before === after },
      { name: "entry_frozen_outside_manager_keys", ok: reg.ok && Object.isFrozen(reg.entry) && !(reg.entry.key in MANAGERS) },
      { name: "ceiling_within_escalation_owner", ok: reg.ok && reg.entry.authority_ceiling <= managerAuthorityCeiling(reg.entry.escalation_owner) },
    ]
    return { suite: "extension_eval:custom_manager_contract_v1", passed: checks.every((c) => c.ok), checks }
  },
})

// ─── ONE EXTENSION LIFECYCLE (wave 137, lane 137D — m738 generalises m727 skill_marketplace_listings) ────────
export const SKILL_PUBLISHERS = ["platform", "tenant", "third_party"] as const
export type SkillPublisher = (typeof SKILL_PUBLISHERS)[number]

export const EXTENSION_KINDS = ["skill", "strategy", "provider_adapter", "custom_manager", "webhook_app"] as const
export type ExtensionKind = (typeof EXTENSION_KINDS)[number]

// TOMBSTONE (m738): the m727 statuses submitted / evaluated / published / revoked / rejected and the names
// SKILL_LISTING_STATUSES / SKILL_LISTING_TRANSITIONS / canSkillListingTransition / isSkillListingRunnableBy are
// RETIRED — submitted → draft, evaluated → validated, published → enabled, revoked → disabled, rejected → disabled
// (validation failed). SURVIVORS: EXTENSION_STATUSES / EXTENSION_TRANSITIONS / canExtensionTransition /
// isExtensionExecutableBy, directly below.
export const EXTENSION_STATUSES = ["draft", "validated", "approved", "enabled", "suspended", "deprecated", "disabled"] as const
export type ExtensionStatus = (typeof EXTENSION_STATUSES)[number]

export const EXTENSION_TRANSITIONS: Readonly<Record<ExtensionStatus, readonly ExtensionStatus[]>> = Object.freeze({
  draft: ["validated", "disabled"],
  validated: ["approved", "disabled"],
  approved: ["enabled", "disabled"],
  enabled: ["suspended", "deprecated", "disabled"],
  suspended: ["enabled", "disabled"],
  deprecated: ["disabled"],
  disabled: [],
})

export function canExtensionTransition(from: ExtensionStatus, to: ExtensionStatus): boolean {
  return EXTENSION_TRANSITIONS[from]?.includes(to) ?? false
}

/** Statuses that may EXECUTE. Deprecated keeps running where already enabled; it can never be newly enabled.
 *  SUSPENDED and DISABLED never execute — the kill switch. */
export const EXTENSION_EXECUTABLE_STATUSES: ReadonlySet<ExtensionStatus> = new Set<ExtensionStatus>(["enabled", "deprecated"])

/** Kinds a tenant can never toggle: provider routing stays platform-controlled (CONTACT_PROVIDER_ROUTES /
 *  routeCapability own the route table). */
export const PLATFORM_ONLY_EXTENSION_KINDS: ReadonlySet<ExtensionKind> = new Set<ExtensionKind>(["provider_adapter"])

// ─── CONTRACTS FOR THE KINDS WHOSE SHAPE LIVES IN ANOTHER SURVIVOR (wave 138, lane 138D) ─────────────────
// Each is a thin ENVELOPE ({ name, version, <the survivor's own shape>, evaluation_suite }) judged AGAINST that
// survivor — never a second copy of its rules: strategy → lib/kernel/strategy-library.ts (StrategyDefinition,
// CAPABILITY_MANAGER ownership, the library's own market vocabulary); provider_adapter → lib/kernel/provider-adapters.ts
// validateProviderAdapter + the route table (routedProviders / adapterFor); webhook_app → lib/platform/
// tenant-webhooks-core.ts (the APPROVED event catalogue + its allow-list payload projection).
const EXT_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
function envelopeErrors(d: unknown, keys: ReadonlySet<string>): string[] {
  if (!isObj(d)) return ["declaration_missing"]
  const errors: string[] = []
  for (const k of Object.keys(d)) if (!keys.has(k)) errors.push(`not_data:${k}`)
  if (typeof d.name !== "string" || !EXT_NAME_RE.test(d.name)) errors.push("name_invalid")
  if (!Number.isInteger(d.version) || (d.version as number) < 1) errors.push("version_invalid")
  if (typeof d.evaluation_suite !== "string" || !d.evaluation_suite.trim()) errors.push("no_evaluation_suite")
  return errors
}

/** A STRATEGY extension: a tenant / third-party StrategyDefinition, versioned, composed only of registered capabilities. */
export interface StrategyExtensionDeclaration { name: string; version: number; strategy: StrategyDefinition; evaluation_suite: string }
const STRATEGY_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["name", "version", "strategy", "evaluation_suite"])
const STRATEGY_DEFINITION_KEYS: ReadonlySet<string> = new Set([
  "key", "version", "tier", "title", "objective", "missionType", "ownerManager", "eligibility", "steps", "budget", "authority",
  "timing", "fatigue", "exitCriteria", "outcomeMetrics", "audience", "marketSuitability", "averageCostUsd", "priority",
])
/** The market vocabulary and the eligibility facts are DERIVED from the platform library (never restated here). A
 *  strategy that names a fact the library never judges (a city, a ZIP, a territory name) is refused. */
const LIBRARY_MARKETS: ReadonlySet<string> = new Set(PLATFORM_STRATEGY_LIBRARY.flatMap((s) => [...s.marketSuitability]))
const LIBRARY_FACTS: ReadonlySet<string> = new Set(PLATFORM_STRATEGY_LIBRARY.flatMap((s) => [...s.eligibility.all, ...(s.eligibility.any ?? [])].map((c) => c.fact as string)))
const POSTAL_CODE_RE = /^\d{5}(-\d{4})?$/

/** PURE — the strategy extension contract. @proofSeam the proof asserts each refusal code directly (production
 *  reaches it through validateExtensionDeclaration) */
export function validateStrategyExtension(d: unknown): SkillValidation {
  const errors = envelopeErrors(d, STRATEGY_ENVELOPE_KEYS)
  if (errors[0] === "declaration_missing") return { ok: false, errors }
  const env = d as Record<string, unknown>
  const s = env.strategy as StrategyDefinition | undefined
  if (!isObj(s)) return { ok: false, errors: [...errors, "strategy_missing"] }
  for (const k of Object.keys(s)) if (!STRATEGY_DEFINITION_KEYS.has(k)) errors.push(`not_data:strategy.${k}`)
  if (s.key !== env.name) errors.push("name_must_equal_strategy_key")
  if (s.version !== env.version) errors.push("version_must_equal_strategy_version")
  if (typeof s.key === "string" && platformStrategy(s.key)) errors.push(`key_shadows_platform_strategy:${s.key}`)
  if (!(STRATEGY_TIERS as readonly string[]).includes(s.tier)) errors.push(`tier_invalid:${String(s.tier)}`)
  if (!(MISSION_TYPES as readonly string[]).includes(s.missionType)) errors.push(`unknown_mission_type:${String(s.missionType)}`)
  const steps = Array.isArray(s.steps) ? s.steps : []
  if (!steps.length) errors.push("no_steps")
  for (const st of steps) {
    if (!isObj(st) || !(typeof st.manager === "string" && st.manager in MANAGERS)) { errors.push(`unknown_step_manager:${String((st as { manager?: unknown })?.manager)}`); continue }
    const caps: readonly string[] = Array.isArray(st.capabilities) ? st.capabilities : []
    // Composed ONLY of registered capabilities: a step that names a gap (no catalogue key) cannot be executed.
    if (!caps.length || st.gap) errors.push(`step_not_composable:${st.manager}`)
    for (const c of caps) {
      if (!(c in APP_CAPABILITY_REGISTRY)) { errors.push(`unregistered_capability:${c}`); continue }
      if (CAPABILITY_MANAGER[c as AppCapability] !== st.manager) errors.push(`capability_not_owned_by_step_manager:${c}:${st.manager}`)
      if (MIN_AUTHORITY_FOR_RISK[capabilityRiskClass(c as AppCapability)] === null) errors.push(`risk_never_ai:${c}`)
    }
  }
  if (!steps.some((st) => isObj(st) && st.manager === s.ownerManager)) errors.push("owner_not_a_step_manager")
  if (!isObj(s.authority) || !isAuthorityLevel(s.authority.recommended) || !["per_authority", "always"].includes(s.authority.approval as string)) errors.push("authority_invalid")
  if (!isObj(s.budget) || !Number.isFinite(s.budget.usd) || s.budget.usd < 0) errors.push("budget_invalid")
  const el = s.eligibility
  const subjects: readonly string[] = isObj(el) && Array.isArray(el.subjectTypes) ? el.subjectTypes : []
  if (!subjects.length || subjects.some((t) => !(STRATEGY_SUBJECT_TYPES as readonly string[]).includes(t))) errors.push("subject_types_invalid")
  // NO HARD-CODED LOCATION (owner, wave 108: territories are anywhere in the US).
  const clauses = isObj(el) ? [...(Array.isArray(el.all) ? el.all : []), ...(Array.isArray(el.any) ? el.any : [])] : []
  for (const c of clauses) {
    if (!LIBRARY_FACTS.has(c?.fact as string)) errors.push(`unknown_fact:${String(c?.fact)}`)
    const vals: readonly unknown[] = Array.isArray(c?.value) ? c.value : [c?.value]
    if (vals.some((v) => typeof v === "string" && POSTAL_CODE_RE.test(v.trim()))) errors.push(`hard_coded_location:${String(c?.fact)}`)
  }
  for (const m of Array.isArray(s.marketSuitability) ? s.marketSuitability : ["<not an array>"]) if (!LIBRARY_MARKETS.has(m)) errors.push(`market_not_in_vocabulary:${m}`)
  return { ok: errors.length === 0, errors }
}

/** A PROVIDER ADAPTER extension: a declaration for a provider the route table ALREADY routes (a provider plugs in
 *  through the route table — LAW 3), validated by THE adapter validator. Platform-controlled (never a tenant's). */
export interface ProviderAdapterExtensionDeclaration { name: string; version: number; adapter: ProviderAdapter; evaluation_suite: string }
const ADAPTER_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["name", "version", "adapter", "evaluation_suite"])

/** PURE — the provider-adapter extension contract. @proofSeam the proof asserts each refusal code directly */
export function validateProviderAdapterExtension(d: unknown): SkillValidation {
  const errors = envelopeErrors(d, ADAPTER_ENVELOPE_KEYS)
  if (errors[0] === "declaration_missing") return { ok: false, errors }
  const a = (d as Record<string, unknown>).adapter as ProviderAdapter | undefined
  // Shape first — validateProviderAdapter reads nested fields and must never be handed a malformed object.
  const shapeOk = isObj(a) && typeof a.provider === "string" && Array.isArray(a.capabilities) && isObj(a.api) && typeof a.api.version === "string"
    && typeof a.api.baseUrl === "string" && Array.isArray(a.api.alternates) && isObj(a.cost) && isObj(a.health) && Array.isArray(a.health.serviceKeys)
    && isObj(a.credential) && Array.isArray(a.credential.envVars)
  if (!shapeOk) return { ok: false, errors: [...errors, "adapter_shape_invalid"] }
  if (a.provider !== (d as { name?: unknown }).name) errors.push("name_must_equal_provider")
  for (const e of validateProviderAdapter(a)) errors.push(`adapter:${e}`)
  if (!routedProviders().includes(a.provider)) errors.push(`unrouted_provider:${a.provider}`)
  else {
    const routed = new Set(adapterFor(a.provider)?.capabilities ?? [])
    for (const c of a.capabilities) if (!routed.has(c)) errors.push(`capability_not_routed_to_provider:${c}`)
  }
  return { ok: errors.length === 0, errors }
}

/** A WEBHOOK APP extension: an external subscriber bounded by the APPROVED event catalogue and its allow-list
 *  projection (it may NARROW a projection, never widen it). No secret, no tenant id, no wildcard. */
export interface WebhookAppDeclaration { name: string; version: number; purpose: string; events: readonly string[]; payload_fields?: Readonly<Record<string, readonly string[]>>; endpoint_url: string; evaluation_suite: string }
const WEBHOOK_APP_KEYS: ReadonlySet<string> = new Set(["name", "version", "purpose", "events", "payload_fields", "endpoint_url", "evaluation_suite"])
const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i

/** PURE — the webhook-app extension contract. @proofSeam the proof asserts each refusal code directly */
export function validateWebhookAppDeclaration(d: unknown): SkillValidation {
  const errors = envelopeErrors(d, WEBHOOK_APP_KEYS)
  if (errors[0] === "declaration_missing") return { ok: false, errors }
  const w = d as Partial<WebhookAppDeclaration>
  if (typeof w.purpose !== "string" || !w.purpose.trim()) errors.push("purpose_missing")
  const events: readonly string[] = Array.isArray(w.events) ? w.events : []
  if (events.includes("*")) errors.push("wildcard_refused")
  const f = validateWebhookEventFilter(events.filter((e) => e !== "*"))
  if (!f.ok) errors.push(`events_invalid:${f.error}`)
  if (w.payload_fields !== undefined) {
    if (!isObj(w.payload_fields)) errors.push("payload_fields_invalid")
    else for (const [ev, fields] of Object.entries(w.payload_fields)) {
      const def = WEBHOOK_EVENT_CATALOG.find((x) => x.event === ev)
      if (!events.includes(ev) || !def) { errors.push(`payload_fields_for_unsubscribed_event:${ev}`); continue }
      for (const k of Array.isArray(fields) ? fields : ["<not an array>"]) if (!def.payloadFields.includes(k)) errors.push(`projection_widened:${ev}.${k}`)
    }
  }
  let host = ""
  try { const u = new URL(String(w.endpoint_url)); if (u.protocol !== "https:") errors.push("endpoint_not_https"); host = u.hostname } catch { errors.push("endpoint_invalid") }
  if (host && PRIVATE_HOST_RE.test(host)) errors.push("endpoint_private_host")
  return { ok: errors.length === 0, errors }
}

const evidenceOf = (suite: string, checks: SkillEvaluationEvidence["checks"]): SkillEvaluationEvidence => ({ suite, passed: checks.every((c) => c.ok), checks })

/** Platform-owned evaluators for the three kinds (deterministic; the submitter never supplies one).
 *  @proofSeam the proof runs each suite on a good and a bad declaration (production reaches it through evaluateExtension) */
export const EXTENSION_CONTRACT_EVALUATORS: Readonly<Record<"strategy" | "provider_adapter" | "webhook_app", Readonly<Record<string, (d: unknown) => SkillEvaluationEvidence>>>> = Object.freeze({
  strategy: Object.freeze({
    "extension_eval:strategy_contract_v1": (d: unknown) => {
      const v = validateStrategyExtension(d)
      const s = (d as StrategyExtensionDeclaration).strategy
      const caps = v.ok ? strategyCapabilities(s) : []
      return evidenceOf("extension_eval:strategy_contract_v1", [
        { name: "contract_valid", ok: v.ok, detail: v.errors.join(", ") || undefined },
        { name: "composed_of_registered_capabilities", ok: v.ok && caps.length > 0 && caps.every((c) => c in APP_CAPABILITY_REGISTRY) },
        { name: "no_hard_coded_location", ok: !v.errors.some((e) => /^(hard_coded_location|unknown_fact|market_not_in_vocabulary)/.test(e)) },
        { name: "versioned", ok: v.ok && Number.isInteger(s.version) && s.version >= 1 },
      ])
    },
  }),
  provider_adapter: Object.freeze({
    "extension_eval:provider_adapter_contract_v1": (d: unknown) => {
      const v = validateProviderAdapterExtension(d)
      return evidenceOf("extension_eval:provider_adapter_contract_v1", [
        { name: "contract_valid", ok: v.ok, detail: v.errors.join(", ") || undefined },
        { name: "routed_through_the_route_table", ok: !v.errors.some((e) => /^(unrouted_provider|capability_not_routed)/.test(e)) },
        { name: "metered", ok: !v.errors.some((e) => /UNMETERED|no declared price/.test(e)) },
      ])
    },
  }),
  webhook_app: Object.freeze({
    "extension_eval:webhook_app_contract_v1": (d: unknown) => {
      const v = validateWebhookAppDeclaration(d)
      const w = d as WebhookAppDeclaration
      // The projection actually built for every subscribed event carries ONLY allow-listed primitive keys — a PII
      // key and a nested object planted on the internal row never leave.
      const leaks: string[] = []
      if (v.ok) for (const ev of w.events) {
        const def = WEBHOOK_EVENT_CATALOG.find((x) => x.event === ev)!
        const metadata: Record<string, unknown> = { email: "x@y.z", phone: "5555550100", nested: { a: 1 } }
        for (const k of def.payloadFields) metadata[k] = "v"
        const p = buildWebhookPayload(ev, { id: "e", event_type: String(def.internalTypes[0]), entity_type: "x", entity_id: "x", brokerage_id: "b", created_at: "t", metadata })
        for (const k of Object.keys(p.data)) if (!def.payloadFields.includes(k)) leaks.push(`${ev}.${k}`)
      }
      return evidenceOf("extension_eval:webhook_app_contract_v1", [
        { name: "contract_valid", ok: v.ok, detail: v.errors.join(", ") || undefined },
        { name: "catalogue_bounded", ok: v.ok && w.events.every((e) => WEBHOOK_EVENT_CATALOG.some((x) => x.event === e)) },
        { name: "projection_allow_list_only", ok: v.ok && leaks.length === 0, detail: leaks.join(", ") || undefined },
      ])
    },
  }),
})

/** PURE — one validator per kind; each judged against its own survivor. An unknown kind fails closed. */
export function validateExtensionDeclaration(kind: ExtensionKind, d: unknown): SkillValidation {
  if (kind === "skill") return validateSkillDeclaration(d as SkillDeclaration, { knownEvaluationSuites: new Set(Object.keys(SKILL_EVALUATORS)) })
  if (kind === "custom_manager") return validateCustomManagerDeclaration(d as CustomManagerDeclaration)
  const v = kind === "strategy" ? validateStrategyExtension(d) : kind === "provider_adapter" ? validateProviderAdapterExtension(d) : kind === "webhook_app" ? validateWebhookAppDeclaration(d) : null
  if (!v) return { ok: false, errors: [`contract_validator_not_registered:${String(kind)}`] }
  const suite = (d as { evaluation_suite?: unknown } | null)?.evaluation_suite
  if (typeof suite === "string" && !(suite in EXTENSION_CONTRACT_EVALUATORS[kind])) v.errors.push(`unknown_evaluation_suite:${suite}`)
  return { ok: v.errors.length === 0, errors: v.errors }
}

/** PURE — run the kind's platform-owned evaluator (null = none exists for that suite / kind). */
export function evaluateExtension(kind: ExtensionKind, d: unknown): SkillEvaluationEvidence | null {
  const suite = (d as { evaluation_suite?: unknown } | null)?.evaluation_suite
  if (typeof suite !== "string") return null
  if (kind === "skill") return SKILL_EVALUATORS[suite]?.(d as SkillDeclaration) ?? null
  if (kind === "custom_manager") return CUSTOM_MANAGER_EVALUATORS[suite]?.(d as CustomManagerDeclaration) ?? null
  if (kind === "strategy" || kind === "provider_adapter" || kind === "webhook_app") return EXTENSION_CONTRACT_EVALUATORS[kind][suite]?.(d) ?? null
  return null
}

export interface EnablementCheck { name: string; ok: boolean; detail?: string }

/**
 * PURE — what ENABLEMENT requires (approved → enabled, suspended → enabled): contract validation, evaluation
 * pass, security / risk classification, dependency availability, an intact digest. Tenant compatibility +
 * entitlement are per-tenant and asked by the kernel at enablement (mayUseAndAfford) — they are not pure.
 */
export function extensionEnablementChecks(row: { extension_kind: ExtensionKind; declaration: unknown; evaluation_evidence: SkillEvaluationEvidence | null }, digestOk: boolean): EnablementCheck[] {
  const v = validateExtensionDeclaration(row.extension_kind, row.declaration)
  const checks: EnablementCheck[] = [
    { name: "contract_valid", ok: v.ok, detail: v.errors.join(", ") || undefined },
    { name: "evaluation_passed", ok: row.evaluation_evidence?.passed === true },
    { name: "digest_intact", ok: digestOk },
  ]
  if (row.extension_kind === "skill") {
    const d = row.declaration as SkillDeclaration
    const caps: readonly AppCapability[] = Array.isArray(d?.required_capabilities) ? d.required_capabilities : []
    checks.push({ name: "risk_classified", ok: !!authorityBandFor(d?.risk_class) && caps.every((c) => c in APP_CAPABILITY_REGISTRY && MIN_AUTHORITY_FOR_RISK[capabilityRiskClass(c)] !== null) })
    const missing = caps.filter((c) => !(c in APP_CAPABILITY_REGISTRY) || CAPABILITY_MANAGER[c] !== d.manager_owner)
    checks.push({ name: "dependencies_available", ok: !!d && d.manager_owner in MANAGERS && missing.length === 0 && !!SKILL_EVALUATORS[d.evaluation_suite], detail: missing.join(", ") || undefined })
  } else if (row.extension_kind === "custom_manager") {
    const d = row.declaration as CustomManagerDeclaration
    const caps = Array.isArray(d?.allowed_capabilities) ? d.allowed_capabilities : []
    checks.push({ name: "risk_classified", ok: caps.length > 0 && caps.every((c) => c in APP_CAPABILITY_REGISTRY && MIN_AUTHORITY_FOR_RISK[capabilityRiskClass(c)] !== null) })
    checks.push({ name: "dependencies_available", ok: !!d && d.escalation_owner in MANAGERS && (d.tools ?? []).every((t) => !!builtinSkill(t)) && (d.policy_requirements ?? []).every((p) => p in TENANT_POLICY_SETTINGS_KEYS) })
  } else if (row.extension_kind === "strategy") {
    // Re-asked at enablement time: capability ownership may have moved since validation.
    const s = (row.declaration as StrategyExtensionDeclaration | null)?.strategy
    const steps: readonly StrategyDefinition["steps"][number][] = Array.isArray(s?.steps) ? s.steps : []
    const capsOf = (st: StrategyDefinition["steps"][number]): readonly AppCapability[] => (Array.isArray(st?.capabilities) ? st.capabilities : [])
    const caps = steps.flatMap(capsOf)
    checks.push({ name: "risk_classified", ok: caps.length > 0 && caps.every((c) => c in APP_CAPABILITY_REGISTRY && MIN_AUTHORITY_FOR_RISK[capabilityRiskClass(c)] !== null) })
    const moved = steps.flatMap((st) => capsOf(st).filter((c) => CAPABILITY_MANAGER[c] !== st.manager).map((c) => `${c}:${st.manager}`))
    checks.push({ name: "dependencies_available", ok: steps.length > 0 && steps.every((st) => st?.manager in MANAGERS) && moved.length === 0, detail: moved.join(", ") || undefined })
  } else if (row.extension_kind === "provider_adapter") {
    const a = (row.declaration as ProviderAdapterExtensionDeclaration | null)?.adapter
    const v = validateProviderAdapterExtension(row.declaration)
    checks.push({ name: "risk_classified", ok: v.ok && !v.errors.some((e) => /UNMETERED|no declared price/.test(e)), detail: "a paid adapter names its usage booking" })
    checks.push({ name: "dependencies_available", ok: !!a && typeof a.provider === "string" && routedProviders().includes(a.provider) && !!adapterFor(a.provider) })
  } else if (row.extension_kind === "webhook_app") {
    const w = row.declaration as WebhookAppDeclaration | null
    const events: readonly string[] = Array.isArray(w?.events) ? w.events : []
    checks.push({ name: "risk_classified", ok: events.length > 0 && !events.includes("*"), detail: "external_message — catalogue events, allow-list projection" })
    checks.push({ name: "dependencies_available", ok: events.length > 0 && events.every((e) => WEBHOOK_EVENT_CATALOG.some((x) => x.event === e)) })
  } else {
    checks.push({ name: "risk_classified", ok: false, detail: `no contract registered for ${String(row.extension_kind)}` })
    checks.push({ name: "dependencies_available", ok: false, detail: `no contract registered for ${String(row.extension_kind)}` })
  }
  return checks
}

export interface SkillApprover { isPlatformStaff: boolean; isTenantAdmin: boolean; brokerageId: string | null }

/** PURE — who may move an extension through its lifecycle: platform staff for third-party and platform listings; a
 *  tenant admin of the SAME brokerage for a tenant-authored one (never another tenant's). Platform staff never
 *  approve / enable a tenant's own extension — but they hold the platform KILL SWITCH (suspend / disable) on
 *  every listing. */
export function canDecideSkillListing(listing: { publisher: SkillPublisher; brokerage_id: string | null }, actor: SkillApprover, decision?: string): boolean {
  if (listing.publisher === "tenant") {
    if (actor.isPlatformStaff && (decision === "suspend" || decision === "disable")) return true
    return actor.isTenantAdmin && !!actor.brokerageId && actor.brokerageId === listing.brokerage_id
  }
  return actor.isPlatformStaff
}

/** PURE — may this tenant EXECUTE this extension? An executable status only. A tenant-authored extension runs
 *  only inside its own tenant (its own lifecycle IS its enablement); a global one only where THIS tenant enabled
 *  it (tenant policy `extensions` — tenantEnabled). */
export function isExtensionExecutableBy(listing: { publisher: SkillPublisher; brokerage_id: string | null; status: ExtensionStatus }, brokerageId: string, tenantEnabled: boolean): boolean {
  if (!EXTENSION_EXECUTABLE_STATUSES.has(listing.status)) return false
  if (listing.publisher === "tenant") return listing.brokerage_id === brokerageId
  return tenantEnabled
}

/** PURE — may a tenant admin OPT IN to (or out of) this extension for their tenant? Global listings only; a
 *  platform-only kind never; opting IN needs `enabled` (a deprecated extension takes no new tenants). */
export function tenantEnablementRefusal(listing: { publisher: SkillPublisher; status: ExtensionStatus; extension_kind: ExtensionKind }, enable: boolean): string | null {
  if (listing.publisher === "tenant") return "tenant_listing_uses_its_own_lifecycle"
  if (PLATFORM_ONLY_EXTENSION_KINDS.has(listing.extension_kind)) return `platform_controlled:${listing.extension_kind}`
  if (enable && listing.status !== "enabled") return `not_enableable:${listing.status}`
  return null
}

/** PURE — a stable serialisation for the declaration digest (key order independent). */
export function stableSkillJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableSkillJson).join(",")}]`
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableSkillJson((v as Record<string, unknown>)[k])}`).join(",")}}`
  return JSON.stringify(v)
}

export function skillRef(d: Pick<SkillDeclaration, "name" | "version">): string { return `${d.name}@v${d.version}` }
