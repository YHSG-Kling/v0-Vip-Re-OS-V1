import { Suspense } from "react"
import { createClient } from "@/lib/supabase/server"
import { redirect, notFound } from "next/navigation"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { markMessagesRead } from "@/app/actions/portal-messages"
import { MessagesClient } from "./messages-client"
import { Skeleton } from "@/components/ui/skeleton"

interface PageProps {
  params: Promise<{ contactId: string }>
}

// Loading skeleton for messages
function MessagesSkeleton() {
  return (
    <div className="flex flex-col h-[calc(100vh-200px)]">
      {/* Agent card skeleton */}
      <div className="p-4 border-b">
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      </div>
      {/* Messages skeleton */}
      <div className="flex-1 p-4 space-y-4">
        <div className="flex justify-start">
          <Skeleton className="h-16 w-48 rounded-2xl" />
        </div>
        <div className="flex justify-end">
          <Skeleton className="h-12 w-56 rounded-2xl" />
        </div>
        <div className="flex justify-start">
          <Skeleton className="h-20 w-64 rounded-2xl" />
        </div>
      </div>
      {/* Composer skeleton */}
      <div className="p-4 border-t">
        <Skeleton className="h-11 w-full" />
      </div>
    </div>
  )
}

export default async function PortalMessagesPage({ params }: PageProps) {
  const { contactId } = await params
  const supabase = await createClient()

  // Validate auth
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    redirect("/login")
  }

  // Get contact with agent info
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select(`
      id,
      first_name,
      last_name,
      contact_type,
      buyer_stage,
      agent_id,
      brokerage_id,
      agent:agents(
        id,
        user_id,
        phone_mobile,
        phone_office,
        profile_image_url
      )
    `)
    .eq("id", contactId)
    .single()

  if (contactError || !contact) {
    notFound()
  }

  // Get agent's full name from users table
  const agentRecord = Array.isArray(contact.agent) ? contact.agent[0] : contact.agent
  let agentName = "Your Agent"
  let agentEmail: string | null = null
  if (agentRecord?.user_id) {
    const { data: agentUser } = await supabase
      .from("users")
      .select("first_name, last_name, email")
      .eq("id", agentRecord.user_id)
      .single()

    if (agentUser) {
      agentName = [agentUser.first_name, agentUser.last_name].filter(Boolean).join(" ") || "Your Agent"
      agentEmail = agentUser.email
    }
  }

  // Determine if current user is the agent (has agent identity)
  const currentAgentId = await resolveAgentId(supabase, user.id)
  const isAgent = currentAgentId === contact.agent_id

  // Get active transaction context if exists
  let transactionContext: { id: string; address: string; stage: string } | null = null
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, property_address, stage")
    .or(`contact_id.eq.${contactId},buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    .in("status", ["active", "under_contract"])
    .limit(1)

  if (transactions?.[0]) {
    transactionContext = {
      id: transactions[0].id,
      address: transactions[0].property_address || "Transaction",
      stage: transactions[0].stage || "Active",
    }
  }

  // Mark messages as read based on who is viewing
  // - If agent is viewing: mark client_to_agent messages (from contact) as read
  // - If contact is viewing: mark agent_to_client messages (from agent) as read
  await markMessagesRead({
    contactId,
    direction: isAgent ? "client_to_agent" : "agent_to_client",
  })

  // Prepare agent contact card data
  const agentCard = {
    name: agentName,
    email: agentEmail,
    phone: agentRecord?.phone_mobile || agentRecord?.phone_office || null,
    imageUrl: agentRecord?.profile_image_url || null,
    initials: getInitials(agentName),
  }

  const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Contact"

  return (
    <div className="h-[calc(100vh-200px)] flex flex-col">
      <Suspense fallback={<MessagesSkeleton />}>
        <MessagesClient
          contactId={contactId}
          contactName={contactName}
          agentCard={agentCard}
          transactionContext={transactionContext}
          isAgent={isAgent}
        />
      </Suspense>
    </div>
  )
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)
}
