"use client"

// app/dashboard/transactions/[id]/hazard-insurance-section.tsx
//
// HAZARD / HOMEOWNER'S INSURANCE — the buyer-transaction step, on the deal detail
// page. Two halves, exactly as ruled:
//
//   TRACK       the bound policy (carrier, number, coverage, dates, premium) and
//               the binder / declarations page itself. The ABSENCE of a policy is
//               a stated state with its own headline and its own deadline — never
//               an empty space — because an unbound policy near closing is what
//               actually stops a funding.
//   RECOMMEND   insurance vendors from the brokerage's own marketplace, each
//               linking to the spot it already has on the buyer's portal
//               marketplace. Order comes from the shared contact-vendor resolver
//               (preferred → display_priority), so paid placement is honoured and
//               no second ranking exists here.
//
// This component RENDERS; it decides nothing. Every posture, label, deadline and
// severity comes from the pure evaluator in lib/transactions/hazard-insurance.ts —
// the same module the closing-orchestration cron reads — so the badge an agent
// sees can never be calmer than the alarm the cron raised.

import { useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { ShieldCheck, ShieldAlert, ShieldQuestion, Loader2, Star, Phone, Mail, ExternalLink, FileText } from "lucide-react"
import { recordHazardPolicyAction } from "@/app/actions/transaction-hazard-insurance"
import {
  HAZARD_EVIDENCE_LEAD_DAYS,
  type HazardInsuranceView,
  type HazardPosture,
} from "@/lib/transactions/hazard-insurance"

const POSTURE_STYLE: Record<HazardPosture, { className: string; Icon: typeof ShieldCheck }> = {
  none:            { className: "bg-red-50 text-red-800 border-red-200",           Icon: ShieldAlert },
  quote_requested: { className: "bg-amber-50 text-amber-800 border-amber-200",     Icon: ShieldQuestion },
  quote_approved:  { className: "bg-amber-50 text-amber-800 border-amber-200",     Icon: ShieldQuestion },
  expiry_unknown:  { className: "bg-amber-50 text-amber-800 border-amber-200",     Icon: ShieldQuestion },
  lapsed:          { className: "bg-red-50 text-red-800 border-red-200",           Icon: ShieldAlert },
  expiring:        { className: "bg-amber-50 text-amber-800 border-amber-200",     Icon: ShieldAlert },
  bound:           { className: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: ShieldCheck },
}

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

/** A stored value or an explicit "not on file" — never a blank cell that reads as zero. */
function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={value ? "text-sm font-medium" : "text-sm italic text-muted-foreground"}>
        {value ?? "Not on file"}
      </dd>
    </div>
  )
}

