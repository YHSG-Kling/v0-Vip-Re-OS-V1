'use client'

// app/portal/[contactId]/components/DualJourneyTabs.tsx
//
// Thin CLIENT tab-switcher for the DUAL-JOURNEY portal. A contact who is BOTH a
// buyer AND a seller (the "must sell to buy" case) must see BOTH journeys — the
// portal used to collapse them to one. The server page renders the EXISTING
// BuyerHome and SellerHome server components and passes them in as `buy` / `sell`
// React nodes; this component only switches which one is visible. No data fetching,
// no journey logic here — it is purely the Buy | Sell toggle. Both tabs keep their
// own transparency_updates / value cards because each rendered home already loads them.

import * as React from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/app/components/ui/tabs'
import { Home, Building } from 'lucide-react'

interface DualJourneyTabsProps {
  /** Server-rendered BuyerHome (the "Buy" journey). */
  buy: React.ReactNode
  /** Server-rendered SellerHome (the "Sell" journey). */
  sell: React.ReactNode
  /** Which tab opens first — the base single-journey view the resolver would have shown. */
  defaultTab?: 'buy' | 'sell'
}

export function DualJourneyTabs({ buy, sell, defaultTab = 'buy' }: DualJourneyTabsProps) {
  return (
    <Tabs defaultValue={defaultTab} className="w-full">
      <TabsList className="grid w-full grid-cols-2 mb-2">
        <TabsTrigger value="buy">
          <Home className="h-4 w-4" />
          Buy
        </TabsTrigger>
        <TabsTrigger value="sell">
          <Building className="h-4 w-4" />
          Sell
        </TabsTrigger>
      </TabsList>
      <TabsContent value="buy">{buy}</TabsContent>
      <TabsContent value="sell">{sell}</TabsContent>
    </Tabs>
  )
}
