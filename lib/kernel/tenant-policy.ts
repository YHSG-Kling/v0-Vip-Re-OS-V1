/**
 * lib/kernel/tenant-policy.ts — THE VERSIONED TENANT OPERATING CONSTITUTION (wave 101, lane 101A;
 * gap map rows 21 + 22; OS-CONSTITUTION LAW 5).
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT HERE: the policy values. Every live value stays in the store that already holds it
 * and every reader is unchanged (LAW 1) —
 *   brokerage_settings.settings  keys in TENANT_POLICY_SETTINGS_KEYS, written ONLY by
 *                                lib/settings/brokerage-settings-merge.ts mergeBrokerageSettings
 *   brokerage_settings columns   review_request_delay_days, live_agent_face_provider_order —
 *                                lib/settings/brokerage-settings-columns.ts
 *   brokerages column            default_assignment_method — app/actions/admin/lead-routing-settings.ts
 *   managed_agents.config        authority_level / autonomy_tier per agent kind —
 *                                app/actions/admin/manager-evals.ts setManagerAuthorityLevel / setManagerAutonomy
 *   ai_isa_settings              brokerage / team / agent tier rows — lib/ai-isa/resolve-isa-settings.ts writeIsaSettings
 *   assignment_rules rows        app/actions/admin/assignment-rules.ts (wave 102, lane 102D)
 *   *_cadence_policy rows        app/actions/blog-cadence-policy.ts, app/actions/marketing-cadence-policy.ts (102D)
 *   brokerages.farm_mail_* + lob_fallback_template_id — app/actions/direct-mail-settings.ts (102D)
 *
 * WHICH POLICY PERMITTED (wave 102, lane 102D; LAW 5): a ledgered action names the policy it ran
 * under as `policy_key@version` (agent_action_ledger.policy_ref, m700). The version is THIS file's
 * currentPolicyVersion — the one reader of "what version is live" — so the ledger, the
 * constitution and the history can never disagree about what v3 of `experiments` was.
 *
 * WHAT IS HERE: the ONE version appender those survivor writers call AFTER their write lands
 * (appendTenantPolicyVersion → tenant_policy_versions, m696, append-only), the registry of policy
 * keys, and the derived reads (history, constitution). A change leaves evidence twice: the
 * immutable version row (who / what / why / previous) and an auditOnly kernel event
 * `tenant_policy.changed` carrying the version id (LAW 5).
 *
 * A tenant with NO version rows behaves exactly as before: nothing here is read by any policy
 * consumer; the constitution shows the live value as "version 0 (never changed here)".
 *
 * Before m696 is applied the insert resolves 42P01 / PGRST205: the policy write has already
 * landed, the missing version is reported back as `{ ok: false, degraded: true }`.
 */

// ── The registry ────────────────────────────────────────────────────────────────────────────

export type TenantPolicyStore =
  | "brokerage_settings.settings"
  | "brokerage_settings.column"
  | "brokerages.column"
  | "managed_agents.config"
  | "ai_isa_settings"
  | "assignment_rules"
  | "cadence_policy"

export interface TenantPolicyDefinition {
  label: string
  store: TenantPolicyStore
  /** What a missing live value means (shown, never written). */
  defaultNote: string
}

