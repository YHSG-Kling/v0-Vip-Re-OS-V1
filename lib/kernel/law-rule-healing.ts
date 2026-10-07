// lib/kernel/law-rule-healing.ts
//
// LAW-RULE SELF-HEALING (wave 138, lane 138C). The weekly regulatory pass (app/api/cron/regulatory-watcher —
// cron owner compliance_officer) runs this after the watcher, per tenant:
//
//   1. JURISDICTIONS — derived from the tenant's own data (brokerages.state, active farm_territories.state,
//      agent_licenses.license_state) through deriveTenantJurisdictions; never a hard-coded place.
//   2. GAP + STALENESS — detectLawRuleGaps over the LAW-RULE REGISTRY (lib/compliance-rules/law-rule-registry.ts,
//      a view over the code gates + state_protected_classes), with verification memory from the ledger.
//   3. RESEARCH — the regulatory watcher's search rail (realRegSearchFetcher, "research" mode through the
//      connector-gateway), entitlement-gated (mayUseAndAfford app.access), METERED (meterVendorSpend →
//      vendor_usage_tracking, system_source law_rule_healing) and COST-CAPPED per pass.
//   4. DRAFT — draftLawRule: deterministic, PRIMARY-cited (.gov / .us), never model-authored; uncited → refused.
//   5. RESOLVE — resolveLawRuleDraft (the owner's rule): a stricter-only, executable, money-free addition is
//      written into state_protected_classes in WARN mode with its citations + evidence; a loosening, a money
//      touch or anything ambiguous becomes an improvement_proposals row (subject_kind law_rule, authority 6 →
//      a human on the tenant admin roster — the compliance officer — decides on the proposals panel).
//   Every act is withActionLedger (compliance.law_rule.*, reason COMPLIANCE_NOTICE) + an audit kernel event.
//
// Tenant: the brokerageId the CRON resolved from its own brokerages read — never a body parameter.

import {
  buildLawRuleRegistry, deriveTenantJurisdictions, detectLawRuleGaps, draftLawRule, researchQueryFor, resolveLawRuleDraft,
  FEDERAL_JURISDICTION, type LawRule, type LawRuleDraft, type LawRuleFinding, type LawRuleResolution, type StateRuleRow,
} from "@/lib/compliance-rules/law-rule-registry"
import type { RegSearchFetcher } from "@/lib/kernel/regulatory-watcher"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any

/** Per-tenant, per-pass research spend cap (USD) and call cap — the loop never runs unmetered or unbounded. */
const LAW_RULE_RESEARCH_BUDGET_USD = 0.1
const LAW_RULE_RESEARCH_MAX_CALLS = 6
/** Assumed cost of one research call when the rail does not report one (Tavily advanced ≈ $0.01). */
const RESEARCH_CALL_ESTIMATE_USD = 0.01

const LAW_RULE_ACTION = {
  verify: "compliance.law_rule.verify",
  enable: "compliance.law_rule.enable",
  propose: "compliance.law_rule.propose",
} as const

const SYSTEM_SOURCE = "law_rule_healing"

interface LedgerCtx { brokerageId: string; action: string; actor: { type: "manager"; managerKey: string }; subject: { type: string; id?: string | null; ref?: string | null }; reasonCode: string; reasonDetail: string; idempotencyKey: string; riskClass: string; systemSource: string; detail: Record<string, unknown> }
type LedgerFn = <T>(ctx: LedgerCtx, run: () => Promise<T>, hooks: { settle: (r: T) => { status: "executed" | "failed" | "skipped"; outcome: string; costUsd?: number | null; provider?: string | null }; replay: () => T }, opts?: { client?: unknown }) => Promise<T>

interface LawRuleHealingDeps {
  now?: Date
  search?: RegSearchFetcher
  budgetUsd?: number
  maxCalls?: number
  /** Entitlement (fail closed): default mayUseAndAfford app.access. */
  afford?: (brokerageId: string) => Promise<{ allowed: boolean; reason: string }>
  meter?: (input: { vendorName: string; usageType: string; cost: number; brokerageId: string; systemSource: string; metadata: Record<string, unknown> }) => Promise<boolean>
  propose?: (svc: Svc, input: { brokerageId: string; subjectKind: "law_rule"; subjectKey: string; proposer: "law_rule_healing"; proposedChange: Record<string, unknown>; evidenceRefs: unknown[] }) => Promise<{ ok: boolean; id?: string; existing?: boolean; error?: string }>
  ledger?: LedgerFn
  emit?: (input: { event: string; brokerageId: string; entityType: string; entityId: string | null; metadata: Record<string, unknown>; auditOnly: true; client: unknown }) => Promise<unknown>
}

