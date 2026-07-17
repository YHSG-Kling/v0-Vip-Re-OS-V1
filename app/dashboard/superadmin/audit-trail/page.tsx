import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { AuditTrailClient } from "./audit-trail-client"

export const dynamic = "force-dynamic"

// Superadmin: the unified audit-EVENT viewer (messages, documents, commissions,
// calls, badges, portal access — served by /api/admin/audit-events). Moved here
// from the ungated legacy /admin/audit-trail console so the page itself sits
// behind the ONE capability gate. Sibling of /dashboard/superadmin/audit, the
// platform-ACTION ledger (what platform staff did); this page is what happened
// across tenants. Gate: 'staff' capability, matching the sibling ledger.
export default async function SuperadminAuditTrailPage() {
  const gate = await requirePlatformCapability("staff")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  return <AuditTrailClient />
}
