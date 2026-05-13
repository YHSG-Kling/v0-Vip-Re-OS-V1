import { redirect } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { createClient }        from "@/lib/supabase/server"
import { OffersClient }        from "./offers-client"
import { canBuyerSubmitOffers } from "@/app/actions/buyer-lifecycle-core"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertTriangle } from "lucide-react"
import Link from "next/link"

const OFFER_ELIGIBLE_STAGES = [
  "BUYER_OFFER_ELIGIBLE",
  "BUYER_OFFER_SUBMITTED",
  "BUYER_UNDER_CONTRACT",
  "BUYER_CLOSED",
  "BUYER_LIFETIME",
]

interface PageProps {
  params: Promise<{ contactId: string }>
}

export default async function BuyerOffersPage({ params }: PageProps) {
  const { contactId: buyerId } = await params

  const serverClient = await createClient()
  const { data: { user } } = await serverClient.auth.getUser()
  if (!user) redirect("/login")

  const supabase = createServiceClient()

  // Auth: agent owns buyer or broker/admin in same brokerage
  const { data: agentProfile } = await supabase
    .from("users")
    .select("id, brokerage_id, role")
    .eq("id", user.id)
    .single()

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, buyer_stage, brokerage_id, agent_id")
    .eq("id", buyerId)
    .is("deleted_at", null)
    .single()

  if (!contact) redirect("/dashboard/buyers")

  const isOwner  = contact.agent_id === user.id
  const isBroker = ["broker", "admin"].includes(agentProfile?.role ?? "") &&
    agentProfile?.brokerage_id === contact.brokerage_id

  if (!isOwner && !isBroker) redirect("/dashboard/buyers")

  // Gate: must be BUYER_OFFER_ELIGIBLE or later
  if (!OFFER_ELIGIBLE_STAGES.includes(contact.buyer_stage ?? "")) {
    redirect(`/contacts/${buyerId}?gate=offer_not_eligible`)
  }

  // Lifecycle gate check
  const offerGateResult = await canBuyerSubmitOffers(buyerId)

  // Load existing offers
  const { data: offers } = await supabase
    .from("offers")
    .select(`
      id, property_address, offer_price, status, esign_status,
      esign_sent_at, form_source, esign_provider, strategy_recommendation_id,
      created_at, submitted_at, closing_date, financing_type,
      earnest_money, contingencies, listing_id
    `)
    .eq("contact_id", buyerId)
    .eq("brokerage_id", contact.brokerage_id)
    .order("created_at", { ascending: false })

  const brokerageId  = contact.brokerage_id ?? agentProfile?.brokerage_id ?? ""
  const contactName  = `${contact.first_name} ${contact.last_name}`
  const contactEmail = contact.email ?? ""

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Lifecycle gate banner */}
      {!offerGateResult.allowed && (
        <Alert className="border-amber-200 bg-amber-50 m-4 mb-0">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-amber-800">
            Offers are locked: {offerGateResult.reason}.{" "}
            <Link href={`/contacts/${buyerId}`} className="underline font-medium">
              Complete financial verification
            </Link>{" "}
            to unlock.
          </AlertDescription>
        </Alert>
      )}
      <OffersClient
        contactId={buyerId}
        brokerageId={brokerageId}
        agentUserId={user.id}
        contactName={contactName}
        contactEmail={contactEmail}
        initialOffers={offers ?? []}
        buyerStage={contact.buyer_stage ?? "BUYER_OFFER_ELIGIBLE"}
        disableOfferCreation={!offerGateResult.allowed}
      />
    </div>
  )
}
