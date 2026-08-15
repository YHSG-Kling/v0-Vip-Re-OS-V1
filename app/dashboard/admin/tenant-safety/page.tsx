import { redirect } from "next/navigation"
import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { getRecentTenantSafetyFindings } from "@/app/actions/tenant-safety-actions"
import { TenantSafetyClient } from "./tenant-safety-client"

/**
 * /dashboard/admin/tenant-safety
 *
 * Admin surface for the tenant-safety-scan cron output. Visible only to
 * broker / broker_admin / admin / superadmin / compliance roles (RLS on
 * tenant_safety_findings + action-level gate both enforce this).
 *
 * Shows: unresolved findings (highest severity first) + recent resolved
 * findings for audit. Each finding can be marked resolved with a note.
 * An on-demand "Run scan now" button triggers the cron immediately.
 */
export default async function TenantSafetyPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()

  const allowed = new Set([
    "superadmin", "broker", "broker_admin", "admin", "compliance_officer", "compliance_manager",
  ])
  if (!allowed.has(profile?.user_type ?? "")) {
    redirect("/dashboard")
  }

  const [unresolvedRes, resolvedRes] = await Promise.all([
    getRecentTenantSafetyFindings({ limit: 50, resolved: false }),
    getRecentTenantSafetyFindings({ limit: 25, resolved: true }),
  ])

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-border bg-background sticky top-0 z-10">
        <Link
          href="/dashboard/admin"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Admin
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium text-foreground">Tenant Safety Scan</span>
      </div>

      <div className="flex-1 overflow-auto p-6 max-w-5xl space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Tenant Safety</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Daily scan finds tables without brokerage_id, tables missing RLS policies, and rows with NULL brokerage_id. Findings here = an action that may have leaked across tenants.
          </p>
        </div>

        <TenantSafetyClient
          unresolved={unresolvedRes.findings ?? []}
          resolved={resolvedRes.findings ?? []}
        />
      </div>
    </div>
  )
}
