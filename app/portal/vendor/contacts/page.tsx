import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Users, Phone, Mail, Building2, Lock } from "lucide-react"
import { listVendorAssignedContactsAction } from "@/app/actions/vendor-contact-access"
import { createClient } from "@/lib/supabase/server"
import { readRoleGrants, selectVendorId } from "@/lib/auth/role-grants"
import { redirect } from "next/navigation"
import { ContactMessagePanel } from "./contact-message-panel"

export const dynamic = "force-dynamic"

function scopeBadge(scope: string) {
  switch (scope) {
    case "pii_basic":         return <Badge className="bg-slate-100 text-slate-700 text-xs">Basic contact</Badge>
    case "pii_full":          return <Badge className="bg-blue-100 text-blue-800 text-xs">Full PII</Badge>
    case "transaction_docs":  return <Badge className="bg-purple-100 text-purple-800 text-xs">Docs</Badge>
    case "financial":         return <Badge className="bg-amber-100 text-amber-800 text-xs">Financial</Badge>
    default:                  return <Badge variant="outline" className="text-xs">{scope}</Badge>
  }
}

export default async function VendorContactsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Resolve the calling vendor's own id so the message panel can address the
  // vendor↔contact thread (same role-assignment lookup the list action uses).
  //
  // It must resolve the vendor the SAME way the list action does — that action
  // already reads every grant and chooses (app/actions/vendor-contact-access.ts).
  // Leaving this page on `.maybeSingle()` meant the two could disagree for a user
  // with two vendor-bearing grants: the list would render its contacts while the
  // message panel silently vanished, with no error anywhere to explain it.
  const grantsResult = await readRoleGrants(supabase, user.id)
  if (!grantsResult.ok) {
    console.error("[portal/vendor/contacts] role grant read failed:", grantsResult.error)
  }
  const { vendorId } = grantsResult.ok
    ? selectVendorId(grantsResult.grants)
    : { vendorId: null }

  const r = await listVendorAssignedContactsAction()
  if (!r.ok) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-6 text-center">
            <Lock className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{r.error}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          My assigned contacts
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          You can only see contacts the brokerage has explicitly assigned to you.
          {r.rows.length === 0 && " No assignments yet — your dashboard will populate as deals come in."}
        </p>
      </div>

      {r.rows.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No contacts assigned yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {r.rows.map(c => (
            <Card key={c.assignment_id}>
              <CardHeader className="pb-3">
                <div className="flex justify-between items-start">
                  <CardTitle className="text-base">{c.contact_name}</CardTitle>
                  {scopeBadge(c.scope)}
                </div>
                {c.property_address && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                    <Building2 className="h-3 w-3" />
                    {c.property_address}
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {c.contact_email && (
                  <a href={`mailto:${c.contact_email}`} className="flex items-center gap-2 text-sm hover:text-primary">
                    <Mail className="h-3.5 w-3.5" />
                    {c.contact_email}
                  </a>
                )}
                {c.contact_phone && (
                  <a href={`tel:${c.contact_phone}`} className="flex items-center gap-2 text-sm hover:text-primary">
                    <Phone className="h-3.5 w-3.5" />
                    {c.contact_phone}
                  </a>
                )}
                <p className="text-[10px] text-muted-foreground pt-1">
                  Assigned {new Date(c.granted_at).toLocaleDateString()}
                </p>
                {vendorId && (
                  <ContactMessagePanel
                    vendorId={vendorId}
                    contactId={c.contact_id}
                    contactName={c.contact_name}
                  />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
