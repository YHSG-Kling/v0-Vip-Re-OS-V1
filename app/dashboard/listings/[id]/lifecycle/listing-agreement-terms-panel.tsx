"use client"

/**
 * THE LISTING AGREEMENT'S GOVERNING TERMS, ON THE LISTING (wave 145, lane 145B — owner rulings 1 + 2).
 *
 * Shows the five things the owner said must never be confused — the seller-agreed MLS live date (and which executed
 * version states it), the agreement's execution, the planned date the listing follows, and whether the listing is
 * VERIFIED live on the MLS (only a feed can say so) — plus the seller's Coming Soon street-address instruction and what
 * public Coming Soon creative may print. The ONLY way to change an agreed term is the amendment form below: an executed
 * amendment document is chosen, its signing day and the changed term(s) are stated, and the server door
 * (app/actions/seller-listing/listing-agreement-amendment.ts) records it as a new version — nothing is typed over.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { recordListingAgreementAmendmentAction } from "@/app/actions/seller-listing/listing-agreement-amendment"

export interface ListingAgreementTermsPanelProps {
  listingId: string
  /** null when the listing has no executed listing agreement yet. */
  agreementId: string | null
  /** A refused read — rendered as UNKNOWN, never as "not stated". */
  readError: string | null
  /** false until m856 is applied (nothing can be recorded on the agreement yet). */
  termsRecordable: boolean
  agreedDate: { value: string | null; source: "listing_agreement" | "amendment" | null; versionNo: number | null }
  addressInstruction: { value: boolean | null; source: "listing_agreement" | "amendment" | null; versionNo: number | null }
  supersededCount: number
  mls: { planned: string | null; verified: boolean; actual: string | null; verifiedSource: string | null }
  comingSoon: { disclose: boolean; addressLine: string; withheldBecause: string[] } | null
  amendmentDocuments: Array<{ id: string; label: string }>
  canAmend: boolean
}

const sourceLabel = (s: "listing_agreement" | "amendment" | null, v: number | null) =>
  s === "amendment" ? `executed amendment no. ${v ?? "?"}` : s === "listing_agreement" ? "the executed listing agreement" : null

export function ListingAgreementTermsPanel(p: ListingAgreementTermsPanelProps) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [documentId, setDocumentId] = useState("")
  const [executedOn, setExecutedOn] = useState("")
  const [newDate, setNewDate] = useState("")
  const [addressChoice, setAddressChoice] = useState<"unchanged" | "authorized" | "withheld">("unchanged")
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function submit() {
    setMessage(null)
    start(async () => {
      const r = await recordListingAgreementAmendmentAction({
        listingId: p.listingId,
        documentId,
        executedOn,
        ...(newDate ? { sellerRequestedMlsLiveDate: newDate } : {}),
        ...(addressChoice !== "unchanged" ? { comingSoonStreetAddressAuthorized: addressChoice === "authorized" } : {}),
      })
      if (!r.success) { setMessage({ ok: false, text: r.error ?? "The amendment was not recorded." }); return }
      setMessage({ ok: true, text: `Amendment ${r.versionNo} recorded.${r.warning ? ` ${r.warning}` : ""}` })
      setNewDate(""); setAddressChoice("unchanged"); setDocumentId(""); setExecutedOn("")
      router.refresh()
    })
  }

  const agreedFrom = sourceLabel(p.agreedDate.source, p.agreedDate.versionNo)
  const addrFrom = sourceLabel(p.addressInstruction.source, p.addressInstruction.versionNo)

  return (
    <Card className="mb-6">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Listing agreement terms — MLS live date &amp; Coming Soon address</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {p.readError ? (
          <p className="text-amber-700">The listing agreement could not be read ({p.readError}). The agreed terms are unknown, so the street address stays withheld.</p>
        ) : !p.agreementId ? (
          <p className="text-muted-foreground">No executed listing agreement yet. The MLS live date the seller requests is recorded when the signed agreement is filed.</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            <dt className="text-muted-foreground">MLS live date the seller requested</dt>
            <dd>{p.agreedDate.value ? <>{p.agreedDate.value} <span className="text-muted-foreground">({agreedFrom})</span></> : <span className="text-muted-foreground">{p.termsRecordable ? "not stated on the agreement" : "not recordable until migration m856 is applied"}</span>}</dd>
            <dt className="text-muted-foreground">Planned date the listing follows</dt>
            <dd>{p.mls.planned ?? <span className="text-muted-foreground">none</span>}</dd>
            <dt className="text-muted-foreground">Live on the MLS</dt>
            <dd>{p.mls.verified ? <>verified {p.mls.actual} ({p.mls.verifiedSource})</> : <span className="text-muted-foreground">not verified — only the RentCast / IDX feed can confirm it</span>}</dd>
            <dt className="text-muted-foreground">Street address in Coming Soon advertising</dt>
            <dd>{p.addressInstruction.value === true ? <>seller authorized <span className="text-muted-foreground">({addrFrom})</span></> : p.addressInstruction.value === false ? <>seller withheld it <span className="text-muted-foreground">({addrFrom})</span></> : <span className="text-muted-foreground">not recorded — withheld</span>}</dd>
            {p.comingSoon && (
              <>
                <dt className="text-muted-foreground">Coming Soon creative prints</dt>
                <dd>{p.comingSoon.addressLine}{!p.comingSoon.disclose && p.comingSoon.withheldBecause[0] ? <span className="block text-xs text-muted-foreground">{p.comingSoon.withheldBecause[0]}</span> : null}</dd>
              </>
            )}
            {p.supersededCount > 0 && (
              <>
                <dt className="text-muted-foreground">Superseded terms kept</dt>
                <dd className="text-muted-foreground">{p.supersededCount} earlier value(s) remain on record beside the governing ones</dd>
              </>
            )}
          </dl>
        )}

        {p.agreementId && p.termsRecordable && p.canAmend && (
          <div className="rounded-md border border-border p-3 space-y-2">
            <p className="font-medium">Record an executed amendment</p>
            <p className="text-xs text-muted-foreground">An agreed term changes only by an amendment both the seller and the listing side signed. Choose the stored, signed document; the term below is your reading of it.</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <Label htmlFor="amend-doc">Signed amendment document</Label>
                <select id="amend-doc" className="w-full rounded-md border border-border bg-background px-2 py-1.5" value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
                  <option value="">Choose…</option>
                  {p.amendmentDocuments.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </div>
              <div>
                <Label htmlFor="amend-day">Fully signed on</Label>
                <Input id="amend-day" type="date" value={executedOn} onChange={(e) => setExecutedOn(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="amend-date">New MLS live date the seller requests</Label>
                <Input id="amend-date" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="amend-addr">Street address in Coming Soon advertising</Label>
                <select id="amend-addr" className="w-full rounded-md border border-border bg-background px-2 py-1.5" value={addressChoice} onChange={(e) => setAddressChoice(e.target.value as typeof addressChoice)}>
                  <option value="unchanged">Not changed by this amendment</option>
                  <option value="authorized">Seller authorizes it</option>
                  <option value="withheld">Seller withholds it</option>
                </select>
              </div>
            </div>
            <Button size="sm" disabled={pending || !documentId || !executedOn || (!newDate && addressChoice === "unchanged")} onClick={submit}>
              {pending ? "Recording…" : "Record amendment"}
            </Button>
            {message && <p className={message.ok ? "text-emerald-700" : "text-red-700"}>{message.text}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
