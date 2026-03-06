import { redirect } from "next/navigation"
import Link         from "next/link"
import { createClient } from "@/lib/supabase/server"
import { SearchClient } from "./search-client"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function BuyerSearchPage({ params }: PageProps) {
  const { id: buyerId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const [{ data: contact }, { data: interests }] = await Promise.all([
    supabase.from("contacts").select("id, first_name, last_name, contact_persona, brokerage_id").eq("id", buyerId).single(),
    supabase.from("property_interests").select("*").eq("contact_id", buyerId).maybeSingle(),
  ])

  if (!contact) redirect(`/dashboard/buyers`)

  const brokerageId = contact.brokerage_id ?? ""
  const buyerName   = `${contact.first_name} ${contact.last_name}`

  return (
    <div className="flex flex-col h-full min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card px-6 py-4 flex items-center gap-4">
        <Link
          href={`/dashboard/buyers/${buyerId}`}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Back to buyer overview"
        >
          <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </Link>
        <div>
          <h1 className="text-lg font-semibold">Property Search</h1>
          <p className="text-xs text-muted-foreground">{buyerName}</p>
        </div>
      </div>

      {/* Search client */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <SearchClient
          buyerId={buyerId}
          brokerageId={brokerageId}
          agentUserId={user.id}
          initialInterests={interests ?? null}
          buyerPersona={contact.contact_persona ?? null}
        />
      </div>
    </div>
  )
}
