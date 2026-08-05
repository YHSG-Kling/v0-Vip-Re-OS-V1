import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ShieldCheck, AlertTriangle, Clock, Inbox } from "lucide-react"
import { listDSARQueueAction } from "@/app/actions/privacy/data-subject-requests"
import { DSARRowActions } from "./dsar-row-actions"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"

export const dynamic = "force-dynamic"

function statusBadge(s: string, overdue: boolean) {
  if (s === "fulfilled") return <Badge className="bg-emerald-100 text-emerald-800">Fulfilled</Badge>
  if (s === "denied")    return <Badge className="bg-red-100 text-red-800">Denied</Badge>
  if (s === "withdrawn") return <Badge variant="outline">Withdrawn</Badge>
  if (s === "expired")   return <Badge className="bg-slate-100 text-slate-700">Expired</Badge>
  if (overdue)           return <Badge className="bg-red-100 text-red-800">Overdue</Badge>
  if (s === "in_progress") return <Badge className="bg-amber-100 text-amber-800">In progress</Badge>
  return <Badge className="bg-blue-100 text-blue-800">Received</Badge>
}

function typeBadge(t: string) {
  return <Badge variant="outline" className="text-xs">{t.replace(/_/g, " ")}</Badge>
}

export default async function DSARQueuePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const r = await listDSARQueueAction()
  if (!r.ok) return <div className="p-6 text-red-600">Failed: {r.error}</div>

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Privacy requests
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            CCPA / CPRA / GDPR data subject requests. 45-day response clock from submission.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">Total</p>
          <p className="text-3xl font-bold">{r.rows.length}</p>
        </CardContent></Card>
        <Card className={r.overdue > 0 ? "border-red-300 bg-red-50/30" : ""}><CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-1">
            {r.overdue > 0 && <AlertTriangle className="h-4 w-4 text-red-600" />}
            <p className="text-xs text-muted-foreground">Overdue</p>
          </div>
          <p className="text-3xl font-bold text-red-700">{r.overdue}</p>
        </CardContent></Card>
        <Card className={r.due_soon > 0 ? "border-amber-300 bg-amber-50/30" : ""}><CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="h-4 w-4 text-amber-600" />
            <p className="text-xs text-muted-foreground">Due in 7d</p>
          </div>
          <p className="text-3xl font-bold text-amber-700">{r.due_soon}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-1">
            <Inbox className="h-4 w-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">Open</p>
          </div>
          <p className="text-3xl font-bold">{r.rows.filter(x => x.status === "received" || x.status === "in_progress").length}</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Request queue</CardTitle></CardHeader>
        <CardContent className="p-0">
          {r.rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Subject</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Type</th>
                    <th className="text-center px-4 py-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-center px-4 py-2 font-medium text-muted-foreground">ID Verified</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Submitted</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Due</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Days left</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Answer</th>
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map(row => (
                    <tr key={row.id} className={`border-b last:border-0 hover:bg-muted/10 ${row.is_overdue ? "bg-red-50/50" : ""}`}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-xs">{row.subject_name ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{row.subject_email}</div>
                      </td>
                      <td className="px-4 py-2.5">{typeBadge(row.request_type)}</td>
                      <td className="px-4 py-2.5 text-center">{statusBadge(row.status, row.is_overdue)}</td>
                      <td className="px-4 py-2.5 text-center">
                        {row.identity_verified
                          ? <Badge className="bg-emerald-100 text-emerald-800 text-xs">Verified</Badge>
                          : <Badge variant="outline" className="text-xs">Pending</Badge>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                        {new Date(row.received_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs">
                        {new Date(row.due_at).toLocaleDateString()}
                      </td>
                      <td className={`px-4 py-2.5 text-right text-xs font-medium ${
                        row.is_overdue ? "text-red-600" : row.days_until_due <= 7 ? "text-amber-700" : "text-muted-foreground"
                      }`}>
                        {row.is_overdue ? `${Math.abs(row.days_until_due)}d overdue` : `${row.days_until_due}d`}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <DSARRowActions
                          requestId={row.id}
                          subjectEmail={row.subject_email}
                          requestType={row.request_type}
                          status={row.status}
                          identityVerified={row.identity_verified}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
