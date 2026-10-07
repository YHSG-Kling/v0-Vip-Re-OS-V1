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
    // kinds without a registered contract fail closed
    const st = await submitSkillListing({ kind: "strategy", publisher: "third_party", brokerageId: null, submittedBy: "u-staff", publisherName: "Acme", declaration: { name: "acme_strategy", version: 1, evaluation_suite: "skill_eval:contract_v1" } as any }, c, s.deps)
    const stEv = st.ok ? await evaluateSkillListing({ listingId: st.listing.id, actorBrokerageId: null }, c, s.deps) : null
    check("D12 a kind whose contract lives in another survivor (strategy) can be DRAFTED but never validated (no evaluator) — fails closed", st.ok && st.listing.status === "draft" && !!stEv && !stEv.ok && /^no_evaluation_suite:strategy/.test(stEv.reason))
    const checks = extensionEnablementChecks({ extension_kind: "webhook_app", declaration: {}, evaluation_evidence: { suite: "x", passed: true, checks: [] } }, true)
    check("D13 enablement checks for an unregistered kind refuse contract + risk + dependencies even with passing evidence", ["contract_valid", "risk_classified", "dependencies_available"].every((n) => checks.find((x) => x.name === n)?.ok === false))
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

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  console.log(" BLIND SPOTS: in-memory client (no RLS / CHECK / trigger — m738 holds those live once applied); mayUseAndAfford, resolveAgentAuthorityLevel, requestDelegation and withActionLedger are seams here (skill-registry-guard runs the REAL ledger; their own proofs cover them); mergeBrokerageSettings + appendTenantPolicyVersion run REAL against the in-memory client; strategy / provider_adapter / webhook_app have NO contract validator registered (they fail closed — drafted, never enabled) until 137B/C/E plug theirs in; a custom manager's memory_access is declared + ledgered, not yet enforced by the context compiler; the census reads one runtime file (a second run path elsewhere would need its own census).")
  if (fail > 0) { console.log(" ❌ EXTENSION_LIFECYCLE_FAIL"); process.exit(1) }
  console.log(" ✅ EXTENSION_LIFECYCLE_PASS — skills and custom managers are bounded contracts on one lifecycle; suspended / disabled never execute and keep their evidence; tenants opt in through versioned policy")
}
main().catch((e) => { console.error(e); process.exit(1) })
