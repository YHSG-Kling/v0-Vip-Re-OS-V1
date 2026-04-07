import { redirect } from "next/navigation"

/**
 * Listing detail root — immediately redirect to the lifecycle subpage.
 * This prevents the "spins forever" issue when navigating to /dashboard/listings/[id].
 */
export default async function ListingDetailRootPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/dashboard/listings/${id}/lifecycle`)
}
