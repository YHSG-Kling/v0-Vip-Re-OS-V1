#!/usr/bin/env tsx
/**
 * scripts/skill-registry-guard.ts   (npm run test:skill-registry) — wave 108, lane 108A.
 * ─────────────────────────────────────────────────────────────────────────────
 * SKILL REGISTRY EXPANSION + AGENT/SKILL MARKETPLACE — in-memory client, no network. Proves
 * lib/kernel/skill-registry.ts + lib/kernel/skill-marketplace.ts:
 *   A. every backfilled built-in skill is valid, carries all eleven declared fields, and is DERIVED from the
 *      catalogue survivors (owner, inputs, risk, authority, entitlement gate file, proof key on package.json)
 *   B. validator negative controls (each defect refused with its own code) + a positive control
 *   C. marketplace lifecycle: submit → evaluate → approve → publish → revoke; failed suite → rejected;
 *      approver rules (platform staff for third-party, tenant admin of THIS tenant for tenant skills)
 *   D. an unapproved / unpublished / revoked / tampered skill cannot run
 *   E. metering + ledger on run — the REAL withActionLedger writes agent_action_ledger (risk_class,
 *      policy_ref, cost_usd) through the client; one delegation per capability to the owning manager
 *   F. run refusals (entitlement, cost lane, authority, self-run, inputs, tenant id as input) act on nothing
 *   G. tenant isolation
 *   H. wiring (stripped source) + registration + one vocabulary (migration CHECK = the code's lists)
 * Rules asserted, not waypoints: counts derive from the registry; the migration is read as the LATEST file
 * defining the CHECK; its header may carry the lane stamp or an APPLIED LIVE stamp.
 */
import { readFileSync, readdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import {
  MANAGER_SKILLS, CAPABILITY_ENTITLEMENT, SKILL_EVALUATORS, SKILL_LISTING_STATUSES, SKILL_PUBLISHERS, SKILL_RUN_RECEIPT_SCHEMA,
  BASE_PLAN_ENTITLEMENT, authorityBandFor, canDecideSkillListing, canSkillListingTransition, knownEvaluationSuites,
  validateSkillDeclaration, type SkillDeclaration,
} from "../lib/kernel/skill-registry"
import {
  submitSkillListing, evaluateSkillListing, decideSkillListing, runSkill, resolveRunnableSkill, skillDeclarationDigest,
  type SkillMarketplaceDeps,
} from "../lib/kernel/skill-marketplace"
import { APP_CAPABILITY_REGISTRY, type AppCapability } from "../lib/agentic-os/app-capability-registry"
import { CAPABILITY_MANAGER } from "../lib/agentic-os/capability-ownership"
import { MIN_AUTHORITY_FOR_RISK } from "../lib/ai-isa/persona-tool-policy"
import { capabilityRiskClass } from "../lib/kernel/mission-controller"
import { MAINTENANCE_DOMAINS, TABLE_MANAGER } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) } }
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

// ─── in-memory supabase-js shaped client (manager-delegation-guard's shape) ─────────────────
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
          const rows = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), evaluation_evidence: null, ...r }))
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
        select: () => b, not: () => b, is: () => b, or: () => b, gte: () => b, lte: () => b, lt: () => b, neq: () => b,
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

/** Observing seams; `realLedger` keeps THE ledger survivor (withActionLedger) writing through the client. */
function seams(over: { afford?: (cap: string, feature?: string) => boolean; authority?: number; realLedger?: boolean } = {}) {
  const affords: any[] = [], ledger: any[] = [], delegations: any[] = []
  const deps: SkillMarketplaceDeps = {
    afford: async (i) => { affords.push(i); const ok = over.afford ? over.afford(i.capability, i.featureKey) : true; return { allowed: ok, reason: ok ? "active" : `refused:${i.capability}` } },
    authority: async () => (over.authority ?? 6) as any,
    delegate: async (i) => { delegations.push(i); return { ok: true, delegationId: `dl-${delegations.length}` } },
  }
  if (!over.realLedger) deps.ledger = async (input, act) => { ledger.push(input); return act() }
  return { deps, affords, ledger, delegations }
}

const T1 = "11111111-1111-4111-8111-111111111111"
const T2 = "22222222-2222-4222-8222-222222222222"
const ADMIN1 = { isPlatformStaff: false, isTenantAdmin: true, brokerageId: T1, userId: "u-admin-1" }
const ADMIN2 = { isPlatformStaff: false, isTenantAdmin: true, brokerageId: T2, userId: "u-admin-2" }
const AGENT1 = { isPlatformStaff: false, isTenantAdmin: false, brokerageId: T1, userId: "u-agent-1" }
const STAFF = { isPlatformStaff: true, isTenantAdmin: false, brokerageId: null, userId: "u-staff" }

