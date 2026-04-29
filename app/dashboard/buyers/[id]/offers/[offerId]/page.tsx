import { redirect, notFound } from "next/navigation"
import Link                   from "next/link"
import { createClient }       from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadOfferWorkspace }  from "@/lib/kernel/offers"
import { OfferWorkspace }      from "@/app/components/features/offers/offer-workspace"
import { ChevronLeft }         from "lucide-react"

/**
 * /dashboard/buyers/[id]/offers/[offerId]
 *
 * Offer detail page — RSC shell that loads server data via loadOfferWorkspace()
 * then renders the OfferWorkspace client component.
 *
 * Auth rules:
 *   - Must be the owning agent OR a broker/admin in the same brokerage.
 *   - Offer contact_id must match the [id] route param (prevents cross-buyer access).
 */

interface PageProps {
  params: Promise<{ id: string; offerId: string }>
}

export default async function OfferDetailPage({ params }: PageProps) {
  const { id: contactId, offerId } = await params

  // ── Auth ──────────────────────────────────────────────────────────────────
  const serverClient = await createClient()
  const { data: { user } } = await serverClient.auth.getUser()
  if (!user) redirect("/login")

  const supabase = createServiceClient()

  const { data: agentProfile } = await supabase
    .from("users")
    .select("id, brokerage_id, role")
    .eq("id", user.id)
    .maybeSingle()

  if (!agentProfile) redirect("/login")

  // ── Load offer workspace via kernel ──────────────────────────────────────
  const result = await loadOfferWorkspace(offerId)

  if (!result.success || !result.data) {
    notFound()
  }

  const { offer, listing, contact, history } = result.data

  // ── Ownership gate ────────────────────────────────────────────────────────
  // Offer must belong to the contact in the URL param
  if (offer.contact_id !== contactId) {
    redirect(`/dashboard/buyers/${contactId}/offers`)
  }

  const isOwner  = offer.agent_id === user.id
  const isBroker = ["broker", "admin"].includes(agentProfile.role ?? "") &&
    agentProfile.brokerage_id === offer.brokerage_id

  if (!isOwner && !isBroker) {
    redirect(`/dashboard/buyers/${contactId}/offers`)
  }

  // ── Back-link breadcrumb ─────────────────────────────────────────────────
  const contactName = contact
    ? `${contact.first_name} ${contact.last_name}`
    : "Buyer"

  const propertyLabel = offer.property_address ?? listing?.address ?? "Offer"

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 px-6 py-4 border-b border-border bg-background sticky top-0 z-10">
        <Link
          href={`/dashboard/buyers/${contactId}/offers`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          {contactName}
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium text-foreground truncate max-w-xs">
          {propertyLabel}
        </span>
      </div>

      {/* Workspace */}
      <div className="flex-1 overflow-auto">
        <OfferWorkspace
          offer={offer}
          listing={listing}
          contact={contact}
          history={history}
          agentId={agentProfile.id}
          brokerageId={agentProfile.brokerage_id ?? ""}
          buyerPath={`/dashboard/buyers/${contactId}/offers`}
        />
      </div>
    </div>
  )
}