interface LawRuleHealingResult {
  jurisdictions: string[]
  findings: LawRuleFinding[]
  researched: number
  spentUsd: number
  verified: string[]
  enabledWarn: Array<{ key: string; rowId: string | null }>
  proposed: Array<{ key: string; proposalId: string | null; direction: string; why: string }>
  refused: Array<{ key: string; why: string }>
  refusedRails: string[]
  status: string
}

/** Load the tenant's jurisdictions from its own rows (each rail best-effort; refusals published). */
async function loadTenantJurisdictions(svc: Svc, brokerageId: string): Promise<{ jurisdictions: string[]; refusedRails: string[] }> {
  const refusedRails: string[] = []
  const [b, t, l] = await Promise.all([
    svc.from("brokerages").select("state").eq("id", brokerageId).maybeSingle(),
    svc.from("farm_territories").select("state").eq("brokerage_id", brokerageId).eq("is_active", true).limit(500),
    svc.from("agent_licenses").select("license_state").eq("brokerage_id", brokerageId).limit(1000),
  ])
  if (b.error) refusedRails.push(`brokerages: ${b.error.message}`)
  if (t.error) refusedRails.push(`farm_territories: ${t.error.message}`)
  if (l.error) refusedRails.push(`agent_licenses: ${l.error.message}`)
  const jurisdictions = deriveTenantJurisdictions({
    brokerageState: (b.data as { state?: string | null } | null)?.state ?? null,
    territoryStates: ((t.data ?? []) as Array<{ state: string | null }>).map((r) => r.state),
    licenseStates: ((l.data ?? []) as Array<{ license_state: string | null }>).map((r) => r.license_state),
  })
  return { jurisdictions, refusedRails }
}

/** The registry as THIS tenant sees it: code rules + its jurisdictions' rows + its verification memory (the ledger). */
async function loadLawRuleRegistry(svc: Svc, brokerageId: string, jurisdictions: readonly string[]): Promise<{ ok: true; registry: LawRule[] } | { ok: false; error: string }> {
  const states = jurisdictions.filter((j) => j !== FEDERAL_JURISDICTION)
  const rows = states.length ? await svc.from("state_protected_classes").select("*").in("state_code", states).limit(2000) : { data: [], error: null }
  if (rows.error) return { ok: false, error: `state_protected_classes: ${rows.error.message}` }
  const { data: ver, error: verErr } = await svc.from("agent_action_ledger").select("subject_ref, created_at")
    .eq("brokerage_id", brokerageId).eq("action", LAW_RULE_ACTION.verify).eq("status", "executed").order("created_at", { ascending: false }).limit(500)
  if (verErr) return { ok: false, error: `agent_action_ledger: ${verErr.message}` }
  const verifiedAt: Record<string, string> = {}
  for (const v of (ver ?? []) as Array<{ subject_ref: string | null; created_at: string }>) if (v.subject_ref && !verifiedAt[v.subject_ref]) verifiedAt[v.subject_ref] = v.created_at
  return { ok: true, registry: buildLawRuleRegistry((rows.data ?? []) as StateRuleRow[], verifiedAt) }
}

/** The state_protected_classes row a WARN auto-enable writes (m744 columns) — the proof asserts the row it lands. */
function warnRowFor(draft: LawRuleDraft, nowIso: string, evidence: Record<string, unknown>): Record<string, unknown> {
  return {
    state_code: draft.jurisdiction, protected_class: draft.name,
    regulation_reference: draft.citations.map((c) => c.title).join("; ").slice(0, 500),
    severity_default: "medium", patterns: draft.patterns, is_active: true,
    rule_scope: draft.scope, source_citations: draft.citations, effective_date: draft.effectiveDate,
    last_verified_at: nowIso, enforcement_mode: "warn", provenance: "law_rule_healing", evidence,
  }
}

