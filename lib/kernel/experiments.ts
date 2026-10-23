/**
 * EXPERIMENT ASSIGNMENT — the ONE deterministic arm picker (wave 101, lane 101B; gap map row 20).
 *
 * OWNER LAW 2 (one canonical path). Before this, the only subject-level split in the repo was
 * lib/campaign-sequences/ab-variant.ts assignAbVariant — a Math.random() 50/50 at enrollment, so
 * the same person re-enrolled could land in either arm and nothing could replay WHY they got B.
 * It now delegates here. The direct-mail Thompson bandit (lib/direct-mail/variant-bandit.ts
 * pickVariantArm) is NOT a fixed-weight experiment — it is an adaptive allocator that learns per
 * cohort — so it keeps its own sampler and only RECORDS its arm through experimentLedgerDetail
 * (same ledger key, so 100A attribution rolls it up beside the A/B arms).
 *
 *   arm = stable hash(brokerageId, subjectId, experimentKey) → [0,1) → weighted arm walk.
 *
 * PURE except loadExperimentPolicy. No Math.random, no clock: the same inputs give the same arm
 * on every server, every replay.
 *
 * DEFINITIONS live in EXPERIMENT_DEFINITIONS below (code, like the reason-code vocabulary). No
 * live table fits a generic weighted-arm definition: content_ab_tests is a two-content-row race
 * with agent_id NOT NULL (app/actions/ai-content-generation.tsx), feature_flags is the platform
 * entitlement catalogue (no tenant, no arms). The per-INSTANCE switch stays where it already
 * lives (campaign_sequences.is_ab_test turns a sequence's A/B on). No migration (m697 unused).
 *
 * KILL SWITCH — per tenant, in POLICY: brokerage_settings.settings.experiments
 *   { kill_switch: boolean, disabled: string[] }  (writer: app/actions/flight-recorder.ts
 *   setExperimentKillSwitch through mergeBrokerageSettings). A killed / disabled / UNREADABLE
 *   policy assigns CONTROL (fail closed: "nobody checked" never renders as "experiment on").
 *   MERGE POINT (lane 101A, versioned tenant policy): loadExperimentPolicy is the single read —
 *   when 101A's versioned policy reader lands, swap its body onto that reader; callers do not move.
 */

export interface ExperimentArm {
  key: string
  /** Relative weight (any positive number; normalised over the arms). */
  weight: number
}

export interface ExperimentDefinition {
  key: string
  description: string
  /** The arm a disabled / killed / unreadable experiment assigns. Must be one of `arms`. */
  control: string
  arms: readonly ExperimentArm[]
  /** Where the per-instance ON switch lives (prose — the reader is the caller). */
  instanceSwitch: string
}

export const EXPERIMENT_DEFINITIONS = Object.freeze({
  sequence_ab: {
    key: "sequence_ab",
    description: "Campaign sequence copy A/B — the step row whose ab_variant matches the enrollment's arm is sent (lib/campaign-sequences/ab-variant.ts pickStepVariant).",
    control: "A",
    arms: Object.freeze([{ key: "A", weight: 50 }, { key: "B", weight: 50 }]),
    instanceSwitch: "campaign_sequences.is_ab_test",
  },
} satisfies Record<string, ExperimentDefinition>)

/** FNV-1a 32 + murmur3 fmix32 avalanche → [0, 1). Pure, platform-independent (no node:crypto, so a
 *  client bundle that reaches ab-variant.ts still builds). */
function stableUnit(...parts: string[]): number {
  let h = 0x811c9dc5
  const s = parts.join("␟")
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 0x1_0000_0000
}

export type AssignmentReason = "assigned" | "provided" | "instance_off" | "kill_switch" | "disabled" | "policy_unreadable" | "no_subject"

export interface ExperimentAssignment {
  /** The experiment instance key (`<definition>` or `<definition>:<instance>`) — what the ledger records. */
  key: string
  arm: string
  control: boolean
  reason: AssignmentReason
}

export interface ExperimentPolicy {
  /** false = the policy read was refused → every experiment assigns control. */
  readable: boolean
  killSwitch: boolean
  disabled: readonly string[]
  /** 102D — the live version of the `experiments` policy (tenant_policy_versions, lib/kernel/tenant-policy.ts
   *  currentPolicyVersion): 0 = never changed through the versioned writer; null = the version read was refused. */
  version?: number | null
  /** Wave 108 (108F) — the experiment CLASSES a human allowed to DEPLOY autonomously
   *  (settings.experiments.autonomous_classes; lib/kernel/experiment-pipeline.ts EXPERIMENT_CLASSES).
   *  DEFAULT NONE: absent / unreadable = every experiment waits for a human. */
  autonomousClasses?: readonly string[]
  /** Wave 108 (108F) — PROMOTED experiments: the winning arm now serves the whole cohort
   *  (settings.experiments.adopted[<experiment key>] = { arm, control_sequence_id, treatment_sequence_id }),
   *  written only by the proposal promotion (improvement-proposals.ts applyChange → mergeBrokerageSettings). */
  adopted?: Readonly<Record<string, { arm: string; control_sequence_id?: string | null; treatment_sequence_id?: string | null; contact_types?: string[] | null }>>
}