/** brokerage_settings.settings keys that ARE tenant operating policy (versioned on every change). */
export const TENANT_POLICY_SETTINGS_KEYS: Record<string, TenantPolicyDefinition> = {
  experiments:             { label: "Experiments (per-tenant kill switch)", store: "brokerage_settings.settings", defaultNote: "experiments on; arms by lib/kernel/experiments.ts" },
  // Wave 102 (102C, owner answer 4): the direct-mail Thompson bandit's exploration freeze — versioned
  // like `experiments`. { frozen: boolean } read by lib/direct-mail/variant-bandit.ts pickVariantArm
  // (frozen = exploit the current best arm, never explore); written by app/actions/flight-recorder.ts
  // setDirectMailExplorationFrozen through mergeBrokerageSettings → appendTenantPolicyVersion.
  direct_mail_exploration: { label: "Direct-mail exploration (bandit kill switch)", store: "brokerage_settings.settings", defaultNote: "exploring; Thompson sampling by lib/direct-mail/variant-bandit.ts" },
  ai_agent_capabilities:   { label: "AI agent capabilities (enabled / custom tools)", store: "brokerage_settings.settings", defaultNote: "every catalogue capability enabled, no custom tools" },
  lead_routing:            { label: "Lead routing switches (mailbox-owner preference)", store: "brokerage_settings.settings", defaultNote: "mailbox-owner preference ON" },
  contact_fatigue_weights: { label: "Contact fatigue weights", store: "brokerage_settings.settings", defaultNote: "platform default weights" },
  topic_video_cadence:     { label: "Topic video cadence", store: "brokerage_settings.settings", defaultNote: "platform default cadence" },
  vendor_tier_pricing:     { label: "Vendor tier pricing overrides", store: "brokerage_settings.settings", defaultNote: "platform default vendor prices" },
  referral_appreciation:   { label: "Referral appreciation policy", store: "brokerage_settings.settings", defaultNote: "platform default appreciation" },
  ce_provider:             { label: "CE provider", store: "brokerage_settings.settings", defaultNote: "no CE provider connected" },
  learned_vetoes:          { label: "Vetoed learned adjustments", store: "brokerage_settings.settings", defaultNote: "no learned adjustment vetoed" },
  // Wave 104 (104C, controlled learning): a PROMOTED predictor threshold — { [predictor]: { thresholdMultiplier,
  // requireStrongest } } read by lib/intelligence/predictor-learning-runner.ts getPredictorTuning ahead of the
  // record-derived tuning; written ONLY by lib/kernel/improvement-proposals.ts promotion / rollback.
  predictor_tuning:        { label: "Predictor thresholds (promoted proposals)", store: "brokerage_settings.settings", defaultNote: "record-derived tuning; no promoted override" },
  // Wave 106 (106A): AUTONOMOUS RESOURCE ALLOCATION — { lead_assignment_mode: off | recommend (default) | consume,
  // ai_min_value_to_cost_ratio, enrichment_max_usd_per_decision } read by lib/kernel/resource-allocation.ts
  // loadResourceAllocationPolicy (the assigner's consult, the model router's reasoning-spend gate, the
  // enrichment rail's purchase gate). Written ONLY through mergeBrokerageSettings (a `policy` proposal on
  // the Manager Trust page promotes it) — never by the recommender itself.
  resource_allocation:     { label: "Resource allocation (recommendation mode, AI / data spend gates)", store: "brokerage_settings.settings", defaultNote: "recommend; expensive reasoning at ≥20× value/cost; enrichment ≤ $1 per decision" },
  // Wave 106 (106E, workforce intelligence): the thresholds every workforce classification and the
  // recruiting-need rule are judged against — read by lib/kernel/brokerage-twin.ts
  // resolveWorkforceThresholds (DEFAULT_WORKFORCE_THRESHOLDS when absent), written only through
  // the policy-proposal promotion path (improvement_proposals → appendTenantPolicyVersion → mergeBrokerageSettings).
  // Wave 107 (107B, marketplace procurement): { enabled, max_auto_approve_usd, allowed_service_categories } read by
  // lib/kernel/procurement.ts loadProcurementAutonomy — DEFAULT OFF (recommendation only, agent approval required).
  procurement_autonomy:    { label: "Procurement autonomy (auto-approve cap + allowed vendor categories)", store: "brokerage_settings.settings", defaultNote: "off — every vendor purchase waits for agent approval" },
  workforce_thresholds:    { label: "Workforce classification + recruiting-need thresholds", store: "brokerage_settings.settings", defaultNote: "platform defaults (lib/kernel/brokerage-twin.ts DEFAULT_WORKFORCE_THRESHOLDS)" },
  // Wave 107 (107E, strategy engine): per-strategy local overrides { [strategy_key]: { budgetUsd, authority,
  // approval, cadenceDays, horizonDays } } read by lib/kernel/strategy-engine.ts activateLibraryStrategy →
  // adaptStrategy (the adaptation is RECORDED on strategy_activations; the platform version never changes).
  // Written only through the policy-proposal promotion path (improvement_proposals → mergeBrokerageSettings).
  strategy_overrides:      { label: "Strategy overrides (budget / authority / timing per activated strategy)", store: "brokerage_settings.settings", defaultNote: "the platform version's own budget, authority and timing" },
  // Wave 107 (107F): the CONTRACTUAL gate on privacy-safe network benchmarks — { opted_in: boolean, set_by, set_at }
  // read by lib/intelligence/network-benchmarks.ts readNetworkOptIn (absent / unreadable = NOT contributing);
  // written by app/actions/network-intelligence.ts setNetworkBenchmarksOptIn (tenant admin, session actor).
  network_benchmarks_opt_in: { label: "Network benchmarks — contribute anonymized aggregates", store: "brokerage_settings.settings", defaultNote: "opted OUT (no owner ruling yet — contribution is opt-in)" },
  // Wave 108 (108G, SELF-OPTIMIZING MANAGER TEAMS — lib/kernel/self-optimization.ts): what the manager team's ALLOWED
  // classes promote — { experience_bias: { education?, properties? } (±15, read by lib/ai-isa/lead-action-plan.ts
  // planNextBestExperience), provider_skip: { property_valuation?: [backup providers] } (read by lib/avm/provider-chain.ts
  // requestPropertyValuation; the owner-ruled primary is never skipped) }. Written ONLY by the proposal promotion path.
  optimization_tuning:     { label: "Self-optimization tuning (experience bias, valuation provider skip, transaction deadline reminder lead)", store: "brokerage_settings.settings", defaultNote: "nothing tuned — the planners' own scores and the platform route" },
  // Wave 108 (108G): { autonomous_classes: OptimizationClass[] } — which optimization classes may promote WITHOUT a human
  // (each still under its owner manager's autonomy gate + authority rung). AUTHORITY POLICY: the optimizer can never
  // propose it (FORBIDDEN surface); a tenant admin sets it on the Manager Trust page through a human policy proposal.
  self_optimization:       { label: "Self-optimization — classes allowed to promote autonomously", store: "brokerage_settings.settings", defaultNote: "none — a human approves every optimization" },
  // Wave 108 (108F): CONTROLLED AUTONOMOUS BUDGETING — per-manager envelopes { ads_manager.max_shift_pct_of_monthly_budget,
  // provider_router.{per_decision_max_usd{standard,high,top}, monthly_max_usd}, asset_manager.max_renders_per_campaign,
  // recruiting_manager.max_prospect_data_usd_per_month, experiments.max_usd_per_month, listing_concierge.max_auto_book_usd_per_month,
  // finance.{burst_share_of_cap, ai_spike_multiple, refusal_pressure} } read by lib/kernel/autonomy-budgets.ts loadAutonomyBudgets
  // (consumeAutonomyEnvelope — the ONE enforcement function every autonomous spend calls). DEFAULT ALL ZERO =
  // recommendation only. Written only through mergeBrokerageSettings (a `policy` proposal on the Manager Trust page).
  autonomy_budgets:        { label: "Autonomous budget envelopes (per manager)", store: "brokerage_settings.settings", defaultNote: "all zero — recommendation only; every spend waits for a human" },
  // Wave 108 (108C, OS health & self-healing): THE FINANCIAL-WRITER KILL SWITCH — { [writer]: { halted, reason,
  // incident, set_by, set_at | released_by, released_at } } for the writers in lib/kernel/os-health.ts
  // FINANCIAL_WRITERS. Set ONLY by the OS health supervisor (actor manager cron_manager) when a financial
  // discrepancy is detected ("never auto-correct money"); released ONLY by a brokerage finance admin
  // (app/actions/os-health.ts releaseFinancialWriterHaltAction). Read by each writer at its entry through
  // loadFinancialWriterHalt — FAILS CLOSED (an unreadable halt state does not write money).
  financial_writer_halts:  { label: "Financial writer halts (OS health kill switch, Finance releases)", store: "brokerage_settings.settings", defaultNote: "no writer halted" },
  // Wave 137 (137D, TENANT EXTENSION CONTROL): { enabled: { [listing_id]: { kind, name, version, set_by, set_at } } } —
  // which ENABLED global extensions (skill_marketplace_listings, m738) this tenant opted in to. Read by
  // lib/kernel/skill-marketplace.ts loadTenantExtensionEnablement (FAILS CLOSED: unreadable = nothing enabled);
  // written ONLY by setTenantExtensionEnabled (tenant admin, session actor) through mergeBrokerageSettings.
  extensions:              { label: "Extensions enabled for this brokerage (approved skills / custom managers)", store: "brokerage_settings.settings", defaultNote: "none — no global extension runs here until a tenant admin enables it" },
  // Wave 139 (139F, owner "approve all" (4)): THE SELF-HEALING POLICY — { diagnosis_cap_usd, provider_research_cap_usd,
  // law_rule_research_cap_usd, law_rule_research_max_calls, max_attempts_per_day, allowed_remediation_classes,
  // auto_fix_min_confidence } read ONLY through lib/kernel/healing-policy.ts loadHealingPolicy, which resolves it UNDER the
  // platform ceiling (platform_settings.self_healing_ceilings, m753) — a tenant value above the ceiling is clamped, never
  // honored. Written only through the policy-proposal promotion path (improvement_proposals → mergeBrokerageSettings).
  self_healing:            { label: "Self-healing (diagnosis / research budgets, attempts per day, allowed remediation classes, auto-fix threshold)", store: "brokerage_settings.settings", defaultNote: "platform defaults ($0.05 diagnosis, $0.06 provider research, $0.10 / 6 calls law-rule research, 2 attempts/day, every declared playbook, auto-fix at ≥ 50% confidence) under the platform ceiling" },
}

