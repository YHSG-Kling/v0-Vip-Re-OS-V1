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

export interface TenantPolicyDefinition {
  label: string
  store: TenantPolicyStore
  /** What a missing live value means (shown, never written). */
  defaultNote: string
}

/** brokerage_settings.settings keys that ARE tenant operating policy (versioned on every change). */
export const TENANT_POLICY_SETTINGS_KEYS: Record<string, TenantPolicyDefinition> = {
  experiments:             { label: "Experiments (per-tenant kill switch)", store: "brokerage_settings.settings", defaultNote: "experiments on; arms by lib/kernel/experiments.ts" },
  ai_agent_capabilities:   { label: "AI agent capabilities (enabled / custom tools)", store: "brokerage_settings.settings", defaultNote: "every catalogue capability enabled, no custom tools" },
  lead_routing:            { label: "Lead routing switches (mailbox-owner preference)", store: "brokerage_settings.settings", defaultNote: "mailbox-owner preference ON" },
  contact_fatigue_weights: { label: "Contact fatigue weights", store: "brokerage_settings.settings", defaultNote: "platform default weights" },
  topic_video_cadence:     { label: "Topic video cadence", store: "brokerage_settings.settings", defaultNote: "platform default cadence" },
  vendor_tier_pricing:     { label: "Vendor tier pricing overrides", store: "brokerage_settings.settings", defaultNote: "platform default vendor prices" },
  referral_appreciation:   { label: "Referral appreciation policy", store: "brokerage_settings.settings", defaultNote: "platform default appreciation" },
  ce_provider:             { label: "CE provider", store: "brokerage_settings.settings", defaultNote: "no CE provider connected" },
  learned_vetoes:          { label: "Vetoed learned adjustments", store: "brokerage_settings.settings", defaultNote: "no learned adjustment vetoed" },
}

/** Real columns that are tenant operating policy. */
export const TENANT_POLICY_COLUMN_KEYS: Record<string, TenantPolicyDefinition> = {
  review_request_delay_days:      { label: "Review request delay (days)", store: "brokerage_settings.column", defaultNote: "platform default delay" },
  live_agent_face_provider_order: { label: "Live agent face provider order", store: "brokerage_settings.column", defaultNote: "did, then simli" },
  default_assignment_method:      { label: "Default lead assignment method", store: "brokerages.column", defaultNote: "load_balance" },
}

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
  return null
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
  const [bs, br, ma, isa, tpv] = await Promise.all([
    svc.from("brokerage_settings").select("settings, review_request_delay_days, live_agent_face_provider_order").eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("brokerages").select("default_assignment_method").eq("id", brokerageId).maybeSingle(),
    svc.from("managed_agents").select("agent_kind, config").eq("brokerage_id", brokerageId).is("archived_at", null),
    svc.from("ai_isa_settings").select("owner_type, team_id, agent_id, settings").eq("brokerage_id", brokerageId),
    svc.from("tenant_policy_versions").select("policy_key, version, changed_by, actor_type, created_at").eq("brokerage_id", brokerageId).order("version", { ascending: false }).limit(2000),
  ])
  for (const [name, r] of [["brokerage settings", bs], ["brokerage", br], ["managed agents", ma], ["ISA settings", isa]] as const) {
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
