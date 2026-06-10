import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ShieldCheck, ShieldAlert, Send, Ban, Clock } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { generateAiDisclosureLedger } from "@/lib/compliance/ai-disclosure-ledger"

export const dynamic = "force-dynamic"

/**
 * AI DISCLOSURE LEDGER — the exportable compliance record: every AI-generated client
 * message, which Claude manager produced it, who approved it, and the recipient's
 * consent state. The human-in-the-loop approval gate is the oversight control; this
 * page is its evidence (EU AI Act / FTC posture).
 */
function statusBadge(status: string) {
  const tone: Record<string, string> = {
    sent:     "bg-green-100 text-green-800",
    proposed: "bg-blue-100 text-blue-800",
    approved: "bg-blue-100 text-blue-800",
    rejected: "bg-slate-100 text-slate-700",
    failed:   "bg-red-100 text-red-800",
  }
  return <Badge className={`text-xs ${tone[status] ?? "bg-slate-100 text-slate-700"}`}>{status}</Badge>
}

export default async function AiDisclosureLedgerPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return <div className="p-6 text-red-600">Brokerage not configured</div>
  if (!["broker", "broker_admin", "admin", "superadmin", "team_lead", "compliance_officer"].includes(profile.user_type ?? "")) {
    return <div className="p-6 text-red-600">Forbidden</div>
  }

  const ledger = await generateAiDisclosureLedger({ brokerageId: profile.brokerage_id })
  const s = ledger.summary

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-green-600" /> AI Disclosure Ledger
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every AI-generated client message in the last 30 days — the Claude manager that produced it,
          the human who approved it, and the recipient&apos;s consent state. Proof of human oversight.
        </p>
      </div>

      {/* Governance headline — the invariant that makes this lawsuit-safe. */}
      <Card className={s.sentWithoutApprover === 0 ? "border-green-300 bg-green-50/40" : "border-red-300 bg-red-50/40"}>
        <CardContent className="flex items-center gap-3 py-4">
          {s.sentWithoutApprover === 0
            ? <ShieldCheck className="h-5 w-5 text-green-600" />
            : <ShieldAlert className="h-5 w-5 text-red-600" />}
          <div className="text-sm">
            <span className="font-semibold">{s.sentWithoutApprover}</span> messages sent without a recorded human approver.
            {s.sentWithoutApprover === 0
              ? " Every AI message that reached a consumer was human-approved."
              : " Investigate immediately — these bypassed the approval gate."}
          </div>
        </CardContent>
      </Card>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="py-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><Send className="h-3.5 w-3.5" /> Sent</div><div className="text-2xl font-semibold">{s.sent}</div></CardContent></Card>
        <Card><CardContent className="py-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><Clock className="h-3.5 w-3.5" /> Awaiting human</div><div className="text-2xl font-semibold">{s.awaitingHuman}</div></CardContent></Card>
        <Card><CardContent className="py-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><Ban className="h-3.5 w-3.5" /> Rejected</div><div className="text-2xl font-semibold">{s.rejected}</div></CardContent></Card>
        <Card><CardContent className="py-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><ShieldAlert className="h-3.5 w-3.5" /> Failed</div><div className="text-2xl font-semibold">{s.failed}</div></CardContent></Card>
      </div>

      {/* Per-manager attribution */}
      {s.byManager.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">By Claude manager</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {s.byManager.map((m) => (
              <Badge key={m.manager} className="bg-slate-900 text-white">{m.label}: {m.count}</Badge>
            ))}
          </CardContent>
        </Card>
      )}

      {/* The ledger itself */}
      <Card>
        <CardHeader><CardTitle className="text-base">Disclosure entries ({ledger.entries.length})</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {ledger.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No AI client messages in this window.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-3">Manager</th>
                  <th className="py-2 pr-3">Recipient</th>
                  <th className="py-2 pr-3">Audience</th>
                  <th className="py-2 pr-3">Channel</th>
                  <th className="py-2 pr-3">Subject</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Approver</th>
                  <th className="py-2 pr-3">Consent now</th>
                </tr>
              </thead>
              <tbody>
                {ledger.entries.map((e) => (
                  <tr key={e.messageId} className="border-b last:border-0">
                    <td className="py-2 pr-3"><Badge className="bg-slate-900 text-white text-[11px]">{e.managerLabel}</Badge></td>
                    <td className="py-2 pr-3">{e.recipientName ?? "—"}</td>
                    <td className="py-2 pr-3 capitalize">{e.audience}</td>
                    <td className="py-2 pr-3">{e.channel}</td>
                    <td className="py-2 pr-3 max-w-[220px] truncate" title={e.subject ?? ""}>{e.subject ?? "—"}</td>
                    <td className="py-2 pr-3">{statusBadge(e.status)}</td>
                    <td className="py-2 pr-3">{e.approvedBy ? <span title={e.approvedBy} className="text-green-700">✓ approved</span> : <span className="text-muted-foreground">—</span>}</td>
                    <td className="py-2 pr-3">
                      {e.channelAllowedNow === null ? <span className="text-muted-foreground">—</span>
                        : e.channelAllowedNow ? <span className="text-green-700">allowed</span>
                        : <span className="text-red-700" title={e.suppressionReason ?? ""}>suppressed</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
