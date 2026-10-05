export {
  calculateFatigue,
  runFatigueSweep,
} from "./fatigue-calculator"
// TOMBSTONE (lane 87A): calculateAllBuyerFatigue — survivor runFatigueSweep
// (lib/fatigue/fatigue-calculator.ts), whose population is derived from the
// calculation's inputs rather than the active-buyer stage list.
export type { FatigueResult, FatigueFactors, RiskLevel, FatigueSweepResult } from "./fatigue-calculator"

// fatigue-scorer.ts was REMOVED. It was a second implementation of exactly this,
// writing the same two tables with a DIFFERENT risk vocabulary (watch/warning at
// 35/60/80) that the live CHECK on buyer_fatigue_scores.risk_level rejects — so
// every score in the 35-79 band failed to persist, silently. It also wrote
// engagement_trend 'slowing' and alert_type 'fatigue_warning'/'fatigue_critical',
// both rejected by their own CHECKs. calculateFatigue speaks the vocabulary the
// database actually admits.
export { generateRecoveryPlan } from "./recovery-generator"
// AGENT SCOPE — the after-hours-volume signal (wave 104, lane 104E), read by the retention radar.
export { afterHoursVolume, afterHoursSubScore, timeZoneForState, AFTER_HOURS_START_HOUR, AFTER_HOURS_END_HOUR, AFTER_HOURS_MIN_OUTBOUND, AFTER_HOURS_FULL_SHARE } from "./after-hours"
