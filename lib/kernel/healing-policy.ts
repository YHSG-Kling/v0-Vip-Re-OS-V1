// lib/kernel/healing-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SELF-HEALING POLICY — tenant policy under a platform ceiling (wave 139, lane 139F; owner "approve
// all" (4): "self-healing diagnosis/research budgets, max attempts/day, allowed remediation classes and the
// auto-fix-vs-approval threshold become tenant/platform POLICY (platform ceilings tenant cannot exceed;
// current defaults stay the fallback)").
//
// NOT A NEW POLICY SYSTEM (LAW 1/2). The tenant half is ONE more versioned key, `self_healing`, in the
// existing registry (lib/kernel/tenant-policy.ts TENANT_POLICY_SETTINGS_KEYS), stored in
// brokerage_settings.settings and written ONLY through the generic `policy` proposal promotion
// (lib/kernel/improvement-proposals.ts applyChange → mergeBrokerageSettings → appendTenantPolicyVersion).
// The platform half is one jsonb column on the platform_settings SINGLETON (m753 self_healing_ceilings),
// beside status_notice / retention_offer, written ONLY by setPlatformHealingCeilings (superadmin, audited).
//
// THE ONE READER: loadHealingPolicy(svc, brokerageId). Every healing spend / attempt / auto-fix decision
// reads it — lib/kernel/self-healing.ts troubleshootIncident (diagnosis cap, attempts/day, allowed
// classes, auto-fix threshold), lib/kernel/os-health.ts failover → healer and
// app/api/cron/connector-health (provider research cap + auto-apply threshold), lib/kernel/law-rule-
// healing.ts runLawRuleHealing (law-rule research cap + calls). The old constants
// (SELF_HEAL_DIAGNOSIS_CAP_USD, SELF_HEAL_PLAYBOOK_ATTEMPT_CAP, PROVIDER_RESEARCH_CAP_USD,
// LAW_RULE_RESEARCH_*) are now aliases of HEALING_POLICY_DEFAULTS — the defaults only.
//
// RESOLUTION (resolveHealingPolicy, pure): every number is min(tenant ?? default, ceiling); the auto-fix
// confidence is max(tenant ?? default, ceiling floor) — a tenant can only demand MORE confidence; the
// allowed classes are tenant ∩ ceiling (null = every declared acting playbook). A tenant value above the
// ceiling is CLAMPED and named in `clamped` (it is never an error at read time — the ceiling may move
// after the tenant's value was promoted).
//
// FAIL CLOSED: a refused tenant read, or a refused ceiling read, resolves `readable: false` with every cap
// 0, no attempts, no acting class and a confidence of 1 — nothing autonomous spends or acts; the callers
// say why. ONE degrade is honest rather than closed: before m753 the column is absent (42703 / PGRST204),
// which can only mean "no ceiling was ever set" — the code defaults ARE the ceiling (source "unapplied").

type Svc = any

export const HEALING_POLICY_KEY = "self_healing"

/** The stored shape (snake_case, like every brokerage_settings policy value). */
interface HealingPolicyValue {
  diagnosis_cap_usd: number
  provider_research_cap_usd: number
  law_rule_research_cap_usd: number
  law_rule_research_max_calls: number
  max_attempts_per_day: number
  /** Acting playbooks (lib/kernel/self-healing.ts SELF_HEAL_PLAYBOOKS keys) the healer may run; null = all. */
  allowed_remediation_classes: string[] | null
  /** Below this diagnosis / finding confidence the fix waits for a human (approval), never auto-applied. */
  auto_fix_min_confidence: number
}

/** THE defaults — today's values (wave 138B/138C). Absent tenant policy + absent ceiling = exactly these. */
export const HEALING_POLICY_DEFAULTS: Readonly<HealingPolicyValue> = Object.freeze({
  diagnosis_cap_usd: 0.05,
  provider_research_cap_usd: 0.06,
  law_rule_research_cap_usd: 0.1,
  law_rule_research_max_calls: 6,
  max_attempts_per_day: 2,
  allowed_remediation_classes: null,
  auto_fix_min_confidence: 0.5,
})

