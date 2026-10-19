// ─── CDA-DELIVERY REAPER (Deal Coordinator) ──────────────────────────────────
// Nothing-falls-through guard for fund disbursement: a CDA approved but never
// delivered to title (the best-effort send failed silently) is escalated to the
// responsible agent so title gets the disbursement authorization before closing —
// otherwise funds can't split correctly and the closing stalls. Pure policy in
// cda-delivery-policy.ts.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { classifyUndeliveredCda } from "./cda-delivery-policy"
import {
  CDA_DEADLINE_NOTIFICATION,
  cdaDeadlineVerdict,
  resolveCdaMode,
  resolveClosingDeadline,
  resolveTenantTimeZone,
} from "./cda-closing-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface CdaDeliveryReapResult {
  scanned: number
  escalated: number
}

export async function reapUndeliveredCdas(
  brokerageId: string,
  client?: Svc,
  opts?: { now?: Date; limit?: number },
): Promise<CdaDeliveryReapResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: CdaDeliveryReapResult = { scanned: 0, escalated: 0 }

  const { data: rows } = await svc
    .from("closing_disclosure_agreement")
    .select("id, status, sent_to_title_at, uses_cda, updated_at, transaction_id, agent_id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "approved")
    .is("sent_to_title_at", null)
    .limit(opts?.limit ?? 200)

  for (const row of (rows ?? []) as Array<{
    id: string; status: string | null; sent_to_title_at: string | null
    uses_cda: boolean | null; updated_at: string | null; transaction_id: string | null; agent_id: string | null
  }>) {
    result.scanned++
    if (classifyUndeliveredCda({ status: row.status, sentToTitleAt: row.sent_to_title_at, usesCda: row.uses_cda, updatedAt: row.updated_at, now }) !== "escalate") {
      continue
    }

    // Idempotent: one open alert per CDA.
    const { data: prior } = await svc
      .from("notifications")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("type", "cda_undelivered")
      .eq("entity_id", row.id)
      .eq("is_read", false)
      .limit(1)
    if (prior && prior.length > 0) continue

    const { resolveResponsibleAgentUserId } = await import("@/lib/intelligence/mobile-approval-queue")
    const agentUserId = await resolveResponsibleAgentUserId(svc, {
      recipient_contact_id: null,
      entity_type: "transaction",
      entity_id: row.transaction_id,
    })
    // closing_disclosure_agreement.agent_id is agents-class since m366 and
    // notifications.user_id FKs users, so the CDA's own agent is a RESOLVE, not a
    // fallback value. No users row behind it ⇒ the escalation is skipped with a
    // line naming the CDA, because a swallowed FK rejection here is invisible.
    let userId = agentUserId
    if (!userId && row.agent_id) {
      const { resolveUserIdForAgentRecord } = await import("@/lib/kernel/agent-identity")
      userId = await resolveUserIdForAgentRecord(svc, row.agent_id)
    }
    if (!userId) {
      console.warn(`[cda-delivery-reaper] no user to notify for CDA ${row.id} (agents.id=${row.agent_id ?? "null"}) — escalation skipped`)
      continue
    }

    await sentinelWrite(svc, svc.from("notifications").insert({
      user_id: userId,
      brokerage_id: brokerageId,
      type: "cda_undelivered",
      title: "💵 An approved CDA never reached title",
      body: "A Commission Disbursement Authorization was approved but never delivered to the title/escrow company — the send may have failed. Re-send it so funds can disburse correctly at closing.",
      entity_type: "closing_disclosure_agreement",
      entity_id: row.id,
      priority: "high",
      is_read: false,
    }), { table: "notifications", flow: "cda_delivery_reaper_notify", brokerageId: brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
    result.escalated++
  }

  return result
}

// ─── THE DEADLINE SWEEP (wave 142, lane 142C) ────────────────────────────────
// Owner: "signed approved CDA reaches title before/at scheduled closing date/time (tenant timezone;
// earlier brokerage/title requirements win) — reminders + immediate escalation to the registered
// owner." The sweep above catches an APPROVED CDA that never left; this one watches EVERY open CDA
// against the closing's deadline — drafting, submitted, awaiting signature or delivery alike — and
// rings 48h / 24h reminders to the agent + TC, then ESCALATES (≤ 12h or overdue) to the brokerage's
// admins and the finance manager's bus. Pure rule: cda-closing-policy.ts cdaDeadlineVerdict /
// resolveClosingDeadline / resolveTenantTimeZone. Idempotent per CDA + state (one open bell each).

/** The open CDA statuses a deadline applies to (every state before delivery). */
const OPEN_CDA_STATUSES = ["pending", "drafting", "submitted", "changes_requested", "approved"] as const

export interface CdaDeadlineReapResult {
  scanned: number
  reminded: number
  escalated: number
  /** The zone the deadlines were read in, and where it came from (a fallback is SAID). */
  zone: string
  zoneSource: string
  /** The brokerage does not run a CDA (offers_cda is not true) — nothing to sweep. */
  notApplicable: boolean
}

export async function reapCdaDeadlines(
  brokerageId: string,
  client?: Svc,
  opts?: { now?: Date; limit?: number },
): Promise<CdaDeadlineReapResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: CdaDeadlineReapResult = { scanned: 0, reminded: 0, escalated: 0, zone: "UTC", zoneSource: "fallback", notApplicable: false }

  const { data: brokerage, error: brkErr } = await svc
    .from("brokerages")
    .select("offers_cda, non_cda_payout_default, state")
    .eq("id", brokerageId)
    .maybeSingle()
  if (brkErr) { console.error(`[cda-deadline-reaper] brokerages read refused for ${brokerageId}: ${brkErr.message}`); return result }
  const b = brokerage as { offers_cda?: boolean | null; non_cda_payout_default?: string | null; state?: string | null } | null
  const mode = resolveCdaMode({ offersCda: b?.offers_cda, nonCdaPayoutDefault: b?.non_cda_payout_default })
  if (mode.mode !== "cda") { result.notApplicable = true; return result }
  const tz = resolveTenantTimeZone({ state: b?.state })
  result.zone = tz.zone
  result.zoneSource = tz.source

  const { data: rows, error: rowsErr } = await svc
    .from("closing_disclosure_agreement")
    .select("id, status, sent_to_title_at, uses_cda, transaction_id, agent_id")
    .eq("brokerage_id", brokerageId)
    .in("status", [...OPEN_CDA_STATUSES])
    .is("sent_to_title_at", null)
    .limit(opts?.limit ?? 200)
  if (rowsErr) { console.error(`[cda-deadline-reaper] CDA read refused: ${rowsErr.message}`); return result }
  const cdas = (rows ?? []) as Array<{ id: string; status: string | null; sent_to_title_at: string | null; uses_cda: boolean | null; transaction_id: string | null; agent_id: string | null }>
  const txnIds = Array.from(new Set(cdas.map((c) => c.transaction_id).filter((id): id is string => !!id)))
  if (txnIds.length === 0) return result

  const [{ data: txns }, { data: escrows }] = await Promise.all([
    svc.from("transactions").select("id, close_date, estimated_close_date, coordinator_id, property_address").eq("brokerage_id", brokerageId).in("id", txnIds),
    svc.from("transaction_title_escrow").select("transaction_id, closing_scheduled_date").eq("brokerage_id", brokerageId).in("transaction_id", txnIds),
  ])
  const txnById = new Map<string, { close_date: string | null; estimated_close_date: string | null; coordinator_id: string | null; property_address: string | null }>(
    ((txns ?? []) as Array<{ id: string; close_date: string | null; estimated_close_date: string | null; coordinator_id: string | null; property_address: string | null }>).map((t) => [t.id, t]),
  )
  const scheduledByTxn = new Map<string, string | null>(
    ((escrows ?? []) as Array<{ transaction_id: string; closing_scheduled_date: string | null }>).map((e) => [e.transaction_id, e.closing_scheduled_date]),
  )

  for (const cda of cdas) {
    result.scanned++
    const txn = cda.transaction_id ? txnById.get(cda.transaction_id) : undefined
    const deadline = resolveClosingDeadline({
      closingScheduledDate: cda.transaction_id ? scheduledByTxn.get(cda.transaction_id) ?? null : null,
      closeDate: txn?.close_date ?? null,
      estimatedCloseDate: txn?.estimated_close_date ?? null,
      timeZone: tz.zone,
    })
    const verdict = cdaDeadlineVerdict({ dueAt: deadline.dueAt, now, sentToTitleAt: cda.sent_to_title_at, status: cda.status, usesCda: cda.uses_cda })
    const type = CDA_DEADLINE_NOTIFICATION[verdict.state]
    if (!type) continue

    // Idempotent: one open bell per CDA per state.
    const { data: prior } = await svc
      .from("notifications")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("type", type)
      .eq("entity_id", cda.id)
      .eq("is_read", false)
      .limit(1)
    if (prior && prior.length > 0) continue

    // Recipients: the CDA's agent (agents.id → users.id, RESOLVED) and the TC.
    const recipients = new Set<string>()
    if (cda.agent_id) {
      const { resolveUserIdForAgentRecord } = await import("@/lib/kernel/agent-identity")
      const userId = await resolveUserIdForAgentRecord(svc, cda.agent_id)
      if (userId) recipients.add(userId)
    }
    if (txn?.coordinator_id) recipients.add(txn.coordinator_id)
    const where = txn?.property_address ? ` for ${txn.property_address}` : ""
    const dueLocal = deadline.dueAt ? new Date(deadline.dueAt).toLocaleString("en-US", { timeZone: tz.zone, dateStyle: "medium", timeStyle: "short" }) : "the scheduled closing"
    const body = verdict.state === "overdue"
      ? `The signed CDA${where} was due at title by ${dueLocal} (${tz.zone}) and has not been delivered (status: ${cda.status}). Title cannot disburse without it — finish and send it now.`
      : verdict.state === "escalate"
        ? `The signed, approved CDA${where} must reach title by ${dueLocal} (${tz.zone}) — about ${Math.max(0, Math.round(verdict.hoursRemaining ?? 0))}h left and it is still ${cda.status}. Finish the signatures and send it to title now.`
        : `The CDA${where} is due at title by ${dueLocal} (${tz.zone}) — about ${Math.round(verdict.hoursRemaining ?? 0)}h left (status: ${cda.status}).`
    const title = verdict.state === "overdue" ? "⏰ CDA overdue at title" : verdict.escalates ? "⏰ CDA due at title within hours" : "CDA due at title soon"
    for (const userId of recipients) {
      await sentinelWrite(svc, svc.from("notifications").insert({
        user_id: userId,
        brokerage_id: brokerageId,
        type,
        title,
        body,
        entity_type: "closing_disclosure_agreement",
        entity_id: cda.id,
        priority: verdict.escalates ? "critical" : "high",
        is_read: false,
      }), { table: "notifications", flow: "cda_deadline_reaper_notify", brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
    }
    if (verdict.escalates) {
      // IMMEDIATE ESCALATION to the registered owners: the brokerage's admins (the humans who can act)
      // and the finance manager's bus (deal_coordinator raises; finance_manager owns the closing money).
      try {
        const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
        await notifyBrokerageAdmins(svc as never, brokerageId, { type, title, body, entityType: "closing_disclosure_agreement", entityId: cda.id, priority: "high" })
      } catch (e) {
        console.error("[cda-deadline-reaper] admin escalation failed:", e instanceof Error ? e.message : String(e))
      }
      try {
        const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
        await publishManagerSignal({
          brokerageId,
          fromManager: "deal_coordinator",
          toManager: "finance_manager",
          signalType: "cda_deadline_at_risk",
          message: body,
          entityType: "closing_disclosure_agreement",
          entityId: cda.id,
          payload: { state: verdict.state, due_at: deadline.dueAt, zone: tz.zone, status: cda.status, transaction_id: cda.transaction_id },
        }, svc)
      } catch (e) {
        console.error("[cda-deadline-reaper] bus signal failed:", e instanceof Error ? e.message : String(e))
      }
      result.escalated++
    } else {
      result.reminded++
    }
  }

  return result
}
