import { createClient } from "@/lib/supabase/server"
import { sendAnniversaryMessage, sendBirthdayMessage, sendReferralRequest } from "@/app/actions/past-client-touchpoints"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// This cron job runs daily at 9 AM to process touchpoints, anniversaries, birthdays
export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const supabase = await createClient()
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
      .select("id, contact_id, actual_close_date, contacts(*)")
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
          await sendAnniversaryMessage(txn.contact_id, yearsAgo)
          results.anniversaries++
        } catch (error: any) {
          results.errors.push(`Anniversary error: ${error.message}`)
        }
      }
    }

    // Check for birthdays
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, birthday")
      .not("birthday", "is", null)

    for (const contact of contacts || []) {
      if (contact.birthday) {
        const birthday = new Date(contact.birthday)
        if (birthday.getMonth() === today.getMonth() && birthday.getDate() === today.getDate()) {
          try {
            await sendBirthdayMessage(contact.id)
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
      .select("id, contact_id, actual_close_date")
      .eq("status", "closed")
      .in("actual_close_date", [threeDaysAgo.toISOString().split("T")[0], thirtyDaysAgo.toISOString().split("T")[0]])

    for (const txn of recentCloses || []) {
      try {
        await sendReferralRequest(txn.contact_id)
        results.referralRequests++
      } catch (error: any) {
        results.errors.push(`Referral request error: ${error.message}`)
      }
    }

    return Response.json({
      success: true,
      processed: results,
    })
  } catch (error: any) {
    return Response.json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 },
    )
  }
}
