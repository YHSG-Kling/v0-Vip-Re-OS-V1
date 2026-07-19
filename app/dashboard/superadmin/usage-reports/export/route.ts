import { NextResponse } from "next/server"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { loadUsageReportRows, usageReportCsv } from "../usage-report-data"

export const dynamic = "force-dynamic"

/**
 * CSV EXPORT of the usage-reports table — EXACTLY the rows the page renders
 * (shared loader in ../usage-report-data.ts; no new data). A route handler
 * rather than a server action because a download needs Content-Type /
 * Content-Disposition headers, which actions cannot set. Same capability gate
 * as the page ('tenants').
 */
export async function GET() {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error ?? "Forbidden" }, { status: gate.userId ? 403 : 401 })
  }

  const res = await loadUsageReportRows(createServiceClient())
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 })

  const csv = usageReportCsv(res.rows)
  const stamp = new Date().toISOString().slice(0, 10)
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="usage-report-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  })
}