/** Real columns that are tenant operating policy. */
export const TENANT_POLICY_COLUMN_KEYS: Record<string, TenantPolicyDefinition> = {
  review_request_delay_days:      { label: "Review request delay (days)", store: "brokerage_settings.column", defaultNote: "platform default delay" },
  live_agent_face_provider_order: { label: "Live agent face provider order", store: "brokerage_settings.column", defaultNote: "did, then simli" },
  default_assignment_method:      { label: "Default lead assignment method", store: "brokerages.column", defaultNote: "load_balance" },
  // 102D: brokerages.farm_mail_enabled / farm_mail_max_per_week / lob_fallback_template_id as ONE value
  // (app/actions/direct-mail-settings.ts saveFarmMailConfig is the only writer).
  farm_mail:                      { label: "Farm mail (enabled, weekly cap, Lob fallback template)", store: "brokerages.column", defaultNote: "farm mail off" },
}

/** 102D — policies that are ROWS in their own table, one version stream per row: `assignment_rule:<id>`,
 *  `<table>:<scope_type>:<scope_id>`. The row's policy columns are the value; a deleted rule is value null. */
export const TENANT_POLICY_ROW_KEYS: Record<string, TenantPolicyDefinition> = {
  assignment_rule:           { label: "Lead assignment rule", store: "assignment_rules", defaultNote: "rule deleted / never saved here" },
  blog_cadence_policy:       { label: "Blog cadence", store: "cadence_policy", defaultNote: "no row — cadence off" },
  newsletter_cadence_policy: { label: "Newsletter cadence", store: "cadence_policy", defaultNote: "no row — cadence off" },
  social_cadence_policy:     { label: "Social cadence", store: "cadence_policy", defaultNote: "no row — cadence off" },
}

