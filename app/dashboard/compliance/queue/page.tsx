import { redirect } from "next/navigation"
import { getComplianceDashboard } from "@/app/actions/compliance/dashboard"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import type { ReactNode } from "react"
import { AlertCircle, Clock, DollarSign, Flag, ShieldCheck } from "lucide-react"

export const dynamic = "force-dynamic"

const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high:     "bg-orange-100 text-orange-900",
  medium:   "bg-amber-100 text-amber-900",
  low:      "bg-slate-100 text-slate-700",
}

const KIND_ICON: Record<string, ReactNode> = {
  flag:             <Flag        className="h-4 w-4 text-orange-600" />,
  missing_required: <AlertCircle className="h-4 w-4 text-red-600" />,
  packet_blocker:   <AlertCircle className="h-4 w-4 text-red-600" />,
  awaiting_review:  <Clock       className="h-4 w-4 text-blue-600" />,
  em_receipt:       <DollarSign  className="h-4 w-4 text-amber-700" />,
}

export default async function ComplianceQueuePage() {
  const data = await getComplianceDashboard()
  if (data.error === "Unauthorized") redirect("/login")
  if (data.error === "Not authorized for compliance dashboard") {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardHeader><CardTitle>Compliance queue</CardTitle></CardHeader>
          <CardContent>You don't have permission. Access is limited to broker, broker_admin, admin, compliance_manager, compliance_officer, and TC roles.</CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold inline-flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-emerald-700" />
            Compliance queue
          </h1>
          <p className="text-sm text-muted-foreground">
            Cross-deal view of open flags, deals awaiting TC review, and missing earnest-money receipts.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">Refreshed {new Date(data.generated_at).toLocaleString()}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Open flags</CardTitle></CardHeader>
          <CardContent className="text-3xl font-semibold">{data.totals.open_flags}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Awaiting TC review</CardTitle></CardHeader>
          <CardContent className="text-3xl font-semibold">{data.totals.awaiting_review}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">EM receipt missing</CardTitle></CardHeader>
          <CardContent className="text-3xl font-semibold">{data.totals.missing_required}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Active items</CardTitle></CardHeader>
        <CardContent>
          {data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No compliance items right now.</p>
          ) : (
            <ul className="divide-y">
              {data.items.map((item, i) => (
                <li key={i} className="py-3 flex items-start gap-3">
                  <div className="mt-1">{KIND_ICON[item.kind] ?? <AlertCircle className="h-4 w-4" />}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium truncate">{item.title}</p>
                      <Badge className={SEVERITY_BADGE[item.severity] ?? ""}>{item.severity}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{item.detail}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(item.raised_at).toLocaleDateString()}
                    </span>
                    {item.offer_id && (
                      <Link href={`/crm/contacts/${item.contact_id ?? ""}/offers/${item.offer_id}`}
                            className="text-xs text-blue-600 hover:underline">
                        Open offer →
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
