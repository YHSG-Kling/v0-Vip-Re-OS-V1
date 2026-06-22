"use client"

/**
 * Contact quick-actions panel — drop-in client island for any contact detail page.
 *
 * Usage:
 *   import { ContactQuickActions } from "@/components/contact/ContactQuickActions"
 *   <ContactQuickActions contactId={contact.id} hasEmail={!!contact.email}
 *                        hasAddress={!!contact.mailing_address}
 *                        emailVerified={contact.email_verified}
 *                        addressVerified={contact.mailing_address_verified} />
 *
 * Authorization is enforced INSIDE the server actions — this island just renders the buttons.
 * A non-authorized click still gets a structured `Forbidden` error response (no row leak).
 */
import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  runDealInvestigatorAction,
  verifyContactEmailAction,
  verifyContactAddressAction,
} from "@/app/actions/contact-quick-actions"
import { convertOutsideInquiryToRepresentedBuyer } from "@/app/actions/convert-outside-inquiry"
import { ContactFatigueGuard } from "@/components/contact/ContactFatigueGuard"
import { Sparkles, Mail, MapPin, AlertCircle, CheckCircle2, UserCheck } from "lucide-react"

export interface ContactQuickActionsProps {
  contactId:        string
  hasEmail:         boolean
  hasAddress:       boolean
  emailVerified?:   boolean | null
  addressVerified?: boolean | null
  /** When provided, gates the "convert outside inquiry" button — surfaces only for
   *  buyer-type contacts that don't yet have a buyer_stage (i.e. came in via the public
   *  listing page or outside-agent showing form and haven't been promoted yet). */
  contactType?:     string | null
  buyerStage?:      string | null
}

