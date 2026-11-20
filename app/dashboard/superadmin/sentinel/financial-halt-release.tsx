"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { releaseFinancialWriterHaltAsPlatformAction } from "@/app/actions/superadmin/financial-halts"

/** Release one tenant's halted financial writer (platform door — reason + evidence, gated server-side). */
export function FinancialHaltRelease({ brokerageId, writer }: { brokerageId: string; writer: string }) {
  const [pending, start] = useTransition()
  const [reason, setReason] = useState("")
  const [evidence, setEvidence] = useState("")
  const [msg, setMsg] = useState<string | null>(null)
  const router = useRouter()
  const release = () =>
    start(async () => {
      const r = await releaseFinancialWriterHaltAsPlatformAction({ brokerageId, writer, reason, evidence })
      setMsg(r.success ? "Released." : r.error)
      if (r.success) router.refresh()
    })
  return (
    <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-center">
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is resolved" className="min-w-0 flex-1 rounded border px-2 py-1 text-xs" />
      <input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Evidence (reconciliation id, ledger rows, ticket)" className="min-w-0 flex-1 rounded border px-2 py-1 text-xs" />
      <button type="button" disabled={pending} onClick={release} className="rounded border px-2 py-1 text-xs hover:bg-emerald-50 disabled:opacity-50">Release</button>
      {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
    </div>
  )
}
