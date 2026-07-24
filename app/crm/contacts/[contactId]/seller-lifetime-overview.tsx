// app/crm/contacts/[contactId]/seller-lifetime-overview.tsx
// Agent-facing detail view for non-buyer-stage contacts (sellers, lifetime customers, prospects).
// This is the consolidated path — the same /crm/contacts/[contactId] route now renders ALL contact
// types (buyer/seller/lifetime) in one place instead of redirecting non-buyers to the legacy /crm
// workspace. Heavy buyer-specific tools live in BuyerOverviewClient; here we render the
// agent-most-useful slices for non-buyers (recent listings, transactions, last activity) plus a
// pointer to the full CRM workspace for advanced tools.
import { createServiceClient } from "@/lib/supabase/service"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { ExternalLink } from "lucide-react"

interface Props {
  contactId:    string
  contact:      Record<string, any>
  brokerageId:  string
}

function fmtMoney(n: number | null | undefined): string {
  if (typeof n !== "number" || !isFinite(n)) return "—"
  return `$${Math.round(n).toLocaleString()}`
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString()
}

export async function SellerLifetimeOverview({ contactId, contact, brokerageId }: Props) {
  const svc = createServiceClient()
  const [listingsRes, transactionsRes, activitiesRes, callClassificationsRes] = await Promise.all([
    // Listings where this contact is the seller — recent first
    svc.from("listings")
       .select("id, address, list_price, status, lifecycle_stage, created_at, listing_date")
       .eq("brokerage_id", brokerageId)
       .eq("seller_contact_id", contactId)
       .order("created_at", { ascending: false })
       .limit(5),
    // Transactions where this contact is buyer OR seller — both sides because lifetime contacts
    // may have been on either side of past deals.
    svc.from("transactions")
       .select("id, deal_name, property_address, stage, status, purchase_price, close_date, created_at")
       .eq("brokerage_id", brokerageId)
       .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId},contact_id.eq.${contactId}`)
       .order("created_at", { ascending: false })
       .limit(5),
    // Last 10 activities
    svc.from("activities")
       .select("id, activity_type, title, description, status, created_at")
       .eq("brokerage_id", brokerageId)
       .eq("contact_id", contactId)
       .order("created_at", { ascending: false })
       .limit(10),
    // Inbound call classifications — written by the Twilio-native reception lane
    // (app/api/voice/twilio/inbound) when it resolves a caller, keyed to this
    // contact via resulting_contact_id. Merged into the activity feed as calls.
    svc.from("inbound_call_classifications")
       .select("id, classification, transfer_reason, ai_handled, classified_at")
       .eq("brokerage_id", brokerageId)
       .eq("resulting_contact_id", contactId)
       .order("classified_at", { ascending: false })
       .limit(10),
  ])

  const listings     = listingsRes.data ?? []
  const transactions = transactionsRes.data ?? []
  const activities   = activitiesRes.data ?? []
  const callClassifications = callClassificationsRes.error ? [] : (callClassificationsRes.data ?? [])

  // Merge activities + classified inbound calls into one newest-first timeline
  const timeline = [
    ...activities.map((a: any) => ({ kind: "activity" as const, ts: a.created_at as string, entry: a })),
    ...callClassifications.map((c: any) => ({ kind: "call" as const, ts: c.classified_at as string, entry: c })),
  ]
    .sort((x, y) => new Date(y.ts ?? 0).getTime() - new Date(x.ts ?? 0).getTime())
    .slice(0, 10)

  const contactType = (contact.contact_type as string | null) ?? "contact"
  const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "(unnamed)"

  return (
    <div className="p-4 pt-2 space-y-4">
      {/* Identity / status */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            {fullName}
            <Badge variant="outline">{contactType}</Badge>
            {contact.lifecycle_state && <Badge variant="outline">{contact.lifecycle_state}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 text-sm">
          <div><span className="text-muted-foreground">Email </span>{contact.email ?? "—"}</div>
          <div><span className="text-muted-foreground">Phone </span>{contact.phone ?? "—"}</div>
          <div className="col-span-2">
            <span className="text-muted-foreground">Address </span>
            {[contact.mailing_address, contact.mailing_city, contact.mailing_state, contact.mailing_zip].filter(Boolean).join(", ") || "—"}
          </div>
          <div className="col-span-2 pt-1">
            <Link href={`/crm?contact=${contactId}`}
                  className="text-xs underline inline-flex items-center gap-1">
              Open in full CRM workspace <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Listings */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Listings ({listings.length})</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {listings.length === 0 ? (
            <p className="text-muted-foreground text-xs">No listings yet for this contact.</p>
          ) : (
            <ul className="divide-y">
              {listings.map((l: any) => (
                <li key={l.id} className="py-2 flex items-center justify-between gap-2">
                  <Link href={`/dashboard/listings/${l.id}`} className="hover:underline">{l.address ?? "(no address)"}</Link>
                  <span className="text-xs text-muted-foreground">
                    {fmtMoney(l.list_price)} · {l.lifecycle_stage ?? l.status ?? "—"} · {fmtDate(l.listing_date ?? l.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Transactions */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Transactions ({transactions.length})</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {transactions.length === 0 ? (
            <p className="text-muted-foreground text-xs">No transactions for this contact.</p>
          ) : (
            <ul className="divide-y">
              {transactions.map((t: any) => (
                <li key={t.id} className="py-2 flex items-center justify-between gap-2">
                  <Link href={`/dashboard/transactions/${t.id}`} className="hover:underline">{t.deal_name ?? t.property_address ?? "(deal)"}</Link>
                  <span className="text-xs text-muted-foreground">
                    {fmtMoney(t.purchase_price)} · {t.stage ?? t.status ?? "—"} · close {fmtDate(t.close_date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Recent activity */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Recent activity</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {timeline.length === 0 ? (
            <p className="text-muted-foreground text-xs">No activity logged yet.</p>
          ) : (
            <ul className="divide-y">
              {timeline.map((item) =>
                item.kind === "activity" ? (
                  <li key={`a-${item.entry.id}`} className="py-2 flex items-start justify-between gap-2">
                    <div>
                      <span className="font-medium">{item.entry.title ?? item.entry.activity_type}</span>
                      {item.entry.description && <p className="text-xs text-muted-foreground line-clamp-1">{item.entry.description}</p>}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{fmtDate(item.entry.created_at)}</span>
                  </li>
                ) : (
                  <li key={`c-${item.entry.id}`} className="py-2 flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium">Inbound call</span>
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {String(item.entry.classification ?? "unknown").replace(/_/g, " ")}
                      </Badge>
                      {item.entry.transfer_reason && (
                        <Badge variant="secondary" className="text-[10px] capitalize">
                          {String(item.entry.transfer_reason).replace(/_/g, " ")}
                        </Badge>
                      )}
                      {item.entry.ai_handled && (
                        <Badge variant="outline" className="text-[10px]">AI handled</Badge>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{fmtDate(item.entry.classified_at)}</span>
                  </li>
                )
              )}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