export const FARM_MAIL_POLICY_KEY = "farm_mail"
export type CadencePolicyTable = "blog_cadence_policy" | "newsletter_cadence_policy" | "social_cadence_policy"
export type CadenceScopeType = "agent" | "team" | "brokerage"

export function assignmentRulePolicyKey(ruleId: string): string { return `assignment_rule:${ruleId}` }
export function cadencePolicyKey(table: CadencePolicyTable, scopeType: CadenceScopeType, scopeId: string): string { return `${table}:${scopeType}:${scopeId}` }

const ASSIGNMENT_RULE_POLICY_COLUMNS = ["name", "rule_type", "conditions", "agent_ids", "team_id", "priority", "is_active"] as const
const CADENCE_POLICY_COLUMNS = ["cadence", "fire_day", "preferred_categories", "preferred_persona", "preferred_post_types"] as const
const FARM_MAIL_POLICY_COLUMNS = ["farm_mail_enabled", "farm_mail_max_per_week", "lob_fallback_template_id"] as const

function pickPolicyColumns(row: Record<string, unknown> | null | undefined, cols: readonly string[]): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const c of cols) if (row[c] !== undefined) out[c] = row[c]
  return out
}
/** PURE — THE policy value of an assignment_rules row (null = no row / deleted). ONE shape for writers, constitution and revert (§6). */
export function assignmentRulePolicyValue(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null { return pickPolicyColumns(row, ASSIGNMENT_RULE_POLICY_COLUMNS) }
/** PURE — THE policy value of a *_cadence_policy row (preferred_post_types only where the table has it). */
export function cadencePolicyValue(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null { return pickPolicyColumns(row, CADENCE_POLICY_COLUMNS) }
/** PURE — THE policy value of brokerages' farm-mail columns. */
export function farmMailPolicyValue(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null { return pickPolicyColumns(row, FARM_MAIL_POLICY_COLUMNS) }

/** Per-agent-kind keys: `authority_level:<kind>` / `autonomy_tier:<kind>`. */
export const TENANT_POLICY_MANAGER_FIELDS = {
  authority_level: { label: "Authority level", store: "managed_agents.config", defaultNote: "level 6 (default)" },
  autonomy_tier:   { label: "Autonomy posture", store: "managed_agents.config", defaultNote: "eval-derived recommendation" },
} as const satisfies Record<string, TenantPolicyDefinition>

export const ISA_POLICY_KEY = "ai_isa_settings"

function isTenantPolicySettingsKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(TENANT_POLICY_SETTINGS_KEYS, key)
}

export function managerPolicyKey(field: keyof typeof TENANT_POLICY_MANAGER_FIELDS, agentKind: string): string {
  return `${field}:${agentKind}`
}

/** `ai_isa_settings` (brokerage tier), `ai_isa_settings:team:<id>`, `ai_isa_settings:agent:<id>`. */
export function isaPolicyKey(ownerType: "brokerage" | "team" | "agent", ownerId: string | null): string {
  return ownerType === "brokerage" || !ownerId ? ISA_POLICY_KEY : `${ISA_POLICY_KEY}:${ownerType}:${ownerId}`
}

export type ParsedPolicyKey =
  | { kind: "settings"; key: string; def: TenantPolicyDefinition }
  | { kind: "column"; key: string; def: TenantPolicyDefinition }
  | { kind: "manager"; field: keyof typeof TENANT_POLICY_MANAGER_FIELDS; agentKind: string; def: TenantPolicyDefinition }
  | { kind: "isa"; ownerType: "brokerage" | "team" | "agent"; ownerId: string | null; def: TenantPolicyDefinition }
  | { kind: "rule"; ruleId: string; def: TenantPolicyDefinition }
  | { kind: "cadence"; table: CadencePolicyTable; scopeType: CadenceScopeType; scopeId: string; def: TenantPolicyDefinition }

const ISA_DEF: TenantPolicyDefinition = { label: "AI ISA settings", store: "ai_isa_settings", defaultNote: "platform ISA defaults" }

/** The key grammar the revert router and the constitution share (test:tenant-policy-versions). */
export function parsePolicyKey(policyKey: string): ParsedPolicyKey | null {
  if (typeof policyKey !== "string" || !policyKey) return null
  if (isTenantPolicySettingsKey(policyKey)) return { kind: "settings", key: policyKey, def: TENANT_POLICY_SETTINGS_KEYS[policyKey] }
  if (Object.prototype.hasOwnProperty.call(TENANT_POLICY_COLUMN_KEYS, policyKey)) return { kind: "column", key: policyKey, def: TENANT_POLICY_COLUMN_KEYS[policyKey] }
  const m = /^(authority_level|autonomy_tier):([a-z][a-z0-9_]*)$/.exec(policyKey)
  if (m) {
    const field = m[1] as keyof typeof TENANT_POLICY_MANAGER_FIELDS
    return { kind: "manager", field, agentKind: m[2], def: TENANT_POLICY_MANAGER_FIELDS[field] }
  }
  if (policyKey === ISA_POLICY_KEY) return { kind: "isa", ownerType: "brokerage", ownerId: null, def: ISA_DEF }
  const i = /^ai_isa_settings:(team|agent):([0-9a-f-]{36})$/.exec(policyKey)
  if (i) return { kind: "isa", ownerType: i[1] as "team" | "agent", ownerId: i[2], def: ISA_DEF }
  // The id segments follow m696's segment grammar (`[a-z0-9_-]+`), not a uuid shape: the CHECK is the authority.
  const r = /^assignment_rule:([a-z0-9_-]+)$/.exec(policyKey)
  if (r) return { kind: "rule", ruleId: r[1], def: TENANT_POLICY_ROW_KEYS.assignment_rule }
  const c = /^(blog_cadence_policy|newsletter_cadence_policy|social_cadence_policy):(agent|team|brokerage):([a-z0-9_-]+)$/.exec(policyKey)
  if (c) return { kind: "cadence", table: c[1] as CadencePolicyTable, scopeType: c[2] as CadenceScopeType, scopeId: c[3], def: TENANT_POLICY_ROW_KEYS[c[1]] }
  return null
}

// ── Which policy permitted (102D) ───────────────────────────────────────────────────────────

/** `policy_key@version` — the agent_action_ledger.policy_ref spelling (m700 CHECK). A version the
 *  reader could not establish is `@unknown`, never `@0` ("never changed" is a claim). PURE. */
export function formatPolicyRef(policyKey: string, version: number | null | undefined): string {
  return `${policyKey}@${Number.isInteger(version) && (version as number) >= 0 ? version : "unknown"}`
}

/** PURE — the inverse of formatPolicyRef (null for a malformed ref).
 *  @proofSeam exported so scripts/action-ledger-guard.ts asserts the ref grammar round-trips against the m700 CHECK. */
export function parsePolicyRef(ref: string | null | undefined): { policyKey: string; version: number | null } | null {
  const m = /^([a-z][a-z0-9_]*(?::[a-z0-9_-]+)*)@([0-9]+|unknown)$/.exec(String(ref ?? ""))
  if (!m) return null
  return { policyKey: m[1], version: m[2] === "unknown" ? null : Number(m[2]) }
}

/**
 * THE ONE reader of a key's live version: max(version) in tenant_policy_versions for this tenant,
 * 0 when the key was never changed through the versioned writer (the constitution's "version 0").
 * A refused read is returned as such — the caller records `@unknown`, never a guessed number.
 */
export async function currentPolicyVersion(
  svc: any,
  brokerageId: string,
  policyKey: string,
): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "No brokerage." }
  if (!parsePolicyKey(policyKey)) return { ok: false, error: `"${policyKey}" is not a registered tenant policy key.` }
  try {
    const { data, error } = await svc
      .from("tenant_policy_versions")
      .select("version")
      .eq("brokerage_id", brokerageId)
      .eq("policy_key", policyKey)
      .order("version", { ascending: false })
      .limit(1)
    if (error) return { ok: false, error: String(error.message ?? error.code ?? "refused") }
    return { ok: true, version: ((data ?? [])[0] as { version?: number } | undefined)?.version ?? 0 }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** `policy_key@version` for a ledger row, through currentPolicyVersion; `@unknown` on a refused read. */
export async function resolvePolicyRef(svc: any, brokerageId: string, policyKey: string): Promise<string> {
  const v = await currentPolicyVersion(svc, brokerageId, policyKey)
  return formatPolicyRef(policyKey, v.ok ? v.version : null)
}

// ── Equality (a no-op write is not a version) ──────────────────────────────────────────────

function canonical(v: unknown): unknown {
  if (v === undefined) return null
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const c = (v as Record<string, unknown>)[k]
      if (c !== undefined) out[k] = canonical(c)
    }
    return out
  }
  return v
}

