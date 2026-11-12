import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { listBrokerageTickets } from "@/app/actions/support"
import { isTicketLane, type TicketLane } from "@/lib/support/ticket-constants"
import { SUPPORT_DESK_USER_TYPES } from "@/lib/support/ticket-scope"
import { SupportQueueClient } from "./support-queue-client"
import { RoleGateNotice } from "@/app/components/shared/role-gate-notice"

export const dynamic = "force-dynamic"

// TOMBSTONE (wave 142, lane 142A; §6): a second `ADMIN_ROLES = new Set([...six
// strings...])` literal stood here, "mirroring" app/actions/support.ts by hand.
// Survivor: lib/support/ticket-scope.ts:SUPPORT_DESK_USER_TYPES (the admin roster
// spread + 'support'). This page only decides what to SHOW; the action decides what
// is ALLOWED and pins every read to the caller's own tenant unless the platform
// 'support' capability (platform_role, never a user_type) admits them across.

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
  if (!SUPPORT_DESK_USER_TYPES.has(ctx.userType)) return <RoleGateNotice surface="Support tickets" audience="your brokerage's office staff and platform support" />

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
