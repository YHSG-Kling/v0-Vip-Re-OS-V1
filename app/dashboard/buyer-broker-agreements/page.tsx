import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileSignature, ShieldCheck, AlertTriangle, Clock } from "lucide-react"
import Link from "next/link"
import { listAgentBBAsAction } from "@/app/actions/buyer-broker-agreements"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"

export const dynamic = "force-dynamic"

function statusBadge(s: string) {
  switch (s) {
    case "active":             return <Badge className="bg-emerald-100 text-emerald-800"><ShieldCheck className="h-3 w-3 mr-1" />Active</Badge>
    case "pending_signature":  return <Badge className="bg-amber-100 text-amber-800"><Clock className="h-3 w-3 mr-1" />Awaiting signature</Badge>
    case "draft":              return <Badge className="bg-slate-100 text-slate-700">Draft</Badge>
    case "expired":            return <Badge className="bg-red-100 text-red-800"><AlertTriangle className="h-3 w-3 mr-1" />Expired</Badge>
    case "cancelled":          return <Badge variant="outline">Cancelled</Badge>
    case "superseded":         return <Badge variant="outline">Superseded</Badge>
    default:                   return <Badge variant="outline">{s}</Badge>
  }
}

function commissionText(r: any) {
  if (r.commission_percentage != null) return `${r.commission_percentage}% / ${r.commission_payer}`
  if (r.commission_flat_amount != null) return `$${Number(r.commission_flat_amount).toLocaleString()} / ${r.commission_payer}`
  return "see doc"
}

export default async function BuyerBrokerAgreementsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const r = await listAgentBBAsAction()
  if (!r.ok) return <div className="p-6 text-red-600">Failed: {r.error}</div>

  const rows = r.rows
  const active   = rows.filter(b => b.status === "active").length
  const draft    = rows.filter(b => b.status === "draft").length
  const pending  = rows.filter(b => b.status === "pending_signature").length
  const expiring = rows.filter(b => {
    if (b.status !== "active" || !b.expiration_date) return false
    const days = (new Date(b.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    return days >= 0 && days <= 30
  }).length

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileSignature className="h-5 w-5 text-primary" />
            Buyer Broker Agreements
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            NAR 2024 settlement requires a signed BBA before any showing or offer.
            Tour requests and offer drafts are gated on an active agreement.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">Active</p>
          <p className="text-3xl font-bold text-emerald-700">{active}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">Drafts</p>
          <p className="text-3xl font-bold">{draft}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">Awaiting signature</p>
          <p className="text-3xl font-bold text-amber-700">{pending}</p>
        </CardContent></Card>
        <Card className={expiring > 0 ? "border-amber-300 bg-amber-50/30" : ""}><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">Expiring in 30d</p>
          <p className="text-3xl font-bold">{expiring}</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">All agreements</CardTitle></CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No buyer broker agreements yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Buyer</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Type</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Commission</th>
                    <th className="text-center px-4 py-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Signed</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Expires</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b: any) => {
                    const buyer = Array.isArray(b.buyer) ? b.buyer[0] : b.buyer
                    return (
                      <tr key={b.id} className="border-b last:border-0 hover:bg-muted/10">
                        <td className="px-4 py-2.5">
                          <div className="font-medium">
                            {[buyer?.first_name, buyer?.last_name].filter(Boolean).join(" ") || "Unknown"}
                          </div>
                          <div className="text-xs text-muted-foreground">{buyer?.email}</div>
                        </td>
                        <td className="px-4 py-2.5"><Badge variant="outline" className="text-xs">{b.agreement_type}</Badge></td>
                        <td className="px-4 py-2.5 text-xs">{commissionText(b)}</td>
                        <td className="px-4 py-2.5 text-center">{statusBadge(b.status)}</td>
                        <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                          {b.signed_at ? new Date(b.signed_at).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right text-xs">
                          {b.expiration_date ? new Date(b.expiration_date).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button asChild size="sm" variant="ghost">
                            <Link href={`/crm/contacts/${buyer?.id}`}>Open contact</Link>
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