type NumericField = Exclude<keyof HealingPolicyValue, "allowed_remediation_classes">
/** Hard bounds a stored value must sit inside (a value outside is ignored and reported, never trusted). */
const NUMERIC_BOUNDS: Readonly<Record<NumericField, { min: number; max: number; int: boolean; floor?: true; label: string }>> = {
  diagnosis_cap_usd:           { min: 0, max: 5, int: false, label: "AI diagnosis cap per incident (USD)" },
  provider_research_cap_usd:   { min: 0, max: 5, int: false, label: "Provider setup research cap per heal (USD)" },
  law_rule_research_cap_usd:   { min: 0, max: 5, int: false, label: "Law-rule research cap per tenant pass (USD)" },
  law_rule_research_max_calls: { min: 0, max: 50, int: true, label: "Law-rule research calls per tenant pass" },
  max_attempts_per_day:        { min: 0, max: 10, int: true, label: "Playbook attempts per incident per 24h" },
  auto_fix_min_confidence:     { min: 0, max: 1, int: false, floor: true, label: "Auto-fix confidence floor (below → approval)" },
}
const NUMERIC_FIELDS = Object.keys(NUMERIC_BOUNDS) as NumericField[]

export interface HealingPolicy {
  diagnosisCapUsd: number
  providerResearchCapUsd: number
  lawRuleResearchCapUsd: number
  lawRuleResearchMaxCalls: number
  maxAttemptsPerDay: number
  /** null = every declared acting playbook; otherwise only these (hand-off playbooks are always offered). */
  allowedRemediationClasses: readonly string[] | null
  autoFixMinConfidence: number
  /** false = a store could not be read → everything above is the fail-closed zero. */
  readable: boolean
  source: { tenant: "policy" | "default" | "unreadable"; ceiling: "platform" | "default" | "unapplied" | "unreadable" }
  /** Tenant fields the platform ceiling clamped (and stored values ignored as out of bounds). */
  clamped: string[]
  ignored: string[]
  note: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

function readNumber(raw: Record<string, unknown>, f: NumericField, ignored: string[], who: string): number | undefined {
  if (!(f in raw) || raw[f] === null || raw[f] === undefined) return undefined
  const n = Number(raw[f])
  const b = NUMERIC_BOUNDS[f]
  if (!Number.isFinite(n) || n < b.min || n > b.max || (b.int && !Number.isInteger(n))) { ignored.push(`${who}.${f}`); return undefined }
  return n
}

function readClasses(raw: Record<string, unknown>, ignored: string[], who: string): string[] | null | undefined {
  if (!("allowed_remediation_classes" in raw)) return undefined
  const v = raw.allowed_remediation_classes
  if (v === null) return null
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !/^[a-z][a-z_]{1,40}$/.test(x))) { ignored.push(`${who}.allowed_remediation_classes`); return undefined }
  return Array.from(new Set(v as string[]))
}

const closed = (): Omit<HealingPolicy, "source" | "note"> => ({
  diagnosisCapUsd: 0, providerResearchCapUsd: 0, lawRuleResearchCapUsd: 0, lawRuleResearchMaxCalls: 0,
  maxAttemptsPerDay: 0, allowedRemediationClasses: [], autoFixMinConfidence: 1, readable: false, clamped: [], ignored: [],
})

/**
 * PURE — the effective policy from the tenant's stored value under the platform ceiling.
 * `undefined` / null tenant value = the defaults (clamped by the ceiling); `undefined` ceiling = the
 * defaults are the ceiling. Never throws; out-of-bounds stored values are ignored and named.
 * @proofSeam scripts/healing-policy-guard.ts drives the ceiling / default / clamp rules directly.
 */
