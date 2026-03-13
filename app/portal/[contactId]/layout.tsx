import type React from "react"
import { Suspense } from "react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import {
  determinePortalView,
  determinePortalModules,
  logPortalAccess,
  buildPortalNav,
  type PortalView,
} from "@/lib/kernel/portal"
import { resolveContactOwnerAgent } from "@/lib/identity/resolve-contact-owner"
import PortalNav from "@/components/portal/PortalNav"
import PortalUserMenu from "@/components/portal/PortalUserMenu"
import PortalAIAssistant from "@/components/portal/PortalAIAssistant"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

// View badge labels
const VIEW_LABELS: Record<PortalView, string> = {
  buyer: "Buyer",
  seller: "Seller",
  lifetime: "Homeowner",
}

// View badge colors
const VIEW_COLORS: Record<PortalView, string> = {
  buyer: "bg-blue-100 text-blue-800",
  seller: "bg-green-100 text-green-800",
  lifetime: "bg-purple-100 text-purple-800",
}

// Loading skeleton for nav
function NavSkeleton() {
  return (
    <div className="flex gap-2 p-4 border-b">
      {[...Array(6)].map((_, i) => (
        <Skeleton key={i} className="h-10 w-24" />
      ))}
    </div>
  )
}

export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Fetch contact (without broken embedded join)
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, brokerage_id, contact_type, buyer_stage, agent_id, created_at, name, contact_persona")
    .eq("id", contactId)
    .single()

  if (contactError || !contact) {
    redirect("/portal?error=contact_not_found")
  }

  // Resolve agent via kernel identity function
  const agentData = contact?.agent_id
    ? await resolveContactOwnerAgent(supabase, contact.agent_id)
    : null

  // Kernel-driven portal view determination
  const [view, modules] = await Promise.all([
    determinePortalView(supabase, contactId),
    determinePortalModules(supabase, contactId),
  ])

  // Build nav from kernel function
  const navItems = buildPortalNav(view, modules, contactId)

  // Log portal access (non-blocking)
  logPortalAccess(supabase, contactId, "layout", "view", agentData?.id).catch(() => {})

  // Derive display values
  const contactName = contact.first_name || contact.name || "Guest"
  const agentName = agentData?.full_name || "Your Agent"
  const isBuyer = view === "buyer"
  const isSeller = view === "seller"
  const persona = contact.contact_persona || "other"

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">
                Welcome, {contactName}
              </h1>
              <Badge className={VIEW_COLORS[view]} variant="secondary">
                {VIEW_LABELS[view]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Your agent: {agentName}
            </p>
          </div>
          <PortalUserMenu contact={contact} contactId={contactId} agentData={agentData} />
        </div>
      </header>

      <Suspense fallback={<NavSkeleton />}>
        <PortalNav items={navItems} />
      </Suspense>

      <main className="container mx-auto px-4 py-8">{children}</main>

      <PortalAIAssistant
        contact={contact}
        contactId={contactId}
        isBuyer={isBuyer}
        isSeller={isSeller}
        persona={persona}
      />
    </div>
  )
}
