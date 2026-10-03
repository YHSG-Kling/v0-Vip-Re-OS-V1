/**
 * lib/onboarding/step-categories.ts
 *
 * THE TENANT COULD NOT SAVE AN ONBOARDING STEP.
 *
 * This is the same defect lib/knowledge/help-topic-categories.ts documents, one
 * table over. The curriculum editor (app/dashboard/admin/onboarding/
 * onboarding-curriculum-editor.tsx) and its server action
 * (app/actions/admin/onboarding-steps.ts) each hard-coded their OWN list:
 *
 *     license, compliance, tech, training, practice, brand, other
 *
 * The live CHECK on onboarding_steps.category admits a different set entirely:
 *
 *     system_setup, training, practice, compliance, certification
 *
 * Only training / practice / compliance appear in both, so FOUR of the seven
 * options an admin could pick were refused by the database. Verified live, as the
 * brokerage admin, inside a rolled-back transaction:
 *
 *     insert into onboarding_steps (…, category) values (…, 'license');
 *     ERROR: 23514 … violates check constraint "onboarding_steps_category_check"
 *     insert into onboarding_steps (…, category) values (…, 'tech');
 *     ERROR: 23514 … violates check constraint "onboarding_steps_category_check"
 *
 * The OTHER authoring surface for the same table
 * (app/dashboard/admin/onboarding-steps/OnboardingStepsClient.tsx) already used
 * the correct five. Both are reachable from the nav (app/config/navigation-config.ts
 * lines 445 and 453), so a tenant admin's success depended on which of the two
 * screens they happened to open. This module is now the ONE list.
 *
 * Client-safe (no `server-only`) so the picker imports it directly rather than
 * keeping a third copy — a hand-maintained vocabulary next to a CHECK constraint
 * is how the drift got in.
 *
 * MIRRORS the live onboarding_steps_category_check. Adding a member here without
 * the migration produces a value the database refuses.
 */

export type OnboardingStepCategory =
  | "system_setup"
  | "training"
  | "practice"
  | "compliance"
  | "certification"

/** Every storable category, in the order a picker should offer them. */
export const ONBOARDING_STEP_CATEGORIES: OnboardingStepCategory[] = [
  "system_setup",
  "training",
  "practice",
  "compliance",
  "certification",
]

/** Human labels — the raw column value is not reader-friendly. */
export const ONBOARDING_STEP_CATEGORY_LABEL: Record<OnboardingStepCategory, string> = {
  system_setup:  "System Setup",
  training:      "Training",
  practice:      "Practice",
  compliance:    "Compliance",
  certification: "Certification",
}

/** Label a raw column value without trusting it to be in the union. */
export function onboardingStepCategoryLabel(value: string | null | undefined): string {
  if (!value) return "Uncategorised"
  return ONBOARDING_STEP_CATEGORY_LABEL[value as OnboardingStepCategory] ?? value
}

/** Is this value actually storable? Use before a write, not after. */
export function isStorableOnboardingStepCategory(value: string): value is OnboardingStepCategory {
  return (ONBOARDING_STEP_CATEGORIES as string[]).includes(value)
}

/**
 * The live CHECKs on the two integer columns, mirrored so the form and the
 * action agree with the database instead of surfacing a raw 23514:
 *
 *     onboarding_steps_day_number_check  CHECK (day_number >= 1 AND day_number <= 7)
 *     onboarding_steps_step_order_check  CHECK (step_order >= 1)
 *
 * The curriculum editor's blank form defaulted stepOrder to "0" and the action
 * fell back to 0 when the field was absent, so a freshly-opened create form
 * failed on the FIRST save with
 *   `violates check constraint "onboarding_steps_step_order_check"`
 * no matter what else the admin typed. day_number had a `min={1}` on the input
 * but no maximum, so day 8 reached the database and was refused.
 */
export const ONBOARDING_STEP_DAY_MIN = 1
export const ONBOARDING_STEP_DAY_MAX = 7
export const ONBOARDING_STEP_ORDER_MIN = 1

/** Clamp a day number into the range the CHECK accepts. */
export function clampOnboardingStepDay(value: number): number {
  if (!Number.isFinite(value)) return ONBOARDING_STEP_DAY_MIN
  return Math.min(ONBOARDING_STEP_DAY_MAX, Math.max(ONBOARDING_STEP_DAY_MIN, Math.floor(value)))
}

/** Clamp a step order into the range the CHECK accepts (1-based, never 0). */
export function clampOnboardingStepOrder(value: number): number {
  if (!Number.isFinite(value)) return ONBOARDING_STEP_ORDER_MIN
  return Math.max(ONBOARDING_STEP_ORDER_MIN, Math.floor(value))
}
