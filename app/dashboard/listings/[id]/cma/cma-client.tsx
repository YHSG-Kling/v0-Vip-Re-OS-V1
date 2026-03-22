"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CMA_DISCLAIMER } from "@/app/actions/cma-presentation/cma-generator"
import { CMAReportTab } from "./tabs/cma-report-tab"
import { NetSheetTab } from "./tabs/net-sheet-tab"
import { PricingIntelligenceTab } from "./tabs/pricing-intelligence-tab"
import type {
  CMAPageData,
  NetSheetPageData,
  PricingPageData,
} from "@/app/actions/seller-cma"

interface Listing {
  id: string
  address: string | null
  city: string | null
  state: string | null
  lifecycle_stage: string | null
  status: string | null
  list_price: number | null
  agent_id: string | null
  brokerage_id: string | null
  property_type?: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  square_footage?: number | null
}

interface Props {
  listing: Listing
  cmaData: CMAPageData
  netSheetData: NetSheetPageData
  pricingData: PricingPageData
}

export function CMAClient({ listing, cmaData, netSheetData, pricingData }: Props) {
  const [tab, setTab] = useState("cma")

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Page header */}
      <div className="border-b border-border bg-card px-6 py-4">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
          CMA Intelligence
        </p>
        <h1 className="text-xl font-semibold text-foreground mt-0.5">
          {listing.address}
          {listing.city ? `, ${listing.city}` : ""}
          {listing.state ? `, ${listing.state}` : ""}
        </h1>
      </div>

      <div className="flex-1 flex flex-col">
        <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col">
          <div className="border-b border-border px-6">
            <TabsList className="h-10 bg-transparent p-0 gap-6">
              <TabsTrigger
                value="cma"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-foreground text-muted-foreground px-0 h-10 bg-transparent"
              >
                CMA Report
              </TabsTrigger>
              <TabsTrigger
                value="netsheet"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-foreground text-muted-foreground px-0 h-10 bg-transparent"
              >
                Net Sheet
              </TabsTrigger>
              <TabsTrigger
                value="pricing"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-foreground text-muted-foreground px-0 h-10 bg-transparent"
              >
                Pricing Intelligence
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Tab content — grows to fill available space */}
          <div className="flex-1 overflow-auto">
            <TabsContent value="cma" className="mt-0 h-full">
              <CMAReportTab listing={listing} data={cmaData} />
            </TabsContent>
            <TabsContent value="netsheet" className="mt-0 h-full">
              <NetSheetTab listing={listing} data={netSheetData} />
            </TabsContent>
            <TabsContent value="pricing" className="mt-0 h-full">
              <PricingIntelligenceTab listing={listing} data={pricingData} />
            </TabsContent>
          </div>
        </Tabs>
      </div>

      {/* MANDATORY disclaimer — sticky footer, non-dismissable */}
      <div className="sticky bottom-0 z-40 bg-amber-50 border-t border-amber-300 px-6 py-2.5">
        <p className="text-xs text-amber-800 font-medium leading-snug max-w-4xl">
          <span className="font-bold">IMPORTANT: </span>
          {CMA_DISCLAIMER}
        </p>
      </div>
    </div>
  )
}
