"use client"

/**
 * Buyer-facing click-through signature for the Buyer Broker Agreement.
 *
 * clickThroughSignBBAAction captures affirmative consent plus the signing IP and
 * user agent — the evidence a state RE commission needs for a valid e-signature
 * under E-SIGN / UETA. It existed with no caller, so the "most common modern
 * flow" named in its own docblock was unreachable: a buyer sent an agreement had
 * no way to sign it from the portal, and lib/buyer-broker/gate.ts kept blocking
 * their showings and offers.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { FileSignature, Loader2, CheckCircle2 } from "lucide-react"
import { clickThroughSignBBAAction } from "@/app/actions/buyer-broker-agreements"

interface Props {
  agreementId: string
  agreementType: string | null
  commissionLine: string
  expirationDate: string | null
  agentName: string | null
}

export function BuyerBrokerAgreementSignCard({
  agreementId,
  agreementType,
  commissionLine,
  expirationDate,
  agentName,
}: Props) {
  const [consented, setConsented] = useState(false)
  const [signed, setSigned] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [isSigning, startSigning] = useTransition()

  function handleSign() {
    setRefusal(null)
    startSigning(async () => {
      const signResult = await clickThroughSignBBAAction({
        agreementId,
        affirmativeConsent: consented,
      })
      if (!signResult.ok) {
        setRefusal(signResult.error)
        return
      }
      setSigned(true)
    })
  }

  if (signed) {
    return (
      <Card className="border-emerald-200 bg-emerald-50">
        <CardContent className="p-4 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <div>
            <p className="text-sm font-medium text-emerald-900">Agreement signed</p>
            <p className="text-xs text-emerald-800">
              You can now tour homes and make offers with {agentName ?? "your agent"}.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-amber-200 bg-amber-50">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2 text-amber-900">
          <FileSignature className="h-4 w-4" />
          Sign your buyer representation agreement
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-amber-900">
          {agentName ?? "Your agent"} needs this signed before showing you homes or writing an offer
          on your behalf. {agreementType ? `Agreement type: ${agreementType}. ` : ""}
          {commissionLine}
          {expirationDate ? ` Runs through ${new Date(expirationDate).toLocaleDateString()}.` : ""}
        </p>

        <div className="flex items-start gap-2">
          <Checkbox
            id={`bba-consent-${agreementId}`}
            checked={consented}
            onCheckedChange={(v) => setConsented(v === true)}
            className="mt-0.5"
          />
          <Label htmlFor={`bba-consent-${agreementId}`} className="text-xs leading-snug text-amber-900">
            I have read this agreement, I understand it, and I agree to be bound by it. I consent to
            signing electronically.
          </Label>
        </div>

        {refusal && <p className="text-xs text-red-700">{refusal}</p>}

        <Button size="sm" disabled={!consented || isSigning} onClick={handleSign}>
          {isSigning && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
          Sign agreement
        </Button>
      </CardContent>
    </Card>
  )
}
