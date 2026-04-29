import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const metadata = { title: "Offers In Progress" }

const STATUS_ORDER = [
  "draft",
  "sent_for_signing",
  "buyer_signed",
  "submitted_to_listing_agent",
  "under_review",
  "compliance_pending",
  "transaction_created",
]

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent_for_signing: "Sent for Signing",
  buyer_signed: "Buyer Signed",
  submitted_to_listing_agent: "Submitted to Listing Agent",
  under_review: "Under Review",
  compliance_pending: "Compliance Pending",
  transaction_created: "Transaction Created",
}

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "secondary",
  sent_for_signing: "outline",
  buyer_signed: "default",
  submitted_to_listing_agent: "default",
  under_review: "outline",
  compliance_pending: "destructive",
  transaction_created: "default",
}

export default async function OffersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  let query = supabase
    .from("offers")
    .select(`
      id, status, created_at, updated_at,
      contacts(first_name, last_name),
      listings(address, city)
    `)
    .order("updated_at", { ascending: false })

  if (userData?.user_type === "agent" && agentRow?.id) {
    query = query.eq("agent_id", agentRow.id)
  } else if (userData?.brokerage_id) {
    query = query.eq("brokerage_id", userData.brokerage_id)
  }

  const { data: offers } = await query

  const grouped = STATUS_ORDER.reduce<Record<string, typeof offers>>((acc, s) => {
    acc[s] = (offers ?? []).filter(o => o.status === s)
    return acc
  }, {})

  const totalActive = (offers ?? []).filter(o => o.status !== "transaction_created").length

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Offers In Progress</h1>
          <p className="text-muted-foreground mt-1">
            {totalActive} active offer{totalActive !== 1 ? "s" : ""} across your pipeline
          </p>
        </div>
        <Button asChild>
          <Link href="/crm">New Offer from CRM</Link>
        </Button>
      </div>

      {/* Kanban-style status columns */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {STATUS_ORDER.map(status => {
          const items = grouped[status] ?? []
          return (
            <div key={status} className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">{STATUS_LABELS[status]}</h2>
                {items.length > 0 && (
                  <Badge variant="secondary">{items.length}</Badge>
                )}
              </div>
              {items.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                  None
                </div>
              ) : (
                items.map(offer => {
                  const contact = offer.contacts as any
                  const listing = offer.listings as any
                  return (
                    <Card key={offer.id} className="hover:shadow-md transition-shadow">
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className="text-sm leading-snug">
                            {contact ? `${contact.first_name} ${contact.last_name}` : "—"}
                          </CardTitle>
                          <Badge variant={STATUS_VARIANTS[offer.status] ?? "secondary"} className="shrink-0 text-xs">
                            {STATUS_LABELS[offer.status] ?? offer.status}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-1 text-xs text-muted-foreground">
                        {listing && (
                          <p>{listing.address}, {listing.city}</p>
                        )}
                        <p>Updated {new Date(offer.updated_at).toLocaleDateString()}</p>
                      </CardContent>
                    </Card>
                  )
                })
              )}
            </div>
          )
        })}
      </div>

      {(offers ?? []).length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          No offers yet.{" "}
          <Link href="/crm" className="underline">Go to CRM</Link> to create your first offer from a contact.
        </div>
      )}
    </div>
  )
}
