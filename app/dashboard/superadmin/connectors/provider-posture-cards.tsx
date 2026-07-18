"use client"

// Fleet-wide external-provider posture — Twilio (subaccounts, numbers, spend,
// webhook drift) + SendGrid (domain auth, suppression sync, bounce/complaint
// rates). Real vendor calls, so each sweep is a button, not a page-load;
// no-creds environments get an honest DB-only / not-configured view.

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Phone, MailCheck } from "lucide-react"
import { getTwilioFleetPostureAction, getSendgridPostureAction } from "@/app/actions/superadmin/provider-posture"
import type { TwilioFleetPosture, SendgridPosture } from "@/lib/platform/provider-posture"

const TIER_LABEL: Record<string, string> = {
  byo: "BYO", subaccount: "Subaccount", master_fallback: "Master (legacy)", none: "—",
}

function SubStatus({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>
  if (status === "active") return <Badge variant="default">active</Badge>
  return <Badge variant="destructive">{status}</Badge>
}

export function TwilioFleetPostureCard() {
  const [busy, setBusy] = useState(false)
  const [p, setP] = useState<TwilioFleetPosture | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const run = async () => {
    setBusy(true); setErr(null)
    const res = await getTwilioFleetPostureAction()
    if (res.ok) setP(res.posture)
    else setErr(res.error)
    setBusy(false)
  }

  const driftedTenants = p ? p.tenants.filter((t) => t.driftedCount > 0).length : 0
  const suspended = p ? p.tenants.filter((t) => t.subaccountStatus && t.subaccountStatus !== "active").length : 0
  const mismatched = p ? p.tenants.filter((t) => t.twilioNumberCount !== null && t.twilioNumberCount !== t.dbNumberCount).length : 0
  const withAnything = p ? p.tenants.filter((t) => t.credTier !== "none" || t.dbNumberCount > 0) : []

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Phone className="h-4 w-4" /> Twilio fleet posture
        </CardTitle>
        <CardDescription className="text-xs">
          Every tenant's telephony rail, verified against Twilio itself: credential tier, live subaccount
          status (suspended = silent total voice/SMS loss), number inventory DB vs Twilio, month-to-date
          account spend, and webhook drift (VoiceUrl/SmsUrl vs the AI lane). Read-only vendor calls — on demand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-3 flex-wrap">
          <Button size="sm" onClick={run} disabled={busy}>{busy ? "Sweeping…" : "Run fleet sweep"}</Button>
          {p && (
            <span className={driftedTenants + suspended === 0 ? "text-green-600 font-medium" : "text-amber-600 font-medium"}>
              {driftedTenants} drifted · {suspended} suspended/closed · {mismatched} inventory mismatch
            </span>
          )}
        </div>
        {err && <div className="text-xs text-red-600">{err}</div>}
        {p && (
          <>
            <div className="text-xs text-muted-foreground">{p.detail}</div>
            {withAnything.length === 0 ? (
              <div className="text-xs text-muted-foreground">No tenant has Twilio credentials or numbers yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-1.5 pr-3">Tenant</th>
                      <th className="py-1.5 pr-3">Tier</th>
                      <th className="py-1.5 pr-3">Subaccount</th>
                      <th className="py-1.5 pr-3">Numbers (DB / Twilio)</th>
                      <th className="py-1.5 pr-3">MTD spend</th>
                      <th className="py-1.5 pr-3">Webhooks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {withAnything.map((t) => (
                      <tr key={t.brokerageId} className="border-b last:border-0 align-top">
                        <td className="py-1.5 pr-3 font-medium">{t.name}</td>
                        <td className="py-1.5 pr-3">{TIER_LABEL[t.credTier] ?? t.credTier}</td>
                        <td className="py-1.5 pr-3"><SubStatus status={t.subaccountStatus} /></td>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {t.dbNumberCount} / {t.twilioNumberCount ?? "—"}
                          {t.twilioNumberCount !== null && t.twilioNumberCount !== t.dbNumberCount && (
                            <Badge variant="secondary" className="ml-1">mismatch</Badge>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 tabular-nums">{t.monthSpendUsd !== null ? `$${t.monthSpendUsd.toFixed(2)}` : "—"}</td>
                        <td className="py-1.5 pr-3">
                          {!t.probed ? (
                            <span className="text-muted-foreground">not probed</span>
                          ) : t.probeError ? (
                            <span className="text-red-600">{t.probeError}</span>
                          ) : t.numbers.length === 0 ? (
                            <span className="text-muted-foreground">no numbers</span>
                          ) : (
                            <div className="space-y-0.5">
                              {t.driftedCount > 0 && <Badge variant="destructive">{t.driftedCount} drifted</Badge>}
                              {t.unboundCount > 0 && <Badge variant="outline" className="ml-1">{t.unboundCount} unbound</Badge>}
                              {t.driftedCount === 0 && t.unboundCount === 0 && <Badge variant="default">all bound</Badge>}
                              {t.numbers.filter((n) => n.voice === "drifted").slice(0, 3).map((n) => (
                                <div key={n.sid} className="text-[11px] text-muted-foreground truncate max-w-[280px]" title={n.voiceUrl ?? undefined}>
                                  {n.phoneNumber} → {n.voiceUrl}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function SendgridPostureCard() {
  const [busy, setBusy] = useState(false)
  const [p, setP] = useState<SendgridPosture | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const run = async () => {
    setBusy(true); setErr(null)
    const res = await getSendgridPostureAction()
    if (res.ok) setP(res.posture)
    else setErr(res.error)
    setBusy(false)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <MailCheck className="h-4 w-4" /> SendGrid posture
        </CardTitle>
        <CardDescription className="text-xs">
          Every sending domain's authentication validity, SendGrid-side suppressions vs our cross-tenant
          DNC (unsynced spam reports = addresses that can still be re-mailed), and 30-day platform-wide
          bounce/complaint counts from our own email_tracking ledger. Read-only — on demand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={run} disabled={busy}>{busy ? "Sweeping…" : "Run SendGrid sweep"}</Button>
          {p && (
            <span className={p.configured ? "text-muted-foreground text-xs" : "text-amber-600 text-xs font-medium"}>
              {p.detail}
            </span>
          )}
        </div>
        {err && <div className="text-xs text-red-600">{err}</div>}
        {p && (
          <div className="space-y-3">
            {p.domains.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Sending domains</div>
                <ul className="space-y-1">
                  {p.domains.map((dom) => (
                    <li key={dom.domain} className="flex items-center gap-2 text-xs">
                      <Badge variant={dom.valid ? "default" : "destructive"}>{dom.valid ? "authenticated" : "DNS invalid"}</Badge>
                      <span className="font-medium">{dom.domain}</span>
                      {!dom.valid && <span className="text-muted-foreground">— finish the CNAME records or mail from this domain lands in spam</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {p.suppressions && (
              <div className="text-xs">
                <div className="font-medium text-muted-foreground mb-1">Suppression sync ({p.suppressions.windowDays}d)</div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">bounces: {p.suppressions.bounces}{p.suppressions.capped ? "+" : ""}</Badge>
                  <Badge variant={p.suppressions.spamReports > 0 ? "secondary" : "outline"}>spam reports: {p.suppressions.spamReports}{p.suppressions.capped ? "+" : ""}</Badge>
                  <Badge variant={p.suppressions.unsyncedSpamReports > 0 ? "destructive" : "outline"}>
                    unsynced spam reports: {p.suppressions.unsyncedSpamReports}
                  </Badge>
                </div>
                {p.suppressions.unsyncedSpamReports > 0 && (
                  <div className="text-muted-foreground mt-1">
                    Spam-reported addresses missing from the platform suppression list — the SendGrid event
                    webhook likely missed them (secret unset or downtime). Add them via the suppression console.
                  </div>
                )}
              </div>
            )}
            <div className="text-xs">
              <div className="font-medium text-muted-foreground mb-1">Our ledger ({p.ledger.windowDays}d, email_tracking)</div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">delivered: {p.ledger.delivered}</Badge>
                <Badge variant="outline">bounced: {p.ledger.bounced}</Badge>
                <Badge variant="outline">dropped: {p.ledger.dropped}</Badge>
                <Badge variant={p.ledger.spamComplaints > 0 ? "secondary" : "outline"}>complaints: {p.ledger.spamComplaints}</Badge>
                <Badge variant={p.ledger.problemRatePct !== null && p.ledger.problemRatePct >= 5 ? "destructive" : "outline"}>
                  problem rate: {p.ledger.problemRatePct !== null ? `${p.ledger.problemRatePct}%` : "no data"}
                </Badge>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
