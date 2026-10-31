"use client"

import { Alert, AlertDescription } from "@/components/ui/alert"

// Same-body census, round 4 (2026-09-09, lane FC). Survivor for the
// byte-identical private `VerdictNote` in
// app/dashboard/documents/document-actions-dialog.tsx:55 and
// app/dashboard/documents/document-workspace-panel.tsx:77 — plus the
// same-NAME, superset-body copy in
// app/dashboard/transactions/[id]/ai-coordinator-panel.tsx:87, which adds an
// optional `skipped` bullet list. Merged onto this one shape per §6 (one
// vocabulary) rather than left as a third near-duplicate: `skipped` is
// optional so the two-site plain form renders identically to before.

export interface Verdict {
  ok: boolean
  headline: string
  detail?: string
  /** Bulleted list of skipped items — only the ai-coordinator-panel caller
   *  populates this. */
  skipped?: string[]
}

export function VerdictNote({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return null
  return (
    <Alert variant={verdict.ok ? "default" : "destructive"} className="mt-2">
      <AlertDescription className="text-xs space-y-1">
        <p className="font-medium">{verdict.headline}</p>
        {verdict.detail ? <p>{verdict.detail}</p> : null}
        {verdict.skipped && verdict.skipped.length > 0 ? (
          <ul className="list-disc pl-4 space-y-0.5">
            {verdict.skipped.map((s, i) => (
              <li key={i} className="text-[11px] break-words">
                {s}
              </li>
            ))}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
