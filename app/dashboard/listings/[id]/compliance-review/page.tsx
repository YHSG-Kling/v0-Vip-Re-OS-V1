import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { redirect } from "next/navigation"
import { RepresentationReviewPanel } from "@/app/dashboard/compliance/queue/representation-review-panel"

/**
 * THE LISTING AGREEMENT'S COMPLIANCE REVIEW, ON THE LISTING (wave 156, lane 156B round 2).
 *
 * The listing-side affordance of the executed-packet review: the listing agent and its coordinator see the status, the compared
 * terms and every reason with its repair; a reviewer — including a SOLO agent who is the account's principal and so its own
 * reviewer — approves or holds it here as well as on the compliance queue (app/dashboard/compliance/queue). Its own page, like the
 * deal-team page beside it, because the lifecycle page sits at the module-graph budget. Every read and decision is session-gated
 * inside app/actions/compliance/representation-review.ts; this page decides nothing about who may see what.
 */
export default async function ListingComplianceReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: listingId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data: listing, error } = await supabase.from("listings").select("id, address, city, state").eq("id", listingId).maybeSingle()
  if (error) {
    return <div className="mx-auto max-w-4xl p-4 md:p-6"><p className="text-sm text-muted-foreground">This listing could not be loaded right now. Nothing was changed; reload the page to try again.</p></div>
  }
  if (!listing) redirect("/dashboard/listings")
  const label = [listing.address, listing.city, listing.state].filter(Boolean).join(", ") || null
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <div className="space-y-1">
        <Link href={`/dashboard/listings/${listingId}/lifecycle`} className="text-sm text-muted-foreground hover:underline">← Back to the listing</Link>
        <h1 className="text-2xl font-semibold">Listing agreement compliance review</h1>
        {label && <p className="text-sm text-muted-foreground">{label}</p>}
      </div>
      <RepresentationReviewPanel record="listing_agreement" subjectId={listingId} />
    </div>
  )
}
