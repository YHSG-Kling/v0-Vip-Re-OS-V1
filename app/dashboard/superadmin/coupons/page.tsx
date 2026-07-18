import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { listCouponsAction, listBrokeragesForCouponAction } from "@/app/actions/superadmin/coupons"
import { CouponsManager } from "./coupons-manager"

export const dynamic = "force-dynamic"

// Superadmin coupon / discount codes for tier subscriptions — create codes,
// apply them to tenants (redemption ledger), publish to Stripe (honest
// mock-safe: a mock ledger entry when Stripe creds are absent).
export default async function SuperadminCouponsPage() {
  const gate = await requirePlatformCapability("billing")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const [couponsRes, brokeragesRes] = await Promise.all([
    listCouponsAction(),
    listBrokeragesForCouponAction(),
  ])

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Coupons &amp; discount codes</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Discount codes for tier subscriptions — create a code, apply it to a tenant, publish it to Stripe.
            Redemptions are a permanent ledger; a redeemed coupon deactivates instead of deleting.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/subscriptions" className="rounded-md border px-3 py-1 text-sm">Subscriptions</Link>
          <Link href="/dashboard/superadmin/plans" className="rounded-md border px-3 py-1 text-sm">Plans</Link>
        </div>
      </div>

      {!couponsRes.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load coupons: {couponsRes.error}</div>}
      <CouponsManager
        initialCoupons={couponsRes.ok ? couponsRes.coupons : []}
        brokerages={brokeragesRes.ok ? brokeragesRes.brokerages : []}
        stripeConfigured={couponsRes.ok ? couponsRes.stripeConfigured : false}
      />
    </div>
  )
}