export function ContactQuickActions(props: ContactQuickActionsProps) {
  const [pending, startTransition] = useTransition()
  const [investigation, setInvestigation] = useState<{ summary?: string; warnings?: string[]; cost?: number; error?: string } | null>(null)
  const [emailRes,   setEmailRes]   = useState<{ verified?: boolean; reason?: string | null; tier?: number; cost?: number; error?: string } | null>(null)
  const [addressRes, setAddressRes] = useState<{ verified?: boolean; deliverability?: string | null; cost?: number; error?: string } | null>(null)
  const [convertRes, setConvertRes] = useState<{ bbaId?: string; bbaCreated?: boolean; buyerStage?: string; error?: string } | null>(null)
  const [busy, setBusy] = useState<"investigate" | "email" | "address" | "convert" | null>(null)

  // Surface the "convert outside inquiry" button only when the contact looks like an
  // un-promoted buyer-side inquiry: contact_type === "buyer" AND buyer_stage is null/empty.
  // (Once converted the action sets buyer_stage = "BUYER_CONTACT_CREATED" so this disappears.)
  const showConvert =
    props.contactType === "buyer" &&
    (!props.buyerStage || props.buyerStage === "")

  const run = (which: "investigate" | "email" | "address" | "convert", deepEmail = false) => {
    // Ethical-attestation gate for the conversion path. NAR Code of Ethics Article 16
    // forbids converting a buyer who is already represented by another agent. The server
    // action enforces this via attestUnrepresented + the external_agent source check, but
    // we surface the question to the agent here so they consciously affirm before the call.
    if (which === "convert") {
      const ok = typeof window !== "undefined" && window.confirm(
        "Have you confirmed this buyer is NOT currently represented by another real estate agent?\n\n" +
        "Converting a represented buyer violates NAR Code of Ethics Article 16 (interference with another REALTOR's exclusive representation).\n\n" +
        "Click OK only if you have verified the buyer is unrepresented."
      )
      if (!ok) return
    }

    setBusy(which)
    startTransition(async () => {
      try {
        if (which === "investigate") {
          setInvestigation(await runDealInvestigatorAction({ contactId: props.contactId }))
        } else if (which === "email") {
          setEmailRes(await verifyContactEmailAction({ contactId: props.contactId, deep: deepEmail }))
        } else if (which === "address") {
          setAddressRes(await verifyContactAddressAction({ contactId: props.contactId }))
        } else {
          const r = await convertOutsideInquiryToRepresentedBuyer({
            contactId:           props.contactId,
            attestUnrepresented: true,
          })
          setConvertRes(r.success
            ? { bbaId: r.bbaId, bbaCreated: r.bbaCreated, buyerStage: r.buyerStage }
            : { error: r.error })
        }
      } finally { setBusy(null) }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> AI quick actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Reach-out fatigue guard — tells the agent whether this contact is over-contacted
            before they fire any outreach action below. Read-only; renders nothing until loaded. */}
        <ContactFatigueGuard contactId={props.contactId} />

        {/* Convert outside inquiry → represented buyer (only renders pre-conversion) */}
        {showConvert && (
          <div className="space-y-2 rounded border border-amber-200 bg-amber-50/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-amber-900 inline-flex items-center gap-2">
                <UserCheck className="h-3.5 w-3.5" />
                Unconverted buyer inquiry — drafts a BBA (NAR 2024) before showings/offers
              </span>
              <Button size="sm" variant="default" disabled={pending} onClick={() => run("convert")}>
                {busy === "convert" ? "Converting…" : "Convert to my buyer"}
              </Button>
            </div>
            {convertRes?.bbaId && (
              <p className="text-xs text-emerald-700 inline-flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {convertRes.bbaCreated ? "BBA drafted" : "Existing BBA found"} — stage set to {convertRes.buyerStage}.
              </p>
            )}
            {convertRes?.error && <p className="text-xs text-red-600 inline-flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5" /> {convertRes.error}</p>}
          </div>
        )}

        {/* Investigator */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">One-paragraph deal brief from PDL + RentCast + BatchData</span>
            <Button size="sm" variant="default" disabled={pending} onClick={() => run("investigate")}>
              {busy === "investigate" ? "Investigating…" : "Run investigation"}
            </Button>
          </div>
          {investigation?.summary && (
            <div className="text-sm rounded border bg-muted/30 p-3 leading-relaxed">{investigation.summary}</div>
          )}
          {investigation?.warnings && investigation.warnings.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">{investigation.warnings.length} warning(s)</summary>
              <ul className="mt-1 list-disc pl-5">{investigation.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
          {investigation?.error && <p className="text-xs text-red-600">{investigation.error}</p>}
          {typeof investigation?.cost === "number" && <p className="text-xs text-muted-foreground">≈ ${investigation.cost.toFixed(3)}</p>}
        </div>

        {/* Email verify */}
        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground inline-flex items-center gap-2">
              <Mail className="h-3.5 w-3.5" /> Email verification
              {props.emailVerified === true   && <Badge variant="default"  className="ml-1">Verified</Badge>}
              {props.emailVerified === false  && <Badge variant="outline"  className="ml-1">Unverified</Badge>}
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" disabled={!props.hasEmail || pending} onClick={() => run("email", false)} title="Free: RFC + DNS MX">
                {busy === "email" ? "…" : "Quick"}
              </Button>
              <Button size="sm" variant="default" disabled={!props.hasEmail || pending} onClick={() => run("email", true)} title="Deep: PDL email validation (~$0.01)">
                Deep
              </Button>
            </div>
          </div>
          {emailRes && (
            <p className="text-xs inline-flex items-center gap-1">
              {emailRes.verified
                ? <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Verified at Tier {emailRes.tier}</>
                : <><AlertCircle  className="h-3.5 w-3.5 text-amber-600" />  {emailRes.reason ?? emailRes.error ?? "Not verified"}</>}
              {typeof emailRes.cost === "number" && emailRes.cost > 0 && <span className="text-muted-foreground">· ${emailRes.cost.toFixed(3)}</span>}
            </p>
          )}
          {!props.hasEmail && <p className="text-xs text-muted-foreground">No email on file.</p>}
        </div>

        {/* Address verify */}
        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground inline-flex items-center gap-2">
              <MapPin className="h-3.5 w-3.5" /> Mailing address verification
              {props.addressVerified === true  && <Badge variant="default" className="ml-1">Verified</Badge>}
              {props.addressVerified === false && <Badge variant="outline" className="ml-1">Unverified</Badge>}
            </span>
            <Button size="sm" variant="default" disabled={!props.hasAddress || pending} onClick={() => run("address")} title="Lob US verifications">
              {busy === "address" ? "…" : "Verify"}
            </Button>
          </div>
          {addressRes && (
            <p className="text-xs inline-flex items-center gap-1">
              {addressRes.verified
                ? <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Deliverable</>
                : <><AlertCircle  className="h-3.5 w-3.5 text-amber-600" />  {addressRes.deliverability ?? addressRes.error ?? "Not verified"}</>}
              {typeof addressRes.cost === "number" && addressRes.cost > 0 && <span className="text-muted-foreground">· ${addressRes.cost.toFixed(4)}</span>}
            </p>
          )}
          {!props.hasAddress && <p className="text-xs text-muted-foreground">No mailing address on file.</p>}
        </div>
      </CardContent>
    </Card>
  )
}
