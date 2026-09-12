"use client"

/**
 * <CapabilityResolverCard> — THE PLATFORM DOOR ONTO /api/agentic-os/resolve-capability.
 *
 * WHY IT EXISTS. That route answers, for one business capability and one brokerage:
 * WHICH connector wins right now, its cost tier, the whole downgrade ladder, and the
 * live budget posture. Nothing in the tree addressed it, and the note that survived a
 * previous census (lib/agentic-os/resolve-vendor-capability.ts) justified the silence by
 * calling it "the ONLY door an external agent has". That justification does not hold and
 * is corrected there: the route is gated by requirePlatformStaffAuth → requireAuth, which
 * reads a SUPABASE SESSION. A `vos_…` agent bearer token resolves through
 * resolveAgenticCaller and never produces a session, so an external agent gets a 401 here,
 * every time. External agents reach the vendor surface through /api/agentic-os/actions and
 * /api/agentic-os/connectivity, both of which are deliberately VENDOR-ANONYMOUS.
 *
 * So the route is a PLATFORM-STAFF door, and this is the surface that walks through it —
 * on the page that already owns provider posture and invocation analytics, behind the same
 * `providers` platform capability gate.
 *
 * IT IS NOT A DUPLICATE OF resolveVendorCapability(). That module is `import "server-only"`;
 * nothing outside the Node process can call it. The route adds the staff gate, validation of
 * `capability` against VENDOR_CAPABILITY_REGISTRY (with the available list in the 400), and a
 * GET discovery listing — which is what this card enumerates its picker from.
 *
 * VENDOR NAMES ARE SHOWN ON PURPOSE. This page is platform staff only; the vendor-anonymity
 * rule governs what a BROKERAGE may see, and the tenant-facing surfaces
 * (/api/agentic-os/actions, the capability panel) still collapse the platform-managed set.
 */

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, Cpu, AlertTriangle } from "lucide-react"

interface ProviderRung {
  vendor: string
  tier: "free" | "paid"
  note: string
}

/** Exactly lib/agentic-os/resolve-vendor-capability.ts::ResolvedCapability. */
interface Resolved {
  capability: string
  domain: string
  verb: string
  scope: string
  intentWeight: number
  purpose: string
  inputs: string[]
  providers: ProviderRung[]
  selection: {
    provider: string
    tier: "free" | "paid"
    action: string
    usingFreeFallback: boolean
    reason: string
  }
  budgetLevel: "ok" | "approaching" | "paused"
}

const BUDGET_STYLE: Record<string, string> = {
  ok: "bg-emerald-100 text-emerald-800 border-emerald-300",
  approaching: "bg-amber-100 text-amber-900 border-amber-300",
  paused: "bg-red-100 text-red-800 border-red-300",
}

export function CapabilityResolverCard() {
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [capability, setCapability] = useState("")
  const [brokerageId, setBrokerageId] = useState("")
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // GET is the route's discovery half — the registry, with no live budget read.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/agentic-os/resolve-capability")
        const json = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok) {
          setError((json && json.error) || `Could not load the capability registry (HTTP ${res.status}).`)
          return
        }
        const keys = Object.keys((json?.capabilities ?? {}) as Record<string, unknown>).sort()
        setCapabilities(keys)
        if (keys.length > 0) setCapability((c) => c || keys[0])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the capability registry")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function resolve() {
    if (!capability || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/agentic-os/resolve-capability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // brokerageId is OPTIONAL: omitted, the route falls back to the staff
        // member's own brokerage. It is never inferred here.
        body: JSON.stringify(
          brokerageId.trim() ? { capability, brokerageId: brokerageId.trim() } : { capability },
        ),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setError((json && json.error) || `Resolve refused (HTTP ${res.status}).`)
        setResolved(null)
        return
      }
      setResolved(json as Resolved)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resolve failed")
      setResolved(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Cpu className="h-4 w-4" />
          Capability resolver
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Which connector serves a capability for a tenant <em>right now</em>, its cost tier, the
          full downgrade ladder, and the tenant&rsquo;s live budget posture. Platform-internal —
          brokerage surfaces stay vendor-anonymous.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <select
            value={capability}
            onChange={(e) => setCapability(e.target.value)}
            disabled={capabilities.length === 0}
            className="h-9 min-w-[14rem] rounded-md border border-input bg-background px-2 text-sm"
          >
            {capabilities.length === 0 && <option value="">Loading capabilities…</option>}
            {capabilities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Input
            value={brokerageId}
            onChange={(e) => setBrokerageId(e.target.value)}
            placeholder="brokerage id (blank = yours)"
            className="h-9 max-w-[20rem]"
          />
          <Button size="sm" onClick={() => void resolve()} disabled={busy || !capability}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Resolve"}
          </Button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {resolved && (
          <div className="space-y-2 text-xs">
            <p className="text-foreground">{resolved.purpose}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{resolved.verb}</Badge>
              <Badge variant="outline">{resolved.domain}</Badge>
              <Badge variant="outline">scope: {resolved.scope}</Badge>
              <Badge variant="outline">intent {resolved.intentWeight}</Badge>
              <Badge className={BUDGET_STYLE[resolved.budgetLevel] ?? "bg-muted text-muted-foreground"}>
                budget: {resolved.budgetLevel}
              </Badge>
            </div>

            <div className="rounded-md border border-border p-2">
              <div className="font-medium text-foreground">
                Serving now: {resolved.selection.provider} ({resolved.selection.tier})
                {resolved.selection.usingFreeFallback && " — degraded to free"}
              </div>
              <div className="text-muted-foreground">
                action <span className="font-mono">{resolved.selection.action}</span> ·{" "}
                {resolved.selection.reason}
              </div>
            </div>

            <div>
              <div className="mb-1 text-muted-foreground">Ladder (priority order)</div>
              <ol className="space-y-1">
                {resolved.providers.map((p, i) => (
                  <li key={p.vendor} className="flex items-baseline gap-2">
                    <span className="text-muted-foreground">{i + 1}.</span>
                    <span className="font-medium text-foreground">{p.vendor}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {p.tier}
                    </Badge>
                    <span className="text-muted-foreground">{p.note}</span>
                  </li>
                ))}
              </ol>
            </div>

            {resolved.inputs.length > 0 && (
              <div className="text-muted-foreground">
                inputs: <span className="font-mono">{resolved.inputs.join(", ")}</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
