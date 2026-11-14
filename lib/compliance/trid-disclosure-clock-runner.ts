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

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
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
  /** WAVE 153 (lane 153C): deals whose receipt-ledger summary was synced, coaching tasks opened, syncs that could not run. */
  synced: number
  coachingOpened: number
  syncFailures: number
}

interface SingleClockResult { result: TridClockResult; escalated: boolean; transitioned: boolean }

/** Map the forward clock verdict to the trid_timeline.compliance_status enum (it already
 *  carries 'at_risk' and 'violation'; we never downgrade a standing 'violation'/'closed'). */
function statusForVerdict(overall: TridClockResult["overall"], prior: string | null): string | null {
  if (overall === "violation") return "violation"
  if (overall === "at_risk") return prior === "violation" ? "violation" : "at_risk"
  return null // ok/insufficient → leave whatever the post-hoc monitor set
}

// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
async function runTridClockForTimeline(
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
  await sentinelWrite(svc, svc.from("trid_timeline").update({ compliance_status: nextStatus }).eq("id", tl.id), { table: "trid_timeline", flow: "trid_forward_status", reason: "forward status flip for the dashboard; the escalation below runs regardless and a lost flip is ledgered" })

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
    // WAVE 152 (lane 152G) — CORRECTED: transactions.agent_id is an AGENTS id and notifications.user_id a USERS id (disjoint —
    // CLAUDE.md §3, 23503). The bell used the agents id as the user, so every TRID alert was refused by the FK (or reached nobody).
    // Cross via agents.user_id, tenant-pinned; a refused read rings no bell and says so (the bus signal below still carries it).
    const agentRecordId = (tl.transactions?.agent_id as string | null | undefined) ?? null
    let agentUserId: string | null = null
    if (agentRecordId) {
      const { data: agentRow, error: agentErr } = await svc.from("agents").select("user_id").eq("id", agentRecordId).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (agentErr) console.error(`[trid-clock] the deal's agent could not be resolved to a user (${agentErr.message}) — no bell; the deal coordinator signal still goes`)
      agentUserId = ((agentRow as { user_id?: string | null } | null)?.user_id as string | null) ?? null
    }
    if (agentUserId) {
      await sentinelWrite(svc, svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: input.brokerageId, type: "trid_disclosure_clock",
        title: result.overall === "violation" ? "⛔ TRID disclosure deadline missed — closing at risk" : "⏳ TRID disclosure deadline approaching",
        body: draft.body, entity_type: "transaction", entity_id: tl.transaction_id,
        priority: result.overall === "violation" ? "critical" : "high",
      }), { table: "notifications", flow: "trid_disclosure_clock_runner_notify", brokerageId: input.brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
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
  const out: TridClockRunResult = { scanned: 0, flagged: 0, escalated: 0, synced: 0, coachingOpened: 0, syncFailures: 0 }

  // Active deals closing within the horizon (or with an open loan-application clock).
  const { data: timelines } = await svc
    .from("trid_timeline")
    .select("id, transaction_id, compliance_status, loan_application_date, loan_estimate_delivered_date, closing_disclosure_delivered_date, scheduled_close_date, transactions(agent_id)")
    .eq("brokerage_id", input.brokerageId)
    .not("compliance_status", "in", "(closed)")
    .or(`scheduled_close_date.lte.${horizon},and(scheduled_close_date.is.null,loan_application_date.not.is.null)`)
    .limit(500)

  const swept = new Set<string>()
  for (const tl of (timelines ?? []) as any[]) {
    out.scanned++
    const r = await runTridClockForTimeline(
      { brokerageId: input.brokerageId, timeline: tl, today, copyGenerator: input.copyGenerator, escalate: input.escalate },
      svc,
    )
    if (r.result.flagged) out.flagged++
    if (r.escalated) out.escalated++
    if (tl.transaction_id) swept.add(String(tl.transaction_id))
  }

  // WAVE 153 (lane 153C) — THE RECEIPT LEDGER RIDES THIS SWEEP (no new cron). For every deal above AND every financed deal closing
  // inside the horizon that has no timeline yet, bring the existing readers in line with the ledger (lib/compliance/
  // trid-disclosure-clock-evidence.ts syncTridSummary): the verified receipt mirror, the seeded `trid_timing` compliance row the
  // closing gate reads, and — when the lender is NOT on the platform — the agent / TC coaching task ("Confirm with the lender
  // when the buyer received the initial Closing Disclosure …"). A sync that cannot run is counted, never reported as clean.
  const { data: financed, error: finErr } = await svc
    .from("transactions")
    .select("id, financing_type")
    .eq("brokerage_id", input.brokerageId)
    .in("status", ["under_contract", "pending", "active", "clear_to_close"])
    .gte("close_date", today)
    .lte("close_date", horizon)
    .limit(500)
  if (finErr) { console.error(`[trid-clock] financed deals could not be read (${finErr.message}) — only timelines were synced`); out.syncFailures++ }
  const { financingKindFor } = await import("@/lib/compliance/checklist-dimensions")
  for (const t of (financed ?? []) as Array<{ id: string; financing_type: string | null }>) {
    if (financingKindFor(t.financing_type) === "financed") swept.add(t.id)
  }
  const { syncTridSummary } = await import("./trid-disclosure-clock-evidence")
  // The lender-required INSURANCE checkpoint is time-driven too (it becomes due around the appraisal deadline by the tenant's
  // setting), so the same financed-deal sweep re-settles it (lib/transactions/lender-insurance-checkpoint.ts) — no second cron.
  const { syncLenderInsuranceCheckpoint } = await import("@/lib/transactions/lender-insurance-checkpoint")
  for (const transactionId of swept) {
    const s = await syncTridSummary(svc as any, { brokerageId: input.brokerageId, transactionId, today })
    if (!s.ok) { out.syncFailures++; console.error(`[trid-clock] receipt-ledger sync for ${transactionId} could not run: ${s.error}`) }
    else { out.synced++; out.coachingOpened += s.coachingOpened }
    const ins = await syncLenderInsuranceCheckpoint(svc as any, { brokerageId: input.brokerageId, transactionId, today })
    if (!ins.ok) { out.syncFailures++; console.error(`[trid-clock] insurance checkpoint sync for ${transactionId} could not run: ${ins.error}`) }
  }

  return out
}
