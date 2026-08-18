"use client"

// LANE 1 (m481), TENANT SURFACE — the subscription agreement, signed IN-APP on
// the billing page (where a blocked tenant lands and where an activating tenant
// manages their subscription). The signer reads the platform-authored body,
// types their name, and the tenant_contract_signatures row is the signature —
// no e-sign provider, no simulated send (this repo refuses fake sends).

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { signSubscriptionAgreementAction } from "@/app/actions/admin/subscription-agreement"
import type { SubscriptionAgreementView } from "@/app/actions/admin/subscription-agreement"

export function SubscriptionAgreementCard({ initialView }: { initialView: SubscriptionAgreementView }) {
  const [view, setView] = useState(initialView)
  const [signedName, setSignedName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // Nothing authored by the platform yet — honestly nothing to sign.
  if (!view.template) return null

  const template = view.template

  function sign() {
    setError(null)
    startTransition(async () => {
      const res = await signSubscriptionAgreementAction({
        templateId: template.id,
        signedName,
      })
      if (!res.ok) { setError(res.error); return }
      setView((v) => ({
        ...v,
        awaitingSignature: false,
        signature: {
          id: res.signatureId,
          signed_name: signedName,
          signed_at: new Date().toISOString(),
          template_version: template.version,
        },
      }))
    })
  }

  return (
    <div className="rounded-lg border bg-white p-6 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-lg font-semibold">{template.name}</h2>
        <Badge variant="outline">v{template.version}</Badge>
        {view.signature ? (
          <Badge className="bg-green-600">Signed</Badge>
        ) : (
          <Badge variant="secondary">Signature required</Badge>
        )}
      </div>

      {view.signature ? (
        <p className="text-sm text-muted-foreground">
          Signed by {view.signature.signed_name} on {new Date(view.signature.signed_at).toLocaleDateString()}
          {view.signature.template_version ? ` (agreement v${view.signature.template_version})` : ""}.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Your subscription is put in writing by signing this agreement. Read it, then sign below —
            the signature is recorded in-app for your brokerage.
          </p>
          {template.body_text && (
            <pre className="text-xs whitespace-pre-wrap border rounded p-3 max-h-72 overflow-y-auto bg-muted/30">
              {template.body_text}
            </pre>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2 flex-wrap items-center">
            <input
              className="border rounded px-3 py-2 text-sm flex-1 min-w-56"
              placeholder="Type your full legal name to sign"
              value={signedName}
              onChange={(e) => setSignedName(e.target.value)}
            />
            <Button onClick={sign} disabled={isPending || !signedName.trim()}>
              {isPending ? "Signing…" : "Sign agreement"}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
