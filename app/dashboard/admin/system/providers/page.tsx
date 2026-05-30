"use client"

/**
 * Super Admin — System Provider Connection Status
 *
 * Shows each platform-level API integration (ZenRows, BatchData, Apify,
 * D-ID, ElevenLabs, HeyGen, HouseCanary) with a "Test Connection" button.
 * Tests POST to /api/admin/system/providers/test.
 *
 * Super admin role only — do not add to agent or broker nav.
 * API keys are set via environment variables (not stored in DB here).
 */

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Server,
  RefreshCw,
  AlertTriangle,
} from "lucide-react"

interface ProviderResult {
  ok: boolean
  message: string
  latencyMs?: number
}

type Status = "idle" | "testing" | "ok" | "error"

interface ProviderState {
  status: Status
  result: ProviderResult | null
}

const PROVIDERS = [
  {
    id: "zenrows",
    label: "ZenRows",
    description: "Web scraping proxy used for OSINT property data and Zillow public page fetching.",
    envKey: "ZENROWS_API_KEY",
    docsUrl: "https://www.zenrows.com/",
  },
  {
    id: "batchdata",
    label: "BatchData",
    description: "Property data API — skip-trace, owner lookup, portfolio data. Used for premium property enrichment.",
    envKey: "BATCHDATA_API_KEY",
    docsUrl: "https://batchdata.com/",
  },
  {
    id: "apify",
    label: "Apify",
    description: "Web scraping orchestration for raw lead collection from public sources.",
    envKey: "APIFY_API_KEY",
    docsUrl: "https://apify.com/",
  },
  {
    id: "did",
    label: "D-ID (Talking Avatar)",
    description: "AI talking avatar video generation. Used for listing videos, market updates, and the AI chat assistant.",
    envKey: "DID_API_KEY",
    docsUrl: "https://www.d-id.com/",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs (Voice AI)",
    description: "Voice cloning and synthesis. Used for podcast audio generation and AI ISA voice calls.",
    envKey: "ELEVENLABS_API_KEY",
    docsUrl: "https://elevenlabs.io/",
  },
  {
    id: "heygen",
    label: "HeyGen (AI Video)",
    description: "AI avatar video creation alternative to D-ID. Used for presentation videos.",
    envKey: "HEYGEN_API_KEY",
    docsUrl: "https://www.heygen.com/",
  },
  {
    id: "housecanary",
    label: "HouseCanary (AVM)",
    description: "Premium automated valuation model. Agent-triggered only for high-stakes CMA work.",
    envKey: "HOUSECANARY_API_KEY",
    docsUrl: "https://www.housecanary.com/",
  },
]

export default function SystemProvidersPage() {
  const [states, setStates] = useState<Record<string, ProviderState>>(
    Object.fromEntries(PROVIDERS.map((p) => [p.id, { status: "idle", result: null }]))
  )
  const [testingAll, setTestingAll] = useState(false)

  async function testProvider(providerId: string) {
    setStates((prev) => ({
      ...prev,
      [providerId]: { status: "testing", result: null },
    }))

    try {
      const res = await fetch("/api/admin/system/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      })

      if (res.status === 401 || res.status === 403) {
        setStates((prev) => ({
          ...prev,
          [providerId]: {
            status: "error",
            result: { ok: false, message: "Not authorized — super admin only." },
          },
        }))
        return
      }

      const data: ProviderResult = await res.json()
      setStates((prev) => ({
        ...prev,
        [providerId]: { status: data.ok ? "ok" : "error", result: data },
      }))
    } catch {
      setStates((prev) => ({
        ...prev,
        [providerId]: {
          status: "error",
          result: { ok: false, message: "Network error — check connectivity." },
        },
      }))
    }
  }

  async function testAllProviders() {
    setTestingAll(true)
    await Promise.all(PROVIDERS.map((p) => testProvider(p.id)))
    setTestingAll(false)
  }

  const allDone = PROVIDERS.every((p) => states[p.id].status !== "idle" && states[p.id].status !== "testing")
  const okCount = PROVIDERS.filter((p) => states[p.id].status === "ok").length
  const errorCount = PROVIDERS.filter((p) => states[p.id].status === "error").length

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Server className="h-6 w-6" />
            System Provider Connections
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Platform-level API integrations — super admin only.
            API keys are configured via environment variables.
          </p>
        </div>
        <Button onClick={testAllProviders} disabled={testingAll} className="gap-2">
          {testingAll ? (
            <><Loader2 className="h-4 w-4 animate-spin" />Testing…</>
          ) : (
            <><RefreshCw className="h-4 w-4" />Test All</>
          )}
        </Button>
      </div>

      {/* Summary bar after testing */}
      {allDone && (
        <div className={`flex items-center gap-3 p-3 rounded-lg border text-sm font-medium ${
          errorCount === 0
            ? "bg-green-50 border-green-200 text-green-800"
            : errorCount === PROVIDERS.length
            ? "bg-red-50 border-red-200 text-red-800"
            : "bg-amber-50 border-amber-200 text-amber-800"
        }`}>
          {errorCount === 0 ? (
            <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          )}
          {okCount} of {PROVIDERS.length} providers connected.
          {errorCount > 0 && ` ${errorCount} failing — check env vars or API keys.`}
        </div>
      )}

      {/* Provider cards */}
      <div className="grid gap-4">
        {PROVIDERS.map((provider) => {
          const state = states[provider.id]
          return (
            <Card key={provider.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base">{provider.label}</CardTitle>
                    <StatusBadge status={state.status} />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => testProvider(provider.id)}
                    disabled={state.status === "testing"}
                    className="gap-1.5"
                  >
                    {state.status === "testing" ? (
                      <><Loader2 className="h-3.5 w-3.5 animate-spin" />Testing…</>
                    ) : (
                      <><RefreshCw className="h-3.5 w-3.5" />Test Connection</>
                    )}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">{provider.description}</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    {provider.envKey}
                  </code>
                  <a
                    href={provider.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline"
                  >
                    Docs ↗
                  </a>
                </div>
                {state.result && (
                  <div className={`flex items-start gap-2 p-2 rounded text-xs ${
                    state.result.ok
                      ? "bg-green-50 text-green-800"
                      : "bg-red-50 text-red-800"
                  }`}>
                    {state.result.ok
                      ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      : <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    }
                    <span>
                      {state.result.message}
                      {state.result.latencyMs != null && (
                        <span className="ml-2 opacity-70">{state.result.latencyMs}ms</span>
                      )}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <p className="text-xs text-muted-foreground text-center pb-4">
        Set API keys via Vercel/Railway environment variables.
        Keys are never stored in the database — only env vars are read at runtime.
      </p>
    </div>
  )
}

function StatusBadge({ status }: { status: Status }) {
  if (status === "idle") return null
  if (status === "testing") return <Badge variant="secondary" className="text-xs">Testing…</Badge>
  if (status === "ok") return (
    <Badge className="text-xs bg-green-100 text-green-700 border-green-200">Connected</Badge>
  )
  return <Badge variant="destructive" className="text-xs">Failed</Badge>
}
