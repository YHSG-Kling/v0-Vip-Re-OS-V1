import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getTenantConnectionsAction } from "@/app/actions/tenant-connections"
import { LeadSourcesClient } from "./lead-sources-client"

export const dynamic = "force-dynamic"
export const metadata = { title: "Lead Sources & Listing Feeds" }

// TENANT-FINISHED connections: the brokerage brings its vendor relationships
// (MLS board, ListHub, ShowingTime, Zillow/realtor.com/Opcity lead sources);
// this page is where they finish the setup.
//
// Wave 69 owner ruling (verbatim): "rentcast is platform provided but idx is for tenant
// connected if the tenant has this connection instead of rentcast option for for sale
// properties. the setting page should only allow them to setup their idx connection." This
// page no longer reads or writes brokerage_settings.active_listing_sources at all — that
// column is platform-staff-managed now (app/actions/superadmin/active-listing-sources.ts);
// the idx-vs-rentcast order is DERIVED (lib/buyer-search/listing-source-order.ts) and the only
// tenant-facing control here is the IDX Broker connection form, mounted by LeadSourcesClient.
export default async function LeadSourcesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const res = await getTenantConnectionsAction()
  if (!res.ok) return <div className="p-6 text-red-600">Brokerage admin access required.</div>

  return (
    <LeadSourcesClient
      connections={res.connections}
      portalLeads={res.portalLeads}
    />
  )
}
