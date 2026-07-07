"use client"

// Tenant stock-photo provider key (Settings → Stock Library). LICENSE LINE:
// stock licenses cover each USER's own use — so each brokerage adds ITS OWN
// key here (their license, their downloads); the platform env key is only a
// fallback. Keys land in platform_credentials (platform='pexels').
import { useEffect, useState, useTransition } from "react"
import { setStockProviderKeyAction, getStockProviderStatusAction } from "@/app/actions/marketing/image-library"

export function StockProviderCard() {
  const [status, setStatus] = useState<{ tenantKeySet: boolean; platformKeySet: boolean } | null>(null)
  const [key, setKey] = useState("")
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => { getStockProviderStatusAction().then((r) => setStatus(r)) }, [])

  function save() {
    setMsg(null)
    start(async () => {
      const r = await setStockProviderKeyAction({ apiKey: key })
      if (!r.ok) { setMsg(r.error ?? "Failed"); return }
      setMsg("Saved — stock photo search now uses your brokerage's own key/license.")
      setKey("")
      getStockProviderStatusAction().then((r2) => setStatus(r2))
    })
  }

  return (
    <div className="rounded-lg border p-4 space-y-2">
      <p className="text-sm font-medium">Stock photo provider (Pexels)</p>
      <p className="text-xs text-muted-foreground">
        Add your brokerage&apos;s own Pexels API key (free at pexels.com/api) so stock photo search in the
        image pickers runs under <em>your</em> license. {status?.tenantKeySet
          ? "A key is set for your brokerage. "
          : status?.platformKeySet
            ? "No brokerage key yet — searches currently use the platform fallback. "
            : "No key configured yet — stock search is off until one is added. "}
        Photos you pick are licensed to your brokerage&apos;s own use.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="password" value={key} onChange={(e) => setKey(e.target.value)}
          placeholder={status?.tenantKeySet ? "Replace existing key…" : "Pexels API key"}
          className="flex-1 rounded-md border px-2 py-1.5 text-sm"
        />
        <button onClick={save} disabled={pending || key.trim().length < 10}
          className="rounded-md border px-3 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-50">
          Save key
        </button>
      </div>
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </div>
  )
}
