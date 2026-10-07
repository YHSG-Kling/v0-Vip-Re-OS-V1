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
 * PURE — no I/O — so the proof asserts every rule directly. The runtime (submit / evaluate / approve / publish /
 * revoke / runSkill) is lib/kernel/skill-marketplace.ts.
 */
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { APP_CAPABILITY_REGISTRY, type AppCapability } from "@/lib/agentic-os/app-capability-registry"
import { CAPABILITY_MANAGER } from "@/lib/agentic-os/capability-ownership"
import { parseInputSpec } from "@/lib/agentic-os/invoke-planner"
import { MIN_AUTHORITY_FOR_RISK, isAuthorityLevel, type AuthorityLevel, type ToolRiskClass } from "@/lib/ai-isa/persona-tool-policy"
import { capabilityRiskClass } from "@/lib/kernel/mission-controller"
import { paidCapabilitiesFor } from "@/lib/kernel/manager-delegation"

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
}

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
  }
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

// ─── the marketplace lifecycle ────────────────────────────────────────────────────────────────
export const SKILL_PUBLISHERS = ["platform", "tenant", "third_party"] as const
export type SkillPublisher = (typeof SKILL_PUBLISHERS)[number]
export const SKILL_LISTING_STATUSES = ["submitted", "evaluated", "approved", "published", "revoked", "rejected"] as const
export type SkillListingStatus = (typeof SKILL_LISTING_STATUSES)[number]

export const SKILL_LISTING_TRANSITIONS: Readonly<Record<SkillListingStatus, readonly SkillListingStatus[]>> = Object.freeze({
  submitted: ["evaluated", "rejected"],
  evaluated: ["approved", "rejected"],
  approved: ["published", "revoked"],
  published: ["revoked"],
  revoked: [],
  rejected: [],
})

export function canSkillListingTransition(from: SkillListingStatus, to: SkillListingStatus): boolean {
  return SKILL_LISTING_TRANSITIONS[from]?.includes(to) ?? false
}

export interface SkillApprover { isPlatformStaff: boolean; isTenantAdmin: boolean; brokerageId: string | null }

/** PURE — who may approve / publish / revoke: platform staff for third-party and platform skills; a tenant
 *  admin of the SAME brokerage for a tenant-authored skill (never another tenant's, never platform staff
 *  acting as the tenant). */
export function canDecideSkillListing(listing: { publisher: SkillPublisher; brokerage_id: string | null }, actor: SkillApprover): boolean {
  if (listing.publisher === "tenant") return actor.isTenantAdmin && !!actor.brokerageId && actor.brokerageId === listing.brokerage_id
  return actor.isPlatformStaff
}

/** PURE — may this tenant RUN this listing? Published only; a tenant-authored skill only inside its tenant. */
export function isSkillListingRunnableBy(listing: { publisher: SkillPublisher; brokerage_id: string | null; status: SkillListingStatus }, brokerageId: string): boolean {
  if (listing.status !== "published") return false
  return listing.publisher !== "tenant" || listing.brokerage_id === brokerageId
}

/** PURE — a stable serialisation for the declaration digest (key order independent). */
export function stableSkillJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableSkillJson).join(",")}]`
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableSkillJson((v as Record<string, unknown>)[k])}`).join(",")}}`
  return JSON.stringify(v)
}

export function skillRef(d: Pick<SkillDeclaration, "name" | "version">): string { return `${d.name}@v${d.version}` }
