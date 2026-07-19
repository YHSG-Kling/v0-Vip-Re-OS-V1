"use client"

// Fleet numbers console — the interactive pieces. Same idiom as the A2P
// board's cells: small client components, one server action per click, the
// honest result line shown verbatim (creds absent → the core's "not
// configured" message; nothing here fabricates a purchase or a release).

import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  searchNumbersForTenant,
  provisionNumberForTenant,
  releaseNumberForTenant,
} from "@/app/actions/superadmin/number-provisioning"

interface TenantOption { id: string; name: string }
interface Candidate { phoneNumber: string; friendlyName: string | null; locality: string | null; region: string | null; postalCode: string | null }

// ─── Tenant picker → area-code search → candidates → provision ───────────────

export function ProvisionPanel({ tenants }: { tenants: TenantOption[] }) {
  const router = useRouter()
  const [brokerageId, setBrokerageId] = useState("")
  const [areaCode, setAreaCode] = useState("")
  const [locality, setLocality] = useState("")
  const [busy, setBusy] = useState(false)
  const [provisioning, setProvisioning] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [credTier, setCredTier] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const search = async () => {
    if (!brokerageId) { setMessage("Pick a tenant first."); return }
    setBusy(true); setMessage(null); setCandidates(null); setCredTier(null)
    const r = await searchNumbersForTenant({ brokerageId, areaCode: areaCode.trim() || undefined, locality: locality.trim() || undefined })
    if (r.ok) {
      setCandidates(r.candidates)
      setCredTier(r.credTier)
      if (r.candidates.length === 0) setMessage("No available numbers matched — try another area code or locality.")
    } else {
      setMessage(r.error)
    }
    setBusy(false)
  }

  const provision = async (phoneNumber: string) => {
    setProvisioning(phoneNumber); setMessage(null)
    const r = await provisionNumberForTenant({ brokerageId, phoneNumber })
    if (r.ok) {
      setMessage(
        `Provisioned ${r.phoneNumber} (${r.credTier} creds)${r.twilioSid ? ` · ${r.twilioSid}` : ""} — ` +
        (r.bound ? "webhooks bound to the AI lane." : r.bindNote ?? "webhooks not bound."),
      )
      setCandidates(null)
      router.refresh()
    } else {
      setMessage(r.error)
    }
    setProvisioning(null)
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h2 className="text-lg font-semibold">Provision a number</h2>
      <p className="text-xs text-muted-foreground">
        Search purchasable US local numbers with the tenant&apos;s canonical Twilio credentials
        (BYO → subaccount → platform master), then provision: purchase, save to the tenant&apos;s
        inventory (brokerage scope), audit line, AI-lane webhook binding.
      </p>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Tenant</span>
          <select value={brokerageId} onChange={(e) => setBrokerageId(e.target.value)} className="rounded-md border px-2 py-1 bg-background min-w-[220px]">
            <option value="">Select a tenant…</option>
            {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Area code</span>
          <input value={areaCode} onChange={(e) => setAreaCode(e.target.value)} placeholder="512" maxLength={3} className="rounded-md border px-2 py-1 bg-background w-20" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Locality (optional)</span>
          <input value={locality} onChange={(e) => setLocality(e.target.value)} placeholder="Austin" className="rounded-md border px-2 py-1 bg-background w-40" />
        </label>
        <button onClick={search} disabled={busy || !brokerageId} className="rounded-md border px-3 py-1 font-medium disabled:opacity-40">
          {busy ? "Searching…" : "Search"}
        </button>
      </div>

      {message && <div className="rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap">{message}</div>}

      {candidates && candidates.length > 0 && (
        <div className="rounded-md border divide-y">
          <div className="px-3 py-1.5 text-[11px] text-muted-foreground">
            {candidates.length} candidate{candidates.length === 1 ? "" : "s"}{credTier ? ` · ${credTier} credentials` : ""}
          </div>
          {candidates.map((c) => (
            <div key={c.phoneNumber} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="font-medium tabular-nums">{c.phoneNumber}</span>
              <span className="text-xs text-muted-foreground">
                {[c.locality, c.region, c.postalCode].filter(Boolean).join(", ") || "—"}
              </span>
              <button
                onClick={() => provision(c.phoneNumber)}
                disabled={provisioning !== null}
                className="ml-auto rounded-md border px-2 py-0.5 text-xs font-medium disabled:opacity-40"
              >
                {provisioning === c.phoneNumber ? "Provisioning…" : "Provision"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Release with type-the-number confirmation ───────────────────────────────

export function ReleaseCell({ brokerageId, numberRowId, phoneNumber }: { brokerageId: string; numberRowId: string; phoneNumber: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const release = async () => {
    setBusy(true); setResult(null)
    // The server RE-CHECKS the verbatim match — this input is a convenience,
    // not the enforcement.
    const r = await releaseNumberForTenant({ brokerageId, numberRowId, confirm: typed })
    if (r.ok) {
      setResult(`Released ${r.phoneNumber}${r.twilioReleased ? " (Twilio release confirmed)" : ""}${r.note ? ` — ${r.note}` : ""}`)
      setOpen(false)
      router.refresh()
    } else {
      setResult(r.error)
    }
    setBusy(false)
  }

  return (
    <div className="space-y-1">
      {!open ? (
        <button onClick={() => { setOpen(true); setTyped(""); setResult(null) }} className="rounded-md border border-red-300 px-2 py-0.5 text-[11px] font-medium text-red-700">
          Release…
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Type ${phoneNumber}`}
            className="rounded-md border px-2 py-0.5 text-[11px] w-40 bg-background"
          />
          <button
            onClick={release}
            disabled={busy || typed !== phoneNumber}
            title={typed !== phoneNumber ? "Type the number exactly as shown to enable release" : "Release this number"}
            className="rounded-md border border-red-400 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-800 disabled:opacity-40"
          >
            {busy ? "Releasing…" : "Confirm release"}
          </button>
          <button onClick={() => setOpen(false)} disabled={busy} className="rounded-md border px-2 py-0.5 text-[11px]">Cancel</button>
        </div>
      )}
      {result && <div className="max-w-[280px] text-[11px] text-muted-foreground" title={result}>{result.length > 120 ? `${result.slice(0, 120)}…` : result}</div>}
    </div>
  )
}
