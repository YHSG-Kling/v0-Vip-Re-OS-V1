// lib/campaign-sequences/ab-variant.ts
//
// A/B VARIANT selection (pure) — the missing half of the self-improving copy loop. The schema
// always supported it (campaign_sequence_steps.ab_variant, sequence_enrollments.ab_variant,
// campaign_sequences.is_ab_test) and the executor READ the enrollment's variant — but never SPLIT
// on it, so variants never ran. These two pure functions make it operational with a minimal,
// behaviour-preserving hot-path change: assign a variant at enrollment, pick the matching step at
// execution. Non-A/B sequences are completely unchanged (single step row → returned as-is).

import { assignExperimentArm, EXPERIMENT_DEFINITIONS, type ExperimentPolicy } from "@/lib/kernel/experiments"

export type AbVariant = "A" | "B"

/**
 * Assign an enrollment's variant. Pure. Non-test sequences → null.
 * TOMBSTONE (wave 101, lane 101B — OWNER LAW 2): the Math.random() 50/50 split that lived here is
 * gone. Survivor: lib/kernel/experiments.ts assignExperimentArm — a STABLE hash of (brokerage,
 * recipient, `sequence_ab:<sequenceId>`) over the `sequence_ab` definition's weighted arms, so the
 * same person in the same sequence always lands in the same arm (replayable), and the tenant's
 * kill switch (brokerage_settings.settings.experiments) assigns control. `rand` was the test seam
 * for the random draw and has no meaning against a deterministic hash — removed with it.
 */
export function assignAbVariant(opts: {
  isAbTest?: boolean | null
  provided?: string | null
  brokerageId?: string | null
  recipientId?: string | null
  sequenceId?: string | null
  policy?: ExperimentPolicy
}): AbVariant | null {
  const a = assignExperimentArm({
    definition: EXPERIMENT_DEFINITIONS.sequence_ab,
    brokerageId: opts.brokerageId ?? "",
    subjectId: opts.recipientId ?? null,
    instance: opts.sequenceId ?? null,
    instanceOn: !!opts.isAbTest,
    // No policy passed = the caller could not read one → control (fail closed).
    policy: opts.policy ?? { readable: false, killSwitch: true, disabled: [] },
    provided: opts.provided ?? null,
  })
  return a && (a.arm === "A" || a.arm === "B") ? a.arm : null
}

/**
 * Pick the step row matching the enrollment's variant. Pure + behaviour-preserving:
 *  - 0 rows → null
 *  - 1 row → that row (the overwhelming common case: no A/B → unchanged)
 *  - many rows → the one whose ab_variant matches; else the control (null/'A'); else the first.
 */
export function pickStepVariant<T extends { ab_variant?: string | null }>(
  steps: T[] | null | undefined,
  abVariant: string | null | undefined,
): T | null {
  if (!steps || steps.length === 0) return null
  if (steps.length === 1) return steps[0]
  if (abVariant === "A" || abVariant === "B") {
    const match = steps.find((s) => s.ab_variant === abVariant)
    if (match) return match
  }
  const control = steps.find((s) => !s.ab_variant || s.ab_variant === "A")
  return control ?? steps[0]
}
