"use client"

/**
 * Buyer Broker Agreement panel — the agent-side control surface for the BBA
 * lifecycle on a buyer contact.
 *
 * THE MISSING MIDDLE THIS CLOSES: app/actions/buyer-broker-agreements.ts had a
 * complete lifecycle (draft → dispatch to the brokerage's e-sign provider →
 * record signature → cancel) and app/dashboard/buyer-broker-agreements only
 * ever LISTED rows. There was no control anywhere that moved an agreement out
 * of draft, so a drafted BBA could never reach `active` — and lib/buyer-broker/gate.ts
 * fails CLOSED, which means every showing and every offer for that buyer was
 * blocked by NAR 2024 with no way forward from the UI.
 *
 * THE MISSING *FRONT* THIS NOW CLOSES: the lifecycle still had no first step.
 * `createBBADraftAction` — the only session-gated way to create an agreement —
 * had ZERO callers anywhere in the tree. The single code path that ever inserted
 * a `buyer_broker_agreements` row was the VOICE tool-call route
 * (app/api/agent-assistant/tool-call/route.ts:1199, which re-implements the
 * insert against a service client because it runs without an auth session), and
 * this panel's own empty state told the agent to "draft one from the agreements
 * dashboard" — a page that only lists. So for an agent who does not use voice,
 * the NAR-2024 gate was unopenable: no agreement could be created, therefore
 * none could be signed, therefore every showing and offer for that buyer stayed
 * blocked. The draft form below is that first step, on the surface where the
 * agent already sees the gate.
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FileSignature, Loader2, ShieldCheck, Clock, AlertTriangle, Send, Ban, Plus } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  createBBADraftAction,
  getBBAForBuyerAction,
  dispatchBBAToSigningProviderAction,
  recordSignedBBAAction,
  cancelBBAAction,
} from "@/app/actions/buyer-broker-agreements"

interface Agreement {
  id: string
  status: string
  agreement_type: string | null
  commission_percentage: number | null
  commission_flat_amount: number | null
  commission_payer: string | null
  effective_date: string | null
  expiration_date: string | null
  signed_at: string | null
  signed_method: string | null
  signed_document_url: string | null
  created_at: string | null
}

function statusBadge(status: string) {
  switch (status) {
    case "active":
      return <Badge className="bg-emerald-100 text-emerald-800"><ShieldCheck className="h-3 w-3 mr-1" />Active</Badge>
    case "pending_signature":
      return <Badge className="bg-amber-100 text-amber-800"><Clock className="h-3 w-3 mr-1" />Awaiting signature</Badge>
    case "draft":
      return <Badge className="bg-slate-100 text-slate-700">Draft</Badge>
    case "expired":
      return <Badge className="bg-red-100 text-red-800"><AlertTriangle className="h-3 w-3 mr-1" />Expired</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

function commissionText(a: Agreement) {
  if (a.commission_percentage != null) return `${a.commission_percentage}% paid by ${a.commission_payer ?? "—"}`
  if (a.commission_flat_amount != null) {
    return `$${Number(a.commission_flat_amount).toLocaleString()} paid by ${a.commission_payer ?? "—"}`
  }
  return "Commission terms in the document"
}

export function BuyerBrokerAgreementPanel({ contactId }: { contactId: string }) {
  const { toast } = useToast()
  const [agreements, setAgreements] = useState<Agreement[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  // The agreement currently being recorded as signed outside the platform, and
  // the wet/DocuSign document URL the agent is typing for it.
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [signedDocumentUrl, setSignedDocumentUrl] = useState("")

  // ── New draft form ──────────────────────────────────────────────────────────
  // Vocabularies are the LIVE CHECK constraints on buyer_broker_agreements
  // (buyer_broker_agreements_agreement_type_check / _commission_payer_check),
  // which are also exactly the unions CreateBBAInput declares.
  const [drafting, setDrafting] = useState(false)
  const [draftBusy, setDraftBusy] = useState(false)
  const [agreementType, setAgreementType] =
    useState<"exclusive" | "non_exclusive" | "showing_only" | "open">("exclusive")
  const [commissionPayer, setCommissionPayer] =
    useState<"seller" | "buyer" | "split" | "either">("seller")
  const [commissionPercentage, setCommissionPercentage] = useState("")
  const [commissionFlatAmount, setCommissionFlatAmount] = useState("")
  const [expirationDate, setExpirationDate] = useState("")

  function resetDraftForm() {
    setDrafting(false)
    setAgreementType("exclusive")
    setCommissionPayer("seller")
    setCommissionPercentage("")
    setCommissionFlatAmount("")
    setExpirationDate("")
  }

  function handleCreateDraft() {
    // Parsed, not coerced: an unparseable box is sent as undefined so the
    // action's own NAR-2024 rule ("percentage or flat amount required unless
    // showing_only") is the thing that refuses, and the agent is told why —
    // rather than NaN reaching a numeric column.
    const pct  = commissionPercentage.trim() === "" ? undefined : Number(commissionPercentage)
    const flat = commissionFlatAmount.trim() === "" ? undefined : Number(commissionFlatAmount)
    if (pct !== undefined && !Number.isFinite(pct)) {
      toast({ title: "Commission percentage is not a number", variant: "destructive" })
      return
    }
    if (flat !== undefined && !Number.isFinite(flat)) {
      toast({ title: "Flat amount is not a number", variant: "destructive" })
      return
    }

    setDraftBusy(true)
    startTransition(async () => {
      const draftResult = await createBBADraftAction({
        buyerContactId:       contactId,
        agreementType,
        commissionPayer,
        commissionPercentage: pct,
        commissionFlatAmount: flat,
        expirationDate:       expirationDate || undefined,
      })
      setDraftBusy(false)
      if (!draftResult.ok) {
        toast({ title: "Draft not created", description: draftResult.error, variant: "destructive" })
        return
      }
      resetDraftForm()
      toast({
        title: "Draft agreement created",
        description: "Send it for e-signature, or record a signature taken outside the platform.",
      })
      await load()
    })
  }

  const load = useCallback(async () => {
    const result = await getBBAForBuyerAction(contactId)
    if (!result.ok) {
      setLoadError(result.error)
      setAgreements([])
      return
    }
    setLoadError(null)
    setAgreements(result.agreements as Agreement[])
  }, [contactId])

  useEffect(() => { void load() }, [load])

  function handleDispatch(agreementId: string) {
    setBusyId(agreementId)
    startTransition(async () => {
      const dispatchResult = await dispatchBBAToSigningProviderAction(agreementId)
      setBusyId(null)
      if (!dispatchResult.ok) {
        toast({ title: "Not sent for signature", description: dispatchResult.error, variant: "destructive" })
        return
      }
      toast({
        title: `Sent through ${dispatchResult.provider}`,
        description: `Transaction ${dispatchResult.externalTransactionId} — the buyer has been emailed to sign.`,
      })
      await load()
    })
  }

  function handleRecordSigned(agreementId: string, signedMethod: "wet_signature" | "docusign" | "dotloop") {
    setBusyId(agreementId)
    startTransition(async () => {
      const recordResult = await recordSignedBBAAction({
        agreementId,
        signedMethod,
        signedDocumentUrl: signedDocumentUrl.trim() || undefined,
      })
      setBusyId(null)
      if (!recordResult.ok) {
        toast({ title: "Signature not recorded", description: recordResult.error, variant: "destructive" })
        return
      }
      setRecordingId(null)
      setSignedDocumentUrl("")
      toast({ title: "Agreement is active", description: "Showings and offers are no longer gated for this buyer." })
      await load()
    })
  }

  function handleCancel(agreementId: string) {
    const cancellationReason = window.prompt("Why is this agreement being cancelled? (required, 5+ characters)")
    if (cancellationReason === null) return
    setBusyId(agreementId)
    startTransition(async () => {
      const cancelResult = await cancelBBAAction({ agreementId, reason: cancellationReason })
      setBusyId(null)
      if (!cancelResult.ok) {
        toast({ title: "Not cancelled", description: cancelResult.error, variant: "destructive" })
        return
      }
      toast({ title: "Agreement cancelled" })
      await load()
    })
  }

  if (agreements === null) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading buyer broker agreements…
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileSignature className="h-4 w-4 text-primary" />
          Buyer Broker Agreement
        </CardTitle>
        <CardDescription className="text-xs">
          NAR 2024 requires a signed agreement before this buyer can be shown a property or have an
          offer drafted. Showings and offers stay blocked until one is active.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loadError && (
          <p className="text-sm text-red-600">Could not load agreements: {loadError}</p>
        )}

        {!loadError && agreements.length === 0 && !drafting && (
          <p className="text-sm text-muted-foreground">
            No buyer broker agreement on file. Draft one below, or by voice
            (&quot;draft a buyer broker agreement for …&quot;).
          </p>
        )}

        {/* ── Draft a new agreement — the lifecycle's first step ───────────── */}
        {drafting ? (
          <div className="space-y-2.5 rounded-lg border bg-muted/20 p-3">
            <p className="text-xs font-medium">New agreement</p>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="bba-type" className="text-xs">Agreement type</Label>
                <select
                  id="bba-type"
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
                  value={agreementType}
                  onChange={(e) => setAgreementType(e.target.value as typeof agreementType)}
                  disabled={draftBusy}
                >
                  <option value="exclusive">Exclusive</option>
                  <option value="non_exclusive">Non-exclusive</option>
                  <option value="showing_only">Showing only</option>
                  <option value="open">Open</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="bba-payer" className="text-xs">Commission paid by</Label>
                <select
                  id="bba-payer"
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
                  value={commissionPayer}
                  onChange={(e) => setCommissionPayer(e.target.value as typeof commissionPayer)}
                  disabled={draftBusy}
                >
                  <option value="seller">Seller</option>
                  <option value="buyer">Buyer</option>
                  <option value="split">Split</option>
                  <option value="either">Either</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label htmlFor="bba-pct" className="text-xs">Commission %</Label>
                <Input
                  id="bba-pct"
                  inputMode="decimal"
                  placeholder="2.5"
                  value={commissionPercentage}
                  onChange={(e) => setCommissionPercentage(e.target.value)}
                  disabled={draftBusy}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bba-flat" className="text-xs">…or flat $</Label>
                <Input
                  id="bba-flat"
                  inputMode="decimal"
                  placeholder="7500"
                  value={commissionFlatAmount}
                  onChange={(e) => setCommissionFlatAmount(e.target.value)}
                  disabled={draftBusy}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bba-exp" className="text-xs">Expires</Label>
                <Input
                  id="bba-exp"
                  type="date"
                  value={expirationDate}
                  onChange={(e) => setExpirationDate(e.target.value)}
                  disabled={draftBusy}
                  className="h-8 text-xs"
                />
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              NAR 2024 requires explicit compensation terms — a percentage or a flat amount is
              mandatory on every type except &quot;showing only&quot;. Leaving the expiry blank
              defaults it to 90 days from signature.
            </p>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={draftBusy} onClick={handleCreateDraft}>
                {draftBusy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                Create draft
              </Button>
              <Button size="sm" variant="ghost" disabled={draftBusy} onClick={resetDraftForm}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setDrafting(true)}>
            <Plus className="h-3 w-3 mr-1" />
            Draft an agreement
          </Button>
        )}

        {agreements.map((a) => {
          const isBusy = busyId === a.id
          const canDispatch = a.status === "draft"
          const canRecord = a.status === "draft" || a.status === "pending_signature"
          const canCancel = a.status === "draft" || a.status === "pending_signature" || a.status === "active"

          return (
            <div key={a.id} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  {statusBadge(a.status)}
                  <Badge variant="outline" className="text-xs">{a.agreement_type ?? "unspecified"}</Badge>
                </div>
                <span className="text-xs text-muted-foreground">
                  {a.expiration_date ? `Expires ${new Date(a.expiration_date).toLocaleDateString()}` : "No expiration set"}
                </span>
              </div>

              <p className="text-sm">{commissionText(a)}</p>
              {a.signed_at && (
                <p className="text-xs text-muted-foreground">
                  Signed {new Date(a.signed_at).toLocaleDateString()} via {a.signed_method ?? "unknown method"}
                </p>
              )}

              {recordingId === a.id && (
                <div className="space-y-1.5 rounded-md border bg-muted/30 p-2.5">
                  <Label htmlFor={`doc-url-${a.id}`} className="text-xs">
                    Signed document URL (optional)
                  </Label>
                  <Input
                    id={`doc-url-${a.id}`}
                    value={signedDocumentUrl}
                    onChange={(e) => setSignedDocumentUrl(e.target.value)}
                    placeholder="https://…"
                  />
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button size="sm" disabled={isBusy} onClick={() => handleRecordSigned(a.id, "wet_signature")}>
                      {isBusy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Wet signature
                    </Button>
                    <Button size="sm" variant="outline" disabled={isBusy} onClick={() => handleRecordSigned(a.id, "docusign")}>
                      DocuSign
                    </Button>
                    <Button size="sm" variant="outline" disabled={isBusy} onClick={() => handleRecordSigned(a.id, "dotloop")}>
                      Dotloop
                    </Button>
                    <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => { setRecordingId(null); setSignedDocumentUrl("") }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {canDispatch && (
                  <Button size="sm" disabled={isBusy} onClick={() => handleDispatch(a.id)}>
                    {isBusy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                    Send for e-signature
                  </Button>
                )}
                {canRecord && recordingId !== a.id && (
                  <Button size="sm" variant="outline" disabled={isBusy} onClick={() => setRecordingId(a.id)}>
                    Record a signature taken outside the platform
                  </Button>
                )}
                {canCancel && (
                  <Button size="sm" variant="ghost" className="text-red-600" disabled={isBusy} onClick={() => handleCancel(a.id)}>
                    <Ban className="h-3 w-3 mr-1" />
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
