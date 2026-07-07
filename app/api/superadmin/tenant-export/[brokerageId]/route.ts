import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { buildTenantExport } from "@/lib/platform/tenant-export"

export const dynamic = "force-dynamic"

/**
 * TENANT DATA EXPORT — superadmin-gated download of a brokerage's core business
 * records as one JSON bundle (offboarding, audits, "give me my data" requests).
 * Every export lands in superadmin_audit_log. See lib/platform/tenant-export.ts.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ brokerageId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })
  const { data: profile } = await supabase.from("users").select("user_type, email").eq("id", user.id).maybeSingle()
  if ((profile as any)?.user_type !== "superadmin") {
    return NextResponse.json({ error: "Forbidden — superadmin only" }, { status: 403 })
  }

  const { brokerageId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(brokerageId)) {
    return NextResponse.json({ error: "Invalid brokerage id" }, { status: 400 })
  }

  const svc = createServiceClient()
  const bundle = await buildTenantExport(svc, brokerageId)
  if (bundle.tables.brokerages.length === 0) {
    return NextResponse.json({ error: "Brokerage not found" }, { status: 404 })
  }

  // Audit the export — data leaving the platform is always on the record.
  await svc.from("superadmin_audit_log").insert({
    actor_user_id: user.id,
    actor_email: (profile as any)?.email ?? user.email ?? "",
    action: "tenant_data_export",
    target_type: "brokerage",
    target_id: brokerageId,
    details: { counts: bundle.counts, truncated: bundle.truncated },
    ip_address: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip"),
    user_agent: request.headers.get("user-agent"),
  }).then(undefined, () => {})

  const name = (bundle.brokerageName ?? "tenant").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${name}-export-${bundle.exportedAt.slice(0, 10)}.json"`,
    },
  })
}
