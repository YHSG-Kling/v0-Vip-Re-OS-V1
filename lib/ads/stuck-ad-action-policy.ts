// ─── STUCK-AD-ACTION POLICY (Ads Manager reaper) ─────────────────────────────
// Pure, import-free policy for the Ads Manager's "approved ad spend that never
// launched" failure. An ad_manager_actions row that a human APPROVED (the spend
// got the green light) but that was never executed — or that started executing
// and hung — is money/intent the brokerage authorized but never put to work. The
// proposed→approval step is covered by the Command Center queue; THIS catches the
// gap AFTER approval, where the launch silently failed.
//
// Pure → unit-testable (scripts/stuck-ad-action-reaper-simulator.ts).

// An approved ad action should execute within hours; past this it didn't launch.
export const AD_ACTION_STUCK_HOURS = 6

export type StuckAdActionAction = "keep" | "escalate"

// status CHECK = proposed | approved | executing | succeeded | failed | skipped.
// 'proposed' is awaiting approval (Command Center queue's job, not ours).
// succeeded/failed/skipped are terminal. Only approved/executing can get stuck.
const STUCKABLE = new Set(["approved", "executing"])

export interface StuckAdActionInput {
  status: string | null | undefined
  /** When the human approved the spend. */
  approvedAt: string | null | undefined
  /** Set once the action actually ran; null means it never launched. */
  executedAt: string | null | undefined
  /** Caller passes "now" so the policy stays deterministic/testable. */
  now: Date
}

export function classifyStuckAdAction(input: StuckAdActionInput): StuckAdActionAction {
  const status = (input.status ?? "").toLowerCase().trim()
  if (!STUCKABLE.has(status)) return "keep"
  if (input.executedAt) return "keep" // it ran — not stuck
  if (!input.approvedAt) return "keep" // can't age an approval we can't date

  const approved = Date.parse(input.approvedAt)
  if (Number.isNaN(approved)) return "keep"

  const graceMs = AD_ACTION_STUCK_HOURS * 60 * 60 * 1000
  return input.now.getTime() - approved > graceMs ? "escalate" : "keep"
}