export function resolveHealingPolicy(tenantRaw: unknown, ceilingRaw: unknown): Omit<HealingPolicy, "source" | "note" | "readable"> & { readable: true } {
  const ignored: string[] = [], clamped: string[] = []
  const t = isObj(tenantRaw) ? tenantRaw : {}
  const c = isObj(ceilingRaw) ? ceilingRaw : {}
  const ceiling = {} as Record<NumericField, number>
  for (const f of NUMERIC_FIELDS) ceiling[f] = readNumber(c, f, ignored, "ceiling") ?? HEALING_POLICY_DEFAULTS[f]
  const out = {} as Record<NumericField, number>
  for (const f of NUMERIC_FIELDS) {
    const want = readNumber(t, f, ignored, "tenant") ?? HEALING_POLICY_DEFAULTS[f]
    const floor = NUMERIC_BOUNDS[f].floor === true
    const eff = floor ? Math.max(want, ceiling[f]) : Math.min(want, ceiling[f])
    if (eff !== want) clamped.push(f)
    out[f] = eff
  }
  const cc = readClasses(c, ignored, "ceiling")
  const tc = readClasses(t, ignored, "tenant")
  const ceilClasses = cc === undefined ? HEALING_POLICY_DEFAULTS.allowed_remediation_classes : cc
  const wantClasses = tc === undefined ? HEALING_POLICY_DEFAULTS.allowed_remediation_classes : tc
  let classes: string[] | null
  if (ceilClasses === null) classes = wantClasses
  else if (wantClasses === null) classes = [...ceilClasses]
  else {
    classes = wantClasses.filter((k) => ceilClasses.includes(k))
    if (classes.length !== wantClasses.length) clamped.push("allowed_remediation_classes")
  }
  return {
    diagnosisCapUsd: out.diagnosis_cap_usd, providerResearchCapUsd: out.provider_research_cap_usd,
    lawRuleResearchCapUsd: out.law_rule_research_cap_usd, lawRuleResearchMaxCalls: out.law_rule_research_max_calls,
    maxAttemptsPerDay: out.max_attempts_per_day, allowedRemediationClasses: classes,
    autoFixMinConfidence: out.auto_fix_min_confidence, readable: true, clamped, ignored,
  }
}

const ABSENT_COLUMN = new Set(["42703", "PGRST204"])

/** The platform ceiling as stored (null = never set / column not applied). Reads its error (§3). */
export async function loadPlatformHealingCeilings(svc: Svc): Promise<{ ok: true; raw: Record<string, unknown> | null; applied: boolean } | { ok: false; error: string }> {
  try {
    const { data, error } = await svc.from("platform_settings").select("self_healing_ceilings").order("created_at", { ascending: true }).limit(1).maybeSingle()
    if (error) {
      if (ABSENT_COLUMN.has(String(error.code ?? ""))) return { ok: true, raw: null, applied: false }
      return { ok: false, error: `platform healing ceiling unreadable: ${error.message ?? error.code}` }
    }
    const raw = (data as { self_healing_ceilings?: unknown } | null)?.self_healing_ceilings
    return { ok: true, raw: isObj(raw) ? raw : null, applied: true }
  } catch (e) {
    return { ok: false, error: `platform healing ceiling unreadable: ${(e as Error).message}` }
  }
}

/**
 * THE ONE READER of the self-healing policy for one tenant (effective = tenant under the platform
 * ceiling). Fail closed: an unreadable store resolves `readable: false` (every cap 0, nothing acts).
 * Never throws. Lane 139A's executors switch with one line:
 *   `const { maxAttemptsPerDay } = await loadHealingPolicy(svc, brokerageId)`.
 */
export async function loadHealingPolicy(svc: Svc, brokerageId: string): Promise<HealingPolicy> {
  if (!brokerageId) return { ...closed(), source: { tenant: "unreadable", ceiling: "unreadable" }, note: "no tenant — the healing policy cannot be resolved (fail closed)" }
  const [ceiling, tenant] = await Promise.all([
    loadPlatformHealingCeilings(svc),
    (async () => {
      try {
        const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
        if (error) return { ok: false as const, error: `tenant healing policy unreadable: ${error.message ?? error.code}` }
        const v = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {})[HEALING_POLICY_KEY]
        return { ok: true as const, raw: isObj(v) ? v : null }
      } catch (e) {
        return { ok: false as const, error: `tenant healing policy unreadable: ${(e as Error).message}` }
      }
    })(),
  ])
  if (!ceiling.ok || !tenant.ok) {
    return {
      ...closed(),
      source: { tenant: tenant.ok ? (tenant.raw ? "policy" : "default") : "unreadable", ceiling: ceiling.ok ? (ceiling.applied ? (ceiling.raw ? "platform" : "default") : "unapplied") : "unreadable" },
      note: `${[!ceiling.ok ? ceiling.error : null, !tenant.ok ? tenant.error : null].filter(Boolean).join("; ")} — nothing autonomous spends or acts (fail closed)`,
    }
  }
  const r = resolveHealingPolicy(tenant.raw, ceiling.raw)
  return {
    ...r,
    source: { tenant: tenant.raw ? "policy" : "default", ceiling: !ceiling.applied ? "unapplied" : ceiling.raw ? "platform" : "default" },
    note: !ceiling.applied ? "platform ceiling column not applied yet (m753) — the code defaults are the ceiling" : null,
  }
}

