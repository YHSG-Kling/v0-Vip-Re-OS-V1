// lib/intelligence/spoken-ai-receipt.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SPOKEN ACTION RECEIPT (approved item 2) — what makes delegation trusted.
// The voice admin doesn't just take commands; asked "what did you do?", it
// answers from the REAL ledgers — the same rows the morning briefing and the
// Command Center read — never from a model's imagination.
//
// Pure composer: fold the counts into one natural spoken paragraph. Honest
// empty when nothing happened. The loader lives with the voice assistant; this
// module stays pure so the simulator can assert the exact sentences.

import type { OvernightAiWorkSection } from "./overnight-ai-work"

export interface AiReceiptFacts {
  /** Overnight autonomous-systems section (no-shows, reels, sentinel). */
  overnight: OvernightAiWorkSection | null
  /** ISA qualified-lead handoffs assigned to this agent in the window. */
  isaHandoffs: number
  /** ISA outreach touches (email / direct mail / video / social) in the window. */
  isaOutreach: number
  /** AI message drafts staged for the agent's approval in the window. */
  draftsStaged: number
  /** Lookback label spoken back, e.g. "the last 24 hours". */
  windowLabel: string
}

/** PURE: one spoken paragraph, most consequential item first, honest empty. */
export function composeSpokenAiReceipt(f: AiReceiptFacts): string {
  const parts: string[] = []
  if (f.isaHandoffs > 0) {
    parts.push(`your ISA qualified and handed you ${f.isaHandoffs} lead${f.isaHandoffs === 1 ? "" : "s"}`)
  }
  if (f.isaOutreach > 0) {
    parts.push(`sent ${f.isaOutreach} outreach touch${f.isaOutreach === 1 ? "" : "es"} to leads in qualification`)
  }
  if (f.draftsStaged > 0) {
    parts.push(`staged ${f.draftsStaged} message draft${f.draftsStaged === 1 ? "" : "s"} for your approval`)
  }
  if (f.overnight?.noshows_to_rebook) {
    parts.push(`flagged ${f.overnight.noshows_to_rebook} missed appointment${f.overnight.noshows_to_rebook === 1 ? "" : "s"} for a re-book`)
  }
  if (f.overnight?.reels_awaiting_approval) {
    parts.push(`produced ${f.overnight.reels_awaiting_approval} reel${f.overnight.reels_awaiting_approval === 1 ? "" : "s"} awaiting your approval`)
  }
  if (f.overnight?.sentinel_escalations) {
    parts.push(`escalated ${f.overnight.sentinel_escalations} compliance item${f.overnight.sentinel_escalations === 1 ? "" : "s"} that need a human`)
  }
  if (parts.length === 0) {
    return `Nothing to report — the team ran clean over ${f.windowLabel} with no items needing your attention.`
  }
  const body =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`
  return `Over ${f.windowLabel}, ${body}. Everything is on the ledgers if you want the details.`
}
