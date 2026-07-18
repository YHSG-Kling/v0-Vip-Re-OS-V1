"use client"

// Superadmin affiliates manager — client half of the EXTERNAL MRR-commission
// rail (NOT the rev-share tree; see lib/platform/affiliates.ts). Create/edit
// partners, copy ref links, review referrals + accruals, mark periods paid.

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Loader2, Plus, Save, Copy, Handshake, ChevronDown, ChevronUp, BadgeDollarSign } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  createAffiliateAction,
  updateAffiliateAction,
  markPeriodPaidAction,
  type AffiliateRow,
} from "./actions"

function fmtCents(c: number) {
  return `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—"
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  paused: "bg-amber-100 text-amber-800",
  ended: "bg-slate-100 text-slate-500",
}

interface FormState {
  name: string
  email: string
  code: string
  commissionPercent: string
  durationMonths: string
  status: "active" | "paused" | "ended"
  payoutNotes: string
  notes: string
}

const EMPTY_FORM: FormState = {
  name: "", email: "", code: "", commissionPercent: "10", durationMonths: "18",
  status: "active", payoutNotes: "", notes: "",
}

function formFrom(a: AffiliateRow): FormState {
  return {
    name: a.name, email: a.email, code: a.code,
    commissionPercent: String(a.commission_percent), durationMonths: String(a.duration_months),
    status: a.status,
    payoutNotes: typeof a.payout_details?.notes === "string" ? (a.payout_details.notes as string) : "",
    notes: a.notes ?? "",
  }
}

function AffiliateFormFields({ form, setForm, showStatus }: {
  form: FormState
  setForm: (f: FormState) => void
  showStatus: boolean
}) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div>
        <Label className="text-xs">Name</Label>
        <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jane Partner" />
      </div>
      <div>
        <Label className="text-xs">Email</Label>
        <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@partner.com" />
      </div>
      <div>
        <Label className="text-xs">Ref code (3–32: letters, digits, - _)</Label>
        <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="PARTNER1" />
      </div>
      <div>
        <Label className="text-xs">Commission % of MRR (1–50)</Label>
        <Input type="number" min={1} max={50} value={form.commissionPercent} onChange={(e) => setForm({ ...form, commissionPercent: e.target.value })} />
      </div>
      <div>
        <Label className="text-xs">Duration, months (1–60)</Label>
        <Input type="number" min={1} max={60} value={form.durationMonths} onChange={(e) => setForm({ ...form, durationMonths: e.target.value })} />
      </div>
      {showStatus && (
        <div>
          <Label className="text-xs">Status</Label>
          <select
            className="w-full h-9 rounded-md border bg-background px-2 text-sm"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as FormState["status"] })}
          >
            <option value="active">active — link works, commissions accrue</option>
            <option value="paused">paused — no new referrals, no accrual</option>
            <option value="ended">ended — partnership closed</option>
          </select>
        </div>
      )}
      <div className={showStatus ? "md:col-span-3" : "md:col-span-1"}>
        <Label className="text-xs">Payout details (how we pay them)</Label>
        <Input value={form.payoutNotes} onChange={(e) => setForm({ ...form, payoutNotes: e.target.value })} placeholder="e.g. ACH — Chase …1234, W-9 on file" />
      </div>
      <div className="md:col-span-3">
        <Label className="text-xs">Notes</Label>
        <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Internal notes" />
      </div>
    </div>
  )
}

export function AffiliatesManager({ initialAffiliates, refLinkBase, readOnly }: {
  initialAffiliates: AffiliateRow[]
  refLinkBase: string
  readOnly: boolean
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState<FormState>(EMPTY_FORM)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM)

  const origin = refLinkBase || (typeof window !== "undefined" ? window.location.origin : "")
  const refLink = (code: string) => `${origin}/api/ref?code=${encodeURIComponent(code)}`

  const copyLink = async (code: string) => {
    try {
      await navigator.clipboard.writeText(refLink(code))
      toast({ title: "Ref link copied", description: refLink(code) })
    } catch {
      toast({ title: "Copy failed", description: refLink(code), variant: "destructive" })
    }
  }

  const submitCreate = () => startTransition(async () => {
    const res = await createAffiliateAction({
      name: createForm.name, email: createForm.email, code: createForm.code,
      commissionPercent: Number(createForm.commissionPercent), durationMonths: Number(createForm.durationMonths),
      payoutNotes: createForm.payoutNotes, notes: createForm.notes,
    })
    if (res.ok) {
      toast({ title: "Affiliate created", description: `${createForm.code} — share ${refLink(createForm.code.trim())}` })
      setCreateForm(EMPTY_FORM)
      setShowCreate(false)
    } else {
      toast({ title: "Create failed", description: res.error, variant: "destructive" })
    }
  })

  const submitEdit = (id: string) => startTransition(async () => {
    const res = await updateAffiliateAction(id, {
      name: editForm.name, email: editForm.email, code: editForm.code,
      commissionPercent: Number(editForm.commissionPercent), durationMonths: Number(editForm.durationMonths),
      status: editForm.status, payoutNotes: editForm.payoutNotes, notes: editForm.notes,
    })
    if (res.ok) toast({ title: "Affiliate updated" })
    else toast({ title: "Update failed", description: res.error, variant: "destructive" })
  })

  const markPaid = (affiliateId: string, period: string) => startTransition(async () => {
    const res = await markPeriodPaidAction(affiliateId, period)
    if (res.ok) toast({ title: `Marked ${period} paid`, description: `${res.marked} event${res.marked === 1 ? "" : "s"} · ${fmtCents(res.paidCents)}` })
    else toast({ title: "Mark-paid failed", description: res.error, variant: "destructive" })
  })

  return (
    <div className="space-y-4">
      {/* Create */}
      {!readOnly && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Plus className="h-4 w-4" /> New affiliate
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => setShowCreate((s) => !s)}>
                {showCreate ? "Hide" : "Create"}
              </Button>
            </CardTitle>
          </CardHeader>
          {showCreate && (
            <CardContent className="space-y-3">
              <AffiliateFormFields form={createForm} setForm={setCreateForm} showStatus={false} />
              <Button onClick={submitCreate} disabled={pending}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
                Create affiliate
              </Button>
            </CardContent>
          )}
        </Card>
      )}

      {/* List */}
      {initialAffiliates.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <Handshake className="h-8 w-8 mx-auto mb-2 opacity-50" />
            No affiliates yet. Create your first external partner — they get a ref link
            ({origin || "https://your-domain"}/api/ref?code=CODE) and earn a % of platform MRR
            for every tenant they refer, for the duration you set.
          </CardContent>
        </Card>
      ) : (
        initialAffiliates.map((a) => {
          const isOpen = expanded === a.id
          return (
            <Card key={a.id}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                  <span>{a.name}</span>
                  <Badge className={`text-xs ${STATUS_BADGE[a.status] ?? ""}`}>{a.status}</Badge>
                  <span className="font-mono text-xs rounded bg-muted px-1.5 py-0.5">{a.code}</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    {a.commission_percent}% for {a.duration_months} mo · {a.email}
                  </span>
                  <span className="ml-auto flex items-center gap-2 text-xs font-normal">
                    <span className="text-emerald-700 font-semibold">{fmtCents(a.total_accrued_cents)} accrued</span>
                    <span className="text-muted-foreground">{fmtCents(a.total_paid_cents)} paid</span>
                    <Button variant="outline" size="sm" onClick={() => copyLink(a.code)}>
                      <Copy className="h-3.5 w-3.5 mr-1" /> Ref link
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => {
                        if (isOpen) { setExpanded(null) } else { setExpanded(a.id); setEditForm(formFrom(a)) }
                      }}
                    >
                      {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </Button>
                  </span>
                </CardTitle>
              </CardHeader>
              {isOpen && (
                <CardContent className="space-y-5">
                  <p className="text-xs text-muted-foreground font-mono break-all">{refLink(a.code)}</p>

                  {/* Edit */}
                  {!readOnly && (
                    <div className="space-y-3 rounded-md border p-3">
                      <AffiliateFormFields form={editForm} setForm={setEditForm} showStatus />
                      <Button size="sm" onClick={() => submitEdit(a.id)} disabled={pending}>
                        {pending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                        Save changes
                      </Button>
                    </div>
                  )}

                  {/* Referrals */}
                  <div>
                    <h3 className="text-sm font-semibold mb-2">Referred tenants ({a.referrals.length})</h3>
                    {a.referrals.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No referrals yet — signups through this affiliate&apos;s link will appear here.
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-muted-foreground border-b">
                              <th className="py-1.5 pr-3">Tenant</th>
                              <th className="py-1.5 pr-3">Subscription</th>
                              <th className="py-1.5 pr-3 text-right">MRR</th>
                              <th className="py-1.5 pr-3">Attributed</th>
                              <th className="py-1.5 pr-3">First payment</th>
                              <th className="py-1.5 pr-3">Window ends</th>
                              <th className="py-1.5">Window</th>
                            </tr>
                          </thead>
                          <tbody>
                            {a.referrals.map((r) => (
                              <tr key={r.id} className="border-b last:border-0">
                                <td className="py-1.5 pr-3 font-medium">{r.brokerage_name}</td>
                                <td className="py-1.5 pr-3">{r.subscription_status ?? "none"}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">{fmtCents(r.mrr_cents)}</td>
                                <td className="py-1.5 pr-3">{fmtDate(r.attributed_at)}</td>
                                <td className="py-1.5 pr-3">{fmtDate(r.first_payment_at)}</td>
                                <td className="py-1.5 pr-3">{fmtDate(r.window_end)}</td>
                                <td className="py-1.5">
                                  <Badge className={`text-xs ${r.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`}>
                                    {r.active ? "open" : "closed"}
                                  </Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Commissions by period */}
                  <div>
                    <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
                      <BadgeDollarSign className="h-4 w-4" /> Commissions by period
                    </h3>
                    {a.periods.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Nothing accrued yet — the monthly accrual runs against live MRR; trials don&apos;t accrue.
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-muted-foreground border-b">
                              <th className="py-1.5 pr-3">Period</th>
                              <th className="py-1.5 pr-3 text-right">Accrued</th>
                              <th className="py-1.5 pr-3 text-right">Paid</th>
                              <th className="py-1.5 pr-3 text-right">Events</th>
                              <th className="py-1.5" />
                            </tr>
                          </thead>
                          <tbody>
                            {a.periods.map((pRow) => (
                              <tr key={pRow.period} className="border-b last:border-0">
                                <td className="py-1.5 pr-3 font-mono">{pRow.period}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums text-emerald-700">{fmtCents(pRow.accrued_cents)}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">{fmtCents(pRow.paid_cents)}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">{pRow.events}</td>
                                <td className="py-1.5 text-right">
                                  {!readOnly && pRow.accrued_cents > 0 && (
                                    <Button variant="outline" size="sm" disabled={pending} onClick={() => markPaid(a.id, pRow.period)}>
                                      Mark {pRow.period} paid
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </CardContent>
              )}
            </Card>
          )
        })
      )}
    </div>
  )
}
