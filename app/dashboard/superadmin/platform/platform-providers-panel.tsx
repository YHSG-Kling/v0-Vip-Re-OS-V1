"use client"

// PLATFORM CHANNEL ENABLEMENT — real, table-backed superadmin toggles for the platform-funded channels
// (direct mail = Lob, video = D-ID) that the runtime getSystemProviderStatus already gates on. Provider API
// keys live in Vercel env; tenant-connected providers (email/calendar/SMS/phone) are configured per-tenant,
// not here.
import { useState, useTransition } from "react"
import { Switch } from "@/app/components/ui/switch"
import { Plug } from "lucide-react"
import { setPlatformProviderAction } from "@/app/actions/superadmin/platform-providers"
import type { PlatformProviderSpec, PlatformProviderState } from "@/lib/platform/platform-providers"

export function PlatformProvidersPanel({ spec, initial }: { spec: PlatformProviderSpec[]; initial: PlatformProviderState[] }) {
  const [state, setState] = useState<Record<string, boolean>>(Object.fromEntries(initial.map((s) => [s.providerType, s.enabled])))
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  function toggle(providerType: string, enabled: boolean) {
    const prev = state[providerType]
    setState((s) => ({ ...s, [providerType]: enabled })) // optimistic
    setErr(null)
    start(async () => {
      const r = await setPlatformProviderAction({ providerType, enabled })
      if (!r.ok) { setState((s) => ({ ...s, [providerType]: prev })); setErr(r.error ?? "Failed") }
    })
  }

  return (
    <div className="rounded-xl border p-4">
      <div className="flex items-center gap-2 mb-1">
        <Plug className="h-5 w-5 text-slate-500" />
        <h2 className="text-base font-semibold">Platform channels</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Enable the platform-funded channels for every tenant. Provider keys are set in Vercel env; email,
        calendar, SMS &amp; phone are connected per-tenant, not here.
      </p>
      {err && <p className="mb-2 text-xs text-red-600">{err}</p>}

      <div className="space-y-3">
        {spec.map((s) => (
          <div key={s.providerType} className="flex items-center justify-between rounded-lg border bg-white p-3">
            <div>
              <p className="text-sm font-medium">{s.label} <span className="text-xs text-muted-foreground">· {s.vendor}</span></p>
              <p className="text-xs text-muted-foreground">{s.note}</p>
            </div>
            <Switch checked={state[s.providerType] ?? false} onCheckedChange={(v) => toggle(s.providerType, v)} disabled={pending} aria-label={`Toggle ${s.label}`} />
          </div>
        ))}
      </div>
    </div>
  )
}
