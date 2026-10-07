#!/usr/bin/env tsx
/**
 * scripts/extension-lifecycle-guard.ts   (npm run test:extension-lifecycle) — wave 137, lane 137D.
 * ─────────────────────────────────────────────────────────────────────────────
 * SKILL + CUSTOM-MANAGER CONTRACTS · ONE EXTENSION LIFECYCLE · TENANT EXTENSION CONTROL. In-memory client, no
 * network. Proves lib/kernel/skill-registry.ts + lib/kernel/skill-marketplace.ts (m738):
 *   A. the full skill contract — wave-108-shaped declarations stay valid (optional-with-derivation); derived
 *      ceilings: a declaration cannot self-grant authority / scope / entitlement / provenance
 *   B. the RUNTIME capability bound — an undeclared capability is refused at CALL time, nothing delegated
 *   C. the custom-manager contract — registers only through registerCustomManager, frozen, registry unaltered,
 *      ceiling ≤ its escalation owner's; its run path respects the bound, the ceiling and the owner's rung
 *   D. one lifecycle — the transition table, legal + illegal moves; the kill switch (suspended / disabled cannot
 *      execute — skill AND custom manager) keeps every piece of evidence; kinds without a contract fail closed
 *   E. tenant extension control — opt-in through the REAL versioned tenant-policy writer; cross-tenant refused;
 *      platform-only kinds refused; entitlement refused → nothing written; unreadable enablement fails closed
 *   F. run-path census — every capability call sits inside withActionLedger; no raw DB; one writer of the table
 *   G. registration + one vocabulary (migration CHECKs = the code's lists; rule, not waypoint)
 *   H. (wave 138D) the strategy / provider_adapter / webhook_app contracts — each validated AGAINST its own survivor
 *      (good + bad per refusal), each reaches ENABLED through the one lifecycle; a tenant cannot author an adapter
 *   I. (138D) memory_access ENFORCED by the context compiler — an undeclared slice's reader is never called
 *   J. (138D) a custom-manager run receives only its declared slices and BOOKS its cost on its ledger row
 *   K. (138D) the platform kill-switch queue for TENANT listings — staff suspend works, evidence kept, wired
 */
import { readFileSync, readdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { stripComments, blankStrings } from "./strip-comments"
import {
  CUSTOM_MANAGER_EVALUATORS, EXTENSION_KINDS, EXTENSION_STATUSES, EXTENSION_TRANSITIONS, MANAGER_SKILLS, SKILL_RUN_RECEIPT_SCHEMA,
  canDecideSkillListing, canExtensionTransition, capabilityCallRefusal, extensionEnablementChecks, managerAuthorityCeiling,
  registerCustomManager, skillContractOf, validateCustomManagerDeclaration, validateSkillDeclaration,
  type CustomManagerDeclaration, type ExtensionStatus, type SkillDeclaration,
} from "../lib/kernel/skill-registry"
import {
  decideSkillListing, evaluateSkillListing, requestExtensionCapability, resolveRunnableSkill, runCustomManagerCapability, runSkill,
  setTenantExtensionEnabled, submitSkillListing, listTenantExtensions, type SkillMarketplaceDeps,
} from "../lib/kernel/skill-marketplace"
import { CAPABILITY_MANAGER } from "../lib/agentic-os/capability-ownership"
import { MANAGERS, MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import { EXTENSION_CONTRACT_EVALUATORS, validateProviderAdapterExtension, validateStrategyExtension, validateWebhookAppDeclaration } from "../lib/kernel/skill-registry"
import { listPlatformSkillListings } from "../lib/kernel/skill-marketplace"
import { compileManagerContext, CONTEXT_SLICES_BY_MEMORY_ACCESS, type MissionContextDeps } from "../lib/kernel/mission-context"
import { PLATFORM_STRATEGY_LIBRARY, strategyGaps } from "../lib/kernel/strategy-library"
import { deriveProviderAdapters, validateProviderAdapter } from "../lib/kernel/provider-adapters"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) } }
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

// ─── in-memory supabase-js shaped client (skill-registry-guard's shape) ─────────────────────
type Row = Record<string, any>
function memClient(tables: Record<string, Row[]> = {}) {
  const t = (name: string) => (tables[name] ??= [])
  return {
    tables,
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
      let op: "select" | "insert" | "update" | "delete" = "select"
      let payload: Row | Row[] | null = null
      let limitN: number | null = null
      let orderBy: { col: string; asc: boolean } | null = null
      const run = (): { data: any; error: any } => {
        if (op === "insert") {
          const rows = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), updated_at: null, evaluation_evidence: null, ...r }))
          for (const r of rows) t(table).push(r)
          return { data: rows.map((r) => structuredClone(r)), error: null }
        }
        let hits = t(table).filter((r) => preds.every((p) => p(r)))
        if (op === "update") { for (const r of hits) Object.assign(r, payload); return { data: hits.map((r) => structuredClone(r)), error: null } }
        if (op === "delete") { tables[table] = t(table).filter((r) => !hits.includes(r)); return { data: hits, error: null } }
        if (orderBy) { const { col, asc } = orderBy; hits = [...hits].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1)) }
        return { data: (limitN ? hits.slice(0, limitN) : hits).map((r) => structuredClone(r)), error: null }
      }
      const b: any = {
        select: () => b, not: () => b, or: () => b, gte: () => b, lte: () => b, lt: () => b, neq: () => b,
        is: (c: string, v: unknown) => { preds.push((r) => (r[c] ?? null) === v); return b },
        order: (col: string, o?: { ascending?: boolean }) => { orderBy = { col, asc: o?.ascending !== false }; return b },
        limit: (n: number) => { limitN = n; return b },
        insert: (p: Row | Row[]) => { op = "insert"; payload = p; return b },
        update: (p: Row) => { op = "update"; payload = p; return b },
        delete: () => { op = "delete"; return b },
        eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b },
        single: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        maybeSingle: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

/** Observing seams. tenantEnablement / mergeSettings stay REAL unless overridden (they read / write the client). */
function seams(over: { afford?: (cap: string, feature?: string) => boolean; authority?: number; enablementUnreadable?: boolean } = {}) {
  const affords: any[] = [], ledger: any[] = [], delegations: any[] = []
  const deps: SkillMarketplaceDeps = {
    afford: async (i) => { affords.push(i); const ok = over.afford ? over.afford(i.capability, i.featureKey) : true; return { allowed: ok, reason: ok ? "active" : `refused:${i.capability}` } },
    authority: async () => (over.authority ?? 6) as any,
    delegate: async (i) => { delegations.push(i); return { ok: true, delegationId: `dl-${delegations.length}` } },
    ledger: async (input, act) => { ledger.push(input); return act() },
  }
  if (over.enablementUnreadable) deps.tenantEnablement = async () => ({ ok: false, error: "permission denied" })
  return { deps, affords, ledger, delegations }
}

const T1 = "11111111-1111-4111-8111-111111111111"
const T2 = "22222222-2222-4222-8222-222222222222"
const ADMIN1 = { isPlatformStaff: false, isTenantAdmin: true, brokerageId: T1, userId: "u-admin-1" }
const STAFF = { isPlatformStaff: true, isTenantAdmin: false, brokerageId: null, userId: "u-staff" }
const CAMPAIGN = { campaignId: "33333333-3333-4333-8333-333333333333" }
const CMA_INPUTS = { agentId: "44444444-4444-4444-8444-444444444444", propertyAddress: "1 Main", propertyCity: "c", propertyState: "s", propertyZip: "z" }

