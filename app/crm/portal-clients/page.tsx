// /crm/portal-clients — the TENANT's portal-clients roster (mirror of the
// round-31 staff view on the god console). Which of my contacts can use the
// client portal, when they accepted, when they were last active, and which
// invites are still pending. The action (listMyPortalClientsAction) gates to
// working seats of the caller's brokerage and scopes to their tenancy.
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { PortalClientsRoster } from "./portal-clients-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Portal Clients | CRM",
  description: "Which of your contacts have client-portal access, their activity, and pending invites.",
}

export default async function PortalClientsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Portal Clients</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every contact with client-portal access, their last portal activity, and pending invites.
        </p>
      </div>
      <PortalClientsRoster />
    </div>
  )
}
