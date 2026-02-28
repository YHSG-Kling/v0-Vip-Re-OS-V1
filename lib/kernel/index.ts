// lib/kernel/index.ts
// Single entry-point for the kernel layer.
// Import from '@/lib/kernel' — never from individual kernel files outside this layer.
// No default exports.

export { transitionLifecycle } from "./lifecycle"
export { evaluateOutbound } from "./compliance"
export { applyBrandVoice } from "./brand-voice"
export { resolveProvider } from "./providers"
export { getEducationDelivery, getEducationPlan } from "./education"
export { getPortalMilestones, getLifetimeTrack } from "./portal"

export type {
  Persona,
  MessageType,
  ProviderType,
  EducationFormat,
  ActorRole,
  EntityType,
  JourneyPhase,
  BuyerStage,
  SellerStage,
  TransitionLifecycleParams,
  EvaluateOutboundParams,
  ComplianceResult,
} from "./types"
