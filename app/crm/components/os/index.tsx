// TOMBSTONE (orphan doctrine §1.1, lane R3-B 2026-09-03): ContactCommandStrip
// (./contact-command-strip.tsx, DELETED) was a superseded duplicate rendered by
// nobody — the only mentions were prose. Survivor: ContactHeaderCard,
// app/crm/components/contact-header-card.tsx (its header :3-17 says "Replaces
// ContactCommandStrip"), mounted at app/crm/page.tsx:1257. The survivor is a
// strict superset: share-to-social, churn warning, suppression toggles,
// persona/stage badges, and Call/SMS/Portal/Note actions that log to
// activities. Nothing was merged back because nothing was missing.
export { ContactPulsePanel } from "./contact-pulse-panel"
export { RelationshipRadar } from "./relationship-radar"
export { CommunicationHealthPanel } from "./communication-health-panel"
export { NextBestActionPanel } from "./next-best-action-panel"
export { ValueDeliveredPanel } from "./value-delivered-panel"
export { ReferralLikelihoodPanel } from "./referral-likelihood-panel"
export { TimelineContextPanel } from "./timeline-context-panel"
export { RelationshipAiChatPanel } from "./relationship-ai-chat-panel"
export { SmartNoteComposer } from "./smart-note-composer"
export { BuyerMatchPanel } from "./buyer-match-panel"
export { PropertyAlertsPanel } from "./property-alerts-panel"
export { QualificationSummaryCard } from "./qualification-summary-card"
// Orphan burn-down (Lane A): the surface for
// app/actions/ai-lead-nurturing.ts:aiPredictConversion, the only
// conversion-probability writer an agent can actually read back.
export { ConversionForecastPanel } from "./conversion-forecast-panel"
export type { IsaHandoffBriefShape } from "./qualification-summary-card"