/** A tenant-authored COMPOSITE skill: two campaign_orchestrator capabilities (newsletter + direct mail). */
function composite(over: Partial<SkillDeclaration> = {}): SkillDeclaration {
  return {
    name: "seller_reactivation_touch", version: 1, manager_owner: "campaign_orchestrator",
    purpose: "Reactivate a past seller with a newsletter issue and a direct-mail piece.",
    inputs: { fields: [{ name: "campaignId", type: "uuid", required: true }] },
    outputs: SKILL_RUN_RECEIPT_SCHEMA,
    required_capabilities: ["newsletter_send", "direct_mail_send"],
    risk_class: "COMMUNICATION", authority_requirement: 3,
    cost_estimate: { usd: 4.5, tokens: 0, budget: "vendor_spend", basis: "declared" },
    tenant_entitlement: "direct_mail", evaluation_suite: "skill_eval:contract_v1",
    evaluation_fixtures: [{ campaignId: "33333333-3333-4333-8333-333333333333" }],
    ...over,
  }
}

async function publishedTenantSkill(c: ReturnType<typeof memClient>, decl = composite(), tenant = T1, admin = ADMIN1) {
  const s = seams()
  const sub = await submitSkillListing({ publisher: "tenant", brokerageId: tenant, submittedBy: admin.userId, declaration: decl }, c, s.deps)
  if (!sub.ok) throw new Error(`submit: ${sub.reason} ${sub.errors?.join(",") ?? ""}`)
  const ev = await evaluateSkillListing({ listingId: sub.listing.id, actorBrokerageId: tenant }, c, s.deps)
  if (!ev.ok) throw new Error(`evaluate: ${ev.reason}`)
  const ap = await decideSkillListing({ listingId: sub.listing.id, decision: "approve", actor: admin }, c, s.deps)
  if (!ap.ok) throw new Error(`approve: ${ap.reason}`)
  const pub = await decideSkillListing({ listingId: sub.listing.id, decision: "publish", actor: admin }, c, s.deps)
  if (!pub.ok) throw new Error(`publish: ${pub.reason}`)
  return pub.listing
}

