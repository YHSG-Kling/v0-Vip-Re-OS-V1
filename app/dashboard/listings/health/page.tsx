import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { loadListingHealthBoard } from "./actions"
import { ListingHealthBoardClient } from "./health-client"

export const metadata = {
  title: "Listing Health · VIP Real Estate OS",
  description: "Every listing you have, sorted by how worried you should be — with AI-drafted seller emails ready to send.",
}

/**
 * /dashboard/listings/health — the agent's "save my listings before they
 * go stale" surface. Pulls the latest listing_health_scores row per
 * listing plus any open listing_health_interventions, sorts everything
 * critical→at_risk→watch→healthy, and lets the agent take action with
 * one click.
 */
export default async function ListingHealthPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const board = await loadListingHealthBoard()
  if ("error" in board) redirect("/dashboard/onboarding")

  return <ListingHealthBoardClient board={board} />
}
