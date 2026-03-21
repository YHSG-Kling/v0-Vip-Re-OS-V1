import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const ranAt = new Date().toISOString()
  const supabase = createServiceClient()
  const errors: string[] = []
  let processed = 0
  let skipped = 0

  try {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const { data: transactions, error } = await supabase
      .from("transactions")
      .select("id, agent_id, contact_id, property_address, close_date")
      .eq("status", "closed")
      .gte("close_date", thirtyDaysAgo.split("T")[0])
      .lte("close_date", fourteenDaysAgo.split("T")[0])
      .limit(30)

    if (error) {
      errors.push(`Transactions query failed: ${error.message}`)
    } else {
      for (const tx of transactions ?? []) {
        try {
          await supabase.from("activities").insert({
            agent_id: tx.agent_id,
            contact_id: tx.contact_id,
            activity_type: "referral_ask_due",
            title: `Request a referral from your recent closing`,
            description: `${tx.property_address} closed recently. Great time to ask for referrals.`,
            status: "pending",
            priority: "medium",
            metadata: { transaction_id: tx.id },
          })
          processed++
        } catch (err: any) {
          skipped++
          errors.push(`Tx ${tx.id}: ${err.message}`)
        }
      }
    }
  } catch (err: any) {
    errors.push(`Referral asks cron failed: ${err.message}`)
    await supabase
      .from("automation_errors")
      .insert({ cron_job: "referral-asks", error_message: err.message, occurred_at: ranAt })
      .catch(() => {})
  }

  return NextResponse.json({ ok: errors.length === 0, ranAt, processed, skipped, errors })
}
