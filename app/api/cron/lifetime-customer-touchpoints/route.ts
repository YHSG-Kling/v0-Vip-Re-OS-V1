import { createServiceClient } from "@/lib/supabase/service"
import { sendAnniversaryMessage, sendBirthdayMessage, sendReferralRequest } from "@/app/actions/lifetime-customer-touchpoints"
import { evaluateDeconflict } from "@/lib/kernel/deconflict"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// This cron job runs daily at 9 AM to process touchpoints, anniversaries, birthdays
export async function GET(request: Request) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "lifetime-customer-touchpoints",
    cron_path: "/app/api/cron/lifetime-customer-touchpoints/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return Response.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[PastClientTouchpoints] Failed to record cron start:", startRecordResult.error)
  }

  const supabase = createServiceClient()
  const today = new Date()
  const results = {
    anniversaries: 0,
    birthdays: 0,
    referralRequests: 0,
    deferred: 0,
    errors: [] as string[],
  }

  // DE-CONFLICTION — lifetime clients are the brokerage's highest-value segment; stacking an
  // anniversary + birthday + referral (or colliding with an ISA re-engagement / a campaign) the
  // same week burns the relationship. The Sphere's calendar touch is gated by the Campaign
  // Orchestrator's cadence policy (evaluateDeconflict — its domain) AND a same-run guard so one
  // contact is never double-touched in a single pass. Managers working together, no over-message.
  const touchedThisRun = new Set<string>()
  async function lifetimeTouchAllowed(brokerageId: string | null, contactId: string, systemSource: string): Promise<boolean> {
    if (touchedThisRun.has(contactId)) return false
    if (brokerageId) {
      try {
        const d = await evaluateDeconflict({ brokerageId, contactId, channel: "email", systemSource })
          .catch(() => ({ allowed: true }))
        if (!(d as { allowed: boolean }).allowed) return false
      } catch { /* fail open — never block a touch on a de-confliction hiccup */ }
    }
    touchedThisRun.add(contactId)
    return true
  }

  try {
    // Check for home anniversaries.
    //
    // `funded` joins `closed` here: the ladder is closed → funded, so a funded deal
    // is definitionally past its closing date. Matching only `closed` meant the
    // clients furthest through the process — the ones whose money actually moved —
    // were the ones who never got an anniversary touch.
    const { data: anniversaries } = await supabase
      .from("transactions")
      .select("id, contact_id, agent_id, brokerage_id, actual_close_date:close_date, contacts(*)")
      .in("status", ["closed", "funded"])
      .not("close_date", "is", null)

    for (const txn of anniversaries || []) {
      const closeDate = new Date(txn.actual_close_date)
      if (
        closeDate.getMonth() === today.getMonth() &&
        closeDate.getDate() === today.getDate() &&
        closeDate.getFullYear() < today.getFullYear()
      ) {
        const yearsAgo = today.getFullYear() - closeDate.getFullYear()
        if (!(await lifetimeTouchAllowed((txn as any).brokerage_id ?? null, txn.contact_id, "sphere_anniversary"))) {
          results.deferred++
          continue
        }
        try {
          await sendAnniversaryMessage(txn.contact_id, yearsAgo, { agentId: txn.agent_id, client: supabase })
          results.anniversaries++

          // EMIT THE EVENT. This cron was the only thing that knew an anniversary
          // had come round, and it kept that to itself — so the "Home Purchase
          // Anniversary" trigger an agent can pick in the workflow builder fired
          // never, and the ANNIVERSARY_TRIGGERED portal template in
          // lib/kernel/event-fanout.ts rendered never. Both ends existed; the
          // signal between them did not.
          try {
            const { fanOutKernelEvent } = await import("@/lib/kernel/event-fanout")
            const { KernelEvent } = await import("@/lib/kernel/events")
            await fanOutKernelEvent({
              event:       KernelEvent.ANNIVERSARY_TRIGGERED,
              brokerageId: (txn as any).brokerage_id,
              entityType:  "contact",
              entityId:    txn.contact_id,
              metadata:    { years_ago: yearsAgo, transaction_id: txn.id, close_date: txn.actual_close_date },
            })
          } catch (fanErr: any) {
            // The touch already went out; a fan-out failure must not undo it.
            results.errors.push(`Anniversary fan-out: ${fanErr?.message ?? fanErr}`)
          }
        } catch (error: any) {
          results.errors.push(`Anniversary error: ${error.message}`)
        }
      }
    }

    // Check for birthdays
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, birthday, agent_id, brokerage_id")
      .not("birthday", "is", null)

    for (const contact of contacts || []) {
      if (contact.birthday) {
        const birthday = new Date(contact.birthday)
        if (birthday.getMonth() === today.getMonth() && birthday.getDate() === today.getDate()) {
          if (!(await lifetimeTouchAllowed((contact as any).brokerage_id ?? null, contact.id, "sphere_birthday"))) {
            results.deferred++
            continue
          }
          try {
            await sendBirthdayMessage(contact.id, { agentId: contact.agent_id, client: supabase })
            results.birthdays++
          } catch (error: any) {
            results.errors.push(`Birthday error: ${error.message}`)
          }
        }
      }
    }

    // Check for referral request opportunities (3 days and 30 days after close)
    const threeDaysAgo = new Date(today)
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
    const thirtyDaysAgo = new Date(today)
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const { data: recentCloses } = await supabase
      .from("transactions")
      .select("id, contact_id, agent_id, brokerage_id, actual_close_date:close_date")
      .eq("status", "closed")
      .in("close_date", [threeDaysAgo.toISOString().split("T")[0], thirtyDaysAgo.toISOString().split("T")[0]])

    for (const txn of recentCloses || []) {
      if (!(await lifetimeTouchAllowed((txn as any).brokerage_id ?? null, txn.contact_id, "sphere_referral_request"))) {
        results.deferred++
        continue
      }
      try {
        await sendReferralRequest(txn.contact_id, { agentId: txn.agent_id, client: supabase })
        results.referralRequests++
      } catch (error: any) {
        results.errors.push(`Referral request error: ${error.message}`)
      }
    }

    const totalProcessed = results.anniversaries + results.birthdays + results.referralRequests

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: totalProcessed,
      metadata: results,
    })

    return Response.json({
      success: true,
      processed: results,
    })
  } catch (error: any) {
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return Response.json(
      { success: false, error: error.message, context_id: contextId },
      { status: 500 },
    )
  }
}
