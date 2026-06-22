import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { listLocationsAction, listBrokerageAgentsAction } from "@/app/actions/admin/locations"
import { LocationsClient } from "./locations-client"

export const dynamic = "force-dynamic"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

export default async function LocationsAdminPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ADMIN_ROLES.has(ctx.userType)) redirect("/dashboard")

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
