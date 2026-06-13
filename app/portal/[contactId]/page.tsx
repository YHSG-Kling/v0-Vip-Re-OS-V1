import { createClient } from "@/lib/supabase/server"
import { resolveDualPortalView, dualBannerPredicate } from "@/lib/kernel/portal"
import SellerHome from "./seller-home"
import LifetimeHome from "./lifetime-home"
import BuyerHome from "./buyer-home"
import { DualJourneyTabs } from "./components/DualJourneyTabs"
import { DualDependencyBanner } from "./components/DualDependencyBanner"

export default async function PortalHomePage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Resolve the portal view. resolveDualPortalView runs determinePortalView
  // FIRST (so the single-journey buyer/seller/lifetime resolution is unchanged
  // for everyone) and ADDS the orthogonal dual question: is this ONE contact
  // BOTH a buyer AND a seller (contact_type='both' OR both journey_states sides)?
  const dual = await resolveDualPortalView(supabase, { contactId })

  // DUAL-JOURNEY PORTAL — a "must sell to buy" contact sees BOTH journeys in a
  // tabbed Buy | Sell portal instead of being collapsed to one side. The tabs
  // reuse the EXISTING BuyerHome and SellerHome server components verbatim, and
  // each home loads its own transparency_updates / value cards. When the sale→buy
  // dependency is gated (and not yet satisfied), a banner sits above both tabs.
  if (dual.isDual) {
    const showBanner = dualBannerPredicate(dual.dependency)
    // The base single-journey view becomes the default-open tab (seller-first
    // when the resolver would have shown the seller view, buyer-first otherwise).
    const defaultTab = dual.baseView === "seller" ? "sell" : "buy"

    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-2xl mx-auto px-4 pt-6 pb-12 space-y-4">
          {showBanner && dual.dependency && (
            <DualDependencyBanner dependency={dual.dependency} />
          )}
          <DualJourneyTabs
            defaultTab={defaultTab}
            buy={<BuyerHome contactId={contactId} embedded />}
            sell={<SellerHome contactId={contactId} />}
          />
        </div>
      </div>
    )
  }

  // ── Non-dual: byte-for-byte the previous single-journey behavior ────────────

  // Render seller home if seller view
  if (dual.baseView === "seller") {
    return <SellerHome contactId={contactId} />
  }

  // Render lifetime home if lifetime view
  if (dual.baseView === "lifetime") {
    return <LifetimeHome contactId={contactId} />
  }

  // Default buyer view
  return <BuyerHome contactId={contactId} />
}