/** A wave-108-shaped declaration (NONE of the wave-137 optional fields) — 137E writes data in this shape. */
function legacy(over: Partial<SkillDeclaration> = {}): SkillDeclaration {
  return {
    name: "seller_reactivation_touch", version: 1, manager_owner: "campaign_orchestrator",
    purpose: "Reactivate a past seller with a newsletter issue and a direct-mail piece.",
    inputs: { fields: [{ name: "campaignId", type: "uuid", required: true }] }, outputs: SKILL_RUN_RECEIPT_SCHEMA,
    required_capabilities: ["newsletter_send", "direct_mail_send"], risk_class: "COMMUNICATION", authority_requirement: 3,
    cost_estimate: { usd: 4.5, tokens: 0, budget: "vendor_spend", basis: "declared" },
    tenant_entitlement: "direct_mail", evaluation_suite: "skill_eval:contract_v1", evaluation_fixtures: [CAMPAIGN],
    ...over,
  }
}

/** A custom manager under campaign_orchestrator that asks listing_concierge for a CMA. */
function desk(over: Partial<CustomManagerDeclaration> = {}): CustomManagerDeclaration {
  return {
    name: "listing_launch_desk", version: 1, responsibility: "Prepares the CMA for a listing launch campaign.", domain: "Listing launch",
    allowed_capabilities: ["cma_generate"], tools: ["cma_generate"], authority_ceiling: 3, policy_requirements: ["strategy_overrides"],
    budget: { max_usd_per_run: 2, max_tokens_per_run: 0 }, memory_access: "mission_context", mission_types: ["campaign"],
    escalation_owner: "campaign_orchestrator", evaluation_suite: "extension_eval:custom_manager_contract_v1",
    ...over,
  }
}

async function toEnabled(c: ReturnType<typeof memClient>, input: Parameters<typeof submitSkillListing>[0], actor: any) {
  const s = seams()
  const sub = await submitSkillListing(input, c, s.deps)
  if (!sub.ok) throw new Error(`submit: ${sub.reason} ${sub.errors?.join(",") ?? ""}`)
  const ev = await evaluateSkillListing({ listingId: sub.listing.id, actorBrokerageId: input.brokerageId }, c, s.deps)
  if (!ev.ok || ev.listing.status !== "validated") throw new Error(`evaluate: ${ev.ok ? ev.listing.status : ev.reason}`)
  const ap = await decideSkillListing({ listingId: sub.listing.id, decision: "approve", actor }, c, s.deps)
  if (!ap.ok) throw new Error(`approve: ${ap.reason}`)
  const en = await decideSkillListing({ listingId: sub.listing.id, decision: "enable", actor }, c, s.deps)
  if (!en.ok) throw new Error(`enable: ${en.reason}`)
  return en.listing
}

