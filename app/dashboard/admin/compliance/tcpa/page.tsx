import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ShieldCheck, ShieldAlert, Phone, MessageSquare, Mail } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { ConsentPanel, type MissingConsentContact } from "./consent-panel"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
// The ONE outbound suppression predicate (CLAUDE.md §6) — see the note on the
// missing-consent query below for why this board uses the hasRecordedOptOut arm
// rather than the full isEligibleForOutbound union.
import { hasRecordedOptOut, SUPPRESSION_COLUMNS } from "@/lib/kernel/compliance/outbound-predicates"

export const dynamic = "force-dynamic"

/** Rows shown in the actionable missing-consent list. */
const MISSING_CONSENT_SHOWN = 50
/**
 * Rows fetched before the suppression predicate removes the opted-out ones.
 * Wider than MISSING_CONSENT_SHOWN because the filtering happens in JS, after
 * the fetch — see the query comment below.
 */
const MISSING_CONSENT_FETCH_WINDOW = 300

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


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) return <div className="p-6 text-red-600">Brokerage not configured</div>
  // SCOPE LADDER (kept inline — admits compliance/team_lead tiers): 'superadmin'
  // removed — dead as users.user_type (0 live rows); broker_owner added.
  if (!["broker","broker_owner","broker_admin","admin","team_lead","compliance_officer"].includes(profile.user_type ?? "")) {
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
    // ── NOT `.neq("tcpa_consent", true)` — that count was WRONG, and wrong in
    //    the direction that HIDES WORK ────────────────────────────────────────
    // `contacts.tcpa_consent` is nullable (no NOT NULL / DEFAULT on it in any
    // migration; lib/contact-pipeline/contact-capture.ts:367 writes
    // `params.tcpa_consent ? true : existing?.tcpa_consent`, which persists NULL
    // for a contact nobody has ever asked). In PostgREST `tcpa_consent=neq.true`
    // becomes SQL `tcpa_consent <> true`, which evaluates NULL — not TRUE — for a
    // NULL column, so the row is DROPPED. The never-asked cohort is precisely the
    // group this board exists to go collect consent from, and it was invisible
    // here while the tile read "Phone contacts w/o consent".
    // Same defect, same fix, already recorded in this repo at
    // lib/kernel/flow-integrity.ts:514: `.or("status.is.null,status.neq.signed")
    // // NULL status is also "not signed" — a bare neq would drop those rows`.
    // Expect this number to GO UP. That rise is the finding, not a regression.
    svc.from("contacts").select("*", { count: "exact", head: true })
      .eq("brokerage_id", profile.brokerage_id).not("phone", "is", null)
      .or("tcpa_consent.is.null,tcpa_consent.eq.false"),
    // Actionable set: phone-reachable, no consent, and NOT already suppressed.
    //
    // "Not already suppressed" used to be spelled here, a THIRD time, as a
    // PostgREST filter chain — `.not("dnc_status","is",true).not("sms_opt_out","is",true)`
    // — which is 2 of the 5 opt-out arms the kernel actually has: it was blind to
    // call_stop_flag, email_opt_out and opt_out_channels, so a contact who had
    // texted STOP appeared on a "go call these people for consent" worklist.
    // The rule now comes from the one predicate (§6). It cannot be expressed as a
    // PostgREST filter without re-spelling it, so the DB does only the cheap
    // narrowing it can do honestly (tenant + phone-reachable + no consent) and
    // hasRecordedOptOut() decides suppression in JS.
    //
    // Over-fetch then slice: the suppressed rows are removed AFTER the fetch, so
    // the window must be wider than the 50 shown or a tenant with many
    // suppressed contacts would render a short list and look "done".
    //
    // The no-consent predicate is the SAME `.or()` as the count above — a bare
    // `.neq("tcpa_consent", true)` dropped every never-asked contact here too.
    svc.from("contacts")
      // Every column the predicate reads, named explicitly. Anything it needs
      // that is not selected reads as `false` and the check FAILS OPEN (§4), so
      // the list comes from SUPPRESSION_COLUMNS — the leaf's own select list,
      // which changes in the same edit as the predicate.
      .select(`id, first_name, last_name, phone, ${SUPPRESSION_COLUMNS}`)
      .eq("brokerage_id", profile.brokerage_id)
      .not("phone", "is", null)
      .or("tcpa_consent.is.null,tcpa_consent.eq.false")
      .order("created_at", { ascending: false })
      .limit(MISSING_CONSENT_FETCH_WINDOW),
    svc.from("contact_consent_events")
      .select("id, contact_id, consented, consent_source, created_at, contact:contacts(first_name, last_name)")
      .eq("brokerage_id", profile.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(25),
  ])

  // The one suppression predicate — NOT needsConsentInRestrictedState/
  // isEligibleForOutbound. Lacking consent is the whole point of this list, so
  // filtering it on full outbound eligibility would hide exactly the
  // restricted-state contacts a broker most needs to go collect consent from.
  // hasRecordedOptOut is the arm that asks the right question here: "did this
  // person already tell us to stop?"
  //
  // SCOPED TO "phone" (2026-09-01), because this call site genuinely knows the
  // channel: the tile says "Phone contacts w/o consent", the query filters on
  // `phone is not null`, the panel renders phone numbers, and the work it asks
  // for is a phone call. That changes the list in BOTH directions and both are
  // corrections:
  //   · REMOVES contacts carrying `phone_opt_out` or `call_stop_flag` or an
  //     opt_out_channels 'phone' entry. `phone_opt_out` in particular was NEVER
  //     checked here — the CRM header-card toggle writes that column alone, so a
  //     contact whose agent had switched phone OFF was still being listed as
  //     someone to ring for consent. That is the same defect class as the portal
  //     invite hole closed earlier today.
  //   · RESTORES contacts who opted out of EMAIL or SMS but never objected to a
  //     phone call. An email opt-out is not a reason to leave someone off a
  //     phone-consent worklist, and the channel-agnostic form was hiding them.
  const actionableRows = (missingRows ?? []).filter((c: any) => !hasRecordedOptOut(c, "phone"))
  const missingConsent: MissingConsentContact[] = actionableRows
    .slice(0, MISSING_CONSENT_SHOWN)
    .map((c: any) => ({
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(" "),
      phone: c.phone ?? null,
    }))
  // PUBLISH THE DENOMINATOR AND THE BLIND SPOT (§2). Three different numbers are
  // in play and the board used to show only the first, which reads as "this is
  // the whole job":
  //   missingConsentCount — every phone contact without consent, INCLUDING ones
  //                         already suppressed, tenant-wide and uncapped.
  //   actionableRows      — those minus phone-suppressed, but only within the
  //                         MISSING_CONSENT_FETCH_WINDOW most recent rows.
  //   missingConsent      — the first MISSING_CONSENT_SHOWN of those, rendered.
  // `windowTruncated` is the honest caveat: past the fetch window we do not know,
  // so the caption says "at least".
  const actionableCount = actionableRows.length
  const windowTruncated = (missingRows ?? []).length >= MISSING_CONSENT_FETCH_WINDOW
  const suppressedFromWindow = (missingRows ?? []).length - actionableCount
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
          {/* Label says "never asked or declined" because that is what the query
              now counts: consent NULL (nobody ever asked) OR false. It used to
              silently exclude the NULL half. */}
          <p className="text-xs text-muted-foreground">Phone contacts w/o consent</p>
          <p className="text-3xl font-bold text-amber-700">{missingConsentCount ?? 0}</p>
          <p className="text-[11px] text-muted-foreground mt-1">never asked or declined</p>
        </CardContent></Card>
      </div>

      {/* Actionable: record express consent for phone-reachable contacts.
          The caption below is the denominator the panel itself cannot show — it
          takes only the rendered slice as a prop. Without it, 50 rows out of a
          few thousand read as the whole job. */}
      <ConsentPanel initialMissing={missingConsent} />
      <p className="text-xs text-muted-foreground -mt-3 px-1">
        Showing {missingConsent.length} of {windowTruncated ? "at least " : ""}
        {actionableCount} contact{actionableCount === 1 ? "" : "s"} who can still be called
        {suppressedFromWindow > 0 && (
          <> · {suppressedFromWindow} more {suppressedFromWindow === 1 ? "is" : "are"} phone-suppressed and deliberately not listed</>
        )}
        {windowTruncated && (
          <> · only the {MISSING_CONSENT_FETCH_WINDOW} most recent of the {missingConsentCount ?? 0} were examined</>
        )}
      </p>

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
