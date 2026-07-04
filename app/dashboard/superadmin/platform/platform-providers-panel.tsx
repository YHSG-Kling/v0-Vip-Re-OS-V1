"use client"

// PLATFORM PROVIDER CONFIG — real, table-backed superadmin controls: channel enablement (direct mail / video)
// + platform-default vendors (email / sms / phone) that every tenant inherits. Writes provider_overrides at
// scope_type='superadmin'; the runtime resolveProvider / getSystemProviderStatus already read it.
import { useState, useTransition } from "react"
import { Switch } from "@/app/components/ui/switch"
import { Plug } from "lucide-react"
import { setPlatformProviderAction } from "@/app/actions/superadmin/platform-providers"
import type { PlatformProviderSpec, PlatformProviderState } from "@/lib/platform/platform-providers"

export function PlatformProvidersPanel({ spec, initial }: { spec: PlatformProviderSpec[]; initial: PlatformProviderState[] }) {
  const [state, setState] = useState<Record<string, PlatformProviderState>>(
    Object.fromEntries(initial.map((s) => [s.providerType, s])),
  )
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  function save(providerType: string, next: Partial<PlatformProviderState>) {
    const cur = state[providerType]
    const merged = { ...cur, ...next }
    setState((s) => ({ ...s, [providerType]: merged })) // optimistic
    setErr(null)
    start(async () => {
      const r = await setPlatformProviderAction({ providerType, providerKey: merged.providerKey, enabled: merged.enabled })
      if (!r.ok) { setState((s) => ({ ...s, [providerType]: cur })); setErr(r.error ?? "Failed") }
    })
  }

  const channels = spec.filter((s) => s.kind === "channel")
  const defaults = spec.filter((s) => s.kind === "default")

  return (
    <div className="rounded-xl border p-4">
      <div className="flex items-center gap-2 mb-3">
        <Plug className="h-5 w-5 text-slate-500" />
        <h2 className="text-base font-semibold">Platform providers</h2>
      </div>
      {err && <p className="mb-2 text-xs text-red-600">{err}</p>}

      <div className="space-y-3">
        <p className="text-xs font-medium text-muted-foreground">Channel enablement (platform-wide)</p>
        {channels.map((s) => (
          <div key={s.providerType} className="flex items-center justify-between rounded-lg border bg-white p-3">
            <div>
              <p className="text-sm font-medium">{s.label}</p>
              <p className="text-xs text-muted-foreground">Turn this channel on/off for every tenant.</p>
            </div>
            <Switch checked={state[s.providerType]?.enabled ?? false} onCheckedChange={(v) => save(s.providerType, { enabled: v })} disabled={pending} aria-label={`Toggle ${s.label}`} />
          </div>
        ))}

        <p className="pt-2 text-xs font-medium text-muted-foreground">Default vendors (inherited by tenants that haven&apos;t set their own)</p>
        {defaults.map((s) => (
          <div key={s.providerType} className="flex items-center justify-between rounded-lg border bg-white p-3">
            <div>
              <p className="text-sm font-medium">{s.label}</p>
              <p className="text-xs text-muted-foreground">Platform default when a brokerage hasn&apos;t connected its own.</p>
            </div>
            <select
              className="h-8 rounded-md border px-2 text-sm"
              value={state[s.providerType]?.providerKey ?? s.options[0]}
              onChange={(e) => save(s.providerType, { providerKey: e.target.value, enabled: true })}
              disabled={pending}
              aria-label={`${s.label} vendor`}
            >
              {s.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  )
}
