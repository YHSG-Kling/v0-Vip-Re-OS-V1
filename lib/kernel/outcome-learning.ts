// lib/kernel/outcome-learning.ts
//
// OUTCOME LEARNING — the human's decisions tune the team. Every approve and reject on
// the gate is feedback; a team that ignores it is an automation, not a staff. This
// module closes the loop WITHOUT a new table: outcomes are computed from the gate's
// own history, and they gate INITIATIVE — a manager whose recent drafts keep getting
// rejected loses the right to take initiative until its work is trusted again
// (commands and scheduled duties continue; only UNASKED work pauses).
//
// PURITY RULE: only HUMAN decisions count. Machine actions — peer-review vetoes,
// team-play supersedes — are excluded, so a manager isn't punished for the system's
// own consolidation mechanics.
//
// NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

/** A manager needs at least this many HUMAN decisions before outcomes gate anything. */
export const MIN_DECISIONS = 10
/** Below this human-approval rate, initiative pauses. */
export const TRUST_THRESHOLD = 0.4

export interface ManagerOutcome {
  manager: string
  approved: number
  rejected: number
  decisions: number
  approvalRate: number
}

export interface DecidedProposal {
  agent_kind: string
  status: string
  approved_by: string | null
  send_error: string | null
}

/** Pure: score outcomes from decided proposals — HUMAN decisions only. */
export function scoreOutcomes(rows: DecidedProposal[]): Record<string, ManagerOutcome> {
  const out: Record<string, ManagerOutcome> = {}
  for (const r of rows) {
    const isMachineAction = (r.send_error ?? "").startsWith("vetoed by peer review")
      || (r.send_error ?? "").startsWith("superseded by team play")
    if (isMachineAction) continue
    const humanApproved = (r.status === "approved" || r.status === "sent") && !!r.approved_by
    const humanRejected = r.status === "rejected"
    if (!humanApproved && !humanRejected) continue
    const o = out[r.agent_kind] ?? { manager: r.agent_kind, approved: 0, rejected: 0, decisions: 0, approvalRate: 1 }
    if (humanApproved) o.approved += 1
    else o.rejected += 1
    o.decisions = o.approved + o.rejected
    o.approvalRate = o.decisions === 0 ? 1 : o.approved / o.decisions
    out[r.agent_kind] = o
  }
  return out
}

/** Pure: may this manager take INITIATIVE? Trusted until proven otherwise —
 *  only a real sample (≥ MIN_DECISIONS) below the threshold pauses it. */
export function isManagerTrusted(outcomes: Record<string, ManagerOutcome>, manager: ManagerKey): boolean {
  const o = outcomes[manager]
  if (!o || o.decisions < MIN_DECISIONS) return true
  return o.approvalRate >= TRUST_THRESHOLD
}

/** Pure: the human's spoken/typed rejection reasons per manager — DIRECTION, not just
 *  a score. Reads the 'agent feedback:' marker rejectClientMessage stores; machine
 *  markers never appear here. Most recent first, capped. */
export function summarizeRejectionFeedback(rows: DecidedProposal[], cap = 3): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const r of rows) {
    const fb = (r.send_error ?? "").startsWith("agent feedback: ") ? (r.send_error ?? "").slice("agent feedback: ".length) : null
    if (!fb || r.status !== "rejected") continue
    const list = out[r.agent_kind] ?? []
    if (list.length < cap) list.push(fb)
    out[r.agent_kind] = list
  }
  return out
}

/** Compute outcomes from the gate's recent history (last ~200 decided proposals). */
export async function computeManagerOutcomes(
  brokerageId: string, client?: Svc,
): Promise<Record<string, ManagerOutcome>> {
  const supabase = client ?? createServiceClient()
  const { data } = await supabase.from("agent_client_messages")
    .select("agent_kind, status, approved_by, send_error")
    .eq("brokerage_id", brokerageId).in("status", ["approved", "sent", "rejected"])
    .order("proposed_at", { ascending: false }).limit(200)
  return scoreOutcomes(((data ?? []) as DecidedProposal[]))
}

/** The trust meter's full payload: per-manager rates + the human's recent reasons. */
export async function computeManagerTrust(
  brokerageId: string, client?: Svc,
): Promise<{ outcomes: Record<string, ManagerOutcome>; feedback: Record<string, string[]> }> {
  const supabase = client ?? createServiceClient()
  const { data } = await supabase.from("agent_client_messages")
    .select("agent_kind, status, approved_by, send_error")
    .eq("brokerage_id", brokerageId).in("status", ["approved", "sent", "rejected"])
    .order("proposed_at", { ascending: false }).limit(200)
  const rows = (data ?? []) as DecidedProposal[]
  return { outcomes: scoreOutcomes(rows), feedback: summarizeRejectionFeedback(rows) }
}