/** Pure: undefined and null both mean "no stored value"; key order never matters. */
export function samePolicyValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

/** Pure: the registered policy keys whose value differs between two settings objects. */
export function changedPolicySettingsKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(TENANT_POLICY_SETTINGS_KEYS).filter((k) => !samePolicyValue(before[k], after[k]))
}

// ── The ONE appender ────────────────────────────────────────────────────────────────────────

/** Who changed it — the agent_action_ledger actor vocabulary (m687), one spelling (§6). */
export interface PolicyActor {
  type: "user" | "manager" | "agent" | "system"
  /** users.id of the human (or the system user) — never a body value. */
  userId?: string | null
  /** For a manager actor: its MANAGERS key, kept in the evidence event. */
  managerKey?: string | null
  reason?: string | null
}

export type AppendPolicyVersionResult =
  | { ok: true; skipped: true; version: null; id: null }
  | { ok: true; skipped: false; version: number; id: string; evidenceError: string | null }
  | { ok: false; error: string; degraded?: boolean }

const MISSING_TABLE = new Set(["42P01", "PGRST205"])

/**
 * Append version n+1 of `policyKey` for `brokerageId`, carrying `previous`. Called by the
 * survivor writer AFTER its write landed; the tenant is the one that writer resolved from the
 * session / verified row. A value equal to `previous` is not a change and appends nothing.
 * A concurrent appender loses on the UNIQUE (23505) and re-reads.
 */
