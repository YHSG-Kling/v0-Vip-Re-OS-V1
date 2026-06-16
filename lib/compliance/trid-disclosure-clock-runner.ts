// lib/compliance/trid-disclosure-clock-runner.ts
//
// Live side of the TRID DISCLOSURE CLOCK. Scans active deals' trid_timeline rows, computes
// the FORWARD-LOOKING disclosure deadlines, and on an approaching-but-undelivered (at_risk)
// or already-missed (violation) Closing-Disclosure / Loan-Estimate deadline, sets the
// long-unused trid_timeline.compliance_status = 'at_risk' and fires ONE gated Deal-Coordinator
// alert + an inter-manager bus signal (deal_coordinator → data_steward, the compliance owner)
// so the closing doesn't slip. Idempotent: escalates only when the forward status TRANSITIONS
// (never re-pings the same standing state). Complements — does not replace — the post-hoc
// monitorTRIDComplianceService. Read-mostly; the only write is the status flag + alerts.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { computeTridClock, mostUrgentDeadline, type TridClockResult } from "./trid-disclosure-clock"
import { generatePersonaCopy, type CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

export interface TridClockRunInput {
  brokerageId: string
  /** horizon: only deals closing within this many days are worth the forward clock */
  withinDays?: number
  /** injectable "today" for deterministic runs */
  today?: string
  copyGenerator?: CopyGenerator
  escalate?: boolean
}

export interface TridClockRunResult {
  scanned: number
  flagged: number
  escalated: number
}

export interface SingleClockResult { result: TridClockResult; escalated: boolean; transitioned: boolean }

/** Map the forward clock verdict to the trid_timeline.compliance_status enum (it already
 *  carries 'at_risk' and 'violation'; we never downgrade a standing 'violation'/'closed'). */
function statusForVerdict(overall: TridClockResult["overall"], prior: string | null): string | null {
  if (overall === "violation") return "violation"
  if (overall === "at_risk") return prior === "violation" ? "violation" : "at_risk"
  return null // ok/insufficient → leave whatever the post-hoc monitor set
}

export async function runTridClockForTimeline(
  input: { brokerageId: string; timeline: any; today: string; copyGenerator?: CopyGenerator; escalate?: boolean },
  svc: Svc,
): Promise<SingleClockResult> {
  const tl = input.timeline
  const result = computeTridClock({
    today: input.today,
    loanApplicationDate: tl.loan_application_date ?? null,
    loanEstimateDeliveredDate: tl.loan_estimate_delivered_date ?? null,
    closingDisclosureDeliveredDate: tl.closing_disclosure_delivered_date ?? null,
    scheduledCloseDate: tl.scheduled_close_date ?? null,
  })

  if (!result.flagged || input.escalate === false) return { result, escalated: false, transitioned: false }

  const prior: string | null = tl.compliance_status ?? null
  const nextStatus = statusForVerdict(result.overall, prior)
  // TRANSITION = the standing status actually changes (idempotent: no re-ping of a held state).
  const transitioned = nextStatus != null && nextStatus !== prior
  if (!transitioned) return { result, escalated: false, transitioned: false }

  // Flip the long-unused forward status so the dashboard + post-hoc monitor agree.
  await svc.from("trid_timeline").update({ compliance_status: nextStatus }).eq("id", tl.id).then(() => {}, () => {})

  const urgent = mostUrgentDeadline(result)
  const fallback = urgent
    ? `${urgent.message}`
    : `A TRID disclosure deadline on this deal needs attention before closing.`

  const draft = await generatePersonaCopy(
    {
      goal: "a short internal alert to the deal coordinator that a TRID disclosure deadline (Closing Disclosure or Loan Estimate) is approaching or missed and action is needed to keep the closing on schedule",
      facts: [
        urgent ? urgent.message : "",
        urgent?.dueBy ? `Deadline: ${urgent.dueBy}` : "",
      ].filter(Boolean) as string[],
      channel: "portal",
      persona: { audience: "agent", situation: "TRID disclosure deadline approaching" },
      words: 55,
    },
    { body: fallback },
    { generator: input.copyGenerator },
  )

  let escalated = false
  try {
    const agentUserId = tl.transactions?.agent_id ?? null
    if (agentUserId) {
      await svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: input.brokerageId, type: "trid_disclosure_clock",
        title: result.overall === "violation" ? "⛔ TRID disclosure deadline missed — closing at risk" : "⏳ TRID disclosure deadline approaching",
        body: draft.body, entity_type: "transaction", entity_id: tl.transaction_id,
        priority: result.overall === "violation" ? "critical" : "high",
      }).then(() => {}, () => {})
    }
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const sig = await publishManagerSignal({
      brokerageId: input.brokerageId, fromManager: "deal_coordinator", toManager: "data_steward",
      signalType: "trid_disclosure_clock", message: draft.body,
      entityType: "transaction", entityId: tl.transaction_id,
      payload: { overall: result.overall, deadlines: result.deadlines.map((d) => ({ kind: d.kind, status: d.status, dueBy: d.dueBy, bdRemaining: d.businessDaysRemaining })) },
    }, svc)
    escalated = sig.ok || !!agentUserId
  } catch { /* escalation best-effort — the status flip still stands */ }

  return { result, escalated, transitioned: true }
}

/** Sweep a brokerage's active TRID timelines and escalate the forward-looking deadlines. */
export async function runTridDisclosureClock(input: TridClockRunInput, client?: Svc): Promise<TridClockRunResult> {
  const svc = client ?? createServiceClient()
  const today = input.today ?? new Date().toISOString().slice(0, 10)
  const horizon = new Date(Date.now() + (input.withinDays ?? 30) * 86_400_000).toISOString().slice(0, 10)
  const out: TridClockRunResult = { scanned: 0, flagged: 0, escalated: 0 }

  // Active deals closing within the horizon (or with an open loan-application clock).
  const { data: timelines } = await svc
    .from("trid_timeline")
    .select("id, transaction_id, compliance_status, loan_application_date, loan_estimate_delivered_date, closing_disclosure_delivered_date, scheduled_close_date, transactions(agent_id)")
    .eq("brokerage_id", input.brokerageId)
    .not("compliance_status", "in", "(closed)")
    .or(`scheduled_close_date.lte.${horizon},and(scheduled_close_date.is.null,loan_application_date.not.is.null)`)
    .limit(500)

  for (const tl of (timelines ?? []) as any[]) {
    out.scanned++
    const r = await runTridClockForTimeline(
      { brokerageId: input.brokerageId, timeline: tl, today, copyGenerator: input.copyGenerator, escalate: input.escalate },
      svc,
    )
    if (r.result.flagged) out.flagged++
    if (r.escalated) out.escalated++
  }

  return out
}
