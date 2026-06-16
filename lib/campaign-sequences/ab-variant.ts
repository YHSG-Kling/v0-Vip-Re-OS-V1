// lib/campaign-sequences/ab-variant.ts
//
// A/B VARIANT selection (pure) — the missing half of the self-improving copy loop. The schema
// always supported it (campaign_sequence_steps.ab_variant, sequence_enrollments.ab_variant,
// campaign_sequences.is_ab_test) and the executor READ the enrollment's variant — but never SPLIT
// on it, so variants never ran. These two pure functions make it operational with a minimal,
// behaviour-preserving hot-path change: assign a variant at enrollment, pick the matching step at
// execution. Non-A/B sequences are completely unchanged (single step row → returned as-is).

export type AbVariant = "A" | "B"

/** Assign an enrollment's variant. Pure (rng injectable for tests). Non-test sequences → null. */
export function assignAbVariant(opts: { isAbTest?: boolean | null; provided?: string | null; rand?: number }): AbVariant | null {
  if (opts.provided === "A" || opts.provided === "B") return opts.provided
  if (!opts.isAbTest) return null
  const r = typeof opts.rand === "number" ? opts.rand : Math.random()
  return r < 0.5 ? "A" : "B"
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
