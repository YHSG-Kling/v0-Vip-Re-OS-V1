// ─── CONVERSATION HANDLING ────────────────────────────────────────────────────
export {
  handleInboundEmailReply,
  shouldStopAutoResponding,
} from './conversation-handler'
export type { InboundEmailContext } from './conversation-handler'

// ─── EMAIL GENERATION ─────────────────────────────────────────────────────────
export {
  generatePersonalizedEmail,
  logEmailActivity,
} from './email-generator'
export type { LeadEmailContext } from './email-generator'

// ─── VIDEO GENERATION ─────────────────────────────────────────────────────────
export {
  generateHeyGenVideo,
  embedVideoInEmail,
} from './video-generator'
export type { VideoGenerationContext } from './video-generator'

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
