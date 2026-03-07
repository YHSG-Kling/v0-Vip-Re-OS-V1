import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import { VendorDirectoryClient } from "./vendor-directory-client"
import {
  searchVendors,
  getAllVendorBookings,
  getCompletedBookingsForRating,
  getVendorCostComparison,
} from "@/app/actions/vendor-marketplace"

export const dynamic = "force-dynamic"

export default async function VendorsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/onboarding")

  // Fetch initial data
  const [
    vendors,
    recentBookings,
    pendingRatings,
    transactions,
  ] = await Promise.all([
    searchVendors({ limit: 50 }),
    getAllVendorBookings(20),
    getCompletedBookingsForRating(),
    supabase
      .from("transactions")
      .select("id, property_address, stage")
      .eq("brokerage_id", profile.brokerage_id)
      .in("status", ["active", "pending"])
      .order("created_at", { ascending: false })
      .limit(50)
      .then(r => r.data || []),
  ])

  // Get unique service types from vendors
  const serviceTypes = [...new Set(vendors.map(v => v.category).filter(Boolean))]

  return (
    <div className="container mx-auto p-6">
      <Suspense fallback={<div className="animate-pulse">Loading vendor directory...</div>}>
        <VendorDirectoryClient
          initialVendors={vendors}
          recentBookings={recentBookings}
          pendingRatings={pendingRatings}
          transactions={transactions}
          serviceTypes={serviceTypes}
          brokerageId={profile.brokerage_id}
          userRole={profile.role ?? "agent"}
        />
      </Suspense>
    </div>
  )
}
