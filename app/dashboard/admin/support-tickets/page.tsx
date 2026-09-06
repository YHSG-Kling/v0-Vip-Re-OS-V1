import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { listBrokerageTickets } from "@/app/actions/support"
import { isTicketLane, type TicketLane } from "@/lib/support/ticket-constants"
import { SupportQueueClient } from "./support-queue-client"

export const dynamic = "force-dynamic"

// SCOPE LADDER (kept inline — mirrors app/actions/support.ts, which admits the
// storable platform 'support' user_type): 'superadmin' removed — dead as
// users.user_type (0 live rows); broker_owner added.
const ADMIN_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin", "team_lead", "support"])

/**
 * THE OFFICE QUEUE, ONE LANE AT A TIME.
 *
 * Owner ruling: an agent or a vendor raises a ticket to the brokerage's office staff
 * (user_to_brokerage), and separately the brokerage raises a ticket to the platform
 * (tenant_to_platform). Those are two queues with two different people answering, so
 * this page draws ONE of them and names which. It used to list both together, which
 * showed a brokerage its own open questions to the platform as though they were work
 * waiting on its desk.
 *
 * The default is the office lane, because that is the queue this page's staff answer.
 */
const DEFAULT_LANE: TicketLane = "user_to_brokerage"

export default async function SupportTicketsAdminPage({
  searchParams,
}: {
  searchParams?: Promise<{ lane?: string }>
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ADMIN_ROLES.has(ctx.userType)) redirect("/dashboard")

  const sp = (await searchParams) ?? {}
  const lane: TicketLane = isTicketLane(sp.lane) ? sp.lane : DEFAULT_LANE

  const res = await listBrokerageTickets({ lane })
  return (
    <SupportQueueClient
      lane={lane}
      initialTickets={res.ok ? res.tickets : []}
      loadError={res.ok ? null : res.error}
    />
  )
}
