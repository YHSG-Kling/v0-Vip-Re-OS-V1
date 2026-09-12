import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listPendingOfferIntentsForAgent } from "@/app/actions/offer-intents"
import { BuyerOfferRequestsList } from "@/app/components/offer/buyer-offer-requests-list"

export const dynamic = "force-dynamic"
export const metadata = { title: "Buyer Offer Requests" }

/**
 * THE AGENT'S BUYER OFFER REQUESTS QUEUE — the aggregate reader for
 * `offer_intents` (m619) across every buyer assigned to this agent (or, for a
 * brokerage admin, the whole tenant). A buyer's per-contact "Buyer offer
 * requests" panel (app/crm/contacts/[contactId]/offers) shows the same rows
 * scoped to one buyer; this page is the work queue an agent checks across all
 * of them. Tenancy/scope is resolved entirely inside the server action from
 * the session — this page passes nothing in.
 */
export default async function BuyerOfferRequestsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const res = await listPendingOfferIntentsForAgent()
  const intents = res.success ? res.intents : []

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <div className="px-6 py-4 border-b border-border">
        <h1 className="text-sm font-semibold">Buyer Offer Requests</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Buyers who hit "submit an offer" in their portal. They never see the forms — acknowledge, dismiss, or start the offer yourself.
        </p>
      </div>
      <div className="p-6">
        {!res.success && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {res.error}
          </div>
        )}
        <BuyerOfferRequestsList
          initialIntents={intents}
          showLinkToContact
          emptyMessage="No pending buyer offer requests right now."
        />
      </div>
    </div>
  )
}
