import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ShieldCheck, ShieldAlert, Phone, MessageSquare, Mail } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { ConsentPanel, type MissingConsentContact } from "./consent-panel"

export const dynamic = "force-dynamic"

function channelIcon(c: string) {
  if (c === "sms")   return <MessageSquare className="h-3.5 w-3.5" />
  if (c === "call")  return <Phone className="h-3.5 w-3.5" />
  return <Mail className="h-3.5 w-3.5" />
}

function reasonBadge(reason: string | null) {
  if (!reason) return <Badge variant="outline" className="text-xs">—</Badge>
  const tone: Record<string, string> = {
    dnc:                "bg-red-100 text-red-800",
    no_consent:         "bg-red-100 text-red-800",
    consent_expired:    "bg-red-100 text-red-800",
    quiet_hours:        "bg-amber-100 text-amber-800",
    phone_stale:        "bg-amber-100 text-amber-800",
    phone_invalid:      "bg-slate-100 text-slate-700",
    phone_reassigned:   "bg-red-100 text-red-800",
    opted_out:          "bg-red-100 text-red-800",
    missing_phone:      "bg-slate-100 text-slate-700",
  }
  return <Badge className={`text-xs ${tone[reason] ?? "bg-slate-100 text-slate-700"}`}>{reason.replace(/_/g," ")}</Badge>
}

