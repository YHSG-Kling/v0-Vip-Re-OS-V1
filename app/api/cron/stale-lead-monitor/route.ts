import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { processStaleLeadsAndSLA } from "@/lib/lead-governance/stale-lead-processor"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()

  const { data: brokerages, error } = await supabase
    .from("brokerages")
    .select("id")
    .eq("is_active", true)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const results: Array<{ brokerageId: string; breachedCount: number; staleCount: number; errors: string[] }> = []

  for (const brokerage of brokerages ?? []) {
    try {
      const result = await processStaleLeadsAndSLA(brokerage.id)
      results.push(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ brokerageId: brokerage.id, breachedCount: 0, staleCount: 0, errors: [msg] })
    }
  }

  const totalBreached = results.reduce((sum, r) => sum + r.breachedCount, 0)
  const totalStale    = results.reduce((sum, r) => sum + r.staleCount, 0)
  const totalErrors   = results.flatMap((r) => r.errors)

  return NextResponse.json({
    ok: true,
    brokeragesProcessed: results.length,
    totalBreached,
    totalStale,
    errors: totalErrors,
  })
}
