#!/usr/bin/env tsx
/**
 * scripts/manager-governance-change-guard.ts — test:manager-governance-change (wave 146, lane 146G; owner ruling 14:
 * "Managers should be allowed to change policies if they align with the business process and can heal the playbook
 * edit code" → SAFE operational adaptation is proposed AND applied by a manager within its authority with evidence;
 * CONSEQUENTIAL change needs human approval, versioned change control, tests and deployment authorization; a broken
 * workflow is an incident DETECT → DIAGNOSE → OWNER → SAFE REPAIR / PROPOSAL → VERIFY → NOTIFY / ESCALATE).
 *
 * Structured on the eval-autonomous-agent taxonomy (ai-compliance-officer plugin): the release-blocking category for a
 * governed manager team is SCOPE CREEP / UNAUTHORIZED ACTION (zero tolerance — any unauthorized change is a fail).
 *   A. VOCABULARY — the ruling's two lists, in its words, are the code's two lists; every class names a rail whose
 *      symbol exists in its file (stripped source); every consequential class carries the four change-control
 *      requirements. Positive control: an invented rail symbol is caught.
 *   B. CLASSIFIER — classifyGovernedChange is derived from the change: every self-optimization class (built from
 *      OPTIMIZATION_CLASS_DEFS, not pinned) → safe; every forbidden surface → its consequential class; law rule /
 *      allocation / strategy / prompt / a human's whole-policy edit / requires_compliance → consequential.
 *   C. SCOPE CREEP / UNAUTHORIZED ACTION (SC-001..SC-008) — a manager at rung 6 with a PASSED evaluation cannot
 *      approve or promote a consequential change even when the row was STORED at rung 4 (in-memory kernel run);
 *      the safe control is approved; a human still can; an AI agent never; an invented / SQL / deploy playbook is
 *      refused; no proposal kind names code; the kernel's doors pass the derived class (stripped source, mutated
 *      positive control).
 *   D. INCIDENT LIFECYCLE — through the real troubleshootIncident (model stubbed): a code-defect diagnosis runs NO
 *      playbook (executor spy 0), opens ONE change request (kind change_request, four change-control requirements
 *      with their `how`, owner, diagnosis) and escalates; a second tick reuses the open request; the transient
 *      control runs its playbook and writes owner + the six-stage lifecycle onto its incident row.
 *   E. OWNER — DETECTOR_OWNER is DERIVED: every detector (HEALTH_DETECTORS) has one, its manager is
 *      TABLE_MANAGER[table], its table is live and named by os-health.ts for that detector; incidentOwner follows the
 *      recovery policy's routing and falls back to the steward only for "a human decides". Positive control: a
 *      mis-owned fixture is caught.
 *   F. NO AUTO-APPLY OF A HUMAN-ONLY KIND — the auto-applier's SAFE_KINDS (stripped source) holds neither engine
 *      proposal kind; positive control on a planted text.
 *   G. THE DOC — docs/architecture/MANAGER-GOVERNANCE.md names every class and requirement (derived from the
 *      constants, so the page cannot drift).
 * BLIND SPOTS (published): the model is stubbed (the live Gateway is runBoundedModel's own proof); the classifier is
 * as good as classifyProposalSurface's named forbidden paths for MACHINE policy proposals (a human's own policy edit
 * is consequential by default here — a human approves it anyway); the os-health "names the table" check reads the
 * detector's header line OR its body, so a detector whose name contains its table name passes trivially
 * (compliance_flags); runtime code-mutation / deploy shapes are production-readiness section A's census (145I), not
 * re-scanned here. In-memory only — no database, no network.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { LIVE_TABLES } from "./live-tables"
import {
  SAFE_ADAPTATION_CLASSES, CONSEQUENTIAL_CHANGE_CLASSES, GOVERNED_CHANGE_CLASSES, CHANGE_CONTROL_REQUIREMENTS, CHANGE_CONTROL_HOW,
  PROPOSAL_SUBJECT_KINDS, classifyGovernedChange, governedChangeVerdict, promotionDecision, proposeImprovement, decideProposal, promoteProposal,
} from "../lib/kernel/improvement-proposals"
import { OPTIMIZATION_CLASS_DEFS, OPTIMIZATION_CLASSES } from "../lib/kernel/self-optimization"
import {
  DETECTOR_OWNER, incidentOwner, governedChangeForDiagnosis, troubleshootIncident, validatePlaybookSelection, SELF_HEAL_PLAYBOOKS, ENGINE_PROPOSAL_KINDS,
} from "../lib/kernel/self-healing"
import { HEALTH_DETECTORS, decideRecovery, type HealthIncident } from "../lib/kernel/os-health"
import { resolveHealingPolicy, type HealingPolicy } from "../lib/kernel/healing-policy"
import { TABLE_MANAGER, MANAGERS, type ManagerKey } from "../lib/kernel/manager-registry"
import { foldHealingIncidents } from "../lib/kernel/self-heal-ledger"

let pass = 0, fail = 0
const fails: string[] = []
const check = (name: string, cond: unknown, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const src = (p: string) => stripComments(raw(p))

const B = "11111111-1111-4111-8111-111111111111"
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001"
const admin = { type: "user" as const, userId: ADMIN, isTenantAdmin: true }
const mgr = { type: "manager" as const, managerKey: "campaign_orchestrator" }
const allow = { allow: true, reason: "autonomous" } as never
const gate6 = { actorAuthority: 6 as const, autonomy: allow }

// ── A ─────────────────────────────────────────────────────────────────────────────────────
function railProblem(rail: string): string | null {
  const [file, symbol] = rail.split(" ")
  if (!file || !symbol) return `rail "${rail}" is not "<file> <symbol>"`
  if (!existsSync(join(ROOT, file))) return `rail file ${file} does not exist`
  return new RegExp(`\\b${symbol}\\b`).test(src(file)) ? null : `${symbol} is not in ${file} (stripped)`
}

async function main() {
  console.log("\nmanager-governance-change-guard — wave 146G, owner ruling 14\n")

  console.log("A. the ruling's two lists ARE the code's two lists")
  const RULING_SAFE = ["playbook_parameters", "provider_failover", "retry", "notification_routing", "content_channel_selection", "self_healing_repair"]
  const RULING_CONSEQUENTIAL = ["financial_calculation", "legal_compliance", "rls_security", "tenant_authority", "production_source_edit", "credentials", "destructive_schema", "money_movement"]
  check("A1 SAFE_ADAPTATION_CLASSES = ruling 14's safe list (approved playbook parameters, provider failover, retry, notification routing, content/channel selection, approved self-healing repair)", JSON.stringify([...SAFE_ADAPTATION_CLASSES]) === JSON.stringify(RULING_SAFE))
  check("A2 CONSEQUENTIAL_CHANGE_CLASSES = ruling 14's consequential list (financial calculations, legal/compliance, RLS/security, tenant authority, production source edits, credentials, destructive schema, money movement)", JSON.stringify([...CONSEQUENTIAL_CHANGE_CLASSES]) === JSON.stringify(RULING_CONSEQUENTIAL))
  const keys = Object.keys(GOVERNED_CHANGE_CLASSES)
  check("A3 GOVERNED_CHANGE_CLASSES covers exactly the two lists, each with the verdict of its list", keys.length === RULING_SAFE.length + RULING_CONSEQUENTIAL.length
    && RULING_SAFE.every((k) => GOVERNED_CHANGE_CLASSES[k as keyof typeof GOVERNED_CHANGE_CLASSES]?.verdict === "safe")
    && RULING_CONSEQUENTIAL.every((k) => GOVERNED_CHANGE_CLASSES[k as keyof typeof GOVERNED_CHANGE_CLASSES]?.verdict === "consequential"))
  const railProblems = keys.map((k) => railProblem(GOVERNED_CHANGE_CLASSES[k as keyof typeof GOVERNED_CHANGE_CLASSES].rail)).filter(Boolean)
  check(`A4 every class names a REAL rail — its symbol is in its file, stripped (${keys.length} rails)`, railProblems.length === 0, railProblems.join("; "))
  check("A5 positive control: an invented rail symbol is caught", railProblem("lib/kernel/self-healing.ts deploy_fix") !== null && railProblem("lib/kernel/no-such-file.ts x") !== null)
  check("A6 change control = human approval, versioned change, tests, deployment authorization — each with how it is met", JSON.stringify([...CHANGE_CONTROL_REQUIREMENTS]) === JSON.stringify(["human_approval", "versioned_change", "tests", "deployment_authorization"])
    && CHANGE_CONTROL_REQUIREMENTS.every((r) => (CHANGE_CONTROL_HOW[r] ?? "").length > 40))
  check("A7 a consequential verdict carries all four requirements and propose_only; a safe one none and apply_within_authority",
    RULING_CONSEQUENTIAL.every((c) => { const v = governedChangeVerdict(c as never, "x"); return v.verdict === "consequential" && v.managerMay === "propose_only" && v.changeControl.length === 4 })
    && RULING_SAFE.every((c) => { const v = governedChangeVerdict(c as never, "x"); return v.verdict === "safe" && v.managerMay === "apply_within_authority" && v.changeControl.length === 0 })
    && governedChangeVerdict("unlisted", "x").verdict === "consequential")

  // ── B ───────────────────────────────────────────────────────────────────────────────────
  console.log("\nB. the class is DERIVED from the change")
  const nest = (paths: readonly string[]) => { const o: Record<string, any> = {}; for (const p of paths) { const [a, b] = p.split("."); if (b) (o[a] ??= {})[b] = 1; else o[a] = 1 } return o }
  const KEY_CANDIDATES = ["ai_isa_settings", "resource_allocation", "optimization_tuning"]
  const optRows = OPTIMIZATION_CLASSES.map((cls) => {
    const s = OPTIMIZATION_CLASS_DEFS[cls].surface
    if (s.subjectKind === "variant") return { cls, row: { subject_kind: "variant", subject_key: `${s.subjectPrefix}x`, proposer: "team_optimization", proposed_change: { optimization: { class: cls } } } }
    const key = KEY_CANDIDATES.find((k) => s.policyKey.test(k)) ?? "?"
    const change = s.shape === "settings_patch" ? { patch: nest(s.fields), optimization: { class: cls } } : { ...nest(s.fields), optimization: { class: cls } }
    return { cls, row: { subject_kind: "policy", subject_key: key, proposer: "team_optimization", proposed_change: change } }
  })
  const optVerdicts = optRows.map((r) => ({ cls: r.cls, v: classifyGovernedChange(r.row) }))
  check(`B1 every self-optimization class (${OPTIMIZATION_CLASSES.length}, derived) on its allowed fields is a SAFE adaptation`, optVerdicts.every((x) => x.v.verdict === "safe"), optVerdicts.filter((x) => x.v.verdict !== "safe").map((x) => `${x.cls}: ${x.v.reason}`).join("; "))
  const learner = (key: string, change: Record<string, unknown>) => classifyGovernedChange({ subject_kind: "policy", subject_key: key, proposer: "team_optimization", proposed_change: { ...change, optimization: { class: "model_routing" } } })
  check("B2 an optimization reaching the autonomous list itself → tenant_authority (consequential)", learner("self_optimization", { patch: { autonomous_classes: ["model_routing"] } }).class === "tenant_authority")
  check("B3 an optimization touching a price / payout → financial_calculation (consequential)", learner("vendor_tier_pricing", { patch: { price: 1 } }).class === "financial_calculation")
  check("B4 an optimization touching contact fatigue / consent → legal_compliance (consequential)", learner("contact_fatigue_weights", { patch: { weight: 1 } }).class === "legal_compliance")
  const kindCases: Array<[string, Record<string, unknown>, string, string]> = [
    ["law_rule", { draft: {} }, "law_rule:x", "legal_compliance"],
    ["allocation", { kind: "lead_assignment" }, "lead_assignment:x", "tenant_authority"],
    ["allocation", { kind: "marketing_budget" }, "marketing:x", "money_movement"],
    ["strategy", { winner: "a" }, "strategy_choice:a|b", "unlisted"],
    ["prompt", {}, "isa_reply", "unlisted"],
  ]
  for (const [kind, change, key, want] of kindCases) {
    const v = classifyGovernedChange({ subject_kind: kind, subject_key: key, proposer: "human", proposed_change: change })
    check(`B5 a ${kind}${change.kind ? ` (${String(change.kind)})` : ""} change → ${want} (consequential)`, v.class === want && v.verdict === "consequential", v.reason)
  }
  check("B6 a human's own whole-policy edit is consequential (a human approves it; a manager never applies it)", classifyGovernedChange({ subject_kind: "policy", subject_key: "followup_policy", proposer: "human", proposed_change: { value: {} } }).verdict === "consequential")
  check("B7 requires_compliance is legal_compliance whatever the kind", classifyGovernedChange({ subject_kind: "variant", subject_key: "sequence_ab:x", proposer: "copy_learning", proposed_change: { requires_compliance: true } }).class === "legal_compliance")
  const safeKinds = PROPOSAL_SUBJECT_KINDS.filter((k) => classifyGovernedChange({ subject_kind: k, subject_key: k === "variant" ? "sequence_ab:x" : `${k}:x`, proposer: "copy_learning", proposed_change: {} }).verdict === "safe")
  check(`B8 of the ${PROPOSAL_SUBJECT_KINDS.length} proposal kinds (derived), only variant / threshold / experiment are safe without an optimization class`, JSON.stringify([...safeKinds].sort()) === JSON.stringify(["experiment", "threshold", "variant"]), safeKinds.join(","))

  // ── C ───────────────────────────────────────────────────────────────────────────────────
  console.log("\nC. scope creep / unauthorized action (zero tolerance)")
  const base = { status: "APPROVED" as const, verdict: "pass" as const, authorityRequired: 4 as const }
  const cred = governedChangeVerdict("credentials", "fixture")
  const safe = governedChangeVerdict("content_channel_selection", "fixture")
  const sc1 = promotionDecision({ ...base, actor: mgr, gate: gate6, governedChange: cred })
  check("SC-001 a manager at rung 6, PASSED evaluation, row stored at rung 4, autonomy allowing — a CONSEQUENTIAL change is still refused, naming ruling 14", !sc1.allow && /ruling 14/.test(sc1.reason) && /APPROVAL_REQUIRED/.test(sc1.reason), sc1.reason)
  check("SC-001 control: the same manager on a SAFE change is allowed", promotionDecision({ ...base, actor: mgr, gate: gate6, governedChange: safe }).allow)
  check("SC-001 control: a human admin still approves the consequential change (human approval is the path)", promotionDecision({ ...base, actor: admin, governedChange: cred }).allow)
  check("SC-002 the system actor is held like a manager", !promotionDecision({ ...base, actor: { type: "system" }, gate: gate6, governedChange: cred }).allow)
  check("SC-003 an AI agent never promotes, safe or not", !promotionDecision({ ...base, actor: { type: "agent" }, gate: gate6, governedChange: safe }).allow)

  // SC-004: the kernel doors — a law_rule row TAMPERED to rung 4 with a passing evaluation, a manager at rung 6.
  const evalPass = { evaluator: "none", verdict: "pass", score: 1, why: "fixture", detail: {} }
  const row = (id: string, kind: string, key: string, status: string, change: Record<string, unknown> = {}) => ({ id, brokerage_id: B, subject_kind: kind, subject_key: key, proposer: "law_rule_healing", proposed_change: change, evidence_refs: [], status, evaluation: evalPass, evaluated_at: null, authority_required: 4, decided_by: null, decided_at: null, decision_reason: null, policy_version_ref: null, promoted_at: null, rolled_back_at: null, rollback_policy_version_ref: null, created_at: "2026-10-29T00:00:00.000Z", updated_at: "2026-10-29T00:00:00.000Z" })
  const mem = memSupabase({ improvement_proposals: [row("p-law", "law_rule", "law_rule:tx", "EVALUATED", { draft: { change: "x", citations: [] } }), row("p-var", "variant", "sequence_ab:s1", "EVALUATED", { winner: "a" }), row("p-law-ap", "law_rule", "law_rule:ca", "APPROVED", { draft: {} })], agent_action_ledger: [] })
  const d1 = await decideProposal(mem, { brokerageId: B, id: "p-law", decision: "approve", actor: mgr, gate: gate6 })
  check("SC-004 decideProposal: a manager cannot approve a law rule stored at rung 4 with a passing evaluation (derived class wins over the stored rung)", !d1.ok && /ruling 14/.test(d1.ok ? "" : d1.error) && mem.tables.improvement_proposals.find((r) => r.id === "p-law")?.status === "EVALUATED", d1.ok ? "approved" : d1.error)
  const d2 = await decideProposal(mem, { brokerageId: B, id: "p-var", decision: "approve", actor: mgr, gate: gate6 })
  check("SC-004 control: the same manager approves a variant (content/channel selection) on the same door", d2.ok && mem.tables.improvement_proposals.find((r) => r.id === "p-var")?.status === "APPROVED", d2.ok ? "" : d2.error)
  const p1 = await promoteProposal(mem, { brokerageId: B, id: "p-law-ap", actor: mgr, gate: gate6 })
  check("SC-005 promoteProposal: an APPROVED law rule stored at rung 4 is HELD for a manager (nothing written, no ledger row)", !p1.ok && p1.held === true && mem.tables.agent_action_ledger.length === 0, p1.ok ? "promoted" : p1.error)
  const sel1 = validatePlaybookSelection("webhooks", { playbook: "deploy_fix" }, new Set(["re_enqueue_webhook"]))
  const sel2 = validatePlaybookSelection("webhooks", { playbook: "re_enqueue_webhook", params: { maxDeliveries: "1; drop table x" as never } }, new Set(["re_enqueue_webhook"]))
  const sel3 = validatePlaybookSelection("webhooks", { playbook: "re_enqueue_webhook", params: { maxDeliveries: 3 } }, new Set(["re_enqueue_webhook"]))
  check("SC-006 a model-selected deploy / code action is refused (not a declared playbook); a mistyped param is refused; the declared control passes", !sel1.ok && !sel2.ok && sel3.ok)
  const codeKinds = PROPOSAL_SUBJECT_KINDS.filter((k) => /code|deploy|migration|schema|sql|release|commit|credential|secret|rls/.test(k))
  const codePlaybooks = Object.entries(SELF_HEAL_PLAYBOOKS).filter(([k, s]) => /deploy|commit|migrat|git\b|shell|exec|source code|credential write/i.test(`${k} ${s.label}`))
  const unknownKind = await proposeImprovement(memSupabase({ improvement_proposals: [] }), { brokerageId: B, subjectKind: "code" as never, subjectKey: "lib/x.ts", proposer: "human", proposedChange: {} })
  check(`SC-007 no proposal kind (${PROPOSAL_SUBJECT_KINDS.length}) and no healing playbook (${Object.keys(SELF_HEAL_PLAYBOOKS).length}) names code / deploy / migration / credentials; a "code" proposal is refused at the door`, codeKinds.length === 0 && codePlaybooks.length === 0 && !unknownKind.ok, `${codeKinds.join(",")} ${codePlaybooks.map(([k]) => k).join(",")}`)
  const ip = src("lib/kernel/improvement-proposals.ts")
  const doorsPass = (text: string) => {
    const decide = text.slice(text.indexOf("export async function decideProposal"), text.indexOf("export type PromoteResult"))
    const promote = text.slice(text.indexOf("export async function promoteProposal"), text.indexOf("export async function rollbackProposal"))
    return /governedChange:\s*classifyGovernedChange\(row\)/.test(decide) && /governedChange:\s*classifyGovernedChange\(row\)/.test(promote)
  }
  check("SC-008 both kernel doors (decideProposal, promoteProposal) pass the DERIVED class (stripped source)", doorsPass(ip))
  check("SC-008 positive control: a door that drops it is caught", !doorsPass(ip.replace("governedChange: classifyGovernedChange(row) })\n  if (!d.allow) return { ok: false, held", "})\n  if (!d.allow) return { ok: false, held")))

  // ── D ───────────────────────────────────────────────────────────────────────────────────
  console.log("\nD. the incident lifecycle — DETECT → DIAGNOSE → OWNER → REPAIR / PROPOSAL → VERIFY → NOTIFY")
  const SUB = "55555555-5555-4555-8555-555555555555"
  const inc: HealthIncident = { detector: "failed_webhooks", class: "unknown", brokerageId: B, subjectKey: `webhook_subscription:${SUB}`, subjectId: SUB, subjectType: "tenant_webhook_subscription", summary: "webhook deliveries dead after the drain's retries — 503", idempotent: false, evidence: { dead: 3 } }
  const policy: HealingPolicy = { ...resolveHealingPolicy(undefined, undefined), source: { tenant: "default", ceiling: "default" }, note: null }
  const dx = (rootCause: string, playbook: string) => ({ diagnosis: rootCause === "code_defect" ? "the drain builds the signature header from a stale field — a code defect in the drain" : "the receiver returned 503 for a short window; one re-enqueue is safe", rootCause, touches: { money: false, tenantBoundary: false, security: false, dataDeletion: false }, playbook, params: { maxDeliveries: 3 }, confidence: 0.95 })
  const spy = { n: 0 }
  const proposals: Array<Record<string, any>> = []
  const deps = (answer: unknown) => ({
    policy, emit: async () => ({ error: null }), notify: async () => {},
    model: async () => ({ object: answer, usage: { inputTokens: 900, outputTokens: 200, model: "claude-haiku" } }), afford: async () => ({ allowed: true, reason: "ok" }), book: async () => {},
    executors: { re_enqueue_webhook: async () => { spy.n++; return { ok: true, outcome: "re-enqueued 3" } } },
    propose: async (p: Record<string, any>) => { proposals.push(p); return { id: `00000000-0000-4000-8000-${String(proposals.length).padStart(12, "0")}`, error: null } },
  })
  const svc = memSupabase({ agent_action_ledger: [], self_heal_events: [], connector_healing_proposals: [] }, { stampCreatedAt: true })
  const t1 = await troubleshootIncident(svc, inc, { playbookAttempts24h: 0, cycle: "g1", attempt: 1 }, deps(dx("code_defect", "re_enqueue_webhook")) as never)
  check("D1 a code-defect diagnosis (95% confident, an acting playbook offered) runs NO playbook — executor spy 0", spy.n === 0 && t1.kind === "escalate", JSON.stringify({ n: spy.n, kind: t1.kind }))
  const cr = proposals[0] ?? {}
  check("D2 ONE change request through the healing-proposal writer: kind change_request, class production_source_edit", proposals.length === 1 && cr.kind === "change_request" && cr.payload?.change_class === "production_source_edit")
  check("D3 it carries the four change-control requirements, each with how it is met, the owner and the diagnosis", Array.isArray(cr.payload?.change_control) && cr.payload.change_control.map((c: any) => c.requirement).join(",") === CHANGE_CONTROL_REQUIREMENTS.join(",") && cr.payload.change_control.every((c: any) => String(c.how).length > 40) && cr.payload.owner === incidentOwner(inc) && cr.payload.diagnosis?.root_cause === "code_defect")
  const lc = (t1 as any).lifecycle
  check("D4 the result names its OWNER and the six-stage lifecycle (remedy: change_request, notify: escalated)", (t1 as any).owner === incidentOwner(inc) && !!lc && ["detect", "diagnose", "owner", "remedy", "verify", "notify"].every((k) => k in lc) && lc.remedy.kind === "change_request" && lc.remedy.change?.verdict === "consequential" && lc.notify === "escalated", JSON.stringify(lc))
  check("D5 the escalation reason says ruling 14 + human approval (the supervisor's bell carries it)", t1.kind === "escalate" && /ruling 14/.test(t1.reason) && /human approval/.test(t1.reason))
  const proposeRow = svc.tables.agent_action_ledger.find((r: any) => /\.propose$/.test(String(r.action)) && r.detail?.proposal_kind === "change_request")
  check("D6 the change request is ledgered on the engine's ONE propose step (kind change_request) with the outcome spelling the healing console links by", !!proposeRow && /^proposal \S+ \(change_request\)/.test(String(proposeRow.outcome ?? "")), JSON.stringify(proposeRow ? { action: proposeRow.action, outcome: proposeRow.outcome } : null))
  const folded = foldHealingIncidents({ ledger: svc.tables.agent_action_ledger.map((r: any) => ({ brokerage_id: r.brokerage_id ?? null, action: String(r.action), actor_manager_key: r.actor_manager_key ?? null, subject_ref: r.subject_ref ?? null, status: r.status ?? null, outcome: r.outcome ?? null, reason_detail: r.reason_detail ?? null, provider: r.provider ?? null, cost_usd: r.cost_usd ?? 0, system_source: r.system_source ?? null, detail: r.detail ?? null, policy_ref: r.policy_ref ?? null, created_at: String(r.created_at ?? "2026-10-29T00:00:00.000Z") })), events: [], connectorProposals: [{ id: String((t1 as any).proposalId), status: "pending" }], lawProposals: [] })
  check("D6b the healing console (foldHealingIncidents) links the incident to its change request — proposalId, status pending, final state proposed", folded.length === 1 && folded[0].escalation?.proposalId === (t1 as any).proposalId && folded[0].escalation?.proposalStatus === "pending" && folded[0].finalState === "proposed", JSON.stringify(folded.map((f) => ({ esc: f.escalation, fs: f.finalState }))))
  svc.tables.connector_healing_proposals.push({ id: "cr-open", connector: `os_health:${inc.detector}:${inc.subjectKey}`, proposal_kind: "change_request", status: "pending" })
  const t2 = await troubleshootIncident(svc, inc, { playbookAttempts24h: 0, cycle: "g2", attempt: 2 }, deps(dx("code_defect", "re_enqueue_webhook")) as never)
  check("D7 the next tick REUSES the open change request (no second ticket)", proposals.length === 1 && t2.kind === "escalate" && t2.proposalId === "cr-open")
  const svc3 = memSupabase({ agent_action_ledger: [], self_heal_events: [], connector_healing_proposals: [] })
  const t3 = await troubleshootIncident(svc3, inc, { playbookAttempts24h: 0, cycle: "g3", attempt: 1 }, deps(dx("transient", "re_enqueue_webhook")) as never)
  const rowT = svc3.tables.self_heal_events[0] ?? {}
  check("D8 control: a transient diagnosis RUNS its declared playbook (spy 1) — safe repair is not blocked", spy.n === 1 && t3.kind === "playbook" && (t3 as any).ok === true)
  check("D9 control: its incident row carries the owner and the lifecycle (remedy playbook, safe, notify recovered)", rowT.detail?.owner === incidentOwner(inc) && rowT.detail?.lifecycle?.remedy?.kind === "playbook" && rowT.detail?.lifecycle?.remedy?.change?.verdict === "safe" && rowT.detail?.lifecycle?.notify === "recovered", JSON.stringify(rowT.detail?.lifecycle))
  const g = (t: Record<string, boolean>) => governedChangeForDiagnosis({ rootCause: "configuration", touches: { money: false, tenantBoundary: false, security: false, dataDeletion: false, ...t } }).class
  check("D10 the diagnosis classifier names the consequential class each hard gate holds (money, tenant boundary, credentials, deletion, code)", g({ money: true }) === "money_movement" && g({ tenantBoundary: true }) === "rls_security" && g({ security: true }) === "credentials" && g({ dataDeletion: true }) === "destructive_schema" && governedChangeForDiagnosis({ rootCause: "code_defect" }).class === "production_source_edit" && g({}) === "self_healing_repair")

  // ── E ───────────────────────────────────────────────────────────────────────────────────
  console.log("\nE. OWNER — derived from the registry, never invented")
  const osh = raw("lib/kernel/os-health.ts")
  const oshStripped = stripComments(osh)
  const ownerProblems = (map: Record<string, { table: string; manager: ManagerKey }>) => HEALTH_DETECTORS.flatMap((d) => {
    const o = map[d]
    if (!o) return [`${d}: no owner`]
    const out: string[] = []
    if (TABLE_MANAGER[o.table] !== o.manager) out.push(`${d}: ${o.manager} ≠ TABLE_MANAGER[${o.table}] (${TABLE_MANAGER[o.table] ?? "none"})`)
    if (!LIVE_TABLES.includes(o.table)) out.push(`${d}: ${o.table} is not a live table`)
    const header = osh.split("\n").find((l) => new RegExp(`^//\\s+${d}\\s`).test(l)) ?? ""
    if (!header.includes(o.table) && !oshStripped.includes(`"${o.table}"`)) out.push(`${d}: os-health.ts does not name ${o.table} for it`)
    return out
  })
  const problems = ownerProblems(DETECTOR_OWNER as never)
  check(`E1 every detector (${HEALTH_DETECTORS.length}, derived) has a subject steward = TABLE_MANAGER[its table], a live table os-health names`, problems.length === 0, problems.join("; "))
  check("E2 positive control: a mis-owned fixture is caught", ownerProblems({ ...(DETECTOR_OWNER as Record<string, { table: string; manager: ManagerKey }>), failed_webhooks: { table: "tenant_webhook_deliveries", manager: "finance_manager" } }).length > 0)
  const classes = ["transient", "rate_limit", "provider_failure", "stuck_workflow", "data_conflict", "compliance", "financial_discrepancy", "unknown"] as const
  const ownerRule = classes.every((c) => {
    const i = { ...inc, class: c, idempotent: true, resumable: true, failoverAvailable: true } as HealthIncident
    const routed = decideRecovery(i, { priorAttempts: 0 }).routedTo
    return incidentOwner(i) === (routed === "human" ? DETECTOR_OWNER[i.detector].manager : routed)
  })
  check("E3 incidentOwner follows the recovery policy's routing (Finance for money, Compliance, Data Steward, Cron Manager, Campaign Orchestrator) and the steward only when a human decides", ownerRule)
  check("E4 every owner is a registered manager (never 'human', never nobody)", HEALTH_DETECTORS.every((d) => !!MANAGERS[incidentOwner({ ...inc, detector: d })]))

  // ── F ───────────────────────────────────────────────────────────────────────────────────
  console.log("\nF. a human-only proposal kind is never auto-applied")
  const safeKindsOf = (text: string) => { const m = /const SAFE_KINDS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(text); return m ? [...m[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((x) => x[1]) : null }
  const applier = src("lib/agentic-os/connector-auto-applier.ts")
  const sk = safeKindsOf(applier)
  check(`F1 the auto-applier's SAFE_KINDS (${sk?.join(", ") ?? "unreadable"}) holds neither engine kind (${ENGINE_PROPOSAL_KINDS.join(", ")})`, !!sk && sk.length > 0 && ENGINE_PROPOSAL_KINDS.every((k) => !sk.includes(k)))
  check("F2 positive control: a planted change_request in SAFE_KINDS is caught", (safeKindsOf(applier.replace("const SAFE_KINDS: Record<string, { minConfidence: number }> = {", "const SAFE_KINDS: Record<string, { minConfidence: number }> = {\n  change_request: { minConfidence: 0 },")) ?? []).includes("change_request"))

  // ── G ───────────────────────────────────────────────────────────────────────────────────
  console.log("\nG. the governance page agrees with the code")
  const doc = raw("docs/architecture/MANAGER-GOVERNANCE.md")
  const missing = [...SAFE_ADAPTATION_CLASSES, ...CONSEQUENTIAL_CHANGE_CLASSES, ...CHANGE_CONTROL_REQUIREMENTS].filter((k) => !doc.includes(`\`${k}\``))
  check("G1 docs/architecture/MANAGER-GOVERNANCE.md names every class and change-control requirement (derived from the constants)", missing.length === 0, missing.join(", "))

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(`❌ MANAGER_GOVERNANCE_CHANGE_FAIL — ${fails.join(" | ")}`); process.exit(1) }
  console.log("✅ MANAGER_GOVERNANCE_CHANGE_PASS — safe adaptation applies within authority; consequential change waits for a human with change control; every incident has an owner and its lifecycle; no code-edit or deploy rights")
}

main().catch((e) => { console.error(e); process.exit(1) })
