import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { siteUrl } from "@/lib/platform/site-url"
import { listAffiliatesAction } from "./actions"
import { AffiliatesManager } from "./affiliates-manager"

export const dynamic = "force-dynamic"

// EXTERNAL AFFILIATE RAIL — MRR-commission partners (NOT the rev-share tree;
// see lib/platform/affiliates.ts). Create partners, hand them a ref link,
// watch attributed tenants + monthly accruals, mark periods paid.
export default async function SuperadminAffiliatesPage() {
  // 'billing' owns this board (writes stay billing-gated in ./actions); the
  // 'marketing' capability gets READ access — marketing hands out the ref
  // links and needs to see partners, attribution, and accruals.
  let gate = await requirePlatformCapability("billing")
  let readOnly = gate.access === "read"
  if (!gate.userId) redirect("/login")
  if (!gate.ok) {
    const marketingGate = await requirePlatformCapability("marketing")
    if (!marketingGate.ok) return <div className="p-6 text-red-600">Forbidden: requires platform billing (write) or marketing (read) capability</div>
    gate = marketingGate
    readOnly = true
  }

  const res = await listAffiliatesAction()

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Affiliates — external partners</h1>
          <p className="text-muted-foreground text-sm mt-1">
            External partners earning a % of platform MRR for tenants they refer (default 10% for 18 months).
            Ref link → 90-day cookie → first-wins attribution at signup; commission accrues monthly on live MRR.
            Separate from brokerage rev-share.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/subscriptions" className="rounded-md border px-3 py-1 text-sm">Subscriptions</Link>
          <Link href="/dashboard/superadmin/coupons" className="rounded-md border px-3 py-1 text-sm">Coupons</Link>
        </div>
      </div>

      {!res.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load affiliates: {res.error}</div>}
      <AffiliatesManager
        initialAffiliates={res.ok ? res.affiliates : []}
        refLinkBase={siteUrl()}
        readOnly={readOnly}
      />
    </div>
  )
}
