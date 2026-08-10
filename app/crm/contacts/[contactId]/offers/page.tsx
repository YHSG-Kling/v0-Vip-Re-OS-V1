import { redirect } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { createClient }        from "@/lib/supabase/server"
import { OffersClient }        from "./offers-client"
import { canBuyerSubmitOffers } from "@/app/actions/buyer-lifecycle-core"
import { getBuyerOffers }       from "@/app/actions/buyer-offers"
import { resolveAgentId }       from "@/lib/kernel/agent-identity"
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
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, buyer_stage, brokerage_id, agent_id")
    .eq("id", buyerId)
    .is("deleted_at", null)
    .single()

  if (!contact) redirect("/crm?contact_type=buyer")

  // ACCESS DEFECT FIXED (w6s3, lesson 7 — disjoint id spaces): this compared
  // `contact.agent_id` (an **agents.id**) against `user.id` (a **users.id**), so
  // `isOwner` was ALWAYS false and the buyer's own agent was redirected away from
  // their own buyer's offers page unless they also happened to be a broker/admin.
  // The users.id is resolved to the agents.id before the comparison.
  const callerAgentId = await resolveAgentId(supabase, user.id)
  const isOwner  = !!callerAgentId && contact.agent_id === callerAgentId
  const isBroker = ["broker", "broker_owner", "admin", "superadmin"].includes(agentProfile?.user_type ?? "") &&
    agentProfile?.brokerage_id === contact.brokerage_id

  if (!isOwner && !isBroker) redirect("/crm?contact_type=buyer")

  // Gate: must be BUYER_OFFER_ELIGIBLE or later
  if (!OFFER_ELIGIBLE_STAGES.includes(contact.buyer_stage ?? "")) {
    redirect(`/crm/contacts/${buyerId}?gate=offer_not_eligible`)
  }

  // Lifecycle gate check
  const offerGateResult = await canBuyerSubmitOffers(buyerId)

  // Load existing offers through the SURVIVOR reader
  // (`app/actions/buyer-offers.ts:getBuyerOffers`) rather than the inline
  // service-client copy that used to live here. That copy duplicated the query and
  // therefore the tenant rule; the action resolves the tenant from the contact row
  // via `requireContactAccess`, which is the invariant this lane is built on — a
  // buyer's offer_price / earnest_money / contingencies / financing is the most
  // commercially damaging read in the product. `listing_id` was ported onto the
  // survivor's projection so nothing this page renders was lost.
  const offersRes = await getBuyerOffers(buyerId)
  const offers = offersRes.success ? (offersRes.offers ?? []) : []

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
            <Link href={`/crm/contacts/${buyerId}`} className="underline font-medium">
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
