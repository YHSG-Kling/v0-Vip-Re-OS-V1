import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { CreditCard } from "lucide-react"
import { normalizeTier } from "@/lib/kernel/vendor-subscription"
import { VendorBillingClient } from "./billing-client"

export const dynamic = "force-dynamic"

/**
 * Vendor billing — the vendor-pays-platform subscription surface. A vendor picks a tier (basic → preferred
 * network), which gates AI surfacing / preferred-list / featured eligibility. Billing runs through Stripe.
 */
export default async function VendorBillingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("vendor_marketplace_profiles")
    .select("subscription_tier, subscription_status")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!profile) redirect("/vendor/dashboard")

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <CreditCard className="h-7 w-7" /> Billing &amp; Plan
        </h1>
        <p className="text-muted-foreground mt-1">
          Your platform plan controls where you show up in the marketplace. Upgrade to be surfaced to clients,
          added to brokerage preferred lists, and featured.
        </p>
      </div>
      <VendorBillingClient
        currentTier={normalizeTier((profile as { subscription_tier?: string }).subscription_tier)}
        status={(profile as { subscription_status?: string }).subscription_status ?? "active"}
      />
    </div>
  )
}
