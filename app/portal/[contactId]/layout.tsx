import type React from "react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { FileText, Home, DollarSign, Users, Calendar, Route, Share2 } from "lucide-react"
import PortalNav from "@/components/portal/PortalNav"
import PortalUserMenu from "@/components/portal/PortalUserMenu"
import PortalAIAssistant from "@/components/portal/PortalAIAssistant"

// Helper function for persona taglines
function getPersonaTagline(persona: string) {
  const taglines: Record<string, string> = {
    first_time_buyer: "Your Real Estate Portal - First Home Journey",
    military_buyer: "Your Real Estate Portal - Serving Those Who Serve",
    luxury_buyer: "Your Real Estate Portal - Distinctive Properties",
    investor: "Your Real Estate Portal - Investment Dashboard",
    first_time_seller: "Your Real Estate Portal - Selling Made Simple",
    motivated_seller: "Your Real Estate Portal - Fast Track Sale",
    luxury_seller: "Your Real Estate Portal - Premium Marketing",
    divorce: "Your Real Estate Portal - Neutral Support",
    probate: "Your Real Estate Portal - Estate Guidance",
    senior: "Your Real Estate Portal - Thoughtful Transition",
    relocating: "Your Real Estate Portal - Relocation Guide",
    fsbo: "Your Real Estate Portal - Professional Support",
    expired: "Your Real Estate Portal - Fresh Start",
    empty_nester: "Your Real Estate Portal - Right-Sizing",
    upsizers: "Your Real Estate Portal - More Space Awaits",
    remote_seller: "Your Real Estate Portal - Remote Management",
    other: "Your Real Estate Portal",
  }
  return taglines[persona] || "Your Real Estate Portal"
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

  // Fetch persona for personalized navigation
  const { data: contact } = await supabase.from("contacts").select("*, listings(*)").eq("id", contactId).single()

  if (!contact) {
    redirect("/")
  }

  const isSeller = contact.listings && contact.listings.length > 0
  const isBuyer = contact.contact_type === "buyer" || !isSeller
  const persona = contact.contact_persona || "other"

  const navItems = [
    {
      label: "Dashboard",
      href: `/portal/${contactId}`,
      icon: Home,
    },
    {
      label: "My Journey",
      href: `/portal/${contactId}/journey`,
      icon: Route,
    },
    {
      label: "Calendar",
      href: `/portal/${contactId}/calendar`,
      icon: Calendar,
    },
    {
      label: "Documents",
      href: `/portal/${contactId}/documents`,
      icon: FileText,
    },
  ]

  // Personas that support family/collaborative search
  const familySearchPersonas = ["first_time_buyer", "military_buyer", "upsizing", "relocating", "repeat_buyer"]
  const showFamilySearch = familySearchPersonas.includes(persona)

  if (isBuyer) {
    navItems.push({
      label: "Properties",
      href: `/portal/${contactId}/properties`,
      icon: Home,
    })
    
    // Only show Family Search for family-oriented personas
    if (showFamilySearch) {
      navItems.push({
        label: "Family Search",
        href: `/portal/${contactId}/search`,
        icon: Users,
      })
    }
    
    navItems.push(
      {
        label: "My Offer",
        href: `/portal/${contactId}/my-offer`,
        icon: DollarSign,
      },
    )
  }

  if (isSeller) {
    navItems.push(
      {
        label: "My Listing",
        href: `/portal/${contactId}/listing`,
        icon: Home,
      },
      {
        label: "Social Posts",
        href: `/portal/${contactId}/social`,
        icon: Share2,
      },
      {
        label: "Offers",
        href: `/portal/${contactId}/offers`,
        icon: DollarSign,
      },
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Welcome, {contact.first_name || contact.name}</h1>
            <p className="text-sm text-muted-foreground">{getPersonaTagline(persona)}</p>
          </div>
          <PortalUserMenu contact={contact} contactId={contactId} />
        </div>
      </header>

      <PortalNav items={navItems} />

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
