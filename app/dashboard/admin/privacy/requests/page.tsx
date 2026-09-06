import { Fragment } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ShieldCheck, AlertTriangle, Clock, Inbox } from "lucide-react"
import { listDSARQueueAction } from "@/app/actions/privacy/data-subject-requests"
import { DSARRowActions } from "./dsar-row-actions"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { protectedClassSourcesBySignalType } from "@/lib/lead-governance/protected-class-signals"
import {
  BATCHDATA_SELLER_SIGNAL_SOURCES, BATCHDATA_PROTECTED_CLASS_BASIS,
} from "@/lib/external/batchdata-seller-signals"

export const dynamic = "force-dynamic"

/**
 * PURE, module-scope: the declaration table compiled into this build. No I/O, no
 * tenant, no personal data — the same answer for every brokerage, which is why it
 * is computed once here rather than per request.
 */
const protectedSignalRows = Object.entries(
  protectedClassSourcesBySignalType(BATCHDATA_SELLER_SIGNAL_SOURCES),
)
  .map(([signalType, sources]) => ({
    signalType,
    sources: [...sources],
    reasons: (BATCHDATA_PROTECTED_CLASS_BASIS[signalType] ?? []).map((b) => b.reason),
  }))
  .sort((a, b) => a.signalType.localeCompare(b.signalType))

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
                    <Fragment key={row.id}>
                    <tr className={`hover:bg-muted/10 ${row.is_overdue ? "bg-red-50/50" : ""}`}>
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
                    {/* THE AUDIT RECORD — the reader half of the eleven columns
                        data_subject_requests carried with nothing reading them
                        (see the note on DSARQueueRow). This is the evidence a
                        regulator asks for: how identity was proved and by whom,
                        what was delivered, why it was refused, and where the
                        request came in from. Rendered only when the row actually
                        holds something — an empty audit strip on a brand-new
                        request would read as "nothing was recorded". */}
                    <tr className={`border-b last:border-0 ${row.is_overdue ? "bg-red-50/50" : ""}`}>
                      <td colSpan={8} className="px-4 pb-2.5 pt-0">
                        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
                          {row.source && <span>Intake: <span className="text-foreground">{row.source.replace(/_/g, " ")}</span></span>}
                          {row.subject_phone && <span>Phone: <span className="text-foreground">{row.subject_phone}</span></span>}
                          {row.identity_method && (
                            <span>
                              ID proof: <span className="text-foreground">{row.identity_method.replace(/_/g, " ")}</span>
                              {row.identity_verified_at && ` on ${new Date(row.identity_verified_at).toLocaleDateString()}`}
                              {(row.identity_verified_by_name || row.identity_verified_by) &&
                                ` by ${row.identity_verified_by_name ?? row.identity_verified_by}`}
                            </span>
                          )}
                          {(row.fulfilled_by_name || row.fulfilled_by) && (
                            <span>Fulfilled by: <span className="text-foreground">{row.fulfilled_by_name ?? row.fulfilled_by}</span></span>
                          )}
                          {row.ip_address && <span>IP: <span className="font-mono">{row.ip_address}</span></span>}
                          {row.user_agent && (
                            <span className="max-w-md truncate" title={row.user_agent}>Agent: {row.user_agent}</span>
                          )}
                        </div>
                        {row.response_summary && (
                          <p className="text-[11px] mt-1">
                            <span className="text-muted-foreground">Delivered: </span>{row.response_summary}
                          </p>
                        )}
                        {row.denied_reason && (
                          <p className="text-[11px] mt-1 text-red-700">
                            <span className="text-muted-foreground">Denied because: </span>{row.denied_reason}
                          </p>
                        )}
                        {row.notes && (
                          <p className="text-[11px] mt-1 text-muted-foreground italic">{row.notes}</p>
                        )}
                      </td>
                    </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── PROTECTED-CLASS DISCLOSURE ────────────────────────────────────────
          THE STAFF-FACING READER FOR A LABEL THAT ONLY EXISTED IN CODE.

          Owner ruling (wave 15): the data lane may SOURCE a motivated-seller
          signal from protected-class data — "we determine the kind of education
          in channels by the age group" — and the refusal moved to the
          ad-audience path. What that ruling did NOT release is the
          record-keeping. `defineSellerSignalSources` labels every declared
          signal type with the protected-class sources it derives from, and
          `protectedClassSourcesBySignalType` is that label's designated reader —
          "without it the label would be a write with no reader" — and it had no
          production caller at all. The person who has to answer a DSAR or a fair-
          housing question is exactly who needs to see it, so it is answered on
          this page.

          PURE AND TENANT-FREE. This reads no database and no contact: it is the
          DECLARATION table compiled into the build, so it is the same answer for
          every brokerage and carries nobody's personal data. It renders after the
          queue gate above, so an un-authorised caller never reaches it.

          The source NAMES come from `protectedClassSourcesBySignalType`; the
          REASON sentence beside each comes from BATCHDATA_PROTECTED_CLASS_BASIS,
          which is the classifier's own wording verbatim — a paraphrase here would
          drift from the live classifier invisibly. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Protected-class derived signals
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Motivated-seller signal types this platform derives from protected-class data, and the
            provider fields each one reads. Signal types absent from this list are derived purely
            from parcel and transaction records. Holding and scoring these facts is permitted;
            using them to target housing advertising is refused at the ad-audience gate.
          </p>
          {protectedSignalRows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No declared signal type is derived from protected-class data.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Signal type</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Protected-class sources</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Why it is protected</th>
                  </tr>
                </thead>
                <tbody>
                  {protectedSignalRows.map((row) => (
                    <tr key={row.signalType} className="border-b last:border-0 align-top">
                      <td className="px-3 py-2 font-medium">{row.signalType}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {row.sources.map((s) => (
                            <Badge key={s} variant="outline" className="font-mono text-[10px]">{s}</Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {row.reasons.length === 0
                          ? "—"
                          : row.reasons.map((reason, i) => <p key={i} className={i > 0 ? "mt-1" : ""}>{reason}</p>)}
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
