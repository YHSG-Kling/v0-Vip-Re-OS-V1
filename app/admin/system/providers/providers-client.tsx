"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ShieldCheck,
  ShieldAlert,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

interface ProviderRow {
  key: string
  name: string
  description: string
  envVar: string
  category: "scraping" | "ai_media" | "property_data" | "realtime_voice"
}

const PROVIDERS: ProviderRow[] = [
  {
    key: "zenrows",
    name: "ZenRows",
    description: "Web scraping proxy + browser rendering for lead enrichment.",
    envVar: "ZENROWS_API_KEY",
    category: "scraping",
  },
  {
    key: "batchdata",
    name: "BatchData",
    description: "Property + skip-trace data for outbound lead lists.",
    envVar: "BATCHDATA_API_KEY",
    category: "scraping",
  },
  {
    key: "apify",
    name: "Apify",
    description: "Hosted scrapers for site-specific lead capture.",
    envVar: "APIFY_API_KEY",
    category: "scraping",
  },
  {
    key: "did",
    name: "D-ID",
    description: "Talking-avatar video + chat widget rendering.",
    envVar: "DID_API_KEY",
    category: "ai_media",
  },
  {
    key: "elevenlabs",
    name: "ElevenLabs",
    description: "Voice cloning for podcast audio + ISA call synthesis.",
    envVar: "ELEVENLABS_API_KEY",
    category: "ai_media",
  },
  {
    key: "heygen",
    name: "HeyGen",
    description: "Avatar video generation; alternative voice synth provider.",
    envVar: "HEYGEN_API_KEY",
    category: "ai_media",
  },
  {
    key: "housecanary",
    name: "HouseCanary",
    description: "AVM, property valuations, and neighborhood data.",
    envVar: "HOUSECANARY_API_KEY",
    category: "property_data",
  },
  {
    key: "livekit",
    name: "LiveKit",
    description:
      "Realtime WebRTC transport for the on-the-go AI talking assistant. Runs in parallel with VAPI ISA calling — does not replace it.",
    envVar: "LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL",
    category: "realtime_voice",
  },
]

const CATEGORY_LABELS: Record<ProviderRow["category"], string> = {
  scraping: "Scraping & Lead Data",
  ai_media: "AI Media (voice + video + avatar)",
  property_data: "Property & Market Data",
  realtime_voice: "Realtime Voice Transport",
}

interface TestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

interface Props {
  configured: Record<string, boolean>
}

export function ProvidersClient({ configured }: Props) {
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<Record<string, TestResult>>({})

  async function testProvider(key: string) {
    setTesting((s) => ({ ...s, [key]: true }))
    try {
      const res = await fetch("/api/admin/system/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: key }),
      })
      const data = await res.json().catch(() => ({}))
      const result: TestResult = {
        ok: res.ok && data?.ok === true,
        message: data?.message ?? (res.ok ? "OK" : `HTTP ${res.status}`),
        latencyMs: data?.latencyMs,
      }
      setResults((r) => ({ ...r, [key]: result }))
      if (result.ok) toast.success(`${key}: ${result.message}`)
      else toast.error(`${key}: ${result.message}`)
    } catch (err: any) {
      const result: TestResult = { ok: false, message: err?.message ?? "Test failed" }
      setResults((r) => ({ ...r, [key]: result }))
      toast.error(`${key}: ${result.message}`)
    } finally {
      setTesting((s) => ({ ...s, [key]: false }))
    }
  }

  // Group providers by category
  const grouped = PROVIDERS.reduce<Record<string, ProviderRow[]>>((acc, p) => {
    ;(acc[p.category] ??= []).push(p)
    return acc
  }, {})

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary" />
          System Providers
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Platform-wide API credentials. These are configured via environment
          variables on the server — agents and brokers do not see this page.
        </p>
      </div>

      {Object.entries(grouped).map(([category, providers]) => (
        <Card key={category}>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{CATEGORY_LABELS[category as ProviderRow["category"]]}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {providers.map((p) => {
              const isConfigured = !!configured[p.key]
              const result = results[p.key]
              const isTesting = !!testing[p.key]
              return (
                <div
                  key={p.key}
                  className="flex items-start gap-3 rounded-lg border p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-sm">{p.name}</p>
                      {isConfigured ? (
                        <Badge variant="outline" className="text-emerald-700 border-emerald-300">
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          Configured
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-amber-700 border-amber-300">
                          <ShieldAlert className="h-3 w-3 mr-1" />
                          Not configured
                        </Badge>
                      )}
                      {result && (
                        <Badge
                          variant="outline"
                          className={
                            result.ok
                              ? "text-emerald-700 border-emerald-300"
                              : "text-red-700 border-red-300"
                          }
                        >
                          {result.ok ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                          {result.message}
                          {result.latencyMs != null ? ` (${result.latencyMs}ms)` : ""}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>
                    <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                      env: <code>{p.envVar}</code>
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => testProvider(p.key)}
                    disabled={!isConfigured || isTesting}
                  >
                    {isTesting ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        Testing…
                      </>
                    ) : (
                      "Test connection"
                    )}
                  </Button>
                </div>
              )
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