export default async function TCPAComplianceDashboard() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) return <div className="p-6 text-red-600">Brokerage not configured</div>
  if (!["broker","broker_admin","admin","superadmin","team_lead","compliance_officer"].includes(profile.user_type ?? "")) {
    return <div className="p-6 text-red-600">Forbidden</div>
  }

  const svc = createServiceClient()

  // 30-day rolling window stats + recent log
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const [{ data: logRows }, { count: total30 }, { count: blocked30 }, { count: allowed30 }] = await Promise.all([
    svc.from("outbound_message_compliance_log")
      .select(`id, channel, phone, decision, block_reason, recipient_state, recipient_local_hour, created_at,
               contact:contacts(first_name, last_name)`)
      .eq("brokerage_id", profile.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(100),
    svc.from("outbound_message_compliance_log")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", profile.brokerage_id)
      .gt("created_at", since),
    svc.from("outbound_message_compliance_log")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", profile.brokerage_id)
      .eq("decision", "blocked")
      .gt("created_at", since),
    svc.from("outbound_message_compliance_log")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", profile.brokerage_id)
      .eq("decision", "allowed")
      .gt("created_at", since),
  ])

  const rows = logRows ?? []
  const blockRate = (total30 ?? 0) > 0 ? Math.round(((blocked30 ?? 0) / (total30 ?? 1)) * 100) : 0

  // ── Suppression posture + actionable missing-consent list + consent audit ──
  const [
    { count: dncCount },
    { count: smsOptOutCount },
    { count: missingConsentCount },
    { data: missingRows },
    { data: consentEvents },
  ] = await Promise.all([
    svc.from("contacts").select("*", { count: "exact", head: true })
      .eq("brokerage_id", profile.brokerage_id).eq("dnc_status", true),
    svc.from("contacts").select("*", { count: "exact", head: true })
      .eq("brokerage_id", profile.brokerage_id).eq("sms_opt_out", true),
    svc.from("contacts").select("*", { count: "exact", head: true })
      .eq("brokerage_id", profile.brokerage_id).not("phone", "is", null).neq("tcpa_consent", true),
    // Actionable set: phone-reachable, no consent, not on DNC / opted-out.
    svc.from("contacts")
      .select("id, first_name, last_name, phone")
      .eq("brokerage_id", profile.brokerage_id)
      .not("phone", "is", null)
      .neq("tcpa_consent", true)
      .not("dnc_status", "is", true)
      .not("sms_opt_out", "is", true)
      .order("created_at", { ascending: false })
      .limit(50),
    svc.from("contact_consent_events")
      .select("id, contact_id, consented, consent_source, created_at, contact:contacts(first_name, last_name)")
      .eq("brokerage_id", profile.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(25),
  ])

  const missingConsent: MissingConsentContact[] = (missingRows ?? []).map((c: any) => ({
    id: c.id,
    name: [c.first_name, c.last_name].filter(Boolean).join(" "),
    phone: c.phone ?? null,
  }))
  const events = consentEvents ?? []

  // Group by block reason
  const blocksByReason: Record<string, number> = {}
  for (const r of rows) {
    if (r.decision === "blocked" && r.block_reason) {
      blocksByReason[r.block_reason] = (blocksByReason[r.block_reason] ?? 0) + 1
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          TCPA compliance
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage consent and suppression, and review every gated decision. Outbound SMS, call, and
          email are gated for TCPA + DNC + quiet hours; decisions retained 7 years.
        </p>
      </div>

      {/* Suppression posture — real counts from the contact book */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card className={(dncCount ?? 0) > 0 ? "border-red-200" : ""}><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">On DNC</p>
          <p className="text-3xl font-bold text-red-700">{dncCount ?? 0}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">SMS opted-out</p>
          <p className="text-3xl font-bold">{smsOptOutCount ?? 0}</p>
        </CardContent></Card>
        <Card className={(missingConsentCount ?? 0) > 0 ? "border-amber-200 bg-amber-50/30" : ""}><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">Phone contacts w/o consent</p>
          <p className="text-3xl font-bold text-amber-700">{missingConsentCount ?? 0}</p>
        </CardContent></Card>
      </div>

      {/* Actionable: record express consent for phone-reachable contacts */}
      <ConsentPanel initialMissing={missingConsent} />

      {/* Consent audit trail */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Consent audit trail</CardTitle></CardHeader>
        <CardContent className="p-0">
          {events.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No consent events recorded yet.</p>
          ) : (
            <div className="divide-y">
              {events.map((e: any) => {
                const c = Array.isArray(e.contact) ? e.contact[0] : e.contact
                return (
                  <div key={e.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <span className="truncate">{c ? [c.first_name, c.last_name].filter(Boolean).join(" ") || "—" : "—"}</span>
                    <div className="flex items-center gap-3 shrink-0">
                      <Badge className={e.consented ? "bg-emerald-100 text-emerald-800 text-xs" : "bg-red-100 text-red-800 text-xs"}>
                        {e.consented ? "consented" : "revoked"}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{e.consent_source}</span>
                      <span className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">Total decisions (30d)</p>
          <p className="text-3xl font-bold">{total30 ?? 0}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">Allowed</p>
          <p className="text-3xl font-bold text-emerald-700">{allowed30 ?? 0}</p>
        </CardContent></Card>
        <Card className={(blocked30 ?? 0) > 0 ? "border-amber-300 bg-amber-50/30" : ""}><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">Blocked</p>
          <p className="text-3xl font-bold text-red-700">{blocked30 ?? 0}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">Block rate</p>
          <p className="text-3xl font-bold">{blockRate}%</p>
        </CardContent></Card>
      </div>

      {Object.keys(blocksByReason).length > 0 && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Recent blocks by reason</CardTitle></CardHeader>
          <CardContent className="flex gap-2 flex-wrap">
            {Object.entries(blocksByReason).sort(([,a],[,b]) => b - a).map(([reason, count]) => (
              <div key={reason} className="flex items-center gap-1">
                {reasonBadge(reason)}
                <span className="text-xs font-medium">×{count}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" />
            Recent decisions
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No TCPA gate decisions logged yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Channel</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Contact</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Phone</th>
                    <th className="text-center px-4 py-2 font-medium text-muted-foreground">Decision</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Reason</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Local time</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">When</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: any) => {
                    const c = Array.isArray(r.contact) ? r.contact[0] : r.contact
                    return (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-muted/10">
                        <td className="px-4 py-2.5">
                          <Badge variant="outline" className="text-xs flex items-center gap-1 w-fit">
                            {channelIcon(r.channel)} {r.channel}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {c ? [c.first_name, c.last_name].filter(Boolean).join(" ") || "—" : "—"}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs">{r.phone}</td>
                        <td className="px-4 py-2.5 text-center">
                          {r.decision === "allowed"
                            ? <Badge className="bg-emerald-100 text-emerald-800 text-xs">allowed</Badge>
                            : <Badge className="bg-red-100 text-red-800 text-xs">blocked</Badge>}
                        </td>
                        <td className="px-4 py-2.5">{reasonBadge(r.block_reason)}</td>
                        <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                          {r.recipient_local_hour != null ? `${r.recipient_local_hour}:00 ${r.recipient_state ?? ""}` : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                          {new Date(r.created_at).toLocaleString()}
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
