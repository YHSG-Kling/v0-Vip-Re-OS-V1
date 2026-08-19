import { redirect } from "next/navigation"
import { Layers } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { listVendorPlansAction } from "@/app/actions/vendors/vendor-plans"
import { VendorPlansClient } from "./plans-client"

export const dynamic = "force-dynamic"

/**
 * VENDOR PLAN CATALOGUE — the surface `public.vendor_plans` was built for and never got.
 *
 * The table has existed, RLS-governed and FK-anchored in both directions
 * (vendor_plans.vendor_id → vendor_marketplace_profiles, vendor_subscriptions.plan_id →
 * vendor_plans ON DELETE RESTRICT), with zero rows and no writer anywhere in the tree. Its
 * validator (lib/vendors/vendor-validators.ts :: validateVendorPlan) sat unwired for the same
 * reason. This page and app/actions/vendors/vendor-plans.ts are the missing half.
 *
 * The acting user must own a `vendor_marketplace_profiles` row — that is what the live
 * `vendor_plans_vendor_manage_own` policy keys on. Anyone else is sent to the vendor dashboard
 * rather than shown an empty catalogue that would read as "you have no plans".
 */
export default async function VendorPlansPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile, error } = await supabase
    .from("vendor_marketplace_profiles")
    .select("id, company_name")
    .eq("user_id", user.id)
    .maybeSingle()

  // A refused profile read is not "no profile" — do not bounce on it silently.
  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">Plans</h1>
        <p className="mt-2 text-sm text-red-600">
          Could not read your vendor profile: {error.message}
        </p>
      </div>
    )
  }
  if (!profile) redirect("/vendor/dashboard")

  const result = await listVendorPlansAction()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Layers className="h-7 w-7" /> Plans
        </h1>
        <p className="text-muted-foreground mt-1">
          The plans brokerages can subscribe to from {profile.company_name ?? "your company"}. Prices
          and credit limits here are what a brokerage is billed for using your service — separate
          from the platform tier you pay us on the Billing page.
        </p>
      </div>

      {result.ok ? (
        <VendorPlansClient initialPlans={result.plans} />
      ) : (
        <p className="text-sm text-red-600">{result.error}</p>
      )}
    </div>
  )
}
