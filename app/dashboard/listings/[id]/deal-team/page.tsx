import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { redirect } from "next/navigation"
import { DealOwnershipSection } from "@/app/dashboard/transactions/[id]/deal-ownership-section"
import { listDealReviewNotesAction } from "@/app/actions/deal-review-notes"
import { CommissionTermsPanel } from "@/app/dashboard/financials/agent/components/commission-terms-panel"

/**
 * THE LISTING'S DEAL TEAM (wave 153): who works the listing (the agent takes charge, the TC assists, compliance reviews
 * and makes notes — owner ruling 8), the review notes, and the listing's commission terms (changed only through the
 * governed door by a seat attached to the listing or an admin, never after close — owner ruling 4).
 *
 * Its own page because the lifecycle page sits at the module-graph budget (scripts/proxy-graph-budget-guard.ts, 1300):
 * the lifecycle page links here instead of mounting these panels. Every read below is session-gated — the listing row
 * through RLS + the session's client, the notes through the session-gated door (listDealReviewNotesAction), the terms
 * through the commission-term actions — so this page decides nothing about who may see what.
 */
export default async function ListingDealTeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: listingId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: listing, error } = await supabase.from("listings").select("id, address, city, state").eq("id", listingId).maybeSingle()
  if (error) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
        <p className="text-sm text-muted-foreground">This listing could not be loaded right now. Nothing was changed; reload the page to try again.</p>
      </div>
    )
  }
  if (!listing) redirect("/dashboard/listings")

  const rolesAndNotes = await listDealReviewNotesAction({ entityType: "listing", entityId: listingId })
  const label = [listing.address, listing.city, listing.state].filter(Boolean).join(", ") || null

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <div className="space-y-1">
        <Link href={`/dashboard/listings/${listingId}/lifecycle`} className="text-sm text-muted-foreground hover:underline">← Back to the listing</Link>
        <h1 className="text-2xl font-semibold">Deal team and commission</h1>
        {label && <p className="text-sm text-muted-foreground">{label}</p>}
      </div>
      <DealOwnershipSection entityType="listing" entityId={listingId} initial={rolesAndNotes} />
      <CommissionTermsPanel listingId={listingId} label={label} />
    </div>
  )
}