/**
 * PURE — a superadmin's ceiling edit → the stored ceiling. Every numeric field bounded (out of bounds is an
 * error, never clamped silently); classes must be DECLARED acting playbooks (`declared`, passed by the
 * caller from SELF_HEAL_PLAYBOOKS — one vocabulary, never restated here). Blank = keep the current value.
 * @proofSeam scripts/healing-policy-guard.ts drives bounds + the undeclared-class refusal.
 */
export function validateHealingCeilingsEdit(input: Record<string, unknown>, current: Record<string, unknown> | null, declared: readonly string[]): { ok: true; value: HealingPolicyValue } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const cur = resolveHealingPolicy(undefined, current ?? undefined)
  const curNum: Record<NumericField, number> = {
    diagnosis_cap_usd: cur.diagnosisCapUsd, provider_research_cap_usd: cur.providerResearchCapUsd, law_rule_research_cap_usd: cur.lawRuleResearchCapUsd,
    law_rule_research_max_calls: cur.lawRuleResearchMaxCalls, max_attempts_per_day: cur.maxAttemptsPerDay, auto_fix_min_confidence: cur.autoFixMinConfidence,
  }
  const value = { allowed_remediation_classes: cur.allowedRemediationClasses === null ? null : [...cur.allowedRemediationClasses] } as HealingPolicyValue
  for (const f of NUMERIC_FIELDS) {
    const raw = input[f]
    const b = NUMERIC_BOUNDS[f]
    const n = raw === undefined || raw === null || String(raw).trim() === "" ? curNum[f] : Number(raw)
    if (!Number.isFinite(n) || n < b.min || n > b.max || (b.int && !Number.isInteger(n))) { errors.push(`${b.label}: must be ${b.int ? "a whole number " : ""}between ${b.min} and ${b.max}`); continue }
    value[f] = b.int ? n : Math.round(n * 10_000) / 10_000
  }
  if ("allowed_remediation_classes" in input) {
    const v = input.allowed_remediation_classes
    if (v === null) value.allowed_remediation_classes = null
    else if (!Array.isArray(v)) errors.push("Allowed remediation classes: a list of declared playbooks (or null for all)")
    else {
      const bad = v.filter((x) => typeof x !== "string" || !declared.includes(x))
      if (bad.length) errors.push(`Allowed remediation classes: not declared playbooks — ${bad.map(String).join(", ").slice(0, 200)}`)
      else value.allowed_remediation_classes = Array.from(new Set(v as string[]))
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value }
}

/**
 * Write the platform ceiling on the platform_settings singleton (the caller is superadmin-gated and
 * audits). Validates first; the update is `.select()`-counted (a write that matched nothing is refused,
 * never reported saved — §3).
 */
export async function setPlatformHealingCeilings(svc: Svc, input: Record<string, unknown>, declared: readonly string[]): Promise<{ ok: true; before: Record<string, unknown> | null; after: HealingPolicyValue } | { ok: false; error: string }> {
  const cur = await loadPlatformHealingCeilings(svc)
  if (!cur.ok) return { ok: false, error: cur.error }
  if (!cur.applied) return { ok: false, error: "The platform healing ceiling column is not applied yet (m753) — nothing written." }
  const v = validateHealingCeilingsEdit(input, cur.raw, declared)
  if (!v.ok) return { ok: false, error: v.errors.join("; ") }
  const { data: row, error: rowErr } = await svc.from("platform_settings").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle()
  if (rowErr) return { ok: false, error: `platform settings unreadable: ${rowErr.message}` }
  if (!row) return { ok: false, error: "No platform_settings row exists — the healing ceiling was not written." }
  const { data: moved, error } = await svc.from("platform_settings").update({ self_healing_ceilings: v.value, updated_at: new Date().toISOString() }).eq("id", (row as { id: unknown }).id).select("id")
  if (error) return { ok: false, error: `Healing ceiling NOT saved: ${error.message}` }
  if (!Array.isArray(moved) || moved.length !== 1) return { ok: false, error: "Healing ceiling NOT saved: the update matched no platform_settings row." }
  return { ok: true, before: cur.raw, after: v.value }
}
