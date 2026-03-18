'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TourPlanTab }    from './components/tour-plan-tab'
import { TourConfirmTab } from './components/tour-confirm-tab'
import { TourDayOfTab }   from './components/tour-day-of-tab'

interface Contact {
  id: string
  first_name: string
  last_name: string
  phone: string | null
  buyer_stage: string | null
}

interface SavedProperty {
  id: string
  listing_id: string | null
  notes: string | null
  ai_match_score: number | null
  added_to_tour: boolean
  listings: {
    id: string
    address: string
    city: string | null
    state: string | null
    zip: string | null
    list_price: number | null
    bedrooms: number | null
    bathrooms: number | null
    mls_number: string | null
  } | null
}

interface Tour {
  id: string
  tour_date: string
  status: string
  all_confirmed?: boolean
  ai_plan_narrative?: string | null
  tour_stops: any[]
}

interface ToursClientProps {
  contact: Contact
  agentUserId: string
  brokerageId: string
  savedProperties: SavedProperty[]
  initialTours: Tour[]
  defaultTab?: 'plan' | 'confirm' | 'day-of'
  tourInsights?: {
    positivePatterns?: string[]
    objectionPatterns?: string[]
    pricingSignal?: string
  } | null
}

export function ToursClient({
  contact, agentUserId, brokerageId,
  savedProperties, initialTours, defaultTab = 'plan',
  tourInsights,
}: ToursClientProps) {
  const router   = useRouter()
  const [tab, setTab]     = useState<string>(defaultTab)
  const [tours, setTours] = useState<Tour[]>(initialTours)

  const buyerName = `${contact.first_name} ${contact.last_name}`

  const refresh = useCallback(() => {
    router.refresh()
  }, [router])

  function handleTourCreated() {
    setTab('confirm')
    router.refresh()
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex flex-col h-full">
      {/* Tour Intelligence Strip */}
      <div className="mb-4 p-2 bg-indigo-50 border border-indigo-100 rounded-lg">
        {tourInsights ? (
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs font-medium text-indigo-700">Tour Insights:</span>
            {tourInsights.positivePatterns?.slice(0, 2).map((p, i) => (
              <span key={`pos-${i}`} className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full">
                + {p}
              </span>
            ))}
            {tourInsights.objectionPatterns?.slice(0, 1).map((p, i) => (
              <span key={`obj-${i}`} className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                ! {p}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-indigo-600">
            Tour insights appear after feedback is collected from showings.
          </p>
        )}
      </div>

      <TabsList className="grid w-full grid-cols-3 mb-6">
        <TabsTrigger value="plan">Plan</TabsTrigger>
        <TabsTrigger value="confirm">Confirm</TabsTrigger>
        <TabsTrigger value="day-of">Day-Of</TabsTrigger>
      </TabsList>

      <TabsContent value="plan" className="flex-1 min-h-0 mt-0">
        <TourPlanTab
          contactId={contact.id}
          agentUserId={agentUserId}
          brokerageId={brokerageId}
          buyerName={buyerName}
          savedProperties={savedProperties}
          onTourCreated={handleTourCreated}
        />
      </TabsContent>

      <TabsContent value="confirm" className="flex-1 overflow-y-auto mt-0">
        <TourConfirmTab
          tours={tours}
          contactId={contact.id}
          brokerageId={brokerageId}
          agentUserId={agentUserId}
          onRefresh={refresh}
          onBackToPlan={() => setTab('plan')}
        />
      </TabsContent>

      <TabsContent value="day-of" className="flex-1 overflow-y-auto mt-0">
        <TourDayOfTab
          tours={tours}
          contactId={contact.id}
          brokerageId={brokerageId}
          agentUserId={agentUserId}
          buyerName={buyerName}
          buyerPhone={contact.phone ?? undefined}
          onRefresh={refresh}
        />
      </TabsContent>
    </Tabs>
  )
}