/** Run ONE law-rule healing pass for one tenant. Never throws into the cron; every refusal is reported. */
export async function runLawRuleHealing(svc: Svc, brokerageId: string, deps: LawRuleHealingDeps = {}): Promise<LawRuleHealingResult> {
  const now = deps.now ?? new Date()
  const out: LawRuleHealingResult = { jurisdictions: [], findings: [], researched: 0, spentUsd: 0, verified: [], enabledWarn: [], proposed: [], refused: [], refusedRails: [], status: "" }
  if (!brokerageId) { out.status = "no tenant — nothing run"; return out }

  const j = await loadTenantJurisdictions(svc, brokerageId)
  out.jurisdictions = j.jurisdictions; out.refusedRails.push(...j.refusedRails)
  const reg = await loadLawRuleRegistry(svc, brokerageId, j.jurisdictions)
  // FAIL CLOSED: a registry we cannot read cannot be compared — nothing is drafted or enabled blind.
  if (!reg.ok) { out.refusedRails.push(reg.error); out.status = "registry unreadable — nothing drafted (fail closed)"; return out }
  out.findings = detectLawRuleGaps(reg.registry, j.jurisdictions, now)
  if (out.findings.length === 0) { out.status = "registry current for every tenant jurisdiction"; return out }

  const afford = deps.afford ?? (async (b: string) => {
    const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
    return mayUseAndAfford({ brokerageId: b, capability: "app.access", client: svc })
  })
  const gate = await afford(brokerageId).catch((e: unknown) => ({ allowed: false, reason: `entitlement check threw: ${(e as Error)?.message ?? String(e)}` }))
  if (!gate.allowed) { out.status = `research not entitled (${gate.reason}) — ${out.findings.length} finding(s) reported, nothing researched`; return out }

  const search = deps.search ?? (await import("@/lib/kernel/regulatory-watcher")).realRegSearchFetcher
  const meter = deps.meter ?? (async (input) => (await import("@/lib/vendor-governance/meter-vendor")).meterVendorSpend(input))
  const ledger: LedgerFn = deps.ledger ?? ((await import("@/lib/kernel/action-ledger")).withActionLedger as unknown as LedgerFn)
  const emit = deps.emit ?? (async (input) => (await import("@/lib/kernel/emit")).emitKernelEvent(input))
  const propose = deps.propose ?? (async (client, input) => (await import("@/lib/kernel/improvement-proposals")).proposeImprovement(client, input))
  const budget = deps.budgetUsd ?? LAW_RULE_RESEARCH_BUDGET_USD
  const maxCalls = deps.maxCalls ?? LAW_RULE_RESEARCH_MAX_CALLS
  const week = now.toISOString().slice(0, 10)
  const ctx = (action: string, ref: string, reasonDetail: string, detail: Record<string, unknown>): LedgerCtx => ({
    brokerageId, action, actor: { type: "manager", managerKey: "compliance_officer" }, subject: { type: "law_rule", ref },
    reasonCode: "COMPLIANCE_NOTICE", reasonDetail: reasonDetail.slice(0, 500), idempotencyKey: `${action}:${brokerageId}:${ref}:${week}`,
    riskClass: "LOW_RISK_WRITE", systemSource: SYSTEM_SOURCE, detail,
  })

  for (const finding of out.findings) {
    if (out.researched >= maxCalls) { out.refused.push({ key: finding.ruleKey ?? `${finding.jurisdiction}.${finding.scope}`, why: `research call cap (${maxCalls}) reached this pass` }); continue }
    if (out.spentUsd + RESEARCH_CALL_ESTIMATE_USD > budget + 1e-9) { out.refused.push({ key: finding.ruleKey ?? `${finding.jurisdiction}.${finding.scope}`, why: `research budget $${budget.toFixed(2)} reached this pass` }); continue }
    const query = researchQueryFor(finding)
    const res = await search({ query, brokerageId }).catch(() => ({ answer: null, hits: [], provider: "none" }))
    out.researched++
    if (res.provider === "none") { out.refused.push({ key: finding.ruleKey ?? `${finding.jurisdiction}.${finding.scope}`, why: "research rail unavailable — nothing drafted (nothing fabricated)" }); continue }
    const cost = typeof (res as { cost?: number }).cost === "number" && (res as { cost?: number }).cost! > 0 ? (res as { cost?: number }).cost! : RESEARCH_CALL_ESTIMATE_USD
    out.spentUsd += cost
    await meter({ vendorName: res.provider, usageType: "web_research", cost, brokerageId, systemSource: SYSTEM_SOURCE, metadata: { query, finding: finding.kind, jurisdiction: finding.jurisdiction, scope: finding.scope } }).catch(() => false)

    const drafted = draftLawRule(finding, res.hits ?? [], reg.registry)
    if (!drafted.ok) { out.refused.push({ key: finding.ruleKey ?? `${finding.jurisdiction}.${finding.scope}`, why: `${drafted.reason}: ${drafted.why}` }); continue }
    for (const draft of drafted.drafts) {
      const resolution: LawRuleResolution = resolveLawRuleDraft(draft, reg.registry)
      const evidence = { query, provider: res.provider, citations: draft.citations, effective_date: draft.effectiveDate, excerpt: draft.evidence.slice(0, 1500), finding, resolution }
      if (resolution.route === "refused") { out.refused.push({ key: draft.key, why: resolution.why }); continue }
      if (resolution.route === "verify") {
        const ok = await ledger(ctx(LAW_RULE_ACTION.verify, draft.key, resolution.why, evidence), async () => {
          if (draft.targetRowId) {
            const { data, error } = await svc.from("state_protected_classes").update({ last_verified_at: now.toISOString(), source_citations: draft.citations }).eq("id", draft.targetRowId).select("id")
            if (error) throw new Error(`state_protected_classes verify refused: ${error.message}`)
            if (!Array.isArray(data) || data.length !== 1) throw new Error("state_protected_classes verify matched no row")
          }
          return true
        }, { settle: () => ({ status: "executed", outcome: "verified", costUsd: cost, provider: res.provider }), replay: () => true }, { client: svc }).catch((e: unknown) => { out.refusedRails.push((e as Error).message); return false })
        if (ok) out.verified.push(draft.key)
        continue
      }
      if (resolution.route === "auto_enable_warn") {
        // A replayed claim (already enabled this day) returns undefined — counted nowhere, done once.
        const rowId = await ledger<string | null | undefined>(ctx(LAW_RULE_ACTION.enable, draft.key, resolution.why, evidence), async () => {
          const { data, error } = await svc.from("state_protected_classes").insert(warnRowFor(draft, now.toISOString(), evidence)).select("id")
          if (error) throw new Error(`state_protected_classes insert refused: ${error.message}`)
          return ((Array.isArray(data) ? data[0] : data)?.id as string | undefined) ?? null
        }, { settle: (id) => ({ status: id ? "executed" : "failed", outcome: id ? "enabled_warn" : "no_row", costUsd: cost, provider: res.provider }), replay: () => undefined }, { client: svc }).catch((e: unknown) => { out.refusedRails.push((e as Error).message); return undefined })
        if (rowId === undefined) continue
        out.enabledWarn.push({ key: draft.key, rowId })
        await emit({ event: "law_rule.auto_enabled_warn", brokerageId, entityType: "state_protected_class", entityId: rowId, metadata: { key: draft.key, jurisdiction: draft.jurisdiction, scope: draft.scope, citations: draft.citations, why: resolution.why }, auditOnly: true, client: svc }).catch(() => null)
        continue
      }
      // compliance_officer — a human decides (loosening, money, ambiguous).
      const subjectKey = `law_rule:${draft.key}`
      const p = await ledger<string | null | undefined>(ctx(LAW_RULE_ACTION.propose, draft.key, resolution.why, evidence), async () => {
        const proposal = await propose(svc, { brokerageId, subjectKind: "law_rule", subjectKey, proposer: "law_rule_healing", proposedChange: { draft, direction: resolution.direction, why: resolution.why, summary: `${draft.change} ${draft.scope} rule for ${draft.jurisdiction}: ${draft.name}` }, evidenceRefs: draft.citations })
        if (!proposal.ok) throw new Error(`law-rule proposal not recorded: ${proposal.error ?? "unknown"}`)
        return proposal.id ?? null
      }, { settle: (id) => ({ status: id ? "executed" : "failed", outcome: id ? "proposed_to_compliance_officer" : "no_proposal", costUsd: cost, provider: res.provider }), replay: () => undefined }, { client: svc }).catch((e: unknown) => { out.refusedRails.push((e as Error).message); return undefined })
      if (p === undefined) continue
      out.proposed.push({ key: draft.key, proposalId: p, direction: resolution.direction, why: resolution.why })
      await emit({ event: "law_rule.proposed", brokerageId, entityType: "improvement_proposal", entityId: p, metadata: { key: draft.key, direction: resolution.direction, why: resolution.why, citations: draft.citations }, auditOnly: true, client: svc }).catch(() => null)
    }
  }
  out.status = `${out.findings.length} finding(s): ${out.verified.length} verified, ${out.enabledWarn.length} enabled (warn), ${out.proposed.length} to the compliance officer, ${out.refused.length} refused; $${out.spentUsd.toFixed(3)} researched`
  return out
}

