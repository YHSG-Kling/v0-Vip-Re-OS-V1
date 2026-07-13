/**
 * lib/kernel/service-recovery.ts
 *
 * SERVICE-RECOVERY PLAYBOOKS (concierge: "apology, explanation, workaround,
 * and follow-up built into the workflow" — with DISTINCT framing per
 * failure type, because a vendor no-show and a system hiccup deserve
 * different apologies). PURE composer: failure kind in → the recovery
 * packet out (acknowledge → explain plainly → the corrective step → the
 * follow-up promise). First live trigger: FAILED SENDS on the client
 * message rail (agent_client_messages.send_error) surface in the morning
 * briefing with the recovery already drafted — a failed touch the client
 * never knew about still gets a human check, and one they noticed gets a
 * real apology. NOT server-only (simulator-driven).
 */

import type { PriorityAction } from "@/lib/intelligence/daily-briefing-generator"

export type FailureKind = "send_failure" | "vendor_no_show" | "system_outage" | "missed_followup" | "agent_oversight"

const PLAYBOOKS: Record<FailureKind, { ack: string; corrective: string; followUp: string }> = {
  send_failure: {
    ack: "A message we meant to send you didn't go through on our side",
    corrective: "I'm sending it again right now by a channel that works",
    followUp: "and I'll confirm you got it",
  },
  vendor_no_show: {
    ack: "The scheduled provider didn't show, and that's not the standard you should expect from us",
    corrective: "I've already lined up a replacement and I'm holding them to a firm window",
    followUp: "I'll be checking in until it's done",
  },
  system_outage: {
    ack: "Our systems hiccuped and a few updates didn't reach you",
    corrective: "everything is back up and I've re-checked your file end to end",
    followUp: "nothing was missed — and I'll flag anything that changes",
  },
  missed_followup: {
    ack: "I owed you a follow-up and it slipped — that's on me",
    corrective: "here it is now, with everything I promised",
    followUp: "and I've set a hard reminder so it doesn't happen again",
  },
  agent_oversight: {
    ack: "We got a detail wrong and I want to own that directly",
    corrective: "here's the correction and what I've done about it",
    followUp: "I'll walk you through it live if that's easier",
  },
}

/** PURE: the recovery packet for a failure — apology-first, plain, concrete. */
export function composeServiceRecovery(kind: FailureKind, addressAs: string): { draft: string } {
  const p = PLAYBOOKS[kind]
  return { draft: `${addressAs}, ${p.ack}. ${p.corrective}, ${p.followUp}. Thank you for your patience with us.` }
}

export interface FailedSendRow {
  contactId: string
  addressAs: string
  subject: string | null
  sendError: string | null
}

/** PURE: yesterday's failed sends → recovery actions for the briefing. */
export function composeRecoveryActions(rows: FailedSendRow[], limit = 3): PriorityAction[] {
  const seen = new Set<string>()
  const out: PriorityAction[] = []
  for (const r of rows) {
    if (seen.has(r.contactId)) continue
    seen.add(r.contactId)
    const { draft } = composeServiceRecovery("send_failure", r.addressAs)
    out.push({
      priority: "high",
      action: `Recover a failed send to ${r.addressAs}${r.subject ? ` ("${r.subject}")` : ""}`,
      context: `The send failed (${(r.sendError ?? "unknown error").slice(0, 120)}). Recovery draft: "${draft}" Re-send through a working channel and confirm receipt.`,
      manager: "sphere_of_influence",
      entity_type: "contact",
      entity_id: r.contactId,
      action_type: "draft_followup",
    })
    if (out.length >= limit) break
  }
  return out
}