export async function appendTenantPolicyVersion(
  svc: any,
  input: { brokerageId: string; policyKey: string; value: unknown; previous: unknown; actor: PolicyActor },
): Promise<AppendPolicyVersionResult> {
  const { brokerageId, policyKey, actor } = input
  if (!brokerageId) return { ok: false, error: "No brokerage — policy version not recorded." }
  if (!parsePolicyKey(policyKey)) return { ok: false, error: `"${policyKey}" is not a registered tenant policy key.` }
  if (samePolicyValue(input.value, input.previous)) return { ok: true, skipped: true, version: null, id: null }
  const value = input.value === undefined ? null : input.value
  const previous = input.previous === undefined ? null : input.previous

  for (let attempt = 1; attempt <= 5; attempt++) {
    const { data: top, error: readErr } = await svc
      .from("tenant_policy_versions")
      .select("version")
      .eq("brokerage_id", brokerageId)
      .eq("policy_key", policyKey)
      .order("version", { ascending: false })
      .limit(1)
    if (readErr) {
      return { ok: false, degraded: MISSING_TABLE.has(String(readErr.code ?? "")), error: `policy history could not be read (${readErr.message}) — version not recorded` }
    }
    const version = (((top ?? [])[0] as { version?: number } | undefined)?.version ?? 0) + 1
    const { data: ins, error: insErr } = await svc
      .from("tenant_policy_versions")
      .insert({
        brokerage_id: brokerageId,
        policy_key: policyKey,
        version,
        value,
        previous,
        changed_by: actor.userId ?? null,
        actor_type: actor.type,
        reason: actor.reason ? String(actor.reason).slice(0, 500) : null,
      })
      .select("id")
    if (insErr) {
      if (String(insErr.code ?? "") === "23505") continue
      return { ok: false, degraded: MISSING_TABLE.has(String(insErr.code ?? "")), error: `policy version not recorded (${insErr.message})` }
    }
    const id = (Array.isArray(ins) ? ins[0] : ins)?.id as string | undefined
    if (!id) return { ok: false, error: "policy version insert returned no row — not recorded" }

    // LAW 5 evidence: an auditOnly kernel event (never fans out — nobody is belled for a policy edit).
    let evidenceError: string | null = null
    try {
      const { emitKernelEvent } = await import("@/lib/kernel/emit")
      const ev = await emitKernelEvent({
        event: "tenant_policy.changed",
        brokerageId,
        entityType: "tenant_policy_version",
        entityId: id,
        actorUserId: actor.userId ?? null,
        source: actor.type === "user" ? "ui" : "system",
        metadata: { policy_key: policyKey, version, actor_type: actor.type, manager_key: actor.managerKey ?? null, reason: actor.reason ?? null },
        auditOnly: true,
      })
      evidenceError = ev.error
    } catch (e) {
      evidenceError = (e as Error).message
    }
    return { ok: true, skipped: false, version, id, evidenceError }
  }
  return { ok: false, error: "policy version lost the race five times — not recorded" }
}

// ── Derived reads (callers gate first; the tenant is the SESSION's) ─────────────────────────

export interface PolicyVersionRow {
  id: string
  policy_key: string
  version: number
  value: unknown
  previous: unknown
  changed_by: string | null
  actor_type: string
  reason: string | null
  created_at: string
}

export type PolicyHistoryResult =
  | { ok: true; available: boolean; rows: PolicyVersionRow[] }
  | { ok: false; error: string }

