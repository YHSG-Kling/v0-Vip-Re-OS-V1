import { redirect } from "next/navigation"
import Link         from "next/link"
import { createClient } from "@/lib/supabase/server"
import { SearchClient } from "./search-client"
import { Button } from "@/components/ui/button"

interface PageProps {
  params: Promise<{ contactId: string }>
}

export default async function BuyerSearchPage({ params }: PageProps) {
  const { contactId: buyerId } = await params
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
          href={`/contacts/${buyerId}`}
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

      {/* AI matching strip */}
      {interests && (
        <div className="px-6 py-3 bg-blue-50 border-b border-blue-100 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-blue-700 flex items-center gap-1">
              AI is matching homes for {buyerName.split(' ')[0]}
            </p>
            <p className="text-xs text-blue-600 mt-0.5 truncate">
              {[
                interests.zip_codes?.length > 0 && interests.zip_codes.slice(0,2).join(', '),
                interests.max_price && `up to $${(interests.max_price/1000).toFixed(0)}K`,
                interests.min_bedrooms && `${interests.min_bedrooms}+ bed`,
              ].filter(Boolean).join(' · ') || 'Searching broadly based on your preferences'}
            </p>
          </div>
          <Link href={`/contacts/${buyerId}/tours`} className="shrink-0">
            <Button size="sm" variant="ghost" className="text-xs text-blue-700 font-semibold">
              Move to Tour Planner
            </Button>
          </Link>
        </div>
      )}

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
