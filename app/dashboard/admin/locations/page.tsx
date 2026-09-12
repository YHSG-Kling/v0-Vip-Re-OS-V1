import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { listLocationsAction, listBrokerageAgentsAction } from "@/app/actions/admin/locations"
import { LocationsClient } from "./locations-client"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

export default async function LocationsAdminPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!isAdminOrBroker({ user_type: ctx.userType })) redirect("/dashboard")

  const [locRes, agentRes] = await Promise.all([listLocationsAction(), listBrokerageAgentsAction()])
  return (
    <LocationsClient
      initialLocations={locRes.ok ? locRes.locations : []}
      initialUnassigned={locRes.ok ? locRes.unassignedCount : 0}
      initialAgents={agentRes.ok ? agentRes.agents : []}
      loadError={locRes.ok ? null : locRes.error}
    />
  )
}
