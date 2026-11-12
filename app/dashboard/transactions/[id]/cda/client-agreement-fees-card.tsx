"use client"

// FEES THE SELLER'S AND THE BUYER'S AGREEMENTS ESTABLISH (wave 145, lane 145C; owner ruling 5).
// The agent who wrote the client agreement enters a transaction / admin fee it states; a finance admin or the compliance officer
// verifies it against the EXECUTED agreement and the brokerage policy; an executed amendment supersedes it. Only a verified,
// payable-at-closing fee that is NOT already inside the commission settles as its own line on its payer's side. Never an agent
// fee (those are the agent's agreement, charged by the commission engine). Rules: lib/commission/client-agreement-fees.ts.

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  listClientAgreementFeesAction,
  enterClientAgreementFeeAction,
  verifyClientAgreementFeeAction,
  amendClientAgreementFeeAction,
} from "@/app/actions/commission-policy/client-agreement-fees"

type Loaded = Extract<Awaited<ReturnType<typeof listClientAgreementFeesAction>>, { success: true }>

export function ClientAgreementFeesCard({ transactionId }: { transactionId: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState({ agreement: "", kind: "transaction_fee", receiver: "brokerage", value: "", valueType: "flat", payableAtClosing: "yes", included: "no", effectiveDate: "" })
  const [policyRef, setPolicyRef] = useState<Record<string, string>>({})
  const [amendDoc, setAmendDoc] = useState<Record<string, string>>({})
  const [amendValue, setAmendValue] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    startTransition(async () => {
      const r = await listClientAgreementFeesAction({ transactionId })
      if (!r.success) { setError(r.error); return }
      setError(null)
      setData(r)
    })
  }, [transactionId])
  useEffect(() => { load() }, [load])

  const run = (f: () => Promise<{ success: boolean; error?: string }>) => startTransition(async () => { const r = await f(); if (!r.success) { setError(r.error ?? "refused"); return } setError(null); load() })
  const chosen = data?.agreements.find((a) => a.id === form.agreement) ?? null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Client-agreement fees</CardTitle>
        <CardDescription>
          A transaction or administrative fee the seller&apos;s listing agreement or the buyer&apos;s buyer-broker agreement establishes —
          paid by that client, never an agent fee, and never charged twice when the agreement already includes it in the commission.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {error ? <p className="text-destructive">{error}</p> : null}
        {data && !data.available ? <p className="text-muted-foreground">Client-agreement fees are not switched on yet for this brokerage.</p> : null}
        {(data?.resolution.fees ?? []).length === 0 ? <p className="text-muted-foreground">No client-agreement fee on this deal.</p> : null}
        <ul className="space-y-2">
          {(data?.resolution.fees ?? []).map((f, i) => (
            <li key={f.feeId ?? `legacy-${i}`} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{data?.feeKinds.find((k) => k.value === f.kind)?.label ?? f.kind} ·{f.amount == null ? `${f.value}% of the price` : `$${f.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}</span>
                <span>paid by the {f.payer}{f.receiver ? ` to the ${f.receiver}` : ""}</span>
                <Badge variant={f.settlesAsOwnLine ? "default" : "secondary"}>{f.status.replace(/_/g, " ")}{f.settlesAsOwnLine ? " · settles at closing" : ""}</Badge>
              </div>
              {f.findings.map((x, j) => <p key={j} className="text-xs text-muted-foreground">{x}</p>)}
              {f.feeId && f.status === "entered" && data?.canVerify ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input className="flex-1 rounded-md border px-2 py-1" placeholder="Brokerage policy (section) that permits it" value={policyRef[f.feeId] ?? ""} onChange={(e) => setPolicyRef((p) => ({ ...p, [f.feeId as string]: e.target.value }))} />
                  <Button size="sm" disabled={pending || (policyRef[f.feeId] ?? "").trim().length < 3} onClick={() => run(() => verifyClientAgreementFeeAction({ feeId: f.feeId as string, brokeragePolicyPermits: true, brokeragePolicyRef: policyRef[f.feeId as string] }))}>Verify against the executed agreement</Button>
                  <Button size="sm" variant="outline" disabled={pending || (policyRef[f.feeId] ?? "").trim().length < 3} onClick={() => run(() => verifyClientAgreementFeeAction({ feeId: f.feeId as string, brokeragePolicyPermits: false, brokeragePolicyRef: policyRef[f.feeId as string] }))}>Policy does not permit it</Button>
                </div>
              ) : null}
              {f.feeId && (f.status === "entered" || f.status === "verified") && data?.canVerify ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input className="rounded-md border px-2 py-1" placeholder="Executed amendment document id" value={amendDoc[f.feeId] ?? ""} onChange={(e) => setAmendDoc((p) => ({ ...p, [f.feeId as string]: e.target.value }))} />
                  <input className="w-28 rounded-md border px-2 py-1" inputMode="decimal" placeholder="New amount" value={amendValue[f.feeId] ?? ""} onChange={(e) => setAmendValue((p) => ({ ...p, [f.feeId as string]: e.target.value }))} />
                  <Button size="sm" variant="ghost" disabled={pending || !amendDoc[f.feeId] || !amendValue[f.feeId]}
                    onClick={() => run(() => amendClientAgreementFeeAction({ supersedesFeeId: f.feeId as string, amendmentDocumentId: amendDoc[f.feeId as string], entry: { receiver: f.receiver ?? "brokerage", value: Number(amendValue[f.feeId as string]), valueType: f.valueType, payableAtClosing: f.payableAtClosing ?? true, includedInCommission: f.includedInCommission ?? false, effectiveDate: new Date().toISOString().slice(0, 10) } }))}>
                    Record executed amendment
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        {(data?.agreements ?? []).length > 0 ? (
          <div className="space-y-2 border-t pt-3">
            <p className="font-medium">Enter a fee the client&apos;s agreement states</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <select className="rounded-md border px-2 py-1" value={form.agreement} onChange={(e) => setForm((f) => ({ ...f, agreement: e.target.value }))} aria-label="Agreement">
                <option value="">Which agreement…</option>
                {(data?.agreements ?? []).map((a) => <option key={a.id} value={a.id}>{a.kind === "listing_agreement" ? "Listing agreement (seller pays)" : "Buyer-broker agreement (buyer pays)"}</option>)}
              </select>
              <select className="rounded-md border px-2 py-1" value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))} aria-label="Fee">
                {(data?.feeKinds ?? []).map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
              <select className="rounded-md border px-2 py-1" value={form.receiver} onChange={(e) => setForm((f) => ({ ...f, receiver: e.target.value }))} aria-label="Received by">
                <option value="brokerage">received by the brokerage</option>
                <option value="agent">received by the agent</option>
              </select>
              <span className="flex gap-2">
                <input className="w-28 rounded-md border px-2 py-1" inputMode="decimal" placeholder="Amount" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
                <select className="rounded-md border px-2 py-1" value={form.valueType} onChange={(e) => setForm((f) => ({ ...f, valueType: e.target.value }))} aria-label="Unit">
                  <option value="flat">dollars</option>
                  <option value="percent_of_price">% of the price</option>
                </select>
              </span>
              <select className="rounded-md border px-2 py-1" value={form.payableAtClosing} onChange={(e) => setForm((f) => ({ ...f, payableAtClosing: e.target.value }))} aria-label="Payable at closing">
                <option value="yes">payable at closing</option>
                <option value="no">billed outside closing</option>
              </select>
              <select className="rounded-md border px-2 py-1" value={form.included} onChange={(e) => setForm((f) => ({ ...f, included: e.target.value }))} aria-label="Inside the commission">
                <option value="no">a separate fee</option>
                <option value="yes">already included in the commission</option>
              </select>
              <label className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Effective from (per the agreement)</span><input type="date" className="rounded-md border px-2 py-1" value={form.effectiveDate} onChange={(e) => setForm((f) => ({ ...f, effectiveDate: e.target.value }))} /></label>
            </div>
            <Button size="sm" disabled={pending || !chosen || !form.value || !form.effectiveDate}
              onClick={() => run(() => enterClientAgreementFeeAction({
                listingAgreementId: chosen?.kind === "listing_agreement" ? chosen.id : null,
                buyerBrokerAgreementId: chosen?.kind === "buyer_broker_agreement" ? chosen.id : null,
                kind: form.kind as "transaction_fee" | "admin_fee", receiver: form.receiver as "brokerage" | "agent", value: Number(form.value),
                valueType: form.valueType as "flat" | "percent_of_price", payableAtClosing: form.payableAtClosing === "yes", includedInCommission: form.included === "yes", effectiveDate: form.effectiveDate,
              }))}>
              Enter fee (a reviewer verifies it)
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
