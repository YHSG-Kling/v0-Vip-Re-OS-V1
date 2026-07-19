import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { aiGenerateReviewRequest } from "@/app/actions/ai-review-automation"
import { verifyCronAuth } from "@/lib/cron-auth"

// Default delay in days between closing and sending review request
const DEFAULT_DELAY_DAYS = 5

export async function GET(req: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "review-request-on-close",
    cron_path: "/app/api/cron/review-request-on-close/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const supabase = createServiceClient()
  let processed = 0
  let skipped = 0
  let drafted = 0
  const errors: string[] = []

  try {
    // Find brokerages and their configured review request delay (or default 5 days)
    const { data: brokerageSettings } = await supabase
      .from("brokerage_settings")
      .select("brokerage_id, review_request_delay_days")

    const delayByBrokerage: Record<string, number> = {}
    for (const s of brokerageSettings ?? []) {
      delayByBrokerage[s.brokerage_id] = s.review_request_delay_days ?? DEFAULT_DELAY_DAYS
    }

    // Find transactions that closed recently and haven't had a review request sent
    // We look for transactions where close_date was N days ago (per brokerage setting)
    const now = new Date()
    const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const windowEnd   = new Date(now.getTime() - 1  * 24 * 60 * 60 * 1000).toISOString()

    const { data: closedTxns, error: txnError } = await supabase
      .from("transactions")
      .select(`
        id,
        brokerage_id,
        agent_id,
        contact_id,
        close_date,
        contacts:contact_id(first_name, last_name, email)
      `)
      .eq("status", "closed")
      .gte("close_date", windowStart)
      .lte("close_date", windowEnd)

    if (txnError) throw txnError

    for (const txn of closedTxns ?? []) {
      try {
        if (!txn.close_date || !txn.contact_id || !txn.agent_id) {
          skipped++
          continue
        }

        const closeDate  = new Date(txn.close_date)
        const delayDays  = delayByBrokerage[txn.brokerage_id] ?? DEFAULT_DELAY_DAYS
        const targetDate = new Date(closeDate.getTime() + delayDays * 24 * 60 * 60 * 1000)

        // Only fire if today is on or after the target send date
        if (now < targetDate) {
          skipped++
          continue
        }

        // Check if a review request was already sent for this transaction
        const { data: existing } = await supabase
          .from("review_requests")
          .select("id")
          .eq("contact_id", txn.contact_id)
          .limit(1)
          .maybeSingle()

        if (existing) {
          skipped++
          continue
        }

        // Generate the review request — then ACTUALLY SEND IT (informed-audit
        // fix: this cron used to create the pending row, discard the composed
        // message, and report "processed" for a send that never happened).
        const gen: any = await aiGenerateReviewRequest({
          transactionId: txn.id,
          agentId:       txn.agent_id,
          platform:      "google",
          channel:       "email",
        })
        if (!gen?.success) { errors.push(`txn ${txn.id}: compose failed`); continue }

        const contactEmail = (txn as any).contacts?.email as string | undefined
        if (!contactEmail || !gen.message) {
          // No email on file — the draft stays 'pending' for the agent to
          // deliver another way; counted honestly as drafted, not sent.
          drafted++
          continue
        }
        const { dispatchEmail } = await import("@/lib/providers/dispatch")
        const sent = await dispatchEmail({
          brokerageId: txn.brokerage_id,
          from: "Your Agent",
          to: contactEmail,
          subject: gen.data?.subject ?? "Quick favor — how was your experience?",
          html: String(gen.message),
          channelPurpose: "update",
          systemSource: "review_automation",
          contactId: txn.contact_id,
          metadata: { transactionId: txn.id, platform: "google" },
        })
        if (sent.success && gen.reviewRequestId) {
          await supabase.from("review_requests")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", gen.reviewRequestId)
          processed++
        } else {
          // Refused by the compliance gate (or no row id) — row stays 'pending'
          // with the draft intact; never stamped sent.
          drafted++
        }
      } catch (err: any) {
        errors.push(`txn ${txn.id}: ${err?.message ?? String(err)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: processed,
      metadata: { skipped, drafted, errors },
    })

    return NextResponse.json({ ok: true, processed, skipped, drafted, errors })
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    await recordCronFailureAction({ context_id: contextId, error: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