async function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
  const suites = new Set<string>([...Object.keys(pkg.scripts).filter((k) => k.startsWith("test:")), ...Object.keys(SKILL_EVALUATORS)])
  const capKeys = Object.keys(APP_CAPABILITY_REGISTRY) as AppCapability[]

  console.log("\nA. every backfilled built-in skill is valid and derived")
  {
    check(`A1 one built-in skill per catalogue capability (${MANAGER_SKILLS.length} of ${capKeys.length})`, MANAGER_SKILLS.length === capKeys.length && capKeys.every((k) => MANAGER_SKILLS.some((s) => s.name === k)))
    const invalid = MANAGER_SKILLS.map((s) => ({ s: s.name, v: validateSkillDeclaration(s, { knownEvaluationSuites: suites }) })).filter((x) => !x.v.ok)
    check("A2 every built-in skill passes the validator (evaluation suites read from package.json)", invalid.length === 0, invalid.map((x) => `${x.s}: ${x.v.errors.join(",")}`).join(" | "))
    const FIELDS = ["name", "version", "manager_owner", "inputs", "outputs", "required_capabilities", "risk_class", "authority_requirement", "cost_estimate", "tenant_entitlement", "evaluation_suite"]
    check("A3 every built-in declares all eleven owner fields", MANAGER_SKILLS.every((s) => FIELDS.every((f) => (s as any)[f] !== undefined && (s as any)[f] !== null)))
    check("A4 derived, never invented: owner = CAPABILITY_MANAGER, capability = itself, risk = capabilityRiskClass, authority = MIN_AUTHORITY_FOR_RISK", MANAGER_SKILLS.every((s) => {
      const c = s.name as AppCapability
      return s.manager_owner === CAPABILITY_MANAGER[c] && s.required_capabilities.length === 1 && s.required_capabilities[0] === c && s.risk_class === capabilityRiskClass(c) && s.authority_requirement === MIN_AUTHORITY_FOR_RISK[capabilityRiskClass(c)]
    }))
    check("A5 inputs = the registry's input spec minus the tenant (no built-in takes brokerageId)", MANAGER_SKILLS.every((s) => {
      const spec = APP_CAPABILITY_REGISTRY[s.name as AppCapability].inputs.map((x) => x.replace(/\?$/, "")).filter((x) => x !== "brokerageId")
      return JSON.stringify(s.inputs.fields.map((f) => f.name)) === JSON.stringify(spec) && !s.inputs.fields.some((f) => f.name === "brokerageId")
    }))
    const missingProof = MANAGER_SKILLS.filter((s) => !(s.evaluation_suite in pkg.scripts))
    check("A6 every built-in evaluation suite is a registered package.json proof", missingProof.length === 0, missingProof.map((s) => `${s.name}→${s.evaluation_suite}`).join(", "))
    const gateMisses = Object.entries(CAPABILITY_ENTITLEMENT).filter(([, e]) => !new RegExp(`mayUseFeature\\([^,]+,\\s*"${e!.feature}"\\)`).test(src(e!.gate)))
    check(`A7 every plan-feature entitlement is the key the capability's own server action already gates on (${Object.keys(CAPABILITY_ENTITLEMENT).length} cited)`, gateMisses.length === 0, gateMisses.map(([k]) => k).join(", "))
    const ctl = stripComments(`// mayUseFeature(userId, "direct_mail") — once\nconst a = 1`)
    check("A8 (control) a gate named only in a comment is NOT read as a gate", !/mayUseFeature\([^,]+,\s*"direct_mail"\)/.test(ctl))
    check("A9 everything else rides the base plan (app.access)", MANAGER_SKILLS.filter((s) => !(s.name in CAPABILITY_ENTITLEMENT)).every((s) => s.tenant_entitlement === BASE_PLAN_ENTITLEMENT))
    check("A10 payment_transfer derives FINANCIAL at rung 6; LEGAL / IRREVERSIBLE never carry a band", MANAGER_SKILLS.find((s) => s.name === "payment_transfer")?.risk_class === "FINANCIAL" && MANAGER_SKILLS.find((s) => s.name === "payment_transfer")?.authority_requirement === 6 && authorityBandFor("LEGAL") === null && authorityBandFor("IRREVERSIBLE") === null)
  }

  console.log("\nB. validator negative controls")
  {
    const v = (d: SkillDeclaration) => validateSkillDeclaration(d, { knownEvaluationSuites: suites })
    const has = (d: SkillDeclaration, code: string) => v(d).errors.some((e) => e.startsWith(code))
    check("B0 (positive control) the composite marketplace declaration is valid", v(composite()).ok, v(composite()).errors.join(","))
    check("B1 a capability its manager does not own → capability_not_owned", has(composite({ required_capabilities: ["newsletter_send", "payment_transfer"] }), "capability_not_owned:payment_transfer"))
    check("B2 authority above the risk class's band → authority_exceeds_risk_class", has(composite({ authority_requirement: 6 }), "authority_exceeds_risk_class"))
    check("B3 authority below the risk class's band → authority_below_risk_class", has(composite({ authority_requirement: 1 }), "authority_below_risk_class"))
    check("B4 risk understated against its capabilities → risk_understated", has(composite({ risk_class: "LOW_RISK_WRITE", authority_requirement: 1 }), "risk_understated"))
    check("B5 LEGAL / IRREVERSIBLE → risk_never_ai", has(composite({ risk_class: "IRREVERSIBLE" }), "risk_never_ai"))
    check("B6 no evaluation suite → no_evaluation_suite", has(composite({ evaluation_suite: "" }), "no_evaluation_suite"))
    check("B7 an unknown evaluation suite → unknown_evaluation_suite", has(composite({ evaluation_suite: "test:does-not-exist" }), "unknown_evaluation_suite"))
    check("B8 a tenant id as an input → tenant_from_input", has(composite({ inputs: { fields: [{ name: "campaignId", type: "uuid", required: true }, { name: "brokerageId", type: "uuid", required: true }] } }), "tenant_from_input"))
    check("B9 a code field → not_data (a marketplace skill is data, never code)", has({ ...composite(), code: "fetch('https://x')" } as any, "not_data:code"))
    check("B10 a capability's required input not covered → capability_input_uncovered", has(composite({ inputs: { fields: [] } }), "capability_input_uncovered:newsletter_send.campaignId"))
    check("B11 an unknown capability → unknown_capability", has(composite({ required_capabilities: ["mint_money" as AppCapability] }), "unknown_capability"))
    check("B12 an ai_tokens lane with no tokens → cost_tokens_missing_for_ai_lane", has(composite({ cost_estimate: { usd: 0, tokens: 0, budget: "ai_tokens", basis: "declared" } }), "cost_tokens_missing_for_ai_lane"))
  }

  console.log("\nC. marketplace lifecycle")
  {
    const c = memClient()
    const s = seams()
    const sub = await submitSkillListing({ publisher: "tenant", brokerageId: T1, submittedBy: "u-admin-1", declaration: composite() }, c, s.deps)
    check("C1 a tenant submission lands `submitted` with a digest", sub.ok && sub.listing.status === "submitted" && sub.listing.declaration_digest === skillDeclarationDigest(composite()))
    if (!sub.ok) throw new Error(sub.reason)
    const early = await decideSkillListing({ listingId: sub.listing.id, decision: "approve", actor: ADMIN1 }, c, s.deps)
    check("C2 approval BEFORE evaluation is refused", !early.ok && early.reason === "evaluation_not_passed")
    const ev = await evaluateSkillListing({ listingId: sub.listing.id, actorBrokerageId: T1 }, c, s.deps)
    check("C3 the evaluation suite runs and passes → `evaluated` with evidence", ev.ok && ev.listing.status === "evaluated" && ev.listing.evaluation_evidence?.passed === true && (ev.listing.evaluation_evidence?.checks.length ?? 0) >= 4)
    const byAgent = await decideSkillListing({ listingId: sub.listing.id, decision: "approve", actor: AGENT1 }, c, s.deps)
    check("C4 a non-admin of the tenant cannot approve", !byAgent.ok && byAgent.reason === "tenant_admin_of_this_tenant_only")
    const byStaff = await decideSkillListing({ listingId: sub.listing.id, decision: "approve", actor: STAFF }, c, s.deps)
    check("C5 platform staff do not approve a TENANT-authored skill (the tenant admin does)", !byStaff.ok)
    const ap = await decideSkillListing({ listingId: sub.listing.id, decision: "approve", actor: ADMIN1 }, c, s.deps)
    check("C6 the tenant's admin approves → `approved` (approved_by from the actor)", ap.ok && ap.listing.status === "approved" && ap.listing.approved_by === "u-admin-1")
    const pub = await decideSkillListing({ listingId: sub.listing.id, decision: "publish", actor: ADMIN1 }, c, s.deps)
    check("C7 publish → `published`", pub.ok && pub.listing.status === "published")
    const noReason = await decideSkillListing({ listingId: sub.listing.id, decision: "revoke", actor: ADMIN1 }, c, s.deps)
    check("C8 revoke without a reason is refused", !noReason.ok && noReason.reason === "revoke_reason_required")
    const rev = await decideSkillListing({ listingId: sub.listing.id, decision: "revoke", actor: ADMIN1, reason: "superseded by v2" }, c, s.deps)
    check("C9 revoke → `revoked` with the reason", rev.ok && rev.listing.status === "revoked" && rev.listing.revoked_reason === "superseded by v2")
    const again = await decideSkillListing({ listingId: sub.listing.id, decision: "publish", actor: ADMIN1 }, c, s.deps)
    check("C10 a revoked listing cannot be re-published (terminal)", !again.ok && /invalid_transition:revoked->published/.test(again.reason))
    check("C11 every lifecycle move left a ledger entry (submit, evaluate, approve, publish, revoke)", ["skill.listing.submit", "skill.listing.evaluate", "skill.listing.approve", "skill.listing.publish", "skill.listing.revoke"].every((a) => s.ledger.some((l) => l.action === a)))
    // failed suite → rejected
    const bad = await submitSkillListing({ publisher: "third_party", brokerageId: null, submittedBy: "u-staff", publisherName: "Acme Skills", declaration: composite({ name: "acme_no_fixture", evaluation_fixtures: [] }) }, c, s.deps)
    if (!bad.ok) throw new Error(bad.reason)
    const badEv = await evaluateSkillListing({ listingId: bad.listing.id, actorBrokerageId: null }, c, s.deps)
    check("C12 a declaration that fails its suite (no fixtures) → `rejected`, and cannot be approved", badEv.ok && badEv.listing.status === "rejected" && !(await decideSkillListing({ listingId: bad.listing.id, decision: "approve", actor: STAFF }, c, s.deps)).ok)
    // third-party approvals
    const tp = await submitSkillListing({ publisher: "third_party", brokerageId: null, submittedBy: "u-staff", publisherName: "Acme Skills", declaration: composite({ name: "acme_reactivation" }) }, c, s.deps)
    if (!tp.ok) throw new Error(tp.reason)
    await evaluateSkillListing({ listingId: tp.listing.id, actorBrokerageId: null }, c, s.deps)
    const tpByTenant = await decideSkillListing({ listingId: tp.listing.id, decision: "approve", actor: ADMIN1 }, c, s.deps)
    check("C13 a tenant admin cannot approve a THIRD-PARTY skill (platform staff only)", !tpByTenant.ok && tpByTenant.reason === "platform_staff_only")
    const tpOk = await decideSkillListing({ listingId: tp.listing.id, decision: "approve", actor: STAFF }, c, s.deps)
    check("C14 platform staff approve the third-party skill", tpOk.ok && tpOk.listing.status === "approved")
    check("C15 a tenant id on a global listing / no tenant on a tenant listing is refused", !(await submitSkillListing({ publisher: "third_party", brokerageId: T1, submittedBy: null, declaration: composite({ name: "x_global" }) }, c, s.deps)).ok && !(await submitSkillListing({ publisher: "tenant", brokerageId: null, submittedBy: null, declaration: composite({ name: "x_tenant" }) }, c, s.deps)).ok)
    check("C16 a built-in name cannot be shadowed by a marketplace listing", !(await submitSkillListing({ publisher: "tenant", brokerageId: T1, submittedBy: null, declaration: composite({ name: "newsletter_send" }) }, c, s.deps)).ok)
    check("C17 an invalid declaration is refused at submission with its errors", (() => true)() && !(await submitSkillListing({ publisher: "tenant", brokerageId: T1, submittedBy: null, declaration: composite({ name: "x_bad", authority_requirement: 6 }) }, c, s.deps)).ok)
    check("C18 the transition table: published → revoked only; rejected / revoked terminal", canSkillListingTransition("published", "revoked") && !canSkillListingTransition("published", "approved") && !canSkillListingTransition("rejected", "evaluated") && !canSkillListingTransition("revoked", "published"))
    check("C19 canDecideSkillListing: tenant admin of ANOTHER tenant is refused", !canDecideSkillListing({ publisher: "tenant", brokerage_id: T1 }, ADMIN2) && canDecideSkillListing({ publisher: "tenant", brokerage_id: T1 }, ADMIN1))
  }

  console.log("\nD. an unapproved skill cannot run")
  {
    const c = memClient()
    const s = seams()
    const run = (skill: string) => runSkill({ brokerageId: T1, skill, requestingManager: "ai_isa", inputs: { campaignId: "33333333-3333-4333-8333-333333333333" }, objective: "reactivate" }, c, s.deps)
    const sub = await submitSkillListing({ publisher: "tenant", brokerageId: T1, submittedBy: "u-admin-1", declaration: composite() }, c, s.deps)
    if (!sub.ok) throw new Error(sub.reason)
    const r1 = await run("seller_reactivation_touch")
    check("D1 `submitted` → not runnable", !r1.ok && /^skill_not_runnable:not_published:submitted/.test(r1.reason))
    await evaluateSkillListing({ listingId: sub.listing.id, actorBrokerageId: T1 }, c, s.deps)
    const r2 = await run("seller_reactivation_touch")
    check("D2 `evaluated` → not runnable", !r2.ok && /not_published:evaluated/.test(r2.reason))
    await decideSkillListing({ listingId: sub.listing.id, decision: "approve", actor: ADMIN1 }, c, s.deps)
    const r3 = await run("seller_reactivation_touch")
    check("D3 `approved` but unpublished → not runnable", !r3.ok && /not_published:approved/.test(r3.reason))
    await decideSkillListing({ listingId: sub.listing.id, decision: "publish", actor: ADMIN1 }, c, s.deps)
    const ok = await run("seller_reactivation_touch")
    check("D4 (positive control) once published it runs", ok.ok, ok.ok ? "" : ok.reason)
    const row = c.tables.skill_marketplace_listings.find((r) => r.id === sub.listing.id)!
    const original = row.declaration
    row.declaration = { ...original, authority_requirement: 3, required_capabilities: ["newsletter_send", "direct_mail_send", "video_distribute"] }
    const tampered = await run("seller_reactivation_touch")
    row.declaration = original
    check("D5 a declaration altered after approval (digest drift) → not runnable", !tampered.ok && /digest_mismatch/.test(tampered.reason))
    await decideSkillListing({ listingId: sub.listing.id, decision: "revoke", actor: ADMIN1, reason: "pulled" }, c, s.deps)
    const r5 = await run("seller_reactivation_touch")
    check("D6 `revoked` → not runnable", !r5.ok && /not_published:revoked/.test(r5.reason))
    const r6 = await run("no_such_skill")
    check("D7 an unknown skill → not runnable", !r6.ok && /unknown_skill/.test(r6.reason))
    check("D8 no delegation was opened by any refused run (only D4's two)", s.delegations.length === 2)
  }

  console.log("\nE. metering + ledger on run (the REAL withActionLedger)")
  {
    const c = memClient()
    const listing = await publishedTenantSkill(c)
    const s = seams({ realLedger: true })
    const r = await runSkill({ brokerageId: T1, skill: "seller_reactivation_touch", requestingManager: "ai_isa", inputs: { campaignId: "33333333-3333-4333-8333-333333333333" }, objective: "reactivate past sellers" }, c, s.deps)
    check("E1 the run executes and returns one delegation per capability", r.ok && r.delegationIds.length === 2, r.ok ? "" : r.reason)
    check("E2 entitlement: feature.use asked for the declared plan feature, for the TENANT", s.affords.some((a) => a.capability === "feature.use" && a.featureKey === "direct_mail" && a.brokerageId === T1))
    check("E3 metering: the declared cost lane is asked (comms.send with the declared USD)", s.affords.some((a) => a.capability === "comms.send" && a.estCostUsd === 4.5))
    check("E4 capability access ONLY through delegation to the owning manager, at the declared authority", s.delegations.every((d) => d.assignedManager === "campaign_orchestrator" && d.requestingManager === "ai_isa" && d.authority === 3 && d.brokerageId === T1) && s.delegations.map((d) => d.capability).join(",") === "newsletter_send,direct_mail_send")
    const rows = (c.tables.agent_action_ledger ?? []).filter((x) => x.action === "skill.manager_skill.run")
    const lr = rows[0]
    check("E5 one agent_action_ledger row for the run (subject skill, ref name@v1, the listing id)", rows.length === 1 && lr.subject_type === "skill" && lr.subject_ref === "seller_reactivation_touch@v1" && lr.subject_id === listing.id, JSON.stringify(rows.map((x) => ({ a: x.action, st: x.status }))))
    check("E6 the ledger row carries the risk class, WHICH POLICY permitted, the actor manager and the cost (settled executed)", lr?.risk_class === "COMMUNICATION" && String(lr?.policy_ref ?? lr?.detail?.policy_ref ?? "").startsWith("authority_level:campaign_orchestrator") && lr?.actor_manager_key === "ai_isa" && Number(lr?.cost_usd) === 4.5 && lr?.status === "executed", JSON.stringify({ risk: lr?.risk_class, policy: lr?.policy_ref, cost: lr?.cost_usd, status: lr?.status }))
    const c2 = memClient()
    await publishedTenantSkill(c2)
    const s2 = seams({ realLedger: true })
    s2.deps.delegate = async () => ({ ok: false, reason: "review:authority_above_ceiling" })
    const refused = await runSkill({ brokerageId: T1, skill: "seller_reactivation_touch", requestingManager: "ai_isa", inputs: { campaignId: "33333333-3333-4333-8333-333333333333" }, objective: "x" }, c2, s2.deps)
    const fr = (c2.tables.agent_action_ledger ?? []).find((x) => x.action === "skill.manager_skill.run")
    check("E7 a refused delegation is settled FAILED with its reason and no cost (never recorded as executed)", !refused.ok && fr?.status === "failed" && /delegation_refused/.test(String(fr?.outcome)) && fr?.cost_usd == null, JSON.stringify({ st: fr?.status, out: fr?.outcome, cost: fr?.cost_usd }))
    const b = memClient()
    const sb = seams()
    const builtin = await runSkill({ brokerageId: T1, skill: "cma_generate", requestingManager: "ai_isa", inputs: { agentId: "44444444-4444-4444-8444-444444444444", propertyAddress: "1 Main", propertyCity: "c", propertyState: "s", propertyZip: "z" }, objective: "prep" }, b, sb.deps)
    check("E8 a BUILT-IN skill runs the same path (app.access entitlement, delegation to listing_concierge)", builtin.ok && sb.affords.some((a) => a.capability === "app.access") && sb.delegations[0]?.assignedManager === "listing_concierge" && sb.ledger[0]?.action === "skill.manager_skill.run")
  }

  console.log("\nF. run refusals act on nothing")
  {
    const go = async (s: ReturnType<typeof seams>, over: Record<string, unknown> = {}) => {
      const c = memClient()
      await publishedTenantSkill(c)
      return runSkill({ brokerageId: T1, skill: "seller_reactivation_touch", requestingManager: "ai_isa", inputs: { campaignId: "33333333-3333-4333-8333-333333333333" }, objective: "x", ...over } as any, c, s.deps)
    }
    const s1 = seams({ afford: (cap) => cap !== "feature.use" })
    const r1 = await go(s1)
    check("F1 plan feature refused → refused, no ledger, no delegation", !r1.ok && /^entitlement:direct_mail/.test(r1.reason) && s1.ledger.length === 0 && s1.delegations.length === 0)
    const s2 = seams({ afford: (cap) => cap !== "comms.send" })
    const r2 = await go(s2)
    check("F2 cost lane refused → refused, nothing acted", !r2.ok && /^budget:vendor_spend/.test(r2.reason) && s2.delegations.length === 0)
    const s3 = seams({ authority: 2 })
    const r3 = await go(s3)
    check("F3 the owner's ladder rung below the requirement → refused", !r3.ok && r3.reason === "authority:2<3" && s3.delegations.length === 0)
    const s4 = seams()
    const r4 = await go(s4, { requestingManager: "campaign_orchestrator" })
    check("F4 the owner asking itself → refused (self_run)", !r4.ok && /^self_run/.test(r4.reason))
    const s5 = seams()
    const r5 = await go(s5, { inputs: { campaignId: "33333333-3333-4333-8333-333333333333", brokerageId: T2 } })
    check("F5 a tenant id smuggled as an input → refused (tenant comes from the session)", !r5.ok && r5.reason === "inputs_invalid" && (r5 as any).errors.some((e: string) => e.startsWith("tenant_from_input")))
    const s6 = seams()
    const r6 = await go(s6, { inputs: {} })
    check("F6 a missing required input → refused", !r6.ok && r6.reason === "inputs_invalid")
  }

  console.log("\nG. tenant isolation")
  {
    const c = memClient()
    const listing = await publishedTenantSkill(c)
    const s = seams()
    const other = await runSkill({ brokerageId: T2, skill: "seller_reactivation_touch", requestingManager: "ai_isa", inputs: { campaignId: "33333333-3333-4333-8333-333333333333" }, objective: "x" }, c, s.deps)
    check("G1 another tenant cannot run (or see) a tenant-authored skill", !other.ok && /unknown_skill/.test(other.reason) && s.delegations.length === 0)
    const decide = await decideSkillListing({ listingId: listing.id, decision: "revoke", actor: ADMIN2, reason: "x" }, c, s.deps)
    check("G2 another tenant's admin deciding on it reads not_found", !decide.ok && decide.reason === "not_found")
    const evalOther = await evaluateSkillListing({ listingId: listing.id, actorBrokerageId: T2 }, c, s.deps)
    check("G3 another tenant evaluating it reads not_found", !evalOther.ok && evalOther.reason === "not_found")
    const tp = await submitSkillListing({ publisher: "third_party", brokerageId: null, submittedBy: "u-staff", publisherName: "Acme", declaration: composite({ name: "acme_global" }) }, c, s.deps)
    if (!tp.ok) throw new Error(tp.reason)
    await evaluateSkillListing({ listingId: tp.listing.id, actorBrokerageId: null }, c, s.deps)
    await decideSkillListing({ listingId: tp.listing.id, decision: "approve", actor: STAFF }, c, s.deps)
    await decideSkillListing({ listingId: tp.listing.id, decision: "publish", actor: STAFF }, c, s.deps)
    const r1 = await resolveRunnableSkill(T1, "acme_global", c), r2 = await resolveRunnableSkill(T2, "acme_global", c)
    check("G4 a published third-party skill is runnable by every tenant, each under its own tenant", r1.ok && r2.ok)
    const runT2 = await runSkill({ brokerageId: T2, skill: "acme_global", requestingManager: "ai_isa", inputs: { campaignId: "33333333-3333-4333-8333-333333333333" }, objective: "x" }, c, s.deps)
    check("G5 its run is metered + delegated under the RUNNING tenant only", runT2.ok && s.delegations.every((d) => d.brokerageId === T2) && s.affords.every((a) => a.brokerageId === T2))
  }

  console.log("\nH. wiring, registration, one vocabulary")
  {
    const act = src("app/actions/skill-marketplace.ts")
    const raw = readFileSync("app/actions/skill-marketplace.ts", "utf8")
    const exportsAll = [...act.matchAll(/export\s+(async\s+)?function\s+(\w+)/g)]
    check(`H1 "use server" + every export async (${exportsAll.length} doors)`, /^"use server"/.test(raw.trimStart()) && exportsAll.length >= 6 && exportsAll.every((m) => !!m[1]))
    const panel = src("app/components/skills/skill-marketplace-panel.tsx")
    const unwired = exportsAll.map((m) => m[2]).filter((n) => !panel.includes(`${n}(`))
    check("H1b every door is wired to the surface (the panel calls each one)", unwired.length === 0, unwired.join(", "))
    check("H1c the panel is mounted: tenant mode in Settings → Assistant, platform mode on the superadmin page behind requirePlatformStaff", /<SkillMarketplacePanel mode="tenant" \/>/.test(src("app/dashboard/settings/assistant/page.tsx")) && /requirePlatformStaff\(\)/.test(src("app/dashboard/superadmin/skill-marketplace/page.tsx")) && /<SkillMarketplacePanel mode="platform" \/>/.test(src("app/dashboard/superadmin/skill-marketplace/page.tsx")))
    const bodies = act.split(/export\s+async\s+function\s+/).slice(1)
    check("H2 every door gates on the session FIRST (tenantGate / requirePlatformStaff before any service write)", bodies.every((b) => { const g = Math.min(...["tenantGate()", "requirePlatformStaff()"].map((x) => b.indexOf(x)).filter((i) => i >= 0)); const w = b.search(/(submitSkillListing|decideSkillListing|runSkill|listVisibleSkillListings|evaluateSkillListing)\(/); return Number.isFinite(g) && g >= 0 && (w < 0 || g < w) }))
    check("H3 no door accepts a brokerageId argument (tenant from the session)", !/function\s+\w+\([^)]*brokerageId/.test(act))
    check("H4 the doors call the runtime: submit+evaluate, decide, run, list", ["submitSkillListing(", "evaluateSkillListing(", "decideSkillListing(", "runSkill(", "listVisibleSkillListings("].every((x) => act.includes(x)))
    const rt = src("lib/kernel/skill-marketplace.ts")
    check("H5 the run path composes the survivors: mayUseAndAfford, resolveAgentAuthorityLevel, withActionLedger, requestDelegation", ["mayUseAndAfford(", "resolveAgentAuthorityLevel(", "withActionLedger(", "requestDelegation("].every((x) => rt.includes(x)))
    check("H6 no code execution: the runtime never evals / imports / fetches a declaration", !/\beval\(|new Function\(|import\(\s*[a-z]|fetch\(/.test(rt.replace(/import\("@\/[^"]+"\)/g, "")))
    const migs = readdirSync("supabase/migrations").filter((f) => /\.sql$/.test(f) && readFileSync(`supabase/migrations/${f}`, "utf8").includes("skill_marketplace_listings_status_check")).sort((a, b) => Number(/^m(\d+)/.exec(a)?.[1] ?? 0) - Number(/^m(\d+)/.exec(b)?.[1] ?? 0))
    const mig = migs.length ? readFileSync(`supabase/migrations/${migs[migs.length - 1]}`, "utf8") : ""
    const list = (name: string) => { const m = new RegExp(`${name}\\s+CHECK\\s*\\(\\w+ IN \\(([^)]*)\\)`).exec(mig); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [] }
    check("H7 the latest migration defining the status CHECK = SKILL_LISTING_STATUSES", list("skill_marketplace_listings_status_check").join(",") === SKILL_LISTING_STATUSES.join(","))
    check("H8 its publisher CHECK = SKILL_PUBLISHERS; tenant-shape CHECK; session writes revoked; immutable declaration trigger", list("skill_marketplace_listings_publisher_check").join(",") === SKILL_PUBLISHERS.join(",") && /tenant_shape_check/.test(mig) && /REVOKE INSERT, UPDATE, DELETE ON public\.skill_marketplace_listings FROM anon, authenticated/.test(mig) && /BEFORE UPDATE ON public\.skill_marketplace_listings/.test(mig))
    check("H9 the migration header carries the lane stamp or an APPLIED LIVE stamp", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(mig))
    check("H10 package.json registers test:skill-registry on the guard chain (membership, not position)", pkg.scripts["test:skill-registry"] === "tsx scripts/skill-registry-guard.ts" && new RegExp("npm run test:skill-registry(\\s|&|$)").test(pkg.scripts.guard))
    const d = MAINTENANCE_DOMAINS.skill_registry as any
    check("H11 MAINTENANCE_DOMAINS owns it (compliance_officer; co-owners data_steward + finance_manager named in prose)", d?.manager === "compliance_officer" && d.proof === "test:skill-registry" && JSON.stringify(d.coOwners) === JSON.stringify(["data_steward", "finance_manager"]) && d.what.includes("data_steward") && d.what.includes("finance_manager"))
    check("H12 TABLE_MANAGER: skill_marketplace_listings → compliance_officer", TABLE_MANAGER.skill_marketplace_listings === "compliance_officer")
    check("H13 every evaluation suite a marketplace skill may name is a platform-owned evaluator, and the validator knows all of them", Object.keys(SKILL_EVALUATORS).every((k) => knownEvaluationSuites().has(k)))
    const actionNames = [...readFileSync("lib/kernel/skill-marketplace.ts", "utf8").matchAll(/action: [`"](skill\.[^`"]+)[`"]/g)].map((m) => m[1].replace("${input.decision}", "approve"))
    check(`H15 every ledger action the runtime writes is domain.entity.action (${actionNames.length} names — a malformed one is silently UNLEDGERED by the survivor)`, actionNames.length >= 4 && actionNames.every((a) => /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(a)), actionNames.join(", "))
    check("H15b (control) the pattern refuses the two-segment name this lane first wrote", !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test("skill.run"))
    const fixture = stripComments(`// TOMBSTONE: runSkill( used to be called here\nconst x = 1\n/* requestDelegation( */`)
    check("H14 (control) a tombstone naming a door is NOT read as a call site", !fixture.includes("runSkill(") && !fixture.includes("requestDelegation(") && fixture.includes("const x = 1"))
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  console.log(` BLIND SPOTS: in-memory client (no RLS, no CHECK, no immutability trigger — m727 holds those live once applied); mayUseAndAfford / resolveAgentAuthorityLevel / requestDelegation are observed through seams (their own proofs cover them) — only withActionLedger runs real; built-in cost estimates are 0 with basis "unmeasured" (no per-call figure exists in the repo); the capability catalogue declares no per-capability OUTPUT shape, so every skill's output is the kernel run receipt; built-in evaluation suites are the existing proofs that exercise the capability (${MANAGER_SKILLS.length} skills on ${new Set(MANAGER_SKILLS.map((s) => s.evaluation_suite)).size} suites), not per-skill evals; no UI page mounts the doors yet.`)
  if (fail > 0) { console.log(" ❌ SKILL_REGISTRY_FAIL"); process.exit(1) }
  console.log(" ✅ SKILL_REGISTRY_PASS — every manager skill is declared and validated; marketplace skills are data, evaluated before approval, and run only through the kernel")
}
main().catch((e) => { console.error(e); process.exit(1) })
