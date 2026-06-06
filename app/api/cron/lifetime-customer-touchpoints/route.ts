import { createServiceClient } from "@/lib/supabase/service"
import { sendAnniversaryMessage, sendBirthdayMessage, sendReferralRequest } from "@/app/actions/lifetime-customer-touchpoints"
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
    errors: [] as string[],
  }

  try {
    // Check for home anniversaries
    const { data: anniversaries } = await supabase
      .from("transactions")
      .select("id, contact_id, agent_id, actual_close_date, contacts(*)")
      .eq("status", "closed")
      .not("actual_close_date", "is", null)

    for (const txn of anniversaries || []) {
      const closeDate = new Date(txn.actual_close_date)
      if (
        closeDate.getMonth() === today.getMonth() &&
        closeDate.getDate() === today.getDate() &&
        closeDate.getFullYear() < today.getFullYear()
      ) {
        const yearsAgo = today.getFullYear() - closeDate.getFullYear()
        try {
          await sendAnniversaryMessage(txn.contact_id, yearsAgo, { agentId: txn.agent_id, client: supabase })
          results.anniversaries++
        } catch (error: any) {
          results.errors.push(`Anniversary error: ${error.message}`)
        }
      }
    }

    // Check for birthdays
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, birthday, agent_id")
      .not("birthday", "is", null)

    for (const contact of contacts || []) {
      if (contact.birthday) {
        const birthday = new Date(contact.birthday)
        if (birthday.getMonth() === today.getMonth() && birthday.getDate() === today.getDate()) {
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
      .select("id, contact_id, agent_id, actual_close_date")
      .eq("status", "closed")
      .in("actual_close_date", [threeDaysAgo.toISOString().split("T")[0], thirtyDaysAgo.toISOString().split("T")[0]])

    for (const txn of recentCloses || []) {
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
