import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getTenantConnectionsAction } from "@/app/actions/tenant-connections"
import { getActiveListingSourcesSetting } from "@/app/actions/settings/active-listing-sources"
import { LeadSourcesClient } from "./lead-sources-client"

export const dynamic = "force-dynamic"
export const metadata = { title: "Lead Sources & Listing Feeds" }

// TENANT-FINISHED connections: the brokerage brings its vendor relationships
// (MLS board, ListHub, ShowingTime, Zillow/realtor.com/Opcity lead sources);
// this page is where they finish the setup.
export default async function LeadSourcesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const res = await getTenantConnectionsAction()
  if (!res.ok) return <div className="p-6 text-red-600">Brokerage admin access required.</div>

  // Wave 68 — active-listing source order for regular-buyer smart search (owner: "that is a lot
  // of money to spend for leads…"). A read failure here falls back to the safe default inside
  // getActiveListingSourcesSetting itself; the page never blocks on it.
  const listingSources = await getActiveListingSourcesSetting()

  return (
    <LeadSourcesClient
      connections={res.connections}
      portalLeads={res.portalLeads}
      initialActiveListingSources={listingSources.sources}
    />
  )
}
