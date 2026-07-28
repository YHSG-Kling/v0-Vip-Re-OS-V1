export {
  calculateFatigue,
  calculateAllBuyerFatigue,
} from "./fatigue-calculator"
export type { FatigueResult, FatigueFactors, RiskLevel } from "./fatigue-calculator"

// fatigue-scorer.ts was REMOVED. It was a second implementation of exactly this,
// writing the same two tables with a DIFFERENT risk vocabulary (watch/warning at
// 35/60/80) that the live CHECK on buyer_fatigue_scores.risk_level rejects — so
// every score in the 35-79 band failed to persist, silently. It also wrote
// engagement_trend 'slowing' and alert_type 'fatigue_warning'/'fatigue_critical',
// both rejected by their own CHECKs. calculateFatigue speaks the vocabulary the
// database actually admits.
export { generateRecoveryPlan } from "./recovery-generator"
