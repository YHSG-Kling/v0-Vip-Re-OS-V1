import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listPlatformProspectsAction } from "@/app/actions/superadmin/platform-growth"
import { listProductDraftsAction } from "@/app/actions/superadmin/platform-content"
import { getProductBrandAction, listTopicsAction } from "@/app/actions/superadmin/platform-brand"
import { DEFAULT_PRODUCT_BRAND } from "@/lib/platform/product-brand"
import { BrandTopicsCard } from "./brand-topics-card"
import { ImageLibraryCard } from "./image-library-card"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"
import { PlatformGrowthBoard } from "./platform-growth-board"
import { ProductContentBoard } from "./product-content-board"
import { listSubscriberReferralsAction } from "@/app/actions/superadmin/subscriber-referrals"
import { SubscriberReferralsCard } from "./subscriber-referrals-card"

export const dynamic = "force-dynamic"

// Platform self-marketing — market VIP Agents itself. Gated to platform marketing
// staff (or superadmin) via the capability map.
export default async function PlatformGrowthPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const role = (data as any)?.platform_role ?? ((data as any)?.user_type === "superadmin" ? "superadmin" : null)
  if (!platformStaffCan(role, "marketing")) return <div className="p-6 text-red-600">Forbidden: platform marketing access required</div>

  // Referral fees are a MONEY surface — billing capability (superadmin + platform admin),
  // narrower than this page's marketing gate, so the card only renders for those roles.
  const canSeeFees = platformStaffCan(role, "billing")
  const [res, draftsRes, brandRes, topicsRes, referralsRes] = await Promise.all([
    listPlatformProspectsAction(), listProductDraftsAction(), getProductBrandAction(), listTopicsAction(),
    canSeeFees ? listSubscriberReferralsAction() : Promise.resolve(null),
  ])

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Growth — market the platform</h1>
        <p className="text-muted-foreground text-sm mt-1">
          The platform's own funnel: prospects who raised their hand for VIP Agents, from first touch to
          converted customer. Draft the product pitch, advance the funnel, and watch the conversion rate.
        </p>
      </div>
      {!res.ok ? (
        <div className="rounded border p-4 text-sm text-red-600">Failed: {res.error}</div>
      ) : (
        <PlatformGrowthBoard initialProspects={res.prospects} initialFunnel={res.funnel} />
      )}
      {/* Subscriber referral fees — who referred each tenant + what's owed (billing roles only) */}
      {referralsRes && referralsRes.ok && (
        <SubscriberReferralsCard initialRows={referralsRes.rows} feePercent={referralsRes.feePercent} brokerageOptions={referralsRes.brokerageOptions} />
      )}
      {/* Brand kit (configurable product name) + watched-topic pool */}
      <BrandTopicsCard initialBrand={brandRes.ok ? brandRes.brand : DEFAULT_PRODUCT_BRAND} initialTopics={topicsRes.ok ? topicsRes.topics : []} />
      {/* Shared image library — stock + AI stills, platform-curated, tenant-reused */}
      <ImageLibraryCard />
      {/* The platform's own social calendar — market the OS on the company channels */}
      <ProductContentBoard initialDrafts={draftsRes.ok ? draftsRes.drafts : []} />
    </div>
  )
}
