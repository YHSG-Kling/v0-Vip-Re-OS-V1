"use client"

/**
 * Contact OS barrel — re-exports all 10 canonical panel implementations.
 * Each component lives in its own file; this file is the single import surface
 * for app/crm/page.tsx and any other consumer.
 */

export { ContactCommandStrip } from "./contact-command-strip"
export { RelationshipRadar } from "./relationship-radar"
export { CommunicationHealthPanel } from "./communication-health-panel"
export { NextBestActionPanel } from "./next-best-action-panel"
export { ValueDeliveredPanel } from "./value-delivered-panel"
export { ReferralLikelihoodPanel } from "./referral-likelihood-panel"
export { TimelineContextPanel } from "./timeline-context-panel"
export { RelationshipAiChatPanel } from "./relationship-ai-chat-panel"
export { SmartNoteComposer } from "./smart-note-composer"
export { BuyerMatchPanel } from "./buyer-match-panel"
