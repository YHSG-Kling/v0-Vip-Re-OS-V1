"use client"

// LANE 1 (m481), TENANT SURFACE — the subscription agreement, signed IN-APP on
// the billing page (where a blocked tenant lands and where an activating tenant
// manages their subscription). The signer reads the platform-authored body,
// types their name, and the tenant_contract_signatures row is the signature —
// no e-sign provider, no simulated send (this repo refuses fake sends).
//
// WAVE 151 (lane 151A): the card now says WHO may sign (the corporate
// signatory — app/actions/admin/subscription-agreement.ts `canSign` /
// `signRefusal`), takes the signer's title, shows the version label + content
// hash the acceptance is pinned to, and hands back the accepted copy
// (downloadAcceptedAgreementAction — hash re-verified server-side).

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { signSubscriptionAgreementAction, downloadAcceptedAgreementAction } from "@/app/actions/admin/subscription-agreement"
import type { SubscriptionAgreementView } from "@/app/actions/admin/subscription-agreement"

/**
 * THE TENANT'S OWN ATTESTATION.
 *
 * The signing writer stores a `signature` jsonb beside the typed name —
 * `{ method: "in_app_click_to_sign", typed_name, signed_at }`
 * (app/actions/admin/subscription-agreement.ts). A typed name is not an
 * attestation: the string is whatever the signer keyed in, while this record is
 * what the platform can say about HOW the agreement was executed. The tenant is
 * entitled to see their OWN record — and only their own (§5: a tenant surface
 * never shows another tenant's signer; the platform-wide table lives on the
 * god console, app/dashboard/superadmin/contracts/subscription-contracts-manager.tsx).
 *
 * For any row whose jsonb is missing or malformed, the method is
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

function shortHash(h: string | null | undefined): string | null {
  return h && h.length >= 12 ? `${h.slice(0, 12)}…` : h ?? null
}

/** Hand the accepted copy to the browser as a file (the body came from the server with its hash re-verified). */
function saveCopy(copy: { fileName: string; contentType: string; body: string }) {
  const blob = new Blob([copy.body], { type: copy.contentType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = copy.fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function SubscriptionAgreementCard({ initialView }: { initialView: SubscriptionAgreementView }) {
  const [view, setView] = useState(initialView)
  const [signedName, setSignedName] = useState("")
  const [signedTitle, setSignedTitle] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
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
        signedTitle: signedTitle.trim() || null,
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
          version_label: template.version_label ?? null,
          content_sha256: template.content_sha256 ?? null,
        },
      }))
    })
  }

  function download(signatureId: string) {
    setDownloadError(null)
    startTransition(async () => {
      const res = await downloadAcceptedAgreementAction({ signatureId })
      if (!res.ok) { setDownloadError(res.error); return }
      saveCopy(res.copy)
    })
  }

  return (
    <div className="rounded-lg border bg-white p-6 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-lg font-semibold">{template.name}</h2>
        <Badge variant="outline">{template.version_label ? `${template.version_label} (v${template.version})` : `v${template.version}`}</Badge>
        {view.signature ? (
          <Badge className="bg-green-600">Signed</Badge>
        ) : (
          <Badge variant="secondary">Signature required</Badge>
        )}
      </div>
      {template.content_sha256 ? (
        <p className="text-[11px] text-muted-foreground">
          Content hash <span className="font-mono">{shortHash(template.content_sha256)}</span> — the exact text this version is, and what your acceptance is pinned to.
        </p>
      ) : null}

      {view.signature ? (
        (() => {
          const sig = view.signature
          const att = readAttestationMethod((sig as unknown as { signature?: unknown }).signature)
          // The RECORD's own timestamp wins over the row stamp when both exist —
          // it is the moment the attestation was made. Falls back to signed_at.
          const when = fmtStamp(att.signedAt) ?? fmtStamp(sig.signed_at)
          const title = typeof (sig.signatory as Record<string, unknown> | null | undefined)?.typed_title === "string" ? String((sig.signatory as Record<string, unknown>).typed_title) : null
          return (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">
                Signed by {sig.signed_name}{title ? `, ${title}` : ""}
                {when ? ` on ${when}` : " (timestamp not recorded)"}
                {sig.version_label ? ` (agreement ${sig.version_label})` : sig.template_version ? ` (agreement v${sig.template_version})` : ""}.
              </p>
              {att.method ? (
                <p className="text-xs text-muted-foreground">
                  Execution method on your record:{" "}
                  <span className="font-medium">{att.method.replace(/_/g, " ")}</span>. The typed name
                  above is what was keyed in; this is how it was executed.
                </p>
              ) : null}
              <p className="text-[11px] text-muted-foreground">
                Signature record <span className="font-mono">{sig.id.slice(0, 8)}</span>
                {sig.content_sha256 ? <> · content hash <span className="font-mono">{shortHash(sig.content_sha256)}</span></> : null} — quote this if you
                need your executed agreement.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <Button size="sm" variant="outline" onClick={() => download(sig.id)} disabled={isPending}>
                  {isPending ? "Preparing…" : "Download your accepted copy"}
                </Button>
                {downloadError ? <span className="text-xs text-red-600">{downloadError}</span> : null}
              </div>
            </div>
          )
        })()
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Your subscription is put in writing by signing this agreement. Read it, then sign below —
            the signature is recorded in-app for your brokerage.
            {view.priorAcceptances.length ? " A newer version is in force: your earlier acceptance stays on record below, and this version needs your acceptance again." : ""}
          </p>
          {template.body_text ? (
            <pre className="text-xs whitespace-pre-wrap border rounded p-3 max-h-72 overflow-y-auto bg-muted/30">
              {template.body_text}
            </pre>
          ) : view.documentUrl ? (
            // The document-arm renderer (built 2026-09-07): body_text is empty,
            // so this template is an uploaded PDF — the signed url is minted
            // fresh on every read (app/actions/admin/subscription-agreement.ts's
            // mintContractDocumentUrl) and never persisted, so it stays valid for
            // this page view without being a permanent link anyone could reuse.
            <div className="space-y-2">
              <iframe
                src={view.documentUrl}
                title={`${template.name} (PDF)`}
                className="w-full h-72 border rounded"
              />
              <a
                href={view.documentUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-600 underline underline-offset-2"
              >
                Open the agreement (PDF) in a new tab
              </a>
            </div>
          ) : (
            <p className="text-sm text-amber-700">
              This agreement is a stored document and a viewable link could not be created right now — reload the page.
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {view.canSign ? (
            <div className="flex gap-2 flex-wrap items-center">
              <input
                className="border rounded px-3 py-2 text-sm flex-1 min-w-56"
                placeholder="Type your full legal name to sign"
                value={signedName}
                onChange={(e) => setSignedName(e.target.value)}
              />
              <input
                className="border rounded px-3 py-2 text-sm min-w-48"
                placeholder="Your title for the brokerage (e.g. Broker of Record)"
                value={signedTitle}
                onChange={(e) => setSignedTitle(e.target.value)}
              />
              <Button onClick={sign} disabled={isPending || !signedName.trim()}>
                {isPending ? "Signing…" : "Sign agreement"}
              </Button>
            </div>
          ) : (
            <p role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {view.signRefusal ?? "You are not this brokerage's authorized signatory."}
            </p>
          )}
        </>
      )}

      {view.priorAcceptances.length ? (
        <div className="border-t pt-3">
          <h3 className="text-sm font-medium">Earlier accepted versions</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {view.priorAcceptances.map((p) => (
              <li key={p.id} className="flex items-center gap-2 flex-wrap">
                <span>{p.version_label ?? (p.template_version ? `v${p.template_version}` : "version not recorded")} — signed by {p.signed_name}{fmtStamp(p.signed_at) ? ` on ${fmtStamp(p.signed_at)}` : ""}</span>
                <Button size="sm" variant="ghost" onClick={() => download(p.id)} disabled={isPending}>Download copy</Button>
              </li>
            ))}
          </ul>
          {downloadError && !view.signature ? <p className="text-xs text-red-600">{downloadError}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
