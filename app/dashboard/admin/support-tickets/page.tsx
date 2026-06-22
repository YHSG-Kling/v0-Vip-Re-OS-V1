import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { listBrokerageTickets } from "@/app/actions/support"
import { SupportQueueClient } from "./support-queue-client"

export const dynamic = "force-dynamic"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead", "support"])

export default async function SupportTicketsAdminPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ADMIN_ROLES.has(ctx.userType)) redirect("/dashboard")

  const res = await listBrokerageTickets()
  return <SupportQueueClient initialTickets={res.ok ? res.tickets : []} loadError={res.ok ? null : res.error} />
}
