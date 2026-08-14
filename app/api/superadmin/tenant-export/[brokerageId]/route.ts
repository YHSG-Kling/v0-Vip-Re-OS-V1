import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { buildTenantExport } from "@/lib/platform/tenant-export"
import { requireSuperadmin } from "@/lib/auth/platform-guard"

export const dynamic = "force-dynamic"

/**
 * TENANT DATA EXPORT — superadmin-gated download of a brokerage's core business
 * records as one JSON bundle (offboarding, audits, "give me my data" requests).
 * Every export lands in superadmin_audit_log. See lib/platform/tenant-export.ts.
 *
 * THE GATE THAT ADMITTED NOBODY. This route tested `profile.user_type !==
 * 'superadmin'` — a value NO live users row carries. The platform superadmin is
 * platform_role='superadmin' with user_type='admin' ('admin' being also a tenant
 * user_type is precisely why the roster lives on platform_role). So the one
 * person entitled to run an offboarding export got a 403, every time; the
 * "Download tenant export" link on the brokerage detail page has never returned
 * a bundle to anyone. requireSuperadmin (lib/auth/platform-guard.ts) reads BOTH
 * identity columns, which is the whole reason it exists.
 *
 * IT STAYS SUPERADMIN-ONLY, DELIBERATELY. This is the widest read on the
 * platform — 23 tables of one tenant's contacts, deals, communications and
 * billing, leaving the platform as a file. The detail page that links here gates
 * on the 'tenants' capability (all four staff roles); resolving that
 * disagreement by widening the EXPORT to 'tenants' would hand a tenant's whole
 * book to marketing. The link is hidden for non-superadmin instead.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ brokerageId: string }> }) {
  const auth = await requireSuperadmin()
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.error === "Unauthenticated" ? 401 : 403 })
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
    actor_user_id: auth.userId,
    actor_email: auth.email,
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
