// ─── CONVERSATION HANDLING ────────────────────────────────────────────────────
// Inbound email orchestration lives in app/actions/ai-isa/handle-inbound-email.ts.
// This module re-exports only the helpers that flow uses.
export {
  shouldStopAutoResponding,
  haltEngagementForNegativeReply,
  detectNegativeIntent,
} from './conversation-handler'

export { buildISATools } from './tools'
export type { ISAToolContext } from './tools'

// ─── EMAIL GENERATION ─────────────────────────────────────────────────────────
export {
  generatePersonalizedEmail,
  logEmailActivity,
} from './email-generator'
export type { LeadEmailContext } from './email-generator'

// ─── VIDEO (email embed seam; generateAvatarVideo removed — superseded by the Director rail) ──
export {
  embedVideoInEmail,
} from './video-generator'

// ─── DIRECT MAIL ──────────────────────────────────────────────────────────────
export {
  shouldTriggerDirectMail,
  triggerDirectMailCampaign,
} from './direct-mail-trigger'
export type { DirectMailContext } from './direct-mail-trigger'

// ─── QUALIFICATION ────────────────────────────────────────────────────────────
export {
  evaluateLeadQualification,
  persistQualificationSignals,
} from './qualification-evaluator'
export type { QualificationSignals } from './qualification-evaluator'
