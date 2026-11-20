"use client"

/**
 * <KernelPlanCard> — the Voice Command Center's binding of THE ONE AFFORDANCE (wave 148, lane 148D).
 *
 * MERGED (CLAUDE.md §1.1): this card was the kernel lane's human door — utterance → plan → confirm,
 * with the planner's `error` and the failed dispatches rendered rather than swallowed. Everything it did
 * now lives in app/components/shared/intent-affordance.tsx:IntentAffordance (the plan in words, the
 * confirmation turn, every refusal shown, nothing mutating without a yes) — which also speaks, asks for
 * missing information and reaches the whole OS through /api/agentic-os/voice (C17). The implementation
 * that was here is gone; this file keeps the page's import stable and binds the one component to the
 * voice_center screen. No second affordance exists.
 */

import { IntentAffordance } from "@/app/components/shared/intent-affordance"

export function KernelPlanCard() {
  return <IntentAffordance screen="voice_center" title="Say what you want the team to do" />
}
