// lib/lead-pipeline/reactivation-cadence.ts
//
// Reactivation follow-up gate. The hand-built ladder planners that used to live here were
// CONSOLIDATED into the real campaign sequencer (lib/lead-pipeline/reactivation-sequence-installer
// + reactivation-enroller): reactivation is now a multi-channel campaign_sequence the step-executor
// drives, with de-confliction, the shared touch ledger, and response-driven stop for free. This
// module keeps only the pure follow-up gate the enroller still needs.

/**
 * Honor an explicit future-intent date: when a lead/contact asked to be reached "in 6 months",
 * the cadence must NOT nag them before that date arrives. Pure. Returns true while the scheduled
 * follow-up is still in the future (suppress enrollment); false once it's due or unset.
 */
export function followupSuppresses(nextFollowupAt: string | null | undefined, now: string): boolean {
  if (!nextFollowupAt) return false
  const t = new Date(nextFollowupAt).getTime()
  return Number.isFinite(t) && t > new Date(now).getTime()
}
