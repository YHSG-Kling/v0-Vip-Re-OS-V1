"use client"

// THE GOD SWITCH — the superadmin's platform-wide controls. Emergency mode / AI engine off freezes every
// autonomous AI manager action across ALL tenants (enforced at the autonomy gate + AI gateway). Every flip
// is superadmin-gated and audited server-side.
import { useCallback, useEffect, useState, useTransition } from "react"
import { Switch } from "@/app/components/ui/switch"
import { ShieldAlert, Power, Gauge, RefreshCw } from "lucide-react"
import { getPlatformControlsAction, setPlatformControlsAction } from "@/app/actions/superadmin/platform-controls"
import type { PlatformControls } from "@/lib/platform/platform-controls"

export function PlatformControlsPanel({ initial }: { initial: PlatformControls }) {
  const [c, setC] = useState<PlatformControls>(initial)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [rate, setRate] = useState(String(initial.globalRateLimitPerMinute))
  const [syncing, setSyncing] = useState(false)
  const [syncedAt, setSyncedAt] = useState<Date | null>(null)

  const halted = c.emergencyMode || !c.aiEnabled

  /**
   * Authoritative re-read via the superadmin-gated
   * `getPlatformControlsAction` — the only door onto
   * `lib/platform/platform-controls.ts:getPlatformControls` that a client may use
   * (the library function is server-side and the page's own read happens once, at
   * render). Without it this panel showed whatever it was rendered with plus its
   * own optimistic edits, so a second operator hitting emergency mode left this
   * one looking at "AI engine: on" while every tenant's autonomy was frozen — the
   * most consequential stale reading on the platform. Re-syncs on mount, whenever
   * the tab regains focus, and on demand.
   */
  const resync = useCallback(async (): Promise<PlatformControls | null> => {
    setSyncing(true)
    try {
      const res = await getPlatformControlsAction()
      if (!res.ok) {
        setError(res.error)
        return null
      }
      setC(res.controls)
      setRate(String(res.controls.globalRateLimitPerMinute))
      setSyncedAt(new Date())
      setError(null)
      return res.controls
    } catch (err: any) {
      setError(err?.message ?? "Could not refresh the platform controls")
      return null
    } finally {
      setSyncing(false)
    }
  }, [])

  useEffect(() => {
    void resync()
    const onFocus = () => { void resync() }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [resync])

  function patch(next: Partial<PlatformControls>) {
    setC({ ...c, ...next }) // optimistic
    setError(null)
    startTransition(async () => {
      const res = await setPlatformControlsAction(next)
      if (!res.ok) {
        setError(res.error)
        // Do NOT restore the pre-click local snapshot: it is only this browser's
        // belief and may itself be stale. Re-read the real state instead, so a
        // rejected flip never leaves the god switch showing a value the platform
        // does not hold.
        await resync()
      } else {
        setC(res.controls)
        setRate(String(res.controls.globalRateLimitPerMinute))
        setSyncedAt(new Date())
      }
    })
  }

  return (
    <div className={"rounded-xl border p-4 " + (halted ? "border-red-300 bg-red-50/60" : "border-slate-200")}>
      <div className="flex items-center gap-2 mb-3">
        <ShieldAlert className={"h-5 w-5 " + (halted ? "text-red-600" : "text-slate-500")} />
        <h2 className="text-base font-semibold">Platform controls — the god switch</h2>
        {halted && <span className="ml-1 rounded bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">AUTONOMY HALTED</span>}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {syncing ? "Checking…" : syncedAt ? `As of ${syncedAt.toLocaleTimeString()}` : "Not yet verified"}
          </span>
          <button
            type="button"
            onClick={() => { void resync() }}
            disabled={syncing || pending}
            aria-label="Re-read platform controls"
            className="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
          >
            <RefreshCw className={"h-3.5 w-3.5 " + (syncing ? "animate-spin" : "")} />
          </button>
        </div>
      </div>
      {halted && (
        <p className="mb-3 text-sm text-red-700">
          Every autonomous AI manager action is currently held platform-wide. Human-approved sends still go
          through. Clear the switches below to resume.
        </p>
      )}

      <div className="space-y-3">
        {/* Emergency mode — the red button */}
        <div className="flex items-center justify-between rounded-lg border bg-white p-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 text-red-600" />
            <div>
              <p className="text-sm font-medium">Emergency mode</p>
              <p className="text-xs text-muted-foreground">Freeze all autonomous AI managers across every tenant. The big red button.</p>
            </div>
          </div>
          <Switch checked={c.emergencyMode} onCheckedChange={(v) => patch({ emergencyMode: v })} disabled={pending} aria-label="Toggle emergency mode" />
        </div>

        {/* AI engine master switch */}
        <div className="flex items-center justify-between rounded-lg border bg-white p-3">
          <div className="flex items-start gap-2">
            <Power className="mt-0.5 h-4 w-4 text-slate-600" />
            <div>
              <p className="text-sm font-medium">AI engine</p>
              <p className="text-xs text-muted-foreground">Master switch for autonomous AI. Off holds all managers platform-wide.</p>
            </div>
          </div>
          <Switch checked={c.aiEnabled} onCheckedChange={(v) => patch({ aiEnabled: v })} disabled={pending} aria-label="Toggle AI engine" />
        </div>

        {/* Global rate limit */}
        <div className="flex items-center justify-between rounded-lg border bg-white p-3">
          <div className="flex items-start gap-2">
            <Gauge className="mt-0.5 h-4 w-4 text-slate-600" />
            <div>
              <p className="text-sm font-medium">Global rate limit</p>
              <p className="text-xs text-muted-foreground">Platform-wide ceiling (requests/minute) surfaced to operators.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)}
              className="h-8 w-24 rounded-md border px-2 text-sm" aria-label="Global rate limit per minute"
            />
            <button
              className="h-8 rounded-md bg-slate-900 px-3 text-xs font-medium text-white disabled:opacity-50"
              disabled={pending || Number(rate) === c.globalRateLimitPerMinute || !(Number(rate) > 0)}
              onClick={() => patch({ globalRateLimitPerMinute: Number(rate) })}
            >Save</button>
          </div>
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}
