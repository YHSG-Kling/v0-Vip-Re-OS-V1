"use client"

// THE EXECUTED REFERRAL AGREEMENT A PAYOUT NEEDS (wave 145, lane 145C; owner ruling 9).
// A referral fee on this deal — to an inside agent or an outside partner's brokerage — is paid only when an executed referral
// agreement is on record; until then the final commission calculation holds by name. A finance admin records the executed paper
// (a document stored on the deal) and the date it was fully signed. Rules: lib/commission/referral-payout.ts; writer:
// lib/agreements/referral-agreements.ts. The card shows nothing to roles that cannot record it (the action refuses them).

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  listDealReferralAgreementsAction,
  recordReferralAgreementAction,
  recordPartnerReferralAgreementAction,
} from "@/app/actions/commission-policy/agreements"

type Loaded = Extract<Awaited<ReturnType<typeof listDealReferralAgreementsAction>>, { success: true }>

export function ReferralAgreementCard({ transactionId }: { transactionId: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [doc, setDoc] = useState<Record<string, string>>({})
  const [day, setDay] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    startTransition(async () => {
      const r = await listDealReferralAgreementsAction({ transactionId })
      if (!r.success) { setData(null); setError(r.error === "forbidden" ? null : r.error); return }
      setError(null)
      setData(r)
    })
  }, [transactionId])
  useEffect(() => { load() }, [load])

  const run = (f: () => Promise<{ success: boolean; error?: string }>) => startTransition(async () => { const r = await f(); if (!r.success) { setError(r.error ?? "refused"); return } setError(null); load() })
  if (!data || data.referrals.length === 0) return error ? <p className="text-sm text-destructive">{error}</p> : null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Referral agreement</CardTitle>
        <CardDescription>A referral fee is paid only on an executed referral agreement on record; without it the commission is held.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error ? <p className="text-destructive">{error}</p> : null}
        {data.referrals.map((r) => {
          const onRecord = !!r.agreementDocumentId || !!r.partnerStandingDocumentId
          return (
            <div key={r.referralId} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.feePct != null ? `${r.feePct}%` : "agreed fee"} to the {r.payee}</span>
                <Badge variant={onRecord ? "default" : "destructive"}>{onRecord ? (r.agreementDocumentId ? `executed ${r.agreementExecutedOn ?? ""}` : "partner's standing agreement") : "no executed agreement — held"}</Badge>
              </div>
              {!r.agreementDocumentId ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <select className="flex-1 rounded-md border px-2 py-1" value={doc[r.referralId] ?? ""} onChange={(e) => setDoc((d) => ({ ...d, [r.referralId]: e.target.value }))} aria-label="Executed referral agreement document">
                    <option value="">The executed agreement on this deal…</option>
                    {data.documents.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                  <input type="date" className="rounded-md border px-2 py-1" value={day[r.referralId] ?? ""} onChange={(e) => setDay((d) => ({ ...d, [r.referralId]: e.target.value }))} aria-label="Fully signed on" />
                  <Button size="sm" disabled={pending || !doc[r.referralId] || !day[r.referralId]} onClick={() => run(() => recordReferralAgreementAction({ referralId: r.referralId, documentId: doc[r.referralId], executedOn: day[r.referralId] }))}>Record for this referral</Button>
                  {r.partnerId ? (
                    <Button size="sm" variant="outline" disabled={pending || !doc[r.referralId] || !day[r.referralId]} onClick={() => run(() => recordPartnerReferralAgreementAction({ partnerId: r.partnerId as string, documentId: doc[r.referralId], agreementDate: day[r.referralId] }))}>Record as the partner&apos;s standing agreement</Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