/**
 * A compliance officer's APPROVED law-rule proposal, applied through the rule's survivor (state_protected_classes).
 * Called ONLY by lib/kernel/improvement-proposals.ts applyChange (promote / rollback — the human-gated door).
 * An add enables the row in ENFORCE mode (or promotes its warn row); a loosen deactivates the target row.
 * A non-executable draft (a code gate, a scope no evaluator runs) has no row writer: the approval is the review.
 */
export async function applyLawRuleProposal(svc: Svc, brokerageId: string, draft: LawRuleDraft, direction: "promote" | "rollback"): Promise<{ writer: string; previous: unknown }> {
  if (!draft || typeof draft !== "object" || !draft.jurisdiction || !Array.isArray(draft.citations) || draft.citations.length === 0) throw new Error("the law-rule proposal carries no cited draft — nothing to apply")
  if (draft.change === "verify") throw new Error("a verification is recorded by the healing loop — nothing to promote")
  if (draft.change === "loosen") {
    if (!draft.targetRowId) throw new Error(`the loosened rule ${draft.targetKey ?? draft.key} is a code gate — a developer changes ${draft.targetKey ?? "it"}; the approval is the review`)
    const { data, error } = await svc.from("state_protected_classes").update({ is_active: direction === "rollback", provenance: "compliance_officer" }).eq("id", draft.targetRowId).select("id")
    if (error) throw new Error(`state_protected_classes refused: ${error.message}`)
    if (!Array.isArray(data) || data.length !== 1) throw new Error("the loosened rule's row is gone — nothing deactivated")
    return { writer: "state_protected_classes.is_active", previous: { is_active: direction === "promote" } }
  }
  if (!draft.executable) throw new Error(`no evaluator runs a ${draft.scope} rule as drafted — the approval is the review; the gate is implemented in code`)
  const { data: have, error: readErr } = await svc.from("state_protected_classes").select("id, enforcement_mode, is_active").eq("state_code", draft.jurisdiction).eq("protected_class", draft.name).limit(1)
  if (readErr) throw new Error(`state_protected_classes read refused: ${readErr.message}`)
  const row = (have ?? [])[0] as { id: string; enforcement_mode?: string | null; is_active?: boolean | null } | undefined
  if (direction === "rollback") {
    if (!row) throw new Error("the enabled rule's row is gone — nothing to roll back")
    const { data, error } = await svc.from("state_protected_classes").update({ is_active: false }).eq("id", row.id).select("id")
    if (error || !Array.isArray(data) || data.length !== 1) throw new Error(`rollback not applied: ${error?.message ?? "matched no row"}`)
    return { writer: "state_protected_classes.is_active", previous: { is_active: true } }
  }
  if (row) {
    const { data, error } = await svc.from("state_protected_classes").update({ enforcement_mode: "enforce", is_active: true, provenance: "compliance_officer", source_citations: draft.citations }).eq("id", row.id).select("id")
    if (error || !Array.isArray(data) || data.length !== 1) throw new Error(`promotion not applied: ${error?.message ?? "matched no row"}`)
    return { writer: "state_protected_classes.enforcement_mode", previous: { enforcement_mode: row.enforcement_mode ?? "enforce", is_active: row.is_active !== false } }
  }
  const ins = { ...warnRowFor(draft, new Date().toISOString(), { approved_by: "compliance_officer", brokerage_id: brokerageId }), enforcement_mode: "enforce", provenance: "compliance_officer" }
  const { data, error } = await svc.from("state_protected_classes").insert(ins).select("id")
  if (error || !(Array.isArray(data) ? data[0] : data)) throw new Error(`rule not written: ${error?.message ?? "no row"}`)
  return { writer: "state_protected_classes.insert", previous: null }
}
