import { redirect } from "next/navigation"
import Link from "next/link"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { listSuppressionAction } from "@/app/actions/superadmin/suppression"
import { SuppressionManager } from "./suppression-manager"

export const dynamic = "force-dynamic"

// Superadmin: the cross-tenant do-not-contact wall. Automated writers (ISA
// opt-out detection, TCPA flags, spam complaints) fill it; this is the HUMAN
// half — staff honoring a consumer's "stop contacting me" request or clearing
// a mistaken entry. Removal is superadmin-only (it re-exposes the person to
// every tenant's outreach).
export default async function SuperadminSuppressionPage() {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: requires platform sentinel capability</div>

  const res = await listSuppressionAction()

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Suppression list</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Cross-tenant do-not-contact wall. Entries here are blocked from lead distribution and every
            outbound channel (email, SMS, voice, direct mail) across ALL subscribers. Every add/remove is audited.
          </p>
        </div>
        <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
      </div>
      {!res.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load: {res.error}</div>}
      <SuppressionManager
        initialRows={res.ok ? res.rows : []}
        total={res.ok ? res.total : 0}
        canRemove={gate.role === "superadmin"}
      />
    </div>
  )
}
