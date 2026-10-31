"use client"

// Subscriber referral fees — who referred each paying tenant and what the platform
// owes them. Data rides the growth-funnel rail (platform_prospects "referral:" source
// + converted_brokerage_id); "Mark paid" POSTS to the referral_payouts ledger (m573;
// idempotent per referral+month; tenant-referrers see + confirm it on their billing
// page), with superadmin_audit_log as the audit trail (and the legacy record while
// m573 is unapplied). Billing-gated server-side (superadmin + platform admin).
import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HandCoins } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  listSubscriberReferralsAction, recordSubscriberReferralAction,
  linkReferralConversionAction, markReferralFeePaidAction,
} from "@/app/actions/superadmin/subscriber-referrals"
import { describeReferralFeeTerms, type SubscriberReferralRow } from "@/lib/platform/subscriber-referrals"
import type { ReferralFeeTerms } from "@/lib/platform/referral-payouts"

const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function SubscriberReferralsCard({ initialRows, feePercent, terms, brokerageOptions }: {
  initialRows: SubscriberReferralRow[]
  feePercent: number
  /** The full configured terms (m576) — shown so staff see exactly what the
   *  platform will compute, and whether it is configured or a reported default. */
  terms?: ReferralFeeTerms | null
  brokerageOptions: Array<{ id: string; name: string }>
}) {
  const [rows, setRows] = useState(initialRows)
  const [options, setOptions] = useState(brokerageOptions)
  const [liveTerms, setLiveTerms] = useState<ReferralFeeTerms | null>(terms ?? null)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ referrer: "", email: "", name: "", company: "" })
  const [linkSel, setLinkSel] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  function reload() {
    listSubscriberReferralsAction().then((r) => {
      if (r.ok) { setRows(r.rows); setOptions(r.brokerageOptions); setLiveTerms(r.terms) }
    })
  }
  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    startTransition(async () => {
      const r = await fn()
      if (r.ok) { toast({ title: okMsg }); reload() }
      else toast({ title: "Error", description: r.error, variant: "destructive" })
    })
  }

  const owedNow = rows.reduce((s, r) => s + r.feeCents, 0)

  return (
    <Card id="subscriber-referrals">
      <CardHeader className="pb-2 flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <HandCoins className="h-4 w-4 text-primary" />
          Subscriber referral fees
          <span className="text-xs font-normal text-muted-foreground">
            {/* The TERMS drive this line (m576) — basis, rate and duration are
                configured, never assumed; a code default is labeled as such. */}
            {liveTerms ? describeReferralFeeTerms(liveTerms) : `${feePercent}% of the referred tenant's MRR`}
            {" · "}{fmt(owedNow)}{liveTerms?.basis === "flat" ? "" : "/mo"} across {rows.length} referral{rows.length === 1 ? "" : "s"}
          </span>
        </CardTitle>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => setShowAdd((s) => !s)}>
          {showAdd ? "Cancel" : "Record referral"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {showAdd && (
          <div className="rounded-md border bg-muted/10 p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Who referred whom — the prospect enters the growth funnel with the referrer on record.</p>
            <div className="grid grid-cols-2 gap-2">
              <input className="rounded border px-2 py-1 text-sm" placeholder="Referrer (name or email)" value={form.referrer} onChange={(e) => setForm((f) => ({ ...f, referrer: e.target.value }))} />
              <input className="rounded border px-2 py-1 text-sm" type="email" placeholder="Prospect email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              <input className="rounded border px-2 py-1 text-sm" placeholder="Prospect name (optional)" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              <input className="rounded border px-2 py-1 text-sm" placeholder="Company (optional)" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} />
            </div>
            <Button size="sm" disabled={pending} onClick={() => run(async () => {
              const r = await recordSubscriberReferralAction(form)
              if (r.ok) { setForm({ referrer: "", email: "", name: "", company: "" }); setShowAdd(false) }
              return r
            }, "Referral recorded")}>
              {pending ? "Saving…" : "Save referral"}
            </Button>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No subscriber referrals on record yet. &ldquo;Record referral&rdquo; captures who referred a prospect; once they convert, link the tenant and the fee computes from its MRR.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/10 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Referrer</th><th className="px-3 py-2">Prospect</th><th className="px-3 py-2">Tenant</th>
                <th className="px-3 py-2 text-right">MRR</th><th className="px-3 py-2 text-right">Fee /mo</th>
                <th className="px-3 py-2">Paid</th><th className="px-3 py-2 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.prospectId} className="border-b last:border-0 align-top">
                    <td className="px-3 py-2 font-medium">{r.referrer}</td>
                    <td className="px-3 py-2">
                      {r.prospectName || "—"}
                      <span className="block text-[11px] text-muted-foreground">{r.prospectEmail}{r.prospectCompany ? ` · ${r.prospectCompany}` : ""}</span>
                    </td>
                    <td className="px-3 py-2">
                      {r.brokerageName
                        ? <Badge variant="outline" className="text-[11px]">{r.brokerageName}</Badge>
                        : (
                          <div className="flex items-center gap-1">
                            <select className="rounded border p-1 text-xs max-w-[160px]" value={linkSel[r.prospectId] ?? ""} disabled={pending}
                              onChange={(e) => setLinkSel((s) => ({ ...s, [r.prospectId]: e.target.value }))}>
                              <option value="">Link tenant…</option>
                              {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                            </select>
                            <Button size="sm" variant="ghost" disabled={pending || !linkSel[r.prospectId]}
                              onClick={() => run(() => linkReferralConversionAction({ prospectId: r.prospectId, brokerageId: linkSel[r.prospectId] }), "Referral linked to tenant")}>
                              Link
                            </Button>
                          </div>
                        )}
                      <span className="block text-[11px] text-muted-foreground capitalize">{r.status}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.mrrCents > 0 ? fmt(r.mrrCents) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{r.feeCents > 0 ? fmt(r.feeCents) : "—"}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.lastPaidAt
                        ? <>
                            {fmt(r.lastPaidCents ?? 0)} on {new Date(r.lastPaidAt).toLocaleDateString()}
                            <span className="block">{fmt(r.totalPaidCents)} lifetime</span>
                            {r.ledgerPostedCents > 0 && (
                              <span className="block">
                                {fmt(r.ledgerPostedCents)} posted · {fmt(r.ledgerReceivedCents)} confirmed received
                                {!r.recipientBrokerageId &&
                                  ` · non-tenant referrer${r.recipientEmail ? ` — pay ${r.recipientEmail}` : ""}`}
                              </span>
                            )}
                          </>
                        : "Never"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="outline" disabled={pending || r.feeCents <= 0}
                        title={r.feeCents <= 0 ? "Link a subscribed tenant first — the fee computes from its MRR" : `Record a ${fmt(r.feeCents)} payment to ${r.referrer}`}
                        onClick={() => run(() => markReferralFeePaidAction({ prospectId: r.prospectId, amountCents: r.feeCents }), "Payment recorded in the ledger")}>
                        Mark {r.feeCents > 0 ? fmt(r.feeCents) : ""} paid
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          &ldquo;Mark paid&rdquo; POSTS the payout to the referral_payouts ledger (one row per referral per month — a repeat post for the same month is refused, and a post beyond the configured duration is refused with the term named); a referrer who is a tenant sees it on their own billing page and confirms receipt there. The audit trail (referral_payout.posted, plus legacy referral_fee.paid lines) stays in <a className="underline" href="/dashboard/superadmin/audit">Audit</a>.
        </p>
      </CardContent>
    </Card>
  )
}
