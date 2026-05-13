import { redirect } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/service'
import { createClient } from '@/lib/supabase/server'
import { ToursClient } from './tours-client'
import { getSavedPropertiesForTour, getBuyerTours } from '@/app/actions/tour-planner'
import { getAIShowingInsights } from '@/app/actions/ai-showing-management'
import { canBuyerScheduleTours } from '@/app/actions/buyer-lifecycle-core'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { TourPipelineStepper } from '@/app/components/shared/TourPipelineStepper'

interface Props {
  params: Promise<{ contactId: string }>
  searchParams: Promise<{ tab?: string }>
}

// Buyer stages that are allowed to access tour planning (BUYER_TOUR_ELIGIBLE or later)
const TOUR_ELIGIBLE_STAGES = [
  'BUYER_TOUR_ELIGIBLE',
  'BUYER_TOURING',
  'BUYER_OFFER_ELIGIBLE',
  'BUYER_OFFER_SUBMITTED',
  'BUYER_UNDER_CONTRACT',
  'BUYER_CLOSED',
]

export default async function BuyerToursPage({ params, searchParams }: Props) {
  const { contactId }  = await params
  const { tab }            = await searchParams

  const serverClient = await createClient()
  const { data: { user } } = await serverClient.auth.getUser()
  if (!user) redirect('/login')

  const supabase = createServiceClient()

  // Load contact
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, phone, buyer_stage, brokerage_id, agent_id')
    .eq('id', contactId)
    .single()

  if (!contact) redirect('/dashboard/buyers')

  // Load agent's brokerage_id
  const { data: agentUser } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  const brokerageId = agentUser?.brokerage_id ?? contact.brokerage_id

  // Gate: buyer must be BUYER_TOUR_ELIGIBLE or later (legacy stage check)
  const isTourEligible = TOUR_ELIGIBLE_STAGES.includes(contact.buyer_stage ?? '')

  if (!isTourEligible) {
    return (
      <div className="p-6 max-w-lg mx-auto mt-12">
        <Card>
          <CardContent className="pt-6 pb-6 text-center space-y-3">
            <p className="text-base font-semibold">Tour Planning Not Yet Available</p>
            <p className="text-sm text-muted-foreground">
              Buyer must complete search setup before tours can be planned.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href={`/contacts/${contactId}`}>
                Go to Financial Verification
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Lifecycle gate check
  const tourGateResult = await canBuyerScheduleTours(contactId)

  // Resolve agentId for insights
  const agentIdentity = await supabase.from("agents").select("id")
    .eq("user_id", user.id).maybeSingle()
  const agentIdForInsights = agentIdentity.data?.id

  // Load saved properties, existing tours, and insights
  const tourInsightsResult = agentIdForInsights
    ? await getAIShowingInsights(agentIdForInsights, {
        start: new Date(Date.now()-30*24*60*60*1000).toISOString().split('T')[0],
        end: new Date().toISOString().split('T')[0]
      })
    : null
  const tourInsights = tourInsightsResult?.success
    ? (tourInsightsResult as any).insights || null : null

  const [savedRes, toursRes] = await Promise.all([
    getSavedPropertiesForTour(contactId),
    getBuyerTours(contactId),
  ])

  const savedProperties = savedRes.success ? (savedRes.properties ?? []) : []
  const tours           = toursRes.success ? (toursRes.tours ?? []) : []

  const validTabs = ['plan', 'confirm', 'day-of'] as const
  const defaultTab = validTabs.includes(tab as any) ? (tab as 'plan' | 'confirm' | 'day-of') : 'plan'

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="mb-6">
        <h1 className="text-xl font-bold">
          Tour Planner — {contact.first_name} {contact.last_name}
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {savedProperties.length} saved propert{savedProperties.length === 1 ? 'y' : 'ies'} ·{' '}
          {tours.length} tour{tours.length === 1 ? '' : 's'} on file
        </p>
      </div>

      {/* Lifecycle gate banner */}
      {!tourGateResult.allowed && (
        <Alert className="border-amber-200 bg-amber-50 mb-4">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-amber-800">
            Tours are locked: {tourGateResult.reason}.{' '}
            <Link href={`/contacts/${contactId}`} className="underline font-medium">
              Complete financial verification
            </Link>{' '}
            to unlock.
          </AlertDescription>
        </Alert>
      )}

      {/* Journey stepper */}
      <TourPipelineStepper
        contactId={contactId}
        savedCount={savedProperties.length}
        tourCount={tours.length}
        buyerStage={contact.buyer_stage}
      />

      {/* AI route optimization nudge */}
      {tours.length > 0 && savedProperties.length > 1 && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between">
          <p className="text-sm text-blue-800">
            <span className="font-medium">AI can optimize your tour route</span>
            {' '}— save drive time and see more homes efficiently
          </p>
          <span className="text-xs text-blue-600 font-medium shrink-0 ml-2">Use route optimizer in Plan tab</span>
        </div>
      )}

      <div className="flex-1 min-h-0">
        <ToursClient
          contact={contact}
          agentUserId={user.id}
          brokerageId={brokerageId}
          savedProperties={savedProperties}
          initialTours={tours}
          defaultTab={defaultTab}
          tourInsights={tourInsights}
          gateBlocked={!tourGateResult.allowed}
        />
      </div>
    </div>
  )
}
