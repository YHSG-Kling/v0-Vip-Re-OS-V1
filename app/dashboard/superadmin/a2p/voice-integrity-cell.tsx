"use client"

// Per-tenant CNAM/SHAKEN register button for the A2P board — same idiom as the
// connectors page's A2pVerifyCard: one button, one server action, the honest
// result line shown verbatim (the runner refuses before campaign approval and
// without creds; nothing here fabricates a status).

import { useState } from "react"
import { registerVoiceIntegrityAction } from "./actions"

export function VoiceIntegrityCell({ brokerageId, eligible }: { brokerageId: string; eligible: boolean }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const run = async () => {
    setBusy(true); setResult(null)
    const r = await registerVoiceIntegrityAction(brokerageId)
    setResult(r.error ? `${r.statusLine ? `${r.statusLine} — ` : ""}${r.error}` : r.statusLine)
    setBusy(false)
  }

  return (
    <div className="space-y-1">
      <button
        onClick={run}
        disabled={busy || !eligible}
        title={eligible ? "Register CNAM + SHAKEN/STIR on the tenant's TrustHub profile (and re-poll reviews)" : "Available after the A2P campaign clears carrier review"}
        className="rounded-md border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40"
      >
        {busy ? "Running…" : "Register"}
      </button>
      {result && <div className="max-w-[220px] text-[11px] text-muted-foreground" title={result}>{result.length > 90 ? `${result.slice(0, 90)}…` : result}</div>}
    </div>
  )
}
