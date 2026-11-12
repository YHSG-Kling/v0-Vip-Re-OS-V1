import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listPendingOfferIntentsForAgent } from "@/app/actions/offer-intents"
import { BuyerOfferRequestsList } from "@/app/components/offer/buyer-offer-requests-list"
import { listOutsideOffers } from "@/app/actions/buyer-offer/outside-offer-loop"
import { OutsideOfferThreads } from "./outside-offer-threads"

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
  // Offers on listings outside this brokerage — the send / reply / counter loop (wave 143A).
  // Tenancy and authority are resolved inside the action from the session.
  const outside = await listOutsideOffers()

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
      <div className="px-6 py-4 border-t border-border">
        <h2 className="text-sm font-semibold">Offers on outside listings</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Send the offer to the verified listing agent, read their reply, and run the counter rounds. The platform never accepts or signs for anyone — it asks you to confirm what each reply means.
        </p>
      </div>
      <div className="p-6 pt-2">
        {!outside.success && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {outside.error}
          </div>
        )}
        <OutsideOfferThreads initialThreads={outside.threads} />
      </div>
    </div>
  )
}
