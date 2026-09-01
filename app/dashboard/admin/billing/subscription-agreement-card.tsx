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

/**
 * THE TENANT'S OWN ATTESTATION.
 *
 * The signing writer stores a `signature` jsonb beside the typed name —
 * `{ method: "in_app_click_to_sign", typed_name, signed_at }`
 * (app/actions/admin/subscription-agreement.ts:158-162). A typed name is not an
 * attestation: the string is whatever the signer keyed in, while this record is
 * what the platform can say about HOW the agreement was executed. The tenant is
 * entitled to see their OWN record — and only their own (§5: a tenant surface
 * never shows another tenant's signer; the platform-wide table lives on the
 * god console, app/dashboard/superadmin/contracts/subscription-contracts-manager.tsx).
 *
 * SEAM — the tenant-half read does not project the column yet. `getSubscriptionAgreementAction`
 * selects `id, signed_name, signed_at, template_version`
 * (app/actions/admin/subscription-agreement.ts:78) and its view type at :32-37
 * matches. That file is owned by another lane, so this card reads the field
 * STRUCTURALLY: add `signature` to that select and to `SubscriptionAgreementView["signature"]`
 * and the method line below lights up with no change here.
 *
 * Until then, and for any row whose jsonb is missing or malformed, the method is
 * UNKNOWN-NOT-ASSERTED: the card shows the timestamp it does have and says
 * nothing about method. It never renders "verified".
 */
function readAttestationMethod(signature: unknown): { method: string | null; signedAt: string | null } {
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) return { method: null, signedAt: null }
  const o = signature as Record<string, unknown>
  return {
    method:   typeof o.method === "string" && o.method.trim() ? o.method.trim() : null,
    signedAt: typeof o.signed_at === "string" && o.signed_at.trim() ? o.signed_at.trim() : null,
  }
}

function fmtStamp(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : null
}

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
        (() => {
          const sig = view.signature
          const att = readAttestationMethod((sig as unknown as { signature?: unknown }).signature)
          // The RECORD's own timestamp wins over the row stamp when both exist —
          // it is the moment the attestation was made. Falls back to signed_at.
          const when = fmtStamp(att.signedAt) ?? fmtStamp(sig.signed_at)
          return (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">
                Signed by {sig.signed_name}
                {when ? ` on ${when}` : " (timestamp not recorded)"}
                {sig.template_version ? ` (agreement v${sig.template_version})` : ""}.
              </p>
              {att.method ? (
                <p className="text-xs text-muted-foreground">
                  Execution method on your record:{" "}
                  <span className="font-medium">{att.method.replace(/_/g, " ")}</span>. The typed name
                  above is what was keyed in; this is how it was executed.
                </p>
              ) : null}
              <p className="text-[11px] text-muted-foreground">
                Signature record <span className="font-mono">{sig.id.slice(0, 8)}</span> — quote this if you
                need your executed agreement.
              </p>
            </div>
          )
        })()
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