export async function loadPolicyHistory(svc: any, brokerageId: string, policyKey: string): Promise<PolicyHistoryResult> {
  if (!brokerageId) return { ok: false, error: "No brokerage on this session." }
  if (!parsePolicyKey(policyKey)) return { ok: false, error: "Unknown policy key." }
  const { data, error } = await svc
    .from("tenant_policy_versions")
    .select("id, policy_key, version, value, previous, changed_by, actor_type, reason, created_at")
    .eq("brokerage_id", brokerageId)
    .eq("policy_key", policyKey)
    .order("version", { ascending: false })
    .limit(200)
  if (error) {
    if (MISSING_TABLE.has(String(error.code ?? ""))) return { ok: true, available: false, rows: [] }
    return { ok: false, error: `Policy history could not be read: ${error.message}` }
  }
  return { ok: true, available: true, rows: (data ?? []) as PolicyVersionRow[] }
}

export interface ConstitutionEntry {
  policyKey: string
  label: string
  store: TenantPolicyStore
  /** The live value from its survivor store (null = default). */
  value: unknown
  isDefault: boolean
  defaultNote: string
  /** 0 = never changed through the versioned writer. */
  version: number
  changedBy: string | null
  changedByName: string | null
  actorType: string | null
  changedAt: string | null
}

export type ConstitutionResult =
  | { ok: true; versionsAvailable: boolean; entries: ConstitutionEntry[] }
  | { ok: false; error: string }

/**
 * The current value of every tenant policy key, with its version, last changer and date.
 * Every read is pinned to `brokerageId` and READS its error (§3) — a refused read is a refusal,
 * never "all defaults".
 */
