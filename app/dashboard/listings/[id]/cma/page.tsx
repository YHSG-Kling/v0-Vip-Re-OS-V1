import { Suspense } from "react"
import { createClient } from "@/lib/supabase/server"
import { notFound, redirect } from "next/navigation"
import {
  loadCMAPageData,
  loadNetSheetPageData,
  loadPricingPageData,
} from "@/app/actions/seller-cma"
import { CMAClient } from "./cma-client"
import { Skeleton } from "@/components/ui/skeleton"

interface Props {
  params: Promise<{ id: string }>
}

export default async function CMAPage({ params }: Props) {
  const { id: listingId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: listing } = await supabase
    .from("listings")
    .select("id, address, city, state, lifecycle_stage, status, list_price, agent_id, brokerage_id, property_type, bedrooms, bathrooms, square_footage")
    .eq("id", listingId)
    .single()

  if (!listing) notFound()

  // Parallel fetch all three tabs
  const [cmaData, netSheetData, pricingData] = await Promise.all([
    loadCMAPageData(listingId),
    loadNetSheetPageData(listingId),
    loadPricingPageData(listingId),
  ])

  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <CMAClient
        listing={listing}
        cmaData={cmaData}
        netSheetData={netSheetData}
        pricingData={pricingData}
      />
    </Suspense>
  )
}