async function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
  const suites = new Set<string>([...Object.keys(pkg.scripts).filter((k) => k.startsWith("test:")), "skill_eval:contract_v1"])
  const v = (d: SkillDeclaration) => validateSkillDeclaration(d, { knownEvaluationSuites: suites })
  const has = (d: SkillDeclaration, code: string) => v(d).errors.some((e) => e.startsWith(code))

  console.log("\nA. the full skill contract — derived ceilings, no self-grant")
  {
    check("A1 (positive control / 137E compatibility) a wave-108-shaped declaration with NONE of the new fields is valid", v(legacy()).ok, v(legacy()).errors.join(","))
    const full = skillContractOf(legacy())
    check("A2 skillContractOf derives every new field: publisher, max_cost = the estimate, external_write from the capabilities", full.publisher === "platform" && full.max_cost.usd === 4.5 && full.external_write === "external_message", JSON.stringify({ p: full.publisher, m: full.max_cost, w: full.external_write }))
    check("A3 the listing ROW publisher wins over the declaration's", skillContractOf(legacy({ publisher: "platform" }), "third_party").publisher === "third_party")
    const FIELDS = ["name", "version", "publisher", "manager_owner", "inputs", "outputs", "required_capabilities", "risk_class", "authority_requirement", "tenant_entitlement", "cost_estimate", "max_cost", "external_write", "evaluation_suite"]
    check(`A4 every built-in declares the full minimum (${FIELDS.length} fields incl. publisher, max_cost, external_write)`, MANAGER_SKILLS.every((s) => FIELDS.every((f) => (s as any)[f] !== undefined)) && MANAGER_SKILLS.every((s) => v(s).ok))
    check("A5 entitlement ceiling: dropping the capability's plan feature to the base plan → entitlement_understated", has(legacy({ tenant_entitlement: "app.access" }), "entitlement_understated:direct_mail"))
    check("A6 external-write ceiling: claiming `none` for a messaging skill → external_write_understated", has(legacy({ external_write: "none" }), "external_write_understated"))
    check("A7 (control) OVERstating external write is allowed", v(legacy({ external_write: "external_spend" })).ok)
    check("A8 max cost below the estimate → max_cost_below_estimate; a ceiling ≥ the estimate is valid", has(legacy({ max_cost: { usd: 1, tokens: 0 } }), "max_cost_below_estimate") && v(legacy({ max_cost: { usd: 9, tokens: 0 } })).ok)
    check("A9 authority self-grant (rung above its risk band) → authority_exceeds_risk_class", has(legacy({ authority_requirement: 6 }), "authority_exceeds_risk_class"))
    const grants = ["permissions", "grants", "scopes", "sql", "tables", "authority_override", "capability_manager"].filter((k) => !has({ ...legacy(), [k]: true } as any, `not_data:${k}`))
    check("A10 permission / scope / raw-DB / ownership keys are not data → not_data (no self-granted permission, no raw DB)", grants.length === 0, grants.join(","))
    const c = memClient()
    const claim = await submitSkillListing({ publisher: "tenant", brokerageId: T1, submittedBy: "u", declaration: legacy({ publisher: "platform" }) }, c, seams().deps)
    check("A11 a tenant submission claiming publisher `platform` → publisher_mismatch (provenance is the session's)", !claim.ok && /^publisher_mismatch/.test(claim.reason))
  }

  console.log("\nB. the runtime capability bound (call time)")
  {
    const s = seams()
    const c = memClient()
    const req = { brokerageId: T1, requestingManager: "ai_isa" as const, objective: "x", inputEntities: {}, authority: 3 as const, budget: {} }
    const undeclared = await requestExtensionCapability({ declared: ["newsletter_send"], owner: "campaign_orchestrator" }, { ...req, capability: "payment_transfer" }, c, s.deps)
    check("B1 an UNDECLARED capability is refused at call time, nothing delegated", !undeclared.ok && undeclared.reason === "undeclared_capability:payment_transfer" && s.delegations.length === 0)
    const ok = await requestExtensionCapability({ declared: ["newsletter_send"], owner: "campaign_orchestrator" }, { ...req, capability: "newsletter_send" }, c, s.deps)
    check("B2 (positive control) a declared capability is delegated to its OWNING manager", ok.ok && s.delegations.length === 1 && s.delegations[0].assignedManager === CAPABILITY_MANAGER.newsletter_send)
    check("B3 a capability whose ownership moved since approval → capability_owner_moved", capabilityCallRefusal(["newsletter_send"], "ads_manager", "newsletter_send")?.startsWith("capability_owner_moved:") === true)
    check("B4 an unknown capability smuggled into a declared list → unknown_capability", capabilityCallRefusal(["mint_money"], null, "mint_money") === "unknown_capability:mint_money")
  }

  console.log("\nC. the custom-manager contract")
  {
    const snap = () => JSON.stringify({ m: MANAGERS, c: CAPABILITY_MANAGER })
    const before = snap()
    const reg = registerCustomManager(desk())
    check("C1 (positive control) a valid custom manager registers → a frozen entry in its own `custom:` namespace", reg.ok && Object.isFrozen(reg.entry) && reg.entry.key === "custom:listing_launch_desk" && !(reg.entry.key in MANAGERS), reg.ok ? "" : reg.errors.join(","))
    check("C2 registration alters NOTHING in the registry (MANAGERS, CAPABILITY_MANAGER byte-identical)", snap() === before)
    check("C3 the entry READS who executes each capability (cma_generate → listing_concierge), never re-assigns it", reg.ok && reg.entry.capability_owners.cma_generate === "listing_concierge")
    const errs = (d: CustomManagerDeclaration) => validateCustomManagerDeclaration(d).errors
    const own = managerAuthorityCeiling("campaign_orchestrator")
    check(`C4 ceiling above its escalation owner's (${own}) → authority_ceiling_exceeds_escalation_owner`, errs(desk({ authority_ceiling: (own + 1) as any })).some((e) => e.startsWith("authority_ceiling_exceeds_escalation_owner")), String(own))
    check("C5 a name that shadows an existing manager → name_shadows_manager (cannot replace ai_isa)", errs(desk({ name: "ai_isa" })).some((e) => e === "name_shadows_manager:ai_isa"))
    check("C6 an escalation owner that is not an existing manager → unknown_escalation_owner", errs(desk({ escalation_owner: "my_new_boss" as any })).some((e) => e.startsWith("unknown_escalation_owner")))
    check("C7 a capability whose risk needs more than its ceiling → capability_above_ceiling", errs(desk({ allowed_capabilities: ["cma_generate", "newsletter_send"], authority_ceiling: 1 })).some((e) => e.startsWith("capability_above_ceiling:newsletter_send")))
    check("C8 a key that would alter ownership / authority / kernel protections → not_data", ["capability_manager", "authority_overrides", "kernel_protections"].every((k) => errs({ ...desk(), [k]: {} } as any).includes(`not_data:${k}`)))
    check("C9 unknown mission type / policy key / tool outside its capabilities are refused", errs(desk({ mission_types: ["world_domination" as any] })).some((e) => e.startsWith("unknown_mission_type")) && errs(desk({ policy_requirements: ["nope"] })).some((e) => e.startsWith("unknown_policy_key")) && errs(desk({ tools: ["newsletter_send"] })).some((e) => e.startsWith("tool_outside_allowed_capabilities")))
    const evidence = CUSTOM_MANAGER_EVALUATORS["extension_eval:custom_manager_contract_v1"](desk())
    check("C10 the platform evaluator proves registry_unaltered + ceiling_within_escalation_owner", evidence.passed && evidence.checks.some((x) => x.name === "registry_unaltered" && x.ok))

    // the custom-manager RUN path
    const c = memClient()
    const listing = await toEnabled(c, { kind: "custom_manager", publisher: "tenant", brokerageId: T1, submittedBy: "u-admin-1", declaration: desk() }, ADMIN1)
    const s = seams({ authority: 6 })
    const run = (over: Record<string, unknown> = {}, sx = s) => runCustomManagerCapability({ brokerageId: T1, customManager: "listing_launch_desk", capability: "cma_generate", inputs: CMA_INPUTS, objective: "prep the launch CMA", ...over } as any, c, sx.deps)
    const r1 = await run()
    check("C11 an ENABLED custom manager asks the OWNER for an allowed capability, AS its escalation owner, CLAMPED to its ceiling (rung 6 → 3)", r1.ok && s.delegations.length === 1 && s.delegations[0].requestingManager === "campaign_orchestrator" && s.delegations[0].assignedManager === "listing_concierge" && s.delegations[0].authority === 3, r1.ok ? JSON.stringify(s.delegations[0]) : r1.reason)
    check("C12 it is ledgered (extension.custom_manager.run, policy authority_level:<owner>) and metered at its budget ceiling", s.ledger.some((l) => l.action === "extension.custom_manager.run" && l.policyKey === "authority_level:campaign_orchestrator") && s.affords.some((a) => a.capability === "comms.send" && a.estCostUsd === 2) && s.affords.some((a) => a.capability === "app.access"))
    const s2 = seams()
    const r2 = await run({ capability: "newsletter_send" }, s2)
    check("C13 an UNDECLARED capability through the custom-manager path → refused before anything is asked (no afford, no ledger, no delegation)", !r2.ok && r2.reason === "undeclared_capability:newsletter_send" && s2.delegations.length === 0 && s2.ledger.length === 0 && s2.affords.length === 0)
    const s3 = seams({ authority: 0 })
    const r3 = await run({}, s3)
    check("C14 the escalation owner's rung below the capability's minimum → refused (never above the owner)", !r3.ok && /^authority:0</.test(r3.reason) && s3.delegations.length === 0)
    const r4 = await run({ missionType: "recruiting" }, seams())
    check("C15 a mission type the contract did not declare → refused", !r4.ok && /^mission_type_not_declared/.test(r4.reason))
    const r5 = await run({ inputs: { ...CMA_INPUTS, brokerageId: T2 } }, seams())
    check("C16 a tenant id smuggled as an input → refused (tenant from the session)", !r5.ok && r5.reason === "inputs_invalid")
    const r6 = await runCustomManagerCapability({ brokerageId: T2, customManager: "listing_launch_desk", capability: "cma_generate", inputs: CMA_INPUTS, objective: "x" }, c, seams().deps)
    check("C17 another tenant cannot run (or see) this tenant's custom manager", !r6.ok && /unknown_custom_manager/.test(r6.reason))
    void listing
  }

  console.log("\nD. one lifecycle — transitions, kill switch, evidence")
  {
    const expected: Record<ExtensionStatus, ExtensionStatus[]> = { draft: ["validated", "disabled"], validated: ["approved", "disabled"], approved: ["enabled", "disabled"], enabled: ["suspended", "deprecated", "disabled"], suspended: ["enabled", "disabled"], deprecated: ["disabled"], disabled: [] }
    const wrong: string[] = []
    for (const a of EXTENSION_STATUSES) for (const b of EXTENSION_STATUSES) if (canExtensionTransition(a, b) !== expected[a].includes(b)) wrong.push(`${a}->${b}`)
    check(`D1 every one of the ${EXTENSION_STATUSES.length * EXTENSION_STATUSES.length} status pairs is legal / illegal exactly as the lifecycle states`, wrong.length === 0 && JSON.stringify(EXTENSION_TRANSITIONS) === JSON.stringify(expected), wrong.join(","))
    check("D2 illegal shortcuts refused: draft→enabled, validated→enabled, approved→suspended, disabled→anything", !canExtensionTransition("draft", "enabled") && !canExtensionTransition("validated", "enabled") && !canExtensionTransition("approved", "suspended") && EXTENSION_STATUSES.every((s) => !canExtensionTransition("disabled", s)))

    const c = memClient()
    const sk = await toEnabled(c, { publisher: "tenant", brokerageId: T1, submittedBy: "u-admin-1", declaration: legacy() }, ADMIN1)
    await toEnabled(c, { kind: "custom_manager", publisher: "tenant", brokerageId: T1, submittedBy: "u-admin-1", declaration: desk() }, ADMIN1)
    const cm = c.tables.skill_marketplace_listings.find((r) => r.extension_kind === "custom_manager")!
    const s = seams()
    const runSk = () => runSkill({ brokerageId: T1, skill: "seller_reactivation_touch", requestingManager: "ai_isa", inputs: CAMPAIGN, objective: "x" }, c, s.deps)
    const runCm = () => runCustomManagerCapability({ brokerageId: T1, customManager: "listing_launch_desk", capability: "cma_generate", inputs: CMA_INPUTS, objective: "x" }, c, s.deps)
    check("D3 (positive control) both enabled extensions execute", (await runSk()).ok && (await runCm()).ok)
    const frozen = (id: string) => { const r = c.tables.skill_marketplace_listings.find((x) => x.id === id)!; return JSON.stringify({ d: r.declaration, g: r.declaration_digest, e: r.evaluation_evidence, a: r.approved_by }) }
    const evidenceBefore = { sk: frozen(sk.id), cm: frozen(cm.id) }
    const ledgerBefore = s.ledger.length
    const noReason = await decideSkillListing({ listingId: sk.id, decision: "suspend", actor: ADMIN1 }, c, s.deps)
    check("D4 the kill switch must say why (suspend without a reason refused)", !noReason.ok && noReason.reason === "suspend_reason_required")
    const sus = await decideSkillListing({ listingId: sk.id, decision: "suspend", actor: STAFF, reason: "incident 42 — investigating" }, c, s.deps)
    const susCm = await decideSkillListing({ listingId: cm.id, decision: "suspend", actor: ADMIN1, reason: "pausing the desk" }, c, s.deps)
    check("D5 platform staff hold the kill switch on a TENANT listing (suspend), a tenant admin on its own", sus.ok && sus.listing.status === "suspended" && sus.listing.suspended_reason === "incident 42 — investigating" && susCm.ok)
    const delegBefore = s.delegations.length
    const a = await runSk(), b = await runCm()
    check("D6 a SUSPENDED skill and a SUSPENDED custom manager cannot execute (nothing delegated)", !a.ok && /not_executable:suspended/.test(a.reason) && !b.ok && /not_executable:suspended/.test(b.reason) && s.delegations.length === delegBefore)
    check("D7 staff may NOT approve / enable a tenant's own extension (only the kill switch)", !canDecideSkillListing({ publisher: "tenant", brokerage_id: T1 }, STAFF, "enable") && canDecideSkillListing({ publisher: "tenant", brokerage_id: T1 }, STAFF, "disable"))
    const res = await decideSkillListing({ listingId: sk.id, decision: "resume", actor: ADMIN1 }, c, s.deps)
    check("D8 resume re-runs the enablement checks and the skill executes again", res.ok && res.listing.status === "enabled" && (await runSk()).ok)
    const dis = await decideSkillListing({ listingId: sk.id, decision: "disable", actor: ADMIN1, reason: "retired" }, c, s.deps)
    const disCm = await decideSkillListing({ listingId: cm.id, decision: "disable", actor: ADMIN1, reason: "retired" }, c, s.deps)
    check("D9 DISABLED cannot execute (skill + custom manager) and is terminal", dis.ok && disCm.ok && !(await runSk()).ok && !(await runCm()).ok && !(await decideSkillListing({ listingId: sk.id, decision: "resume", actor: ADMIN1 }, c, s.deps)).ok)
    check("D10 the kill switch KEEPS the evidence: rows still exist; declaration, digest, evaluation evidence, approver unchanged", c.tables.skill_marketplace_listings.length === 2 && frozen(sk.id) === evidenceBefore.sk && frozen(cm.id) === evidenceBefore.cm)
    check("D11 every kill-switch move was ledgered (suspend, resume, disable) — the ledger only grew", s.ledger.length > ledgerBefore && ["extension.listing.suspend", "extension.listing.resume", "extension.listing.disable"].every((x) => s.ledger.some((l) => l.action === x)))
    // every kind is judged by its OWN contract (wave 138D): a shell declaration is refused at submit, never drafted
    const st = await submitSkillListing({ kind: "strategy", publisher: "third_party", brokerageId: null, submittedBy: "u-staff", publisherName: "Acme", declaration: { name: "acme_strategy", version: 1, evaluation_suite: "skill_eval:contract_v1" } as any }, c, s.deps)
    check("D12 a strategy shell (no StrategyDefinition, a skill suite) is refused at submit by the strategy contract — nothing inserted", !st.ok && st.reason === "declaration_invalid" && (st.errors ?? []).includes("strategy_missing") && c.tables.skill_marketplace_listings.length === 2, JSON.stringify(st))
    const checks = extensionEnablementChecks({ extension_kind: "webhook_app", declaration: {}, evaluation_evidence: { suite: "x", passed: true, checks: [] } }, true)
    check("D13 enablement checks for an empty webhook_app refuse contract + risk + dependencies even with passing evidence", ["contract_valid", "risk_classified", "dependencies_available"].every((n) => checks.find((x) => x.name === n)?.ok === false))
    const bogus = extensionEnablementChecks({ extension_kind: "plugin" as any, declaration: {}, evaluation_evidence: { suite: "x", passed: true, checks: [] } }, true)
    check("D13b an UNKNOWN kind still fails closed (contract_validator_not_registered)", bogus.every((x) => x.name === "evaluation_passed" || x.name === "digest_intact" || !x.ok) && /contract_validator_not_registered/.test(bogus.find((x) => x.name === "contract_valid")?.detail ?? ""))
    const enChecks = extensionEnablementChecks({ extension_kind: "skill", declaration: legacy(), evaluation_evidence: { suite: "x", passed: false, checks: [] } }, true)
    check("D14 enablement requires the evaluation pass (contract-valid but failed evidence → evaluation_passed false)", enChecks.find((x) => x.name === "evaluation_passed")?.ok === false && enChecks.find((x) => x.name === "contract_valid")?.ok === true)
  }

  console.log("\nE. tenant extension control (the REAL versioned tenant-policy writer)")
  {
    const c = memClient({ brokerage_settings: [{ id: "bs-1", brokerage_id: T1, settings: { other_key: 1 }, updated_at: "2026-10-01T00:00:00.000Z" }, { id: "bs-2", brokerage_id: T2, settings: {}, updated_at: "2026-10-01T00:00:00.000Z" }] })
    const tp = await toEnabled(c, { publisher: "third_party", brokerageId: null, submittedBy: "u-staff", publisherName: "Acme", declaration: legacy({ name: "acme_reactivation" }) }, STAFF)
    const s = seams()
    const runAs = (b: string) => runSkill({ brokerageId: b, skill: "acme_reactivation", requestingManager: "ai_isa", inputs: CAMPAIGN, objective: "x" }, c, s.deps)
    const before = await runAs(T1)
    check("E1 an enabled global extension does not run for a tenant that has not opted in", !before.ok && /not_enabled_for_tenant/.test(before.reason))
    const agent = await setTenantExtensionEnabled({ brokerageId: T1, listingId: tp.id, enable: true, actor: { userId: "u-agent", isTenantAdmin: false } }, c, s.deps)
    check("E2 a non-admin cannot enable an extension for the tenant", !agent.ok && agent.reason === "tenant_admin_only")
    const sNo = seams({ afford: (cap) => cap !== "feature.use" })
    const noPlan = await setTenantExtensionEnabled({ brokerageId: T1, listingId: tp.id, enable: true, actor: { userId: "u-admin-1", isTenantAdmin: true } }, c, sNo.deps)
    check("E3 the plan does not cover it → refused at opt-in, NOTHING written", !noPlan.ok && /^entitlement:direct_mail/.test(noPlan.reason) && !(c.tables.brokerage_settings[0].settings as any).extensions)
    const on = await setTenantExtensionEnabled({ brokerageId: T1, listingId: tp.id, enable: true, actor: { userId: "u-admin-1", isTenantAdmin: true } }, c, s.deps)
    const st1 = c.tables.brokerage_settings.find((r) => r.brokerage_id === T1)!.settings as any
    check("E4 a tenant admin opts in: written under tenant policy `extensions`, other settings keys kept", on.ok && !!st1.extensions?.enabled?.[tp.id] && st1.extensions.enabled[tp.id].set_by === "u-admin-1" && st1.other_key === 1, JSON.stringify(st1))
    const versions = (c.tables.tenant_policy_versions ?? []).filter((r) => r.policy_key === "extensions" && r.brokerage_id === T1)
    check("E5 the opt-in is a VERSIONED policy change (tenant_policy_versions row, actor = the admin)", versions.length === 1, JSON.stringify(versions.map((r) => ({ v: r.version, a: r.actor_user_id ?? r.actor_id }))))
    check("E6 it now runs for T1 — and still NOT for T2 (no cross-tenant enablement)", (await runAs(T1)).ok && /not_enabled_for_tenant/.test(((await runAs(T2)) as any).reason ?? ""))
    const t1own = await toEnabled(c, { publisher: "tenant", brokerageId: T1, submittedBy: "u-admin-1", declaration: legacy({ name: "t1_private_touch" }) }, ADMIN1)
    const cross = await setTenantExtensionEnabled({ brokerageId: T2, listingId: t1own.id, enable: true, actor: { userId: "u-admin-2", isTenantAdmin: true } }, c, s.deps)
    check("E7 T2's admin enabling T1's own extension → not_found (cross-tenant enablement refused)", !cross.ok && cross.reason === "not_found" && !((c.tables.brokerage_settings.find((r) => r.brokerage_id === T2)!.settings as any).extensions))
    c.tables.skill_marketplace_listings.push({ id: randomUUID(), extension_kind: "provider_adapter", skill_id: "acme_avm_adapter", publisher: "third_party", brokerage_id: null, version: 1, declaration: { name: "acme_avm_adapter", version: 1 }, declaration_digest: "x", status: "enabled", evaluation_evidence: { suite: "x", passed: true, checks: [] } })
    const pa = c.tables.skill_marketplace_listings[c.tables.skill_marketplace_listings.length - 1]
    const plat = await setTenantExtensionEnabled({ brokerageId: T1, listingId: pa.id, enable: true, actor: { userId: "u-admin-1", isTenantAdmin: true } }, c, s.deps)
    check("E8 a platform-only kind (provider_adapter) cannot be toggled by a tenant", !plat.ok && plat.reason === "platform_controlled:provider_adapter")
    const view = await listTenantExtensions(T1, c, s.deps)
    const vx = (id: string) => view.extensions.find((x) => x.listing.id === id)
    check("E9 the tenant panel's read: opted-in global runs here; own listing = own lifecycle; provider adapter = platform-controlled", vx(tp.id)?.executable === true && vx(tp.id)?.control === "tenant" && vx(t1own.id)?.control === "own_lifecycle" && vx(pa.id)?.control === "platform", JSON.stringify(view.extensions.map((x) => [x.listing.skill_id, x.control, x.executable])))
    await decideSkillListing({ listingId: tp.id, decision: "deprecate", actor: STAFF }, c, s.deps)
    const still = await runAs(T1)
    const late = await setTenantExtensionEnabled({ brokerageId: T2, listingId: tp.id, enable: true, actor: { userId: "u-admin-2", isTenantAdmin: true } }, c, s.deps)
    check("E10 DEPRECATED keeps running where already enabled, and takes no new tenant", still.ok && !late.ok && late.reason === "not_enableable:deprecated")
    const off = await setTenantExtensionEnabled({ brokerageId: T1, listingId: tp.id, enable: false, actor: { userId: "u-admin-1", isTenantAdmin: true } }, c, s.deps)
    check("E11 the tenant disables it → it stops running here; the opt-out is versioned too", off.ok && !(await runAs(T1)).ok && (c.tables.tenant_policy_versions ?? []).filter((r) => r.policy_key === "extensions" && r.brokerage_id === T1).length === 2)
    const sBad = seams({ enablementUnreadable: true })
    const closed = await resolveRunnableSkill(T1, "acme_reactivation", c, sBad.deps)
    check("E12 an UNREADABLE tenant enablement fails CLOSED (never read as enabled)", !closed.ok && /^tenant_enablement_unreadable/.test(closed.reason))
    check("E13 the policy key is registered as tenant operating policy (versioned on every change)", "extensions" in TENANT_POLICY_SETTINGS_KEYS)
  }

  console.log("\nF. run-path census (stripped source)")
  {
    const rt = blankStrings(src("lib/kernel/skill-marketplace.ts"))
    const rawRt = src("lib/kernel/skill-marketplace.ts")
    const delegateCalls = [...rt.matchAll(/\bd\.delegate\(|withDeps\(deps\)\.delegate\(/g)].length
    check("F1 exactly ONE call reaches the delegate seam (inside requestExtensionCapability, behind capabilityCallRefusal)", delegateCalls === 1 && /capabilityCallRefusal\(scope\.declared[\s\S]{0,400}withDeps\(deps\)\.delegate\(/.test(rawRt))
    /** Spans of every `d.ledger(` argument list (paren-matched on string-blanked source). */
    const ledgerSpans = (text: string) => [...text.matchAll(/\bd\.ledger\(/g)].map((m) => { let depth = 0, i = m.index! + m[0].length - 1; for (; i < text.length; i++) { if (text[i] === "(") depth++; else if (text[i] === ")" && --depth === 0) break } return [m.index!, i] as const })
    const outside = (text: string) => { const spans = ledgerSpans(text); return [...text.matchAll(/\brequestExtensionCapability\(/g)].filter((m) => !/function\s+$/.test(text.slice(Math.max(0, m.index! - 12), m.index!))).filter((m) => !spans.some(([a, b]) => m.index! > a && m.index! < b)).length }
    const calls = [...rt.matchAll(/\brequestExtensionCapability\(/g)].length - 1
    check(`F2 every capability call (${calls}) sits INSIDE a withActionLedger claim (d.ledger argument)`, calls >= 2 && outside(rt) === 0)
    const fixture = blankStrings(stripComments(`async function f() {\n  await d.ledger({ a: 1 }, async () => requestExtensionCapability(x), svc)\n  await requestExtensionCapability(y)\n}`))
    check("F3 (positive control) the census DETECTS a capability call outside the ledger", outside(fixture) === 1)
    const tables = [...rawRt.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1])
    check(`F4 the runtime touches only its own table + the tenant-policy settings row (no raw DB on behalf of an extension): ${[...new Set(tables)].join(", ")}`, tables.length > 0 && tables.every((t) => t === "skill_marketplace_listings" || t === "brokerage_settings"))
    const reg = src("lib/kernel/skill-registry.ts")
    check("F5 the contract module is PURE: no .from(, no fetch, no eval", !/\.from\(|\bfetch\(|\beval\(|new Function\(/.test(reg))
    const writers: string[] = []
    const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) { if (e.name !== "node_modules") walk(p) } else if (/\.(ts|tsx)$/.test(e.name) && src(p).includes(`from("skill_marketplace_listings")`)) writers.push(p) } }
    walk("lib"); walk("app")
    check("F6 lib/ + app/: lib/kernel/skill-marketplace.ts is the ONLY module that touches skill_marketplace_listings", writers.length === 1 && writers[0] === "lib/kernel/skill-marketplace.ts", writers.join(", "))
    check("F7 every door delegates to the runtime — none reads the table or the settings row itself", !/\.from\(/.test(src("app/actions/skill-marketplace.ts")))
  }

  console.log("\nG. registration + one vocabulary")
  {
    const latest = (token: string) => { const ms = readdirSync("supabase/migrations").filter((f) => /\.sql$/.test(f) && readFileSync(`supabase/migrations/${f}`, "utf8").includes(token)).sort((a, b) => Number(/^m(\d+)/.exec(a)?.[1] ?? 0) - Number(/^m(\d+)/.exec(b)?.[1] ?? 0)); return ms.length ? readFileSync(`supabase/migrations/${ms[ms.length - 1]}`, "utf8") : "" }
    const list = (name: string) => { const m = new RegExp(`${name}\\s+CHECK\\s*\\(\\w+ IN \\(([^)]*)\\)`).exec(latest(name)); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [] }
    check("G1 the latest extension_kind CHECK = EXTENSION_KINDS", list("skill_marketplace_listings_extension_kind_check").join(",") === EXTENSION_KINDS.join(","))
    check("G2 the latest status CHECK = EXTENSION_STATUSES", list("skill_marketplace_listings_status_check").join(",") === EXTENSION_STATUSES.join(","))
    const mig = latest("skill_marketplace_listings_extension_kind_check")
    check("G3 the kill-switch shapes are enforced (disabled / suspended carry stamp + reason) and the trigger freezes extension_kind", /disabled_shape_check CHECK \(status <> 'disabled'/.test(mig) && /suspended_shape_check CHECK \(status <> 'suspended'/.test(mig) && /NEW\.extension_kind IS DISTINCT FROM OLD\.extension_kind/.test(mig))
    check("G4 the migration header carries the lane stamp or an APPLIED LIVE stamp", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(mig))
    check("G5 package.json registers test:extension-lifecycle on the guard chain (membership, not position)", pkg.scripts["test:extension-lifecycle"] === "tsx scripts/extension-lifecycle-guard.ts" && new RegExp("npm run test:extension-lifecycle(\\s|&|$)").test(pkg.scripts.guard))
    const d = MAINTENANCE_DOMAINS.extension_lifecycle as any
    check("G6 MAINTENANCE_DOMAINS owns the proof (compliance_officer; co-owners named in the prose)", d?.manager === "compliance_officer" && d.proof === "test:extension-lifecycle" && (d.coOwners ?? []).every((k: string) => d.what.includes(k)) && (d.coOwners ?? []).length >= 1)
    const panel = src("app/components/skills/tenant-extensions-panel.tsx")
    check("G7 the tenant panel is wired (getTenantExtensions, setTenantExtension, runCustomManagerForTenant) and mounted in Settings → Assistant", ["getTenantExtensions(", "setTenantExtension(", "runCustomManagerForTenant("].every((x) => panel.includes(x)) && /<TenantExtensionsPanel \/>/.test(src("app/dashboard/settings/assistant/page.tsx")))
    const staleNames = ["SKILL_LISTING_STATUSES", "canSkillListingTransition", "isSkillListingRunnableBy", "revoked_reason", "published_at"].filter((n) => ["lib/kernel/skill-registry.ts", "lib/kernel/skill-marketplace.ts", "app/actions/skill-marketplace.ts", "app/components/skills/skill-marketplace-panel.tsx"].some((f) => blankStrings(src(f)).includes(n) || new RegExp(`"${n}"`).test(src(f))))
    check("G8 the retired m727 names live only in tombstones (stripped code never uses them)", staleNames.length === 0, staleNames.join(","))
  }


  console.log("\nH. the three survivor-owned contracts (strategy · provider_adapter · webhook_app)")
  {
    const lib = PLATFORM_STRATEGY_LIBRARY.find((x) => strategyGaps(x).length === 0 && x.steps.every((st) => st.capabilities.length > 0))!
    const strat = (over: Record<string, unknown> = {}, env: Record<string, unknown> = {}) => ({ name: "t1_sphere_plan", version: 1, evaluation_suite: "extension_eval:strategy_contract_v1", strategy: { ...lib, key: "t1_sphere_plan", version: 1, tier: "tenant", ...over }, ...env })
    const sErr = (d: unknown) => validateStrategyExtension(d).errors
    check(`H1 (positive control) a strategy composed of registered capabilities (from ${lib.key}) validates`, validateStrategyExtension(strat()).ok, sErr(strat()).join(","))
    const firstCap = lib.steps[0].capabilities[0]
    check("H2 an UNREGISTERED capability → unregistered_capability", sErr(strat({ steps: [{ ...lib.steps[0], capabilities: ["teleport_buyer"] }, ...lib.steps.slice(1)] })).includes("unregistered_capability:teleport_buyer"))
    const foreign = (Object.keys(CAPABILITY_MANAGER) as Array<keyof typeof CAPABILITY_MANAGER>).find((c) => CAPABILITY_MANAGER[c] !== lib.steps[0].manager)!
    check("H3 a capability the step's manager does not own → capability_not_owned_by_step_manager", sErr(strat({ steps: [{ ...lib.steps[0], capabilities: [firstCap, foreign] }, ...lib.steps.slice(1)] })).some((e) => e.startsWith(`capability_not_owned_by_step_manager:${foreign}`)))
    check("H4 a step that names a GAP (no catalogue key) → step_not_composable", sErr(strat({ steps: [{ ...lib.steps[0], capabilities: [], gap: "no key yet" }, ...lib.steps.slice(1)] })).some((e) => e.startsWith("step_not_composable")))
    check("H5 NO HARD-CODED LOCATION: a city fact, a ZIP literal and a market outside the library vocabulary are refused", sErr(strat({ eligibility: { ...lib.eligibility, all: [...lib.eligibility.all, { fact: "city", op: "eq", value: "Springfield" }] } })).includes("unknown_fact:city") && sErr(strat({ eligibility: { ...lib.eligibility, all: [...lib.eligibility.all, { fact: lib.eligibility.all[0]?.fact ?? "dnc", op: "in", value: ["12345"] }] } })).some((e) => e.startsWith("hard_coded_location")) && sErr(strat({ marketSuitability: ["springfield_metro"] })).includes("market_not_in_vocabulary:springfield_metro"))
    check("H6 VERSIONED: version 0 refused; envelope ≠ strategy version refused; a platform key cannot be shadowed", sErr(strat({ version: 0 }, { version: 0 })).includes("version_invalid") && sErr(strat({ version: 2 })).includes("version_must_equal_strategy_version") && sErr(strat({ key: lib.key }, { name: lib.key })).some((e) => e.startsWith("key_shadows_platform_strategy")))
    check("H7 code-shaped keys are not data (strategy.run / envelope.script)", sErr(strat({ run: "x" })).includes("not_data:strategy.run") && sErr(strat({}, { script: "x" })).includes("not_data:script"))

    const good = deriveProviderAdapters().adapters.find((a) => validateProviderAdapter(a).length === 0 && /^[a-z][a-z0-9_]{2,63}$/.test(a.provider))!
    const adapter = (over: Record<string, unknown> = {}) => ({ name: good.provider, version: 1, evaluation_suite: "extension_eval:provider_adapter_contract_v1", adapter: { ...good, ...over } })
    const aErr = (d: unknown) => validateProviderAdapterExtension(d).errors
    check(`H8 (positive control) a declaration for a ROUTED provider (${good.provider}) validates through validateProviderAdapter`, validateProviderAdapterExtension(adapter()).ok, aErr(adapter()).join(","))
    check("H9 an UNMETERED paid adapter is refused by THE adapter validator", aErr(adapter({ cost: { ...good.cost, payer: "platform", unitUsd: 0.5, ledger: "tenant_account", booking: "none" } })).some((e) => /UNMETERED/.test(e)))
    check("H10 a provider nothing routes (a hidden provider) → unrouted_provider", aErr({ ...adapter({ provider: "shadow_vendor" }), name: "shadow_vendor" }).includes("unrouted_provider:shadow_vendor"))
    check("H11 a capability the route table does not send to this provider → capability_not_routed_to_provider", aErr(adapter({ capabilities: [...good.capabilities, "skip_trace_everyone"] })).includes("capability_not_routed_to_provider:skip_trace_everyone"))
    check("H12 a malformed adapter never reaches the validator (adapter_shape_invalid)", aErr({ name: good.provider, version: 1, evaluation_suite: "x", adapter: { provider: good.provider } }).includes("adapter_shape_invalid"))

    const hook = (over: Record<string, unknown> = {}) => ({ name: "acme_crm_sync", version: 1, purpose: "Mirror conversions into Acme CRM.", events: ["lead.converted"], payload_fields: { "lead.converted": ["contactId"] }, endpoint_url: "https://hooks.acme.example/vip", evaluation_suite: "extension_eval:webhook_app_contract_v1", ...over })
    const wErr = (d: unknown) => validateWebhookAppDeclaration(d).errors
    check("H13 (positive control) a webhook app on approved events with a narrowing projection validates", validateWebhookAppDeclaration(hook()).ok, wErr(hook()).join(","))
    check("H14 an internal / unknown event and the wildcard are refused (approved catalogue only)", wErr(hook({ events: ["contact.updated_internal"], payload_fields: undefined })).some((e) => e.startsWith("events_invalid")) && wErr(hook({ events: ["*"], payload_fields: undefined })).includes("wildcard_refused"))
    check("H15 a projection WIDER than the catalogue's allow-list (email) → projection_widened", wErr(hook({ payload_fields: { "lead.converted": ["contactId", "email"] } })).includes("projection_widened:lead.converted.email"))
    check("H16 http / private-host endpoints and a smuggled secret are refused", wErr(hook({ endpoint_url: "http://hooks.acme.example/vip" })).includes("endpoint_not_https") && wErr(hook({ endpoint_url: "https://10.0.0.5/x" })).includes("endpoint_private_host") && wErr(hook({ secret: "s" })).includes("not_data:secret"))
    const wev = EXTENSION_CONTRACT_EVALUATORS.webhook_app["extension_eval:webhook_app_contract_v1"](hook())
    check("H17 the platform evaluator BUILDS each payload and proves only allow-listed keys leave (PII + nested planted)", wev.passed && wev.checks.some((x) => x.name === "projection_allow_list_only" && x.ok))

    const c = memClient()
    const st = await toEnabled(c, { kind: "strategy", publisher: "tenant", brokerageId: T1, submittedBy: "u-admin-1", declaration: strat() as any }, ADMIN1)
    const pa = await toEnabled(c, { kind: "provider_adapter", publisher: "platform", brokerageId: null, submittedBy: "u-staff", publisherName: "VIPAgents", declaration: adapter() as any }, STAFF)
    const wa = await toEnabled(c, { kind: "webhook_app", publisher: "third_party", brokerageId: null, submittedBy: "u-staff", publisherName: "Acme", declaration: hook() as any }, STAFF)
    check("H18 each of the three kinds reaches ENABLED through the one lifecycle (validated → approved → enabled, evidence passed)", [st, pa, wa].every((l) => l.status === "enabled" && l.evaluation_evidence?.passed === true), JSON.stringify([st, pa, wa].map((l) => [l.extension_kind, l.status])))
    const bad = await submitSkillListing({ kind: "webhook_app", publisher: "third_party", brokerageId: null, submittedBy: "u-staff", publisherName: "Acme", declaration: hook({ events: ["*"] }) as any }, c, seams().deps)
    check("H19 a contract-invalid declaration of a new kind is refused at submit (never drafted)", !bad.ok && bad.reason === "declaration_invalid")
    const tenantAdapter = await submitSkillListing({ kind: "provider_adapter", publisher: "tenant", brokerageId: T1, submittedBy: "u-admin-1", declaration: adapter() as any }, c, seams().deps)
    check("H20 a TENANT can never author a provider adapter (platform_controlled)", !tenantAdapter.ok && tenantAdapter.reason === "platform_controlled:provider_adapter")
    const sx = seams()
    const c2 = memClient({ skill_marketplace_listings: c.tables.skill_marketplace_listings, brokerage_settings: [{ id: "bs", brokerage_id: T2, settings: {}, updated_at: "2026-10-01T00:00:00.000Z" }] })
    const optIn = await setTenantExtensionEnabled({ brokerageId: T2, listingId: wa.id, enable: true, actor: { userId: "u-admin-2", isTenantAdmin: true } }, c2, sx.deps)
    check("H21 a tenant opts in to the enabled webhook app through the entitlement gate (app.access asked)", optIn.ok && sx.affords.some((a) => a.capability === "app.access"), JSON.stringify(optIn))
  }

  console.log("\nI. memory_access ENFORCED by the context compiler (lib/kernel/mission-context.ts)")
  const M1 = "99999999-1111-4111-8111-999999999999", C1 = "88888888-1111-4111-8111-888888888888"
  const missionRow: any = { id: M1, brokerage_id: T1, objective: "Launch 1 Main", mission_type: "campaign", owner_manager: "campaign_orchestrator", participating_managers: [], subject_type: "contact", subject_id: C1, state: "ACTIVE", priority: "normal", success_criteria: [], budget: { usd: 10 }, spent_usd: 0, spent_tokens: 0, authority_ceiling: 4, deadline: null, dependencies: [], blockers: [], evidence: [], progress: {}, actions: [], outcomes: [], created_by: null, parent_mission: null, state_changed_at: null, completed_at: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: null }
  const observed = () => {
    const called: string[] = []
    const mark = (k: string) => { called.push(k) }
    const deps: MissionContextDeps = {
      mission: async (b, id) => (b === T1 && id === M1 ? missionRow : null),
      contactRow: async () => { mark("person"); return { row: { id: C1, first_name: "Dana", contact_type: "seller", agent_id: "a1" }, error: null } },
      identity: async () => ({ personId: null, evidenceCount: 0, error: null }),
      listing: async () => { mark("property"); return { row: { id: "l1", address: "1 Main", status: "draft" }, error: null } },
      memory: async () => { mark("memory"); return { spine: {}, block: "SECRET-MEMORY-LINE: prefers texts after 6pm" } as any },
      nba: async () => { mark("opportunity"); return { ok: true, context: { appointmentAt: null, callbackRequested: false, deadEnds: [], memoryFacts: [], householdContactIds: [] } as any } },
      policy: async (_b, m) => { mark("policy"); return { isaPolicyRef: "p@1", managerPolicyRef: `authority_level:${m}@1`, brandBlock: "", voice: null, error: null } },
      fatigue: async () => { mark("fatigue"); return { riskLevel: "fresh", score: 1, at: null, found: true, error: null } },
      capacity: async () => { mark("capacity"); return { band: "available", load: 1, fatigueTier: null, error: null } },
      authority: async () => 4 as any,
      events: async () => { mark("events"); return { rows: [{ at: "2026-10-01T00:00", source: "mission_events", kind: "transition", summary: "e" }], error: null } },
      delegations: async () => { mark("delegations"); return { rows: [], error: null } },
      book: async () => ({ booked: true, error: null }),
    }
    return { called, deps }
  }
  const compileAs = async (access: any) => { const o = observed(); const r = await compileManagerContext({ brokerageId: T1, missionId: M1, manager: "campaign_orchestrator", tokenBudget: 4000, memoryAccess: access, deps: o.deps, client: memClient() as any }); return { o, r } }
  {
    const builtin = await compileAs(undefined)
    check("I1 (positive control) a BUILT-IN manager (no memory_access) gets every slice — memory read and rendered", builtin.r.ok && builtin.o.called.includes("memory") && builtin.r.section.includes("SECRET-MEMORY-LINE"))
    const mc = await compileAs("mission_context")
    check("I2 memory_access mission_context: the memory reader is NEVER CALLED and the memory line is absent from the section", mc.r.ok && !mc.o.called.includes("memory") && !mc.r.section.includes("SECRET-MEMORY-LINE") && mc.r.context.memory.data === null, JSON.stringify(mc.o.called))
    check("I3 mission_context still compiles its declared slices (person, property, opportunity, events)", mc.r.ok && ["person", "property", "opportunity", "events"].every((k) => mc.o.called.includes(k)))
    const none = await compileAs("none")
    const undeclared = ["person", "property", "memory", "opportunity", "fatigue", "capacity", "events", "delegations"]
    check("I4 memory_access none: only governance slices (mission, policy, tools, budget) — no undeclared reader is called", none.r.ok && undeclared.every((k) => !none.o.called.includes(k)) && none.o.called.includes("policy") && none.r.context.person.data === null && /withheld/.test(none.r.context.person.reader), JSON.stringify(none.o.called))
    const cm = await compileAs("contact_memory")
    check("I5 memory_access contact_memory admits the memory slice (read + rendered)", cm.r.ok && cm.o.called.includes("memory") && cm.r.section.includes("SECRET-MEMORY-LINE"))
    const unknown = await compileAs("everything")
    check("I6 an unknown memory_access value fails CLOSED to governance only", unknown.r.ok && !unknown.o.called.includes("memory") && !unknown.o.called.includes("person"))
    check("I7 each declared level's admitted set is a superset of the one below (none ⊂ mission_context ⊂ contact_memory; memory only in the last)", [...CONTEXT_SLICES_BY_MEMORY_ACCESS.none].every((x) => CONTEXT_SLICES_BY_MEMORY_ACCESS.mission_context.has(x)) && [...CONTEXT_SLICES_BY_MEMORY_ACCESS.mission_context].every((x) => CONTEXT_SLICES_BY_MEMORY_ACCESS.contact_memory.has(x)) && !CONTEXT_SLICES_BY_MEMORY_ACCESS.mission_context.has("memory") && CONTEXT_SLICES_BY_MEMORY_ACCESS.contact_memory.has("memory"))
  }

  console.log("\nJ. a custom-manager run: declared slices only + cost booked on its ledger row")
  {
    const c = memClient()
    await toEnabled(c, { kind: "custom_manager", publisher: "tenant", brokerageId: T1, submittedBy: "u-admin-1", declaration: desk() }, ADMIN1)
    const o = observed()
    const s = seams({ authority: 6 })
    const passed: any[] = []
    s.deps.compileContext = async (input) => { passed.push(input); return compileManagerContext({ ...input, deps: o.deps }) }
    const r = await runCustomManagerCapability({ brokerageId: T1, customManager: "listing_launch_desk", capability: "cma_generate", inputs: CMA_INPUTS, objective: "prep", missionId: M1 }, c, s.deps)
    check("J1 the run compiles its context through THE compiler with its DECLARED memory_access (mission_context), as its escalation owner", r.ok && passed.length === 1 && passed[0].memoryAccess === "mission_context" && passed[0].manager === "campaign_orchestrator", r.ok ? JSON.stringify(passed.map((p) => [p.memoryAccess, p.manager])) : (r as any).reason)
    check("J2 what it RECEIVED holds no undeclared slice (no memory read, no memory line; slices published on the result)", r.ok && !!r.context && !r.context.slices.includes("memory") && !r.context.section.includes("SECRET-MEMORY-LINE") && !o.called.includes("memory"), r.ok ? JSON.stringify(r.context?.slices) : (r as any).reason)
    const row = s.ledger.find((l) => l.action === "extension.custom_manager.run")
    check("J3 COST is booked on its run ledger row (cost_usd = the metered per-run ceiling, basis named) and returned", r.ok && row?.costUsd === 2 && row?.detail?.cost_basis === "per_run_budget_ceiling_metered" && r.costUsd === 2 && Array.isArray(row?.detail?.context_slices), JSON.stringify(row?.detail))
    const foreignMission = await runCustomManagerCapability({ brokerageId: T2, customManager: "listing_launch_desk", capability: "cma_generate", inputs: CMA_INPUTS, objective: "x", missionId: M1 }, c, s.deps)
    check("J4 another tenant cannot run it against this tenant's mission (refused)", !foreignMission.ok)
    const s2 = seams({ authority: 6 })
    s2.deps.compileContext = async (input) => compileManagerContext({ ...input, deps: o.deps })
    const nf = await runCustomManagerCapability({ brokerageId: T1, customManager: "listing_launch_desk", capability: "cma_generate", inputs: CMA_INPUTS, objective: "x", missionId: "00000000-0000-4000-8000-000000000000" }, c, s2.deps)
    check("J5 an unknown mission → mission_context_refused (fail closed: no ledger row, no delegation)", !nf.ok && /^mission_context_refused:not_found/.test(nf.reason) && s2.delegations.length === 0 && s2.ledger.length === 0, JSON.stringify(nf))
  }

  console.log("\nK. the platform kill-switch queue for TENANT listings")
  {
    const c = memClient()
    const own = await toEnabled(c, { kind: "custom_manager", publisher: "tenant", brokerageId: T2, submittedBy: "u-admin-2", declaration: desk({ name: "t2_desk" }) }, { ...ADMIN1, brokerageId: T2, userId: "u-admin-2" })
    await toEnabled(c, { publisher: "third_party", brokerageId: null, submittedBy: "u-staff", publisherName: "Acme", declaration: legacy({ name: "acme_touch" }) }, STAFF)
    const q = await listPlatformSkillListings(c, "tenant")
    const g = await listPlatformSkillListings(c)
    check("K1 the staff tenant queue lists tenant-authored listings (any tenant) and the global queue does not", q.listings.some((l) => l.id === own.id) && q.listings.every((l) => l.publisher === "tenant") && g.listings.length > 0 && g.listings.every((l) => l.publisher !== "tenant"))
    const s = seams()
    const sus = await decideSkillListing({ listingId: own.id, decision: "suspend", actor: STAFF, reason: "abuse report #7" }, c, s.deps)
    const row = s.ledger.find((l) => l.action === "extension.listing.suspend")
    check("K2 staff SUSPEND works on a tenant listing; evidence: ledgered on THAT tenant as platform_staff with the reason; declaration + digest + evidence kept", sus.ok && sus.listing.status === "suspended" && sus.listing.suspended_reason === "abuse report #7" && row?.brokerageId === T2 && row?.detail?.approver === "platform_staff" && sus.listing.declaration_digest === own.declaration_digest && JSON.stringify(sus.listing.evaluation_evidence) === JSON.stringify(own.evaluation_evidence), JSON.stringify(row))
    const run = await runCustomManagerCapability({ brokerageId: T2, customManager: "t2_desk", capability: "cma_generate", inputs: CMA_INPUTS, objective: "x" }, c, seams().deps)
    check("K3 the suspended tenant extension cannot execute", !run.ok && /not_executable:suspended/.test(run.reason))
    const resume = await decideSkillListing({ listingId: own.id, decision: "resume", actor: STAFF }, c, s.deps)
    check("K4 staff hold ONLY the kill switch on a tenant listing (resume refused)", !resume.ok)
    const panel = src("app/components/skills/skill-marketplace-panel.tsx")
    check("K5 wired: the superadmin panel reads getPlatformTenantExtensions and offers only the kill switch; the door is staff-gated; the page mounts the platform panel", panel.includes("getPlatformTenantExtensions()") && /only=\{KILL_SWITCH\}/.test(panel) && /KILL_SWITCH[^=]*=\s*\["suspend", "disable"\]/.test(panel) && /export async function getPlatformTenantExtensions\(\)[\s\S]{0,200}requirePlatformStaff\(\)/.test(src("app/actions/skill-marketplace.ts")) && /<SkillMarketplacePanel mode="platform" \/>/.test(src("app/dashboard/superadmin/skill-marketplace/page.tsx")))
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  console.log(" BLIND SPOTS: in-memory client (no RLS / CHECK / trigger — m738 holds those live once applied); mayUseAndAfford, resolveAgentAuthorityLevel, requestDelegation and withActionLedger are seams here (skill-registry-guard runs the REAL ledger; their own proofs cover them); mergeBrokerageSettings + appendTenantPolicyVersion run REAL against the in-memory client; the three survivor-owned contracts are judged against the CURRENT strategy library / route table / event catalogue (a later edit there re-judges every listing at enablement); the compiler's readers are seams in I/J (mission-context-guard runs the real readers); a custom-manager run's cost is the metered per-run CEILING, not a measured spend; the census reads one runtime file (a second run path elsewhere would need its own census).")
  if (fail > 0) { console.log(" ❌ EXTENSION_LIFECYCLE_FAIL"); process.exit(1) }
  console.log(" ✅ EXTENSION_LIFECYCLE_PASS — skills, custom managers, strategies, provider adapters and webhook apps are bounded contracts on one lifecycle; suspended / disabled never execute and keep their evidence; tenants opt in through versioned policy")
}
main().catch((e) => { console.error(e); process.exit(1) })