export function HazardInsuranceSection({
  transactionId,
  brokerageId,
  view,
}: {
  transactionId: string
  brokerageId: string
  view: HazardInsuranceView
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [showForm, setShowForm] = useState(false)
  const [carrier, setCarrier] = useState("")
  const [policyNumber, setPolicyNumber] = useState("")
  const [coverageAmount, setCoverageAmount] = useState("")
  const [annualPremium, setAnnualPremium] = useState("")
  const [effectiveDate, setEffectiveDate] = useState("")
  const [expiry, setExpiry] = useState("")
  const [binderUrl, setBinderUrl] = useState("")
  const [notes, setNotes] = useState("")
  const [vendorId, setVendorId] = useState<string | null>(null)

  // A failed read is stated, not papered over with an empty panel that would
  // read as "no policy on file" — the opposite fact.
  if (!view.ok || !view.status) {
    return (
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldQuestion className="h-4 w-4" /> Hazard Insurance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {view.error ?? "This deal's insurance record could not be read, so its status is unknown."}
          </p>
        </CardContent>
      </Card>
    )
  }

  const s = view.status
  const style = POSTURE_STYLE[s.posture]
  const StatusIcon = style.Icon

  const submit = () => {
    startTransition(async () => {
      const res = await recordHazardPolicyAction({
        transactionId,
        brokerageId,
        carrier: carrier.trim(),
        policyNumber: policyNumber.trim() || undefined,
        coverageAmount: coverageAmount.trim() ? Number(coverageAmount) : undefined,
        annualPremium: annualPremium.trim() ? Number(annualPremium) : undefined,
        effectiveDate: effectiveDate || undefined,
        expiry: expiry || undefined,
        binderUrl: binderUrl.trim() || undefined,
        vendorId,
        notes: notes.trim() || undefined,
      })
      if (!res.success) {
        toast({ title: "Policy not recorded", description: res.error, variant: "destructive" })
        return
      }
      toast({ title: "Policy recorded", description: "The homeowner's policy is on file for this deal." })
      setShowForm(false)
    })
  }

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <StatusIcon className="h-4 w-4" /> Hazard Insurance
            </CardTitle>
            <CardDescription className="text-xs">
              The buyer&apos;s homeowner&apos;s policy — the lender needs evidence of coverage about{" "}
              {HAZARD_EVIDENCE_LEAD_DAYS} days before funding.
            </CardDescription>
          </div>
          <Badge
            variant="outline"
            // A bound policy whose binder was never filed is not a green state —
            // the lender underwrites the document. Follow the evaluator's verdict
            // rather than the posture name.
            className={s.blocksClosing ? POSTURE_STYLE.lapsed.className : style.className}
          >
            {s.label}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* The verdict, in words, always naming the fact it comes from. */}
        <p className="text-sm">{s.detail}</p>

        {/* SELLER-SIDE DEAL. Stated BEFORE anything else on this card, because
            every other line here would otherwise be read as a fact about the
            deal rather than a fact about our records. The buyer's carrier
            answers to another brokerage: we never see the binder, so an empty
            panel is silence, not absence of coverage — and the evaluator has
            already refused to raise a closing blocker on it. */}
        {view.sideNote && (
          <div className="rounded-md border border-muted bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {view.sideNote}
          </div>
        )}

        {/* The deadline. Stated whenever there is a close date AND the coverage
            is ours to chase — an agent should not have to compute it, and should
            not be handed a due date for another brokerage's paperwork. */}
        {view.representsBuyer && s.evidenceDueDate && (
          <div
            className={`rounded-md border px-3 py-2 text-xs ${
              s.blocksClosing
                ? "border-red-200 bg-red-50 text-red-800"
                : "border-muted bg-muted/40 text-muted-foreground"
            }`}
          >
            Binder due on file by <span className="font-semibold">{s.evidenceDueDate}</span>
            {s.daysToClose != null && <> — {s.daysToClose} day{s.daysToClose === 1 ? "" : "s"} to close</>}
            {s.blocksClosing && <> · this is currently a closing blocker.</>}
          </div>
        )}

        {/* The tracked policy. Rendered only when there IS one; every unknown
            field says so rather than showing an empty value. */}
        {s.hasPolicyOnFile && (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Fact label="Carrier" value={s.carrier} />
            <Fact label="Policy number" value={s.policyNumber} />
            <Fact label="Dwelling coverage" value={s.coverageAmount != null ? money(s.coverageAmount) : null} />
            <Fact label="Annual premium" value={s.annualPremium != null ? `${money(s.annualPremium)}/yr` : null} />
            <Fact label="Effective" value={s.effectiveDate} />
            <Fact label="Expires" value={s.expiry} />
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-xs text-muted-foreground">Binder / declarations page</dt>
              <dd className="text-sm">
                {s.documentId ? (
                  <span className="inline-flex items-center gap-1 font-medium">
                    <FileText className="h-3.5 w-3.5" /> Filed to this deal&apos;s documents
                  </span>
                ) : (
                  <span className="italic text-muted-foreground">
                    Not filed — the lender needs the document, not just the numbers.
                  </span>
                )}
              </dd>
            </div>
          </dl>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={s.hasPolicyOnFile ? "outline" : "default"} onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : s.hasPolicyOnFile ? "Update policy" : "Record bound policy"}
          </Button>
        </div>

        {showForm && (
          <div className="space-y-3 rounded-lg border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="hzCarrier">Carrier *</Label>
                <Input id="hzCarrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="hzPolicyNo">Policy number</Label>
                <Input id="hzPolicyNo" value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="hzCoverage">Dwelling coverage ($)</Label>
                <Input id="hzCoverage" type="number" min="0" value={coverageAmount} onChange={(e) => setCoverageAmount(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="hzPremium">Annual premium ($)</Label>
                <Input id="hzPremium" type="number" min="0" value={annualPremium} onChange={(e) => setAnnualPremium(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="hzEffective">Effective date</Label>
                <Input id="hzEffective" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="hzExpiry">Expiry date</Label>
                <Input id="hzExpiry" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="mt-1" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="hzBinder">Binder / declarations page URL</Label>
                <Input id="hzBinder" value={binderUrl} onChange={(e) => setBinderUrl(e.target.value)} placeholder="Link to the uploaded document" className="mt-1" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="hzNotes">Notes</Label>
                <Textarea id="hzNotes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" />
              </div>
            </div>

            {/* Attributing the policy to a marketplace vendor is OPTIONAL: a buyer
                who brings their own agent from outside the marketplace is normal
                and must stay recordable. */}
            {view.recommendations.length > 0 && (
              <div>
                <Label className="text-xs">Marketplace carrier (optional)</Label>
                <div className="mt-1 flex flex-wrap gap-2">
                  {view.recommendations.map((v) => (
                    <Button
                      key={v.vendorId}
                      type="button"
                      size="sm"
                      variant={vendorId === v.vendorId ? "default" : "outline"}
                      onClick={() => {
                        const next = vendorId === v.vendorId ? null : v.vendorId
                        setVendorId(next)
                        if (next && !carrier.trim() && v.name) setCarrier(v.name)
                      }}
                    >
                      {v.name ?? "Vendor"}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button size="sm" onClick={submit} disabled={pending || !carrier.trim()}>
                {pending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Save policy
              </Button>
            </div>
          </div>
        )}

        {/* ── Recommendation half ───────────────────────────────────────────
            BUYER SIDE ONLY. There is nobody to recommend a carrier to on a
            seller-side deal, and the buyer's portal marketplace link below
            points at another brokerage's client. The action already returns an
            empty list with a stated reason; the whole half is withheld rather
            than rendered as an emptiness the agent has to interpret. */}
        {view.representsBuyer && (
        <div className="border-t pt-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Insurance vendors on your marketplace
          </h4>

          {view.recommendations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {view.recommendationNote ?? "No insurance vendors are available for this buyer."}
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {view.recommendations.map((v) => (
                <div key={v.vendorId} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{v.name ?? "Vendor"}</p>
                      <div className="mt-0.5 flex items-center gap-2">
                        {v.preferred && (
                          <Badge className="border-amber-200 bg-amber-100 text-[10px] text-amber-800">Preferred</Badge>
                        )}
                        {v.rating != null && (
                          <span className="inline-flex items-center gap-1 text-xs">
                            <Star className="h-3 w-3 fill-yellow-400 text-yellow-500" />
                            {Number(v.rating).toFixed(1)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                    {v.phone && (
                      <a href={`tel:${v.phone}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                        <Phone className="h-3 w-3" /> {v.phone}
                      </a>
                    )}
                    {v.email && (
                      <a href={`mailto:${v.email}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                        <Mail className="h-3 w-3" /> Email
                      </a>
                    )}
                    {v.marketplaceUrl && (
                      <Link href={v.marketplaceUrl} className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                        <ExternalLink className="h-3 w-3" /> Their marketplace spot
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {view.buyerContactId && (
            <p className="mt-2 text-xs text-muted-foreground">
              <Link href={`/portal/${view.buyerContactId}/vendors#vendor-category-insurance`} className="text-blue-600 hover:underline">
                Open the buyer&apos;s marketplace at the insurance section →
              </Link>{" "}
              Contact details there are governed by the brokerage&apos;s RESPA / affiliated-business
              disclosure gate.
            </p>
          )}
        </div>
        )}
      </CardContent>
    </Card>
  )
}
