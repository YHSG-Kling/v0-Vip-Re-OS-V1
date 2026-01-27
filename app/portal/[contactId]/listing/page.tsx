import { createClient } from "@/lib/supabase/server"
import SellerListingDashboard from "@/components/portal/SellerListingDashboard"
import { redirect } from "next/navigation"

export default async function ListingPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Fetch contact with listing
  const { data: contact } = await supabase.from("contacts").select("*, listings(*)").eq("id", contactId).single()

  if (!contact) {
    redirect("/")
  }

  const listing = contact.listings?.[0]

  // Fetch showing requests for this listing
  const { data: showings } = listing
    ? await supabase
        .from("showing_requests")
        .select("*")
        .eq("listing_id", listing.id)
        .order("requested_date", { ascending: false })
        .limit(20)
    : { data: [] }

  // Fetch offers for this listing
  const { data: offers } = listing
    ? await supabase.from("offers").select("*").eq("listing_id", listing.id).order("created_at", { ascending: false })
    : { data: [] }

  return (
    <SellerListingDashboard
      contact={contact}
      listing={listing}
      showings={showings || []}
      offers={offers || []}
      contactId={contactId}
    />
  )
}