/** The registered tenant policy key the kill switch lives under (TENANT_POLICY_SETTINGS_KEYS). */
export const EXPERIMENTS_POLICY_KEY = "experiments"

/** PURE. The tenant's experiment policy from brokerage_settings.settings (any shape; unknown → on). */
function experimentPolicyFromSettings(settings: unknown): ExperimentPolicy {
  const exp = (settings && typeof settings === "object" ? (settings as Record<string, unknown>).experiments : null) as Record<string, unknown> | null | undefined
  if (!exp || typeof exp !== "object") return { readable: true, killSwitch: false, disabled: [], version: null, autonomousClasses: [], adopted: {} }
  const adopted = exp.adopted && typeof exp.adopted === "object" && !Array.isArray(exp.adopted) ? (exp.adopted as ExperimentPolicy["adopted"]) : {}
  return {
    readable: true,
    killSwitch: exp.kill_switch === true,
    disabled: Array.isArray(exp.disabled) ? exp.disabled.map(String) : [],
    version: null,
    autonomousClasses: Array.isArray(exp.autonomous_classes) ? exp.autonomous_classes.map(String) : [],
    adopted,
  }
}

/**
 * PURE — THE assignment. Deterministic over (brokerageId, subjectId, instance key).
 *   · `provided` (a valid arm a human chose) wins;
 *   · instance off (e.g. a sequence that is not is_ab_test) → no experiment (null);
 *   · policy unreadable / kill switch / this definition disabled → CONTROL, with the reason;
 *   · no subject to hash → CONTROL (an unhashable subject is never randomised).
 */
export function assignExperimentArm(input: {
  definition: ExperimentDefinition
  brokerageId: string
  subjectId: string | null | undefined
  instance?: string | null
  instanceOn: boolean
  policy: ExperimentPolicy
  provided?: string | null
}): ExperimentAssignment | null {
  const d = input.definition
  const key = input.instance ? `${d.key}:${input.instance}` : d.key
  const armKeys = d.arms.map((a) => a.key)
  if (input.provided && armKeys.includes(input.provided)) {
    return { key, arm: input.provided, control: input.provided === d.control, reason: "provided" }
  }
  if (!input.instanceOn) return null
  const control = (reason: AssignmentReason): ExperimentAssignment => ({ key, arm: d.control, control: true, reason })
  if (!input.policy.readable) return control("policy_unreadable")
  if (input.policy.killSwitch) return control("kill_switch")
  if (input.policy.disabled.includes(d.key) || input.policy.disabled.includes(key)) return control("disabled")
  if (!input.brokerageId || !input.subjectId) return control("no_subject")
  const total = d.arms.reduce((s, a) => s + (a.weight > 0 ? a.weight : 0), 0)
  if (!(total > 0)) return control("disabled")
  const u = stableUnit(input.brokerageId, input.subjectId, key) * total
  let acc = 0
  for (const a of d.arms) {
    if (!(a.weight > 0)) continue
    acc += a.weight
    if (u < acc) return { key, arm: a.key, control: a.key === d.control, reason: "assigned" }
  }
  const last = [...d.arms].reverse().find((a) => a.weight > 0)!
  return { key, arm: last.key, control: last.key === d.control, reason: "assigned" }
}

/** The ledger `detail` fragment for an assignment — `detail.experiment = { key, arm }` is what
 *  lib/intelligence/roi-ledger.ts attributeOutcomesToLedger rolls up as byExperimentArm. */
export function experimentLedgerDetail(a: { key: string; arm: string } | null | undefined): { experiment?: { key: string; arm: string } } {
  return a && a.key && a.arm ? { experiment: { key: a.key, arm: a.arm } } : {}
}

/**
 * The ONE read of the tenant's experiment policy (brokerage_settings.settings.experiments). The
 * caller passes a client it has already gated / a service client on a server path. FAIL CLOSED: a
 * refused read returns readable:false, which assigns control everywhere.
 */
export async function loadExperimentPolicy(svc: { from: (t: string) => any }, brokerageId: string): Promise<ExperimentPolicy> {
  if (!brokerageId) return { readable: false, killSwitch: true, disabled: [], version: null }
  try {
    const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { readable: false, killSwitch: true, disabled: [], version: null }
    const policy = experimentPolicyFromSettings((data as { settings?: unknown } | null)?.settings ?? null)
    // 102D — the version rides with the value so a ledger row can say `experiments@<n>` (dynamic
    // import: this module is reachable from a client bundle through ab-variant.ts).
    const { currentPolicyVersion } = await import("@/lib/kernel/tenant-policy")
    const v = await currentPolicyVersion(svc, brokerageId, EXPERIMENTS_POLICY_KEY)
    return { ...policy, version: v.ok ? v.version : null }
  } catch {
    return { readable: false, killSwitch: true, disabled: [], version: null }
  }
}