export async function buildTenantOperatingConstitution(svc: any, brokerageId: string): Promise<ConstitutionResult> {
  if (!brokerageId) return { ok: false, error: "No brokerage on this session." }
  const [bs, br, ma, isa, tpv, rules, agents, teams] = await Promise.all([
    svc.from("brokerage_settings").select("settings, review_request_delay_days, live_agent_face_provider_order").eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("brokerages").select("default_assignment_method, farm_mail_enabled, farm_mail_max_per_week, lob_fallback_template_id").eq("id", brokerageId).maybeSingle(),
    svc.from("managed_agents").select("agent_kind, config").eq("brokerage_id", brokerageId).is("archived_at", null),
    svc.from("ai_isa_settings").select("owner_type, team_id, agent_id, settings").eq("brokerage_id", brokerageId),
    svc.from("tenant_policy_versions").select("policy_key, version, changed_by, actor_type, created_at").eq("brokerage_id", brokerageId).order("version", { ascending: false }).limit(2000),
    svc.from("assignment_rules").select("id, name, rule_type, conditions, agent_ids, team_id, priority, is_active").eq("brokerage_id", brokerageId).limit(500),
    // blog_cadence_policy carries no brokerage_id: its scope ids are this tenant's agents / teams / the brokerage itself.
    svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(2000),
    svc.from("teams").select("id").eq("brokerage_id", brokerageId).limit(500),
  ])
  for (const [name, r] of [["brokerage settings", bs], ["brokerage", br], ["managed agents", ma], ["ISA settings", isa], ["assignment rules", rules], ["agents", agents], ["teams", teams]] as const) {
    if (r.error) return { ok: false, error: `The ${name} could not be read (${r.error.message}) — the constitution is not shown rather than shown as defaults.` }
  }
  let versionsAvailable = true
  if (tpv.error) {
    if (!MISSING_TABLE.has(String(tpv.error.code ?? ""))) return { ok: false, error: `Policy history could not be read: ${tpv.error.message}` }
    versionsAvailable = false
  }
  const latest = new Map<string, { version: number; changed_by: string | null; actor_type: string; created_at: string }>()
  for (const r of (tpv.data ?? []) as Array<{ policy_key: string; version: number; changed_by: string | null; actor_type: string; created_at: string }>) {
    const cur = latest.get(r.policy_key)
    if (!cur || r.version > cur.version) latest.set(r.policy_key, r)
  }

  const entries: ConstitutionEntry[] = []
  const push = (policyKey: string, def: TenantPolicyDefinition, value: unknown, label = def.label) => {
    const v = latest.get(policyKey)
    entries.push({
      policyKey, label, store: def.store, value: value === undefined ? null : value,
      isDefault: value === undefined || value === null, defaultNote: def.defaultNote,
      version: v?.version ?? 0, changedBy: v?.changed_by ?? null, changedByName: null,
      actorType: v?.actor_type ?? null, changedAt: v?.created_at ?? null,
    })
  }
  const settings = ((bs.data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
  for (const [k, def] of Object.entries(TENANT_POLICY_SETTINGS_KEYS)) push(k, def, settings[k])
  const bsRow = (bs.data ?? {}) as Record<string, unknown>
  push("review_request_delay_days", TENANT_POLICY_COLUMN_KEYS.review_request_delay_days, bsRow.review_request_delay_days)
  push("live_agent_face_provider_order", TENANT_POLICY_COLUMN_KEYS.live_agent_face_provider_order, bsRow.live_agent_face_provider_order)
  push("default_assignment_method", TENANT_POLICY_COLUMN_KEYS.default_assignment_method, (br.data as Record<string, unknown> | null)?.default_assignment_method)
  {
    const fm = farmMailPolicyValue(br.data as Record<string, unknown> | null)
    push(FARM_MAIL_POLICY_KEY, TENANT_POLICY_COLUMN_KEYS.farm_mail, fm && fm.farm_mail_enabled != null ? fm : undefined)
  }
  for (const r of ((rules.data ?? []) as Array<Record<string, unknown>>).sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))) {
    push(assignmentRulePolicyKey(String(r.id)), TENANT_POLICY_ROW_KEYS.assignment_rule, assignmentRulePolicyValue(r), `${TENANT_POLICY_ROW_KEYS.assignment_rule.label} — ${String(r.name ?? r.id)}`)
  }
  // Cadence rows: newsletter / social are tenant-anchored; blog is matched on this tenant's scope ids.
  const scopeIds = new Set<string>([brokerageId, ...((agents.data ?? []) as Array<{ id: string }>).map((a) => a.id), ...((teams.data ?? []) as Array<{ id: string }>).map((t) => t.id)])
  const cadenceSelect = "scope_type, scope_id, cadence, fire_day, preferred_categories, preferred_persona"
  const [blog, nl, so] = await Promise.all([
    svc.from("blog_cadence_policy").select(cadenceSelect).in("scope_id", [...scopeIds].slice(0, 500)).limit(500),
    svc.from("newsletter_cadence_policy").select(cadenceSelect).eq("brokerage_id", brokerageId).limit(500),
    svc.from("social_cadence_policy").select(`${cadenceSelect}, preferred_post_types`).eq("brokerage_id", brokerageId).limit(500),
  ])
  for (const [table, r] of [["blog_cadence_policy", blog], ["newsletter_cadence_policy", nl], ["social_cadence_policy", so]] as const) {
    if (r.error) return { ok: false, error: `The ${table} rows could not be read (${r.error.message}) — the constitution is not shown rather than shown as defaults.` }
    for (const row of (r.data ?? []) as Array<Record<string, unknown>>) {
      const st = row.scope_type as CadenceScopeType
      if ((st !== "agent" && st !== "team" && st !== "brokerage") || !row.scope_id) continue
      const def = TENANT_POLICY_ROW_KEYS[table]
      push(cadencePolicyKey(table, st, String(row.scope_id)), def, cadencePolicyValue(row), `${def.label} — ${st}`)
    }
  }
  const kinds = new Map<string, Record<string, unknown>>()
  for (const r of (ma.data ?? []) as Array<{ agent_kind: string; config: Record<string, unknown> | null }>) {
    if (!kinds.has(r.agent_kind)) kinds.set(r.agent_kind, r.config ?? {})
  }
  for (const [kind, cfg] of Array.from(kinds.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    for (const field of Object.keys(TENANT_POLICY_MANAGER_FIELDS) as Array<keyof typeof TENANT_POLICY_MANAGER_FIELDS>) {
      const def = TENANT_POLICY_MANAGER_FIELDS[field]
      push(managerPolicyKey(field, kind), def, cfg[field], `${def.label} — ${kind}`)
    }
  }
  for (const r of (isa.data ?? []) as Array<{ owner_type: string; team_id: string | null; agent_id: string | null; settings: unknown }>) {
    if (r.owner_type !== "brokerage" && r.owner_type !== "team" && r.owner_type !== "agent") continue
    const ownerId = r.owner_type === "team" ? r.team_id : r.owner_type === "agent" ? r.agent_id : null
    const key = isaPolicyKey(r.owner_type, ownerId)
    push(key, ISA_DEF, r.settings, r.owner_type === "brokerage" ? ISA_DEF.label : `${ISA_DEF.label} — ${r.owner_type}`)
  }
  // A versioned key whose live row is gone (an archived manager, a deleted team) still shows.
  const shown = new Set(entries.map((e) => e.policyKey))
  for (const key of Array.from(latest.keys()).sort()) {
    const parsed = parsePolicyKey(key)
    if (!shown.has(key) && parsed) push(key, parsed.def, undefined)
  }

  const userIds = Array.from(new Set(entries.map((e) => e.changedBy).filter((x): x is string => !!x)))
  if (userIds.length) {
    const { data: users, error: uErr } = await svc.from("users").select("id, first_name, last_name, email").in("id", userIds)
    if (!uErr) {
      const names = new Map<string, string>()
      for (const u of (users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>) {
        names.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || u.id)
      }
      for (const e of entries) if (e.changedBy) e.changedByName = names.get(e.changedBy) ?? null
    }
  }
  return { ok: true, versionsAvailable, entries }
}
