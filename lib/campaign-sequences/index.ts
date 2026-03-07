/**
 * lib/campaign-sequences/index.ts
 *
 * Single entry point for the campaign sequence engine.
 * Import from '@/lib/campaign-sequences' — never from individual files outside this layer.
 */

export { checkSequenceAuthority } from "./compliance-gate"
export { executeSequenceStep } from "./step-executor"
export {
  enrollContact,
  pauseEnrollment,
  resumeEnrollment,
  unenrollContact,
} from "./enrollment-engine"

export type { EnrollContactParams, EnrollResult } from "./enrollment-engine"
