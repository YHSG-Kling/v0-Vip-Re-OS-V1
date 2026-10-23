import { createServiceClient } from "@/lib/supabase/service"
import { sendAnniversaryMessage, sendBirthdayMessage } from "@/app/actions/lifetime-customer-touchpoints"
import { evaluateDeconflict } from "@/lib/kernel/deconflict"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronProgressAction,
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
    // WAVE 89 (lane 89C): a touch the send gate REFUSED (no email / no phone / consent / DNC / quiet
    // hours). The three senders return { success: false } without throwing, and this route counted
    // every call as a touch delivered — a blocked anniversary read as an anniversary sent. Counted
    // honestly now, and named per touch in `errors`.
    blocked: 0,
    // WAVE 143 (143E): the post-close moments the arbiter reviewed this run (lib/sphere/followup-moments.ts).
    moments: {} as Record<string, number>,
    errors: [] as string[],
  }

  // DE-CONFLICTION — lifetime clients are the brokerage's highest-value segment; stacking an
  // anniversary + birthday + referral (or colliding with an ISA re-engagement / a campaign) the
  // same week burns the relationship. The Sphere's calendar touch is gated by the Campaign
  // Orchestrator's cadence policy (evaluateDeconflict — its domain) AND a same-run guard so one
  // contact is never double-touched in a single pass. Managers working together, no over-message.
  // ── MID-RUN PROGRESS ───────────────────────────────────────────────────────
  // `recordCronProgressAction` is the one member of the five-part cron logging
  // kernel that no route ever called: every /api/cron/… route opens a context,
  // records START, and then goes silent until SUCCESS or FAILURE. So a run that
  // died partway through — or one still in flight — showed
  // `cron_execution_logs.records_processed` null and status 'started', and the
  // Cron Health screen could not tell "stuck at zero" from "halfway done".
  // This route is the natural first caller: it walks three independent
  // populations (anniversaries → birthdays → referral windows), so each phase
  // boundary is a real, meaningful checkpoint rather than an arbitrary tick.
  //
  // Progress is BEST-EFFORT bookkeeping and must never take the run down: the
  // kernel command returns { success:false, error } rather than throwing, and a
  // refusal is logged and stepped over.
  async function noteProgress(stage: string): Promise<void> {
    const processed = results.anniversaries + results.birthdays + results.referralRequests
    const progress = await recordCronProgressAction({
      context_id:     contextId,
      records_processed: processed,
      metadata_delta: { ...results, stage },
    })
    if (!progress.success) {
      console.error("[PastClientTouchpoints] progress not recorded:", progress.error)
    }
  }

  // WAVE 89 (lane 89C) — FATIGUE TEMPERS THE LIFETIME CADENCE. The engine now reads the contact's
  // fatigue score and tightens the cap for a high/critical contact (lib/kernel/deconflict), so an
  // over-touched past client is held here without a second rule. The channel passed is the one the
  // touch actually rides (anniversary = email; birthday / referral ask = sms) — every touch was
  // evaluated as "email" before, so an SMS ask was capped by the email allowance.
  const touchedThisRun = new Set<string>()
  async function lifetimeTouchAllowed(
    brokerageId: string | null, contactId: string, systemSource: string, channel: "email" | "sms" = "email",
  ): Promise<boolean> {
    if (touchedThisRun.has(contactId)) return false
    if (brokerageId) {
      try {
        const d = await evaluateDeconflict({ brokerageId, contactId, channel, systemSource })
          .catch(() => ({ allowed: true }))
        if (!(d as { allowed: boolean }).allowed) return false
      } catch { /* fail open — never block a touch on a de-confliction hiccup */ }
    }
    touchedThisRun.add(contactId)
    return true
  }
  /** Count a sender's result honestly: a gate refusal is `blocked`, not a touch. */
  function countSend(kind: "anniversaries" | "birthdays" | "referralRequests", res: { success: boolean; error?: string }, contactId: string) {
    if (res.success) results[kind]++
    else { results.blocked++; results.errors.push(`${kind} blocked for ${contactId}: ${res.error ?? "send gate refused"}`) }
    return res.success
  }

  try {
    // Check for home anniversaries.
    //
    // `funded` joins `closed` here: the ladder is closed → funded, so a funded deal
    // is definitionally past its closing date. Matching only `closed` meant the
    // clients furthest through the process — the ones whose money actually moved —
    // were the ones who never got an anniversary touch.
    //
    // AMBIGUOUS EMBED REMOVED (PGRST201). transactions → contacts carries THREE
    // foreign keys (transactions_contact_id_fkey, transactions_buyer_contact_id_fkey,
    // transactions_seller_contact_id_fkey), so a bare `contacts(*)` is ambiguous and
    // PostgREST REFUSES THE WHOLE REQUEST — not just the embed. supabase-js resolves
    // that refusal, so `data` came back null and this loop iterated ZERO rows: no
    // anniversary touch has ever been sent from this cron. Nothing here ever read
    // `txn.contacts` (the loop uses contact_id/agent_id/brokerage_id and hands the
    // contact id to sendAnniversaryMessage, which loads the contact itself), so the
    // embed was pure dead weight that broke the read. Dropped rather than hinted.
    const { data: anniversaries, error: anniversariesError } = await supabase
      .from("transactions")
      .select("id, contact_id, agent_id, brokerage_id, actual_close_date:close_date")
      .in("status", ["closed", "funded"])
      .not("close_date", "is", null)

    // supabase-js RESOLVES a failed query — an unchecked read reports a refusal as
    // an absence, which is exactly how the ambiguity above stayed invisible.
    if (anniversariesError) {
      results.errors.push(`Anniversary read: ${anniversariesError.message}`)
    }

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
          const sent = await sendAnniversaryMessage(txn.contact_id, yearsAgo, { agentId: txn.agent_id, client: supabase })
          if (!countSend("anniversaries", sent, txn.contact_id)) continue

          // EMIT THE EVENT. This cron was the only thing that knew an anniversary
          // had come round, and it kept that to itself — so the "Home Purchase
          // Anniversary" trigger an agent can pick in the workflow builder fired
          // never, and the ANNIVERSARY_TRIGGERED portal template in
          // lib/kernel/event-fanout.ts rendered never. Both ends existed; the
          // signal between them did not.
          try {
            // emitKernelEvent also writes the anniversary_triggered audit row (this cron
            // fanned out without ever recording the fact it announced).
            const { emitKernelEvent } = await import("@/lib/kernel/emit")
            const { KernelEvent } = await import("@/lib/kernel/events")
            await emitKernelEvent({
              event:       KernelEvent.ANNIVERSARY_TRIGGERED,
              brokerageId: (txn as any).brokerage_id,
              entityType:  "contact",
              entityId:    txn.contact_id,
              contactId:   txn.contact_id,
              source:      "cron",
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

    await noteProgress("anniversaries-complete")

    // Check for birthdays
    const { data: contacts, error: contactsError } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, birthday, agent_id, brokerage_id")
      .not("birthday", "is", null)

    if (contactsError) {
      results.errors.push(`Birthday read: ${contactsError.message}`)
    }

    for (const contact of contacts || []) {
      if (contact.birthday) {
        const birthday = new Date(contact.birthday)
        if (birthday.getMonth() === today.getMonth() && birthday.getDate() === today.getDate()) {
          if (!(await lifetimeTouchAllowed((contact as any).brokerage_id ?? null, contact.id, "sphere_birthday", "sms"))) {
            results.deferred++
            continue
          }
          try {
            countSend("birthdays", await sendBirthdayMessage(contact.id, { agentId: contact.agent_id, client: supabase }), contact.id)
          } catch (error: any) {
            results.errors.push(`Birthday error: ${error.message}`)
          }
        }
      }
    }

    await noteProgress("birthdays-complete")

    // TOMBSTONE (wave 143, lane 143E): "Check for referral request opportunities (3 days and 30 days after close)" — a
    // hard-coded timetable that texted every closed client a referral ask at EXACTLY day 3 and day 30, whatever their
    // intent, history or fatigue (and disagreed with the 18-month referral row the close writes, which nothing delivered).
    // SURVIVOR: lib/sphere/followup-moments.ts conductDueFollowUpMoments — the `referral_request` moment of the tenant's
    // versioned followup_policy (lib/ai-isa/followup-policy.ts postClose) opens on the policy's date; the arbiter decides
    // WHETHER, WHEN and HOW to ask (message, video, a task for the agent, or wait) under the same consent / fatigue / DNC
    // gates. `sendReferralRequest` (app/actions/lifetime-customer-touchpoints.ts) was DELETED with this block — it had no
    // other caller and shipped a canned fallback body (tombstone there). The owner may restore the old cadence by setting
    // followup_policy.postClose[referral_request].afterClosingDays (the policy admits one referral moment per tenant).

    // THE POST-CLOSE MOMENTS (wave 143, lane 143E) — the delivery half that did not exist: due lifetime_customer_touchpoints
    // rows are reviewed by the arbiter and delivered / delegated / routed to the agent / deferred; anniversary rows the
    // block above already sent are reconciled so the reaper never reports them as slipped.
    let momentsActedOn = 0
    try {
      const { conductDueFollowUpMomentsAllTenants } = await import("@/lib/sphere/followup-moments")
      const moments = await conductDueFollowUpMomentsAllTenants(supabase as never)
      const { errors: _momentErrors, ...momentCounts } = moments.totals
      void _momentErrors
      momentsActedOn = moments.totals.sent + moments.totals.delegated + moments.totals.routedToAgent
      results.moments = { tenants: moments.tenants, ...momentCounts }
      for (const e of moments.totals.errors) results.errors.push(`Moments: ${e}`)
    } catch (error: any) {
      results.errors.push(`Moments error: ${error.message}`)
    }

    await noteProgress("moments-complete")

    const totalProcessed = results.anniversaries + results.birthdays + results.referralRequests + momentsActedOn

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
