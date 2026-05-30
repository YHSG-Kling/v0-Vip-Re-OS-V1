"use client"

/**
 * Lead quick-actions panel — drop-in client island for lead detail pages.
 *
 * Authorization (leads are platform OR brokerage-scoped, NEVER agent-assigned) is enforced inside
 * the server actions — this island just renders the buttons.
 */
import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  verifyLeadEmailAction,
  verifyLeadAddressAction,
  enrichLeadAction,
} from "@/app/actions/lead-quick-actions"
import { Sparkles, Mail, MapPin, AlertCircle, CheckCircle2, RefreshCw } from "lucide-react"

export interface LeadQuickActionsProps {
  leadId:          string
  hasEmail:        boolean
  hasAddress:      boolean
  emailVerified?:  boolean | null
  addressVerified?: boolean | null
}

export function LeadQuickActions(props: LeadQuickActionsProps) {
  const [pending, startTransition] = useTransition()
  const [busy,    setBusy]   = useState<"email" | "address" | "enrich" | null>(null)
  const [emailRes,   setEmailRes]   = useState<{ verified?: boolean; reason?: string | null; tier?: number; cost?: number; error?: string } | null>(null)
  const [addressRes, setAddressRes] = useState<{ verified?: boolean; deliverability?: string | null; cost?: number; error?: string } | null>(null)
  const [enrichRes,  setEnrichRes]  = useState<{ success?: boolean; emails?: number; phones?: number; cost?: number; error?: string } | null>(null)

  const run = (which: "email" | "address" | "enrich", deepEmail = false) => {
    setBusy(which)
    startTransition(async () => {
      try {
        if (which === "email")        setEmailRes(await verifyLeadEmailAction({ leadId: props.leadId, deep: deepEmail }))
        else if (which === "address") setAddressRes(await verifyLeadAddressAction({ leadId: props.leadId }))
        else                          setEnrichRes(await enrichLeadAction({ leadId: props.leadId }))
      } finally { setBusy(null) }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> Lead quick actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Skip-trace enrichment */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground inline-flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5" /> Re-run PDL skip-trace
            </span>
            <Button size="sm" variant="default" disabled={pending} onClick={() => run("enrich")}>
              {busy === "enrich" ? "…" : "Enrich"}
            </Button>
          </div>
          {enrichRes && (
            <p className="text-xs">
              {enrichRes.success
                ? <>Surfaced {enrichRes.emails ?? 0} email(s), {enrichRes.phones ?? 0} phone(s){typeof enrichRes.cost === "number" && enrichRes.cost > 0 ? ` · $${enrichRes.cost.toFixed(2)}` : ""}.</>
                : <span className="text-amber-700">{enrichRes.error ?? "no data"}</span>}
            </p>
          )}
        </div>

        {/* Email verify */}
        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground inline-flex items-center gap-2">
              <Mail className="h-3.5 w-3.5" /> Email verification
              {props.emailVerified === true  && <Badge variant="default" className="ml-1">Verified</Badge>}
              {props.emailVerified === false && <Badge variant="outline" className="ml-1">Unverified</Badge>}
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
